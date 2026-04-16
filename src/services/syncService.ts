import * as vscode from 'vscode';
import { ConnectionManager, SyncLoadResult } from './connectionManager';
import { EncryptionService } from './encryptionService';

/** How long to show the ✓ icon in the status bar after a successful sync. */
const SYNC_STATUS_HIDE_DELAY_MS = 5_000;
/** Polling interval — detects data delivered by Settings Sync while window stayed focused. */
const POLL_INTERVAL_MS = 60_000;
/** Exponential-backoff delays for the first-load retry (e.g. Settings Sync delivers late). */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * Orchestrates cross-device sync:
 *  - fingerprint-based change detection on window focus
 *  - periodic polling (60 s) as a fallback when the window stays focused
 *  - exponential-backoff retry on first activation (Settings Sync may deliver late)
 *  - exponential-backoff retry after a master-password key rotation
 *  - OutputChannel logging for every sync event
 *  - status-bar indicator and user-facing result notifications
 */
export class SyncService implements vscode.Disposable {
    private _fingerprint = '';
    private _lastSyncResult: SyncLoadResult | null = null;
    private _syncing = false;
    private _pollTimer: ReturnType<typeof setInterval> | undefined;
    private _retryTimer: ReturnType<typeof setTimeout> | undefined;
    private _retryAttempt = 0;
    /** Debounce timer for push-triggering VS Code Settings Sync after local mutations. */
    private _pushDebounceTimer: ReturnType<typeof setTimeout> | undefined;
    private _statusBar: vscode.StatusBarItem;

    private readonly _disposables: vscode.Disposable[] = [];
    private readonly _onDidSyncComplete = new vscode.EventEmitter<SyncLoadResult | undefined>();
    /** Fired after every sync attempt (result is undefined when no data changed or sync was skipped). */
    readonly onDidSyncComplete = this._onDidSyncComplete.event;
    private _debugEnabled = false;

    constructor(
        private readonly _connectionManager: ConnectionManager,
        private readonly _encryptionService: EncryptionService,
        private readonly _outputChannel: vscode.OutputChannel
    ) {
        this._statusBar = vscode.window.createStatusBarItem(
            'remoteBridge.syncStatus',
            vscode.StatusBarAlignment.Left,
            -1              // just to the right of the main plug icon
        );
        this._statusBar.name = vscode.l10n.t('Remote Bridge Sync');
        this._statusBar.tooltip = vscode.l10n.t('Remote Bridge: Sync status');
        this._disposables.push(this._statusBar);

        // Keep the status-bar fingerprint current so our own writes never look
        // like foreign changes.  After local mutations, debounce-push to VS Code
        // Settings Sync so the other device receives changes promptly.
        this._disposables.push(
            this._connectionManager.onDidChange(() => {
                this._fingerprint = this._currentFingerprint();
                if (!this._syncing && this._shouldSync()) {
                    this._log('Local state changed — pushing to VS Code Settings Sync');
                    // Debounce: wait 2 s to coalesce rapid mutations (e.g. bulk delete)
                    // before triggering VS Code sync.
                    if (this._pushDebounceTimer !== undefined) {
                        clearTimeout(this._pushDebounceTimer);
                    }
                    this._pushDebounceTimer = setTimeout(() => {
                        this._pushDebounceTimer = undefined;
                        this._triggerVsCodeSync();
                    }, 2_000);
                }
            })
        );
    }

    // ─── Public API ────────────────────────────────────────────

    get isSyncing(): boolean { return this._syncing; }
    get lastSyncResult(): SyncLoadResult | null { return this._lastSyncResult; }

    /** Start periodic polling and the window-focus change listener. */
    startPeriodicSync(): void {
        this._stopTimers();

        // Window-focus listener: re-read globalState (VS Code has no change event for it).
        this._disposables.push(
            vscode.window.onDidChangeWindowState(async (state) => {
                if (!state.focused) { return; }
                if (!this._shouldSync()) { return; }
                await this._checkAndSync('focus');
            })
        );

        // Periodic poll every 60 s (in case the window stays focused indefinitely).
        this._pollTimer = setInterval(async () => {
            if (!this._shouldSync()) { return; }
            await this._checkAndSync('poll');
        }, POLL_INTERVAL_MS);
    }

    stopPeriodicSync(): void {
        this._stopTimers();
    }

    /**
     * Schedule exponential-backoff retries.
     * Used after activation (Settings Sync may deliver data with a delay)
     * or after a successful key-rotation unlock.
     */
    scheduleRetry(): void {
        this._cancelRetry();
        this._retryAttempt = 0;
        this._scheduleNextRetry();
    }

    /** Cancel any pending retry. */
    cancelRetry(): void {
        this._cancelRetry();
    }

