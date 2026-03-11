import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionPool } from '../services/connectionPool';
import { EncryptionService } from '../services/encryptionService';
import { ConnectionStatus } from '../types/connection';
import { openSshTerminal } from '../terminal/sshTerminalProvider';

/**
 * Provides a simple status bar item (left, lowest priority) showing
 * a plug icon and live transfer speeds (↓/↑). Clicking it opens a
 * QuickPick with all configured connections and their current state.
 *
 * When master password encryption is enabled, a second status bar item
 * (lock icon) is shown to the right of the main item. It indicates the
 * locked/unlocked state and can be clicked to lock or unlock.
 */
export class StatusBarService implements vscode.Disposable {
    private readonly _item: vscode.StatusBarItem;
    private readonly _lockItem: vscode.StatusBarItem;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _connectionManager: ConnectionManager,
        private readonly _connectionPool: ConnectionPool,
        private readonly _encryptionService: EncryptionService,
        context: vscode.ExtensionContext
    ) {
        // Create status bar item — left side, priority 0 (far left)
        this._item = vscode.window.createStatusBarItem(
            'remoteBridge.status',
            vscode.StatusBarAlignment.Left,
            0
        );
        this._item.name = 'Remote Bridge';
        this._item.tooltip = vscode.l10n.t('Show remote connections');
        this._item.command = 'remoteBridge.showConnections';

        // Create lock status bar item — shown only when master password is enabled
        this._lockItem = vscode.window.createStatusBarItem(
            'remoteBridge.lockStatus',
            vscode.StatusBarAlignment.Left,
            -1
        );
        this._lockItem.name = 'Remote Bridge — Master Password';

        // Set initial text based on current connection state
        this._updateText();

        // Only show the status bar when there are connections
        this._updateVisibility();
        this._updateLockItem();

        // Listen for connection changes to toggle visibility and update text
        this._disposables.push(
            this._connectionManager.onDidChange(() => {
                this._updateVisibility();
                this._updateText();
            })
        );

        // Listen for connection status changes to update server name display
        this._disposables.push(
            this._connectionPool.onDidChangeStatus(() => this._updateText())
        );

        // Update lock item on encryption state changes
        this._disposables.push(
            this._encryptionService.onDidLock(() => this._updateLockItem()),
            this._encryptionService.onDidUnlock(() => this._updateLockItem())
        );

        // Register the QuickPick command
        this._disposables.push(
            vscode.commands.registerCommand(
                'remoteBridge.showConnections',
                () => this._showConnectionQuickPick()
            )
        );

        context.subscriptions.push(this._item, this._lockItem);
    }

    /** Show the status bar only when at least one connection is configured. */
    private _updateVisibility(): void {
        if (this._connectionManager.getConnections().length > 0) {
            this._item.show();
        } else {
            this._item.hide();
        }
    }

    /** Update the lock status bar item to reflect the current encryption state. */
    private _updateLockItem(): void {
        if (!this._encryptionService.isEnabled()) {
            this._lockItem.hide();
            return;
        }
        if (this._encryptionService.isUnlocked()) {
            this._lockItem.text = '$(unlock)';
            this._lockItem.tooltip = vscode.l10n.t('Connections unlocked — click to lock');
            this._lockItem.command = 'remoteBridge.lockMasterPassword';
            this._lockItem.backgroundColor = undefined;
        } else {
            this._lockItem.text = '$(lock)';
            this._lockItem.tooltip = vscode.l10n.t('Connections locked — click to unlock');
            this._lockItem.command = 'remoteBridge.unlockMasterPassword';
            this._lockItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        this._lockItem.show();
    }

    /** Update the status bar text to show currently connected server names. */
    private _updateText(): void {
        const sessions = this._connectionPool.getActiveSessions();
        if (sessions.length === 0) {
            this._item.text = '$(plug) Remote Bridge';
            this._item.tooltip = vscode.l10n.t('Show remote connections');
        } else {
            const names = sessions.map(s => s.config.name).join(', ');
            this._item.text = `$(plug) ${names}`;
            this._item.tooltip = vscode.l10n.t('Connected: {0}', names);
        }
    }

    private async _showConnectionQuickPick(): Promise<void> {
        const connections = this._connectionManager.getConnections();

        if (connections.length === 0) {
            const action = await vscode.window.showInformationMessage(
                vscode.l10n.t('No connections configured.'),
                vscode.l10n.t('Add Connection')
            );
            if (action) {
                await vscode.commands.executeCommand('remoteBridge.addConnection');
            }
            return;
        }

        // Build QuickPick items
        interface ConnectionQuickPickItem extends vscode.QuickPickItem {
            connectionId: string;
        }

        const items: ConnectionQuickPickItem[] = connections.map(conn => {
            const status = this._connectionPool.getStatus(conn.id);
            let icon: string;
            let statusLabel: string;
            switch (status) {
                case ConnectionStatus.Connected:
                    icon = '$(circle-filled)';
                    statusLabel = vscode.l10n.t('Connected');
                    break;
                case ConnectionStatus.Connecting:
                    icon = '$(sync~spin)';
                    statusLabel = vscode.l10n.t('Connecting');
                    break;
                case ConnectionStatus.Error:
                    icon = '$(error)';
                    statusLabel = vscode.l10n.t('Error');
                    break;
                default:
                    icon = '$(circle-outline)';
                    statusLabel = vscode.l10n.t('Disconnected');
                    break;
            }

            return {
                label: `${icon} ${conn.name}`,
                description: `${conn.protocol}://${conn.host}:${conn.port}`,
                detail: `${statusLabel} — ${conn.remotePath}`,
                connectionId: conn.id,
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            title: vscode.l10n.t('Remote Bridge — Connections'),
            placeHolder: vscode.l10n.t('Select a connection'),
        });

        if (!selected) {
            return;
        }

        const conn = connections.find(c => c.id === selected.connectionId);
        if (!conn) {
            return;
        }

        // Show actions for the selected connection
        const isConnected = this._connectionPool.isConnected(conn.id);
        const isSsh = conn.protocol === 'ssh' || conn.protocol === 'sftp';

        interface ActionItem extends vscode.QuickPickItem {
            action: string;
        }

        const actions: ActionItem[] = [];

        if (isConnected) {
            actions.push({
                label: `$(debug-disconnect) ${vscode.l10n.t('Disconnect')}`,
                action: 'disconnect',
            });
            actions.push({
                label: `$(folder-opened) ${vscode.l10n.t('Open Workspace')}`,
                action: 'openWorkspace',
            });
        } else {
            actions.push({
                label: `$(plug) ${vscode.l10n.t('Connect')}`,
                action: 'connect',
            });
        }

        if (isSsh) {
            actions.push({
                label: `$(terminal) ${vscode.l10n.t('Open SSH Terminal')}`,
                action: 'terminal',
            });
        }

        const actionSelected = await vscode.window.showQuickPick(actions, {
            title: `${conn.name} — ${conn.host}`,
            placeHolder: vscode.l10n.t('Select an action'),
        });

        if (!actionSelected) {
            return;
        }

        const node = { type: 'connection', connection: conn };

        switch (actionSelected.action) {
            case 'connect':
                await vscode.commands.executeCommand('remoteBridge.connect', node);
                break;
            case 'disconnect':
                await vscode.commands.executeCommand('remoteBridge.disconnect', node);
                break;
            case 'openWorkspace':
                await vscode.commands.executeCommand('remoteBridge.connect', node);
                break;
            case 'terminal':
                openSshTerminal(conn, this._connectionPool);
                break;
        }
    }

    dispose(): void {
        this._item.dispose();
        this._lockItem.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