    /** Manual sync triggered by the user: first pulls from VS Code Settings Sync, then merges. */
    async syncNow(): Promise<SyncLoadResult | undefined> {
        if (!this._encryptionService.isEnabled()) {
            vscode.window.showWarningMessage(
                vscode.l10n.t('Remote Bridge: Connection sync requires a master password. Please enable master password encryption first.')
            );
            return undefined;
        }
        if (!this._encryptionService.isUnlocked()) {
            return undefined; // caller is expected to unlock first
        }
        this._log('Manual sync triggered');
        await this._triggerVsCodeSync();
        return this._runSync('manual');
    }

    dispose(): void {
        if (this._pushDebounceTimer !== undefined) {
            clearTimeout(this._pushDebounceTimer);
            this._pushDebounceTimer = undefined;
        }
        this._stopTimers();
        this._cancelRetry();
        for (const d of this._disposables) { d.dispose(); }
        this._onDidSyncComplete.dispose();
    }

    // ─── Internal helpers ───────────────────────────────────────

    private _shouldSync(): boolean {
        if (!this._encryptionService.isEnabled()) { return false; }
        if (!this._encryptionService.isUnlocked()) { return false; }
        const secCfg = vscode.workspace.getConfiguration('remoteBridge.security');
        return !!secCfg.get<boolean>('syncConnections');
    }

    private _currentFingerprint(): string {
        const blob = this._encryptionService.getEncryptedBlob();
        return blob ? `${blob.length}:${blob.substring(0, 64)}` : '';
    }

    /** Check whether the encrypted blob changed since last time, and sync if so. */
    private async _checkAndSync(trigger: string): Promise<void> {
        // Pull latest data from VS Code Settings Sync first, so that globalState
        // reflects what other devices have written before we compare fingerprints.
        await this._triggerVsCodeSync();
        const fp = this._currentFingerprint();
        if (fp === this._fingerprint) { return; }
        this._log(`Change detected (${trigger}) — fingerprint changed`);
        this._fingerprint = fp;
        await this._runSync(trigger);
    }

    /**
     * Run a full sync cycle: load (merge) → save (push merged state to Settings Sync).
     * Emits onDidSyncComplete and updates the status bar.
     */
    private async _runSync(trigger: string): Promise<SyncLoadResult | undefined> {
        if (this._syncing) {
            this._log(`Sync already in progress (trigger: ${trigger}) — skipping`);
            return undefined;
        }
        this._syncing = true;
        this._showSpinner();
        this._log(`Sync started (trigger: ${trigger})`);

        let result: SyncLoadResult | undefined;
        try {
            result = await this._connectionManager.load();

            // Only write back the merged state when load() produced actual data changes
            // (new / updated / removed items).  Unconditionally saving every sync cycle
            // re-writes ENCRYPTED_STORE_KEY with a fresh timestamp and causes VS Code
            // Settings Sync to treat this device as the most-recent writer — silently
            // overwriting deletions or other changes that have not yet been delivered
            // from the other device.
            //
            // Exceptions:
            //  source='local'  — remote was unavailable; push local data to the sync key.
            //  source='remote' — encryption was disabled on this device; ensure the local
            //                    shadow is written.
            const changeCount = result !== undefined
                ? (result.connectionsAdded + result.connectionsUpdated +
                   result.connectionsRemoved + result.foldersAdded + result.foldersRemoved)
                : 0;
            if (changeCount > 0 || result?.source === 'local' || result?.source === 'remote') {
                await this._connectionManager.save();
            }

            this._lastSyncResult = result ?? null;
            this._fingerprint = this._currentFingerprint();

            const summary = this._formatResult(result);
            this._log(`Sync complete — ${summary}`);
            this._showSuccess();
            this._notifySuccess(result, trigger);
            // Note: retry cancellation is managed by the retry scheduler, not here.
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this._log(`Sync error: ${msg}`);
            this._showError();
            vscode.window.showWarningMessage(
                vscode.l10n.t('Remote Bridge: Sync failed — {0}', msg),
                vscode.l10n.t('Show Log')
            ).then(choice => {
                if (choice) { this._outputChannel.show(true); }
            });
        } finally {
            this._syncing = false;
        }

        this._onDidSyncComplete.fire(result);
        return result;
    }

    // ─── Retry logic ────────────────────────────────────────────

    private _scheduleNextRetry(): void {
        if (this._retryAttempt >= RETRY_DELAYS_MS.length) {
            this._log('Retry limit reached — giving up');
            return;
        }
        const delay = RETRY_DELAYS_MS[this._retryAttempt];
        this._log(`Scheduling retry ${this._retryAttempt + 1}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s`);
        this._retryTimer = setTimeout(async () => {
            if (!this._shouldSync()) {
                this._log('Retry skipped — sync no longer enabled');
                return;
            }
            this._retryAttempt++;
            this._log(`Retry ${this._retryAttempt}/${RETRY_DELAYS_MS.length} starting`);
            await this._triggerVsCodeSync();
            const result = await this._runSync('retry');
            // Stop retrying if:
            //  - sync returned a non-fresh source (data exists on at least one side — nothing left to wait for)
            //  - or we've exhausted all attempts regardless
            const dataPresentOrExhausted =
                (result !== undefined && result.source !== 'fresh') ||
                this._retryAttempt >= RETRY_DELAYS_MS.length;
            if (dataPresentOrExhausted) {
                this._log('Retry complete — data present or attempt limit reached');
                this._cancelRetry();
            } else {
                this._scheduleNextRetry();
            }
        }, delay);
    }

    private _cancelRetry(): void {
        if (this._retryTimer !== undefined) {
            clearTimeout(this._retryTimer);
            this._retryTimer = undefined;
        }
        // Note: _retryAttempt is intentionally NOT reset here so that an in-progress
        // retry chain keeps its position. It is reset only in scheduleRetry() when a
        // fresh sequence is started.
    }

    /**
     * Trigger VS Code Settings Sync immediately.  This pushes local globalState
     * changes to the cloud and pulls the latest version from other devices.
     * Silently ignored when Settings Sync is not active or configured.
     */
    private async _triggerVsCodeSync(): Promise<void> {
        try {
            await vscode.commands.executeCommand('workbench.userDataSync.actions.syncNow');
        } catch {
            // Settings Sync is not active or the command is unavailable — ignore.
        }
    }

    private _stopTimers(): void {
        if (this._pollTimer !== undefined) {
            clearInterval(this._pollTimer);
            this._pollTimer = undefined;
        }
        this._cancelRetry();
    }

    // ─── Status bar ──────────────────────────────────────────────

    private _showSpinner(): void {
        this._statusBar.text = '$(sync~spin)';
        this._statusBar.tooltip = vscode.l10n.t('Remote Bridge: Syncing…');
        this._statusBar.show();
    }

    private _showSuccess(): void {
        this._statusBar.text = '$(check)';
        this._statusBar.tooltip = vscode.l10n.t('Remote Bridge: Sync complete');
        this._statusBar.show();
        setTimeout(() => { this._statusBar.hide(); }, SYNC_STATUS_HIDE_DELAY_MS);
    }

    private _showError(): void {
        this._statusBar.text = '$(warning)';
        this._statusBar.tooltip = vscode.l10n.t('Remote Bridge: Sync failed — click Show Log for details');
        this._statusBar.show();
    }

    // ─── Notifications ───────────────────────────────────────────

    private _notifySuccess(result: SyncLoadResult | undefined, trigger: string): void {
        if (!result) { return; }
        const { connectionsAdded, connectionsUpdated, connectionsRemoved, foldersAdded, foldersRemoved, source } = result;
        const total = connectionsAdded + connectionsUpdated + connectionsRemoved + foldersAdded + foldersRemoved;
        if (total === 0) { return; } // nothing changed — no popup needed

        const parts: string[] = [];
        if (connectionsAdded > 0) {
            parts.push(vscode.l10n.t('+{0} connection(s)', String(connectionsAdded)));
        }
        if (connectionsUpdated > 0) {
            parts.push(vscode.l10n.t('{0} updated', String(connectionsUpdated)));
        }
        if (connectionsRemoved > 0) {
            parts.push(vscode.l10n.t('-{0} removed', String(connectionsRemoved)));
        }
        if (foldersAdded > 0) {
            parts.push(vscode.l10n.t('+{0} folder(s)', String(foldersAdded)));
        }
        if (foldersRemoved > 0) {
            parts.push(vscode.l10n.t('-{0} folder(s) removed', String(foldersRemoved)));
        }

        const summary = parts.join(', ');
        const isFirstSync = trigger === 'retry' && connectionsAdded > 0 && connectionsUpdated === 0;
        if (isFirstSync) {
            vscode.window.showInformationMessage(
                vscode.l10n.t('Remote Bridge: {0} connection(s) loaded from another device.', String(connectionsAdded))
            );
        } else if (source === 'merge' || source === 'remote') {
            vscode.window.showInformationMessage(
                vscode.l10n.t('Remote Bridge: Synced — {0}', summary)
            );
        }
    }

    // ─── Logging ────────────────────────────────────────────────

    setDebug(enabled: boolean): void {
        this._debugEnabled = enabled;
    }

    private _log(message: string): void {
        if (!this._debugEnabled) { return; }
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
        this._outputChannel.appendLine(`[${ts}] [Sync] ${message}`);
    }

    private _formatResult(result: SyncLoadResult | undefined): string {
        if (!result) { return 'no data changes'; }
        return (
            `source=${result.source}` +
            ` +${result.connectionsAdded}conn` +
            ` ~${result.connectionsUpdated}conn` +
            ` -${result.connectionsRemoved}conn` +
            ` +${result.foldersAdded}folder` +
            ` -${result.foldersRemoved}folder`
        );
    }
}
