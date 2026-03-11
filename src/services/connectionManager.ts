import * as vscode from 'vscode';
import {
    ConnectionConfig,
    ConnectionFolder,
    ConnectionSecrets,
    ConnectionStore,
    Tombstone,
    CONNECTION_STORE_VERSION,
    secretKeyForPassword,
    secretKeyForPassphrase,
    secretKeyForProxyPassword,
} from '../types/connection';
import { EncryptionService } from './encryptionService';
import { BackupService } from './backupService';
import { generateId } from '../utils/uriParser';

/** Tombstones older than this are pruned on every save. */
const TOMBSTONE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

/**
 * Result returned by load() when data from another device was applied.
 * Describes what changed relative to the previous in-memory state.
 */
export interface SyncLoadResult {
    connectionsAdded: number;
    connectionsUpdated: number;
    connectionsRemoved: number;
    foldersAdded: number;
    foldersRemoved: number;
    source: 'remote' | 'local' | 'merge' | 'fresh' | 'none';
}

/**
 * Manages CRUD operations on connections and folders.
 * Handles persistence via EncryptionService (which handles globalState + optional encryption).
 * Secrets (passwords, passphrases) are stored separately in VS Code SecretStorage.
 */
export class ConnectionManager implements vscode.Disposable {
    private _store: ConnectionStore | null = null;
    private _loaded = false;
    /** Cached local-shadow data kept across lock/unlock cycles after a remote password change. */
    private _pendingLocalStore: ConnectionStore | null = null;
    /** Monotonic counter incremented on every synchronous in-memory mutation so that a
     *  concurrent load() can detect it was pre-empted and must not overwrite fresh data. */
    private _storeVersion = 0;
    /** Serial queue that prevents concurrent load() / explicit save() calls. */
    private _lockQueue: Promise<void> = Promise.resolve();

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly _encryption: EncryptionService,
        private readonly _secrets: vscode.SecretStorage,
        private readonly _backup?: BackupService
    ) {}

    /**
     * Acquire the serial lock. Prevents concurrent load() and explicit save() calls.
     * Errors in fn propagate to the caller; the lock chain is never broken.
     */
    private _withLock<T>(fn: () => Promise<T>): Promise<T> {
        const task = this._lockQueue.then(fn);
        this._lockQueue = task.then(() => undefined, () => undefined);
        return task;
    }

    // ─── Initialization ────────────────────────────────────────

    /**
     * Load the connection store from persistence.
     * Must be called after master password unlock (if applicable).
     *
     * Load order is critical: the local shadow must be read BEFORE `loadStore()`
     * because `loadStore()` may detect a remote master-password change, call
     * `lock()` (which zeroes the derived key), and return null — leaving the
     * local shadow unreadable.  Reading the shadow first preserves it so the
     * merge can still happen after the user re-enters the new password.
     */
    async load(): Promise<SyncLoadResult | undefined> {
        return this._withLock(async (): Promise<SyncLoadResult | undefined> => {
            // Snapshot pre-load state for diff calculation and concurrent-mutation safety guard.
            const prevVersion = this._storeVersion;
            const prevConnIds = new Set(this._store?.connections.map(c => c.id) ?? []);
            const prevConnUpdatedAt = new Map(this._store?.connections.map(c => [c.id, c.updatedAt ?? 0]) ?? []);
            const prevFolderIds = new Set(this._store?.folders.map(f => f.id) ?? []);

            // 1. Read local shadow BEFORE loadStore() may call lock().
            let localSource = await this._encryption.loadLocalStore();

            // Fallback: pending cache (survives key rotation) or current in-memory
            // store.  This handles the re-unlock case after a remote password change
            // where the shadow was encrypted with the old key.
            if (!localSource) {
                localSource =
                    this._pendingLocalStore ??
                    ((this._store &&
                        (this._store.connections.length > 0 ||
                            this._store.folders.length > 0))
                        ? this._store
                        : null);
            }

            // Cache so the next load() call still has the local data if the shadow
            // key has rotated (i.e. loadLocalStore() returns null again).
            this._pendingLocalStore = localSource;

            // 2. Load the synced / master-password-protected store.
            //    May internally call lock() on remote-password-change detection.
            const remote = await this._encryption.loadStore();

            // 3. Determine the candidate store to apply.
            let candidate: ConnectionStore | null = null;
            let shouldRestoreSecrets = false;
            let forceOverwriteSecrets = false;
            let source: SyncLoadResult['source'] = 'none';

            if (remote && localSource && this._isSyncEnabled()) {
                try {
                    candidate = this._mergeStores(localSource, remote);
                    shouldRestoreSecrets = true;
                    forceOverwriteSecrets = true;
                    source = 'merge';
                } catch {
                    // Merge threw unexpectedly — keep existing in-memory data.
                    this._pendingLocalStore = null;
                    this._loaded = true;
                    this._onDidChange.fire();
                    return undefined;
                }
            } else if (remote) {
                candidate = remote;
                shouldRestoreSecrets = true;
                source = 'remote';
            } else if (localSource) {
                // Synced store unavailable — fall back to local shadow.
                candidate = localSource;
                source = 'local';
            } else if (!this._store || (this._store.connections.length === 0 && this._store.folders.length === 0)) {
                // No data anywhere — start fresh.
                candidate = { version: CONNECTION_STORE_VERSION, folders: [], connections: [] };
                source = 'fresh';
            }
            // else: candidate = null → keep existing in-memory data

            // Safety guard: abort if a concurrent mutation modified _store since we started.
            // The mutation already saved its state; applying our stale candidate would cause data loss.
            if (candidate !== null && this._storeVersion !== prevVersion) {
                this._pendingLocalStore = null;
                this._loaded = true;
                this._onDidChange.fire();
                return undefined;
            }

            // Safety guard: don't silently replace a non-empty store with an empty candidate
            // (guards against corrupt or incomplete sync data arriving before the real payload).
            const prevHasData = prevConnIds.size > 0 || prevFolderIds.size > 0;
            if (candidate !== null && prevHasData &&
                candidate.connections.length === 0 && candidate.folders.length === 0) {
                this._pendingLocalStore = null;
                this._loaded = true;
                this._onDidChange.fire();
                return undefined;
            }

            if (candidate !== null) {
                this._store = candidate;
                if (shouldRestoreSecrets) {
                    await this._restoreSecretsFromStore(forceOverwriteSecrets);
                }
            }
            // else: keep existing in-memory data (load failed but we have something)

            this._pendingLocalStore = null;
            this._loaded = true;
            this._onDidChange.fire();

            if (candidate === null || source === 'none' || source === 'fresh') {
                return undefined;
            }

            // Compute diff relative to the pre-load snapshot.
            const newConnIds = new Set(this._store!.connections.map(c => c.id));
            const connectionsAdded    = [...newConnIds].filter(id => !prevConnIds.has(id)).length;
            const connectionsRemoved  = [...prevConnIds].filter(id => !newConnIds.has(id)).length;
            const connectionsUpdated  = [...newConnIds].filter(id =>
                prevConnIds.has(id) &&
                (this._store!.connections.find(c => c.id === id)?.updatedAt ?? 0) > (prevConnUpdatedAt.get(id) ?? 0)
            ).length;
            const newFolderIds = new Set(this._store!.folders.map(f => f.id));
            const foldersAdded   = [...newFolderIds].filter(id => !prevFolderIds.has(id)).length;
            const foldersRemoved = [...prevFolderIds].filter(id => !newFolderIds.has(id)).length;

            return { connectionsAdded, connectionsUpdated, connectionsRemoved, foldersAdded, foldersRemoved, source };
        });
    }

    /**
     * Save the current store state to persistence.
     * Public: serialised through the lock so explicit callers (e.g. SyncService)
     * never run concurrently with an in-progress load().
     */
    async save(): Promise<void> {
        return this._withLock(() => this._saveCore());
    }

    /**
     * Internal (unlocked) save — called directly by mutation methods that
     * already hold a version-counter guard against concurrent load() interference.
     */
    private async _saveCore(): Promise<void> {
        if (!this._store) {
            return;
        }

        // Prune tombstones older than TOMBSTONE_TTL before persisting.
        if (this._store.tombstones) {
            const cutoff = Date.now() - TOMBSTONE_TTL;
            this._store.tombstones = this._store.tombstones.filter(
                (t) => t.deletedAt >= cutoff
            );
            if (this._store.tombstones.length === 0) {
                delete this._store.tombstones;
            }
        }

        // Bundle secrets into the store whenever master password is active.
        // This covers both cross-device sync and encrypted local backups.
        if (this._encryption.isEnabled() && this._encryption.isUnlocked()) {
            await this._syncSecretsToStore();
        }

        await this._encryption.saveStore(this._store);

        // Remove secrets from the in-memory store after they were persisted encrypted
        if (this._store.secrets) {
            delete this._store.secrets;
        }

        // Create encrypted backup (fire-and-forget; must not block save)
        if (this._backup && this._encryption.isEnabled()) {
            const blob = this._encryption.getEncryptedBlob();
            const meta = this._encryption.getMeta();
            if (blob && meta) {
                this._backup.createBackupIfNeeded(blob, meta).catch(() => {});
            }
        }
    }

    // ─── Sync Helpers ──────────────────────────────────────────

    /**
     * Returns true when both conditions for cross-device sync are met:
     * - The `remoteBridge.security.syncConnections` setting is enabled
     * - Master password encryption is active (so secrets travel encrypted)
     */
    private _isSyncEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('remoteBridge.security');
        return !!config.get<boolean>('syncConnections') && this._encryption.isEnabled();
    }

    /**
     * Merge two stores from potentially different devices into a single
     * authoritative store.
     *
     * Rules:
     * - Newer `updatedAt` wins; local wins on tie (equal or missing timestamps).
     * - A tombstone beats an edit only if `deletedAt > winner.updatedAt`.
     * - Tombstones are unioned, deduped (keep latest deletedAt) and pruned.
     * - Dangling `folderId` / `parentId` references are cleared to root.
     * - Winner's bundled secrets are forwarded to the result.
     */
    private _mergeStores(
        local: ConnectionStore,
        remote: ConnectionStore
    ): ConnectionStore {
        const cutoff = Date.now() - TOMBSTONE_TTL;

        // ── Tombstones: union, dedup (keep latest deletedAt), prune old ──────
        const tombstoneMap = new Map<string, Tombstone>();
        for (const t of [
            ...(local.tombstones ?? []),
            ...(remote.tombstones ?? []),
        ]) {
            const existing = tombstoneMap.get(t.id);
            if (!existing || t.deletedAt > existing.deletedAt) {
                tombstoneMap.set(t.id, t);
            }
        }
        const tombstones = [...tombstoneMap.values()].filter(
            (t) => t.deletedAt >= cutoff
        );

        // ── Connections ───────────────────────────────────────────────────────
        const localConnMap = new Map(local.connections.map((c) => [c.id, c]));
        const remoteConnMap = new Map(remote.connections.map((c) => [c.id, c]));
        const allConnIds = new Set([...localConnMap.keys(), ...remoteConnMap.keys()]);

        const mergedConnections: ConnectionConfig[] = [];
        const survivingConnIds = new Set<string>();
        // Track winner source to select the right bundled secrets later.
        const winnerIsLocalMap = new Map<string, boolean>();

        for (const id of allConnIds) {
            const tombstone = tombstoneMap.get(id);
            const lc = localConnMap.get(id);
            const rc = remoteConnMap.get(id);

            let winner: ConnectionConfig;
            let isLocal: boolean;

            if (lc && rc) {
                // Local wins on tie (>= means equal timestamps → local).
                isLocal = (lc.updatedAt ?? 0) >= (rc.updatedAt ?? 0);
                winner = isLocal ? lc : rc;
            } else if (lc) {
                winner = lc;
                isLocal = true;
            } else {
                winner = rc!;
                isLocal = false;
            }

            // Tombstone overrides only if deletion happened AFTER the last edit.
            if (tombstone && tombstone.deletedAt > (winner.updatedAt ?? 0)) {
                continue;
            }

            mergedConnections.push({ ...winner });
            survivingConnIds.add(id);
            winnerIsLocalMap.set(id, isLocal);
        }

        // ── Folders ───────────────────────────────────────────────────────────
        const localFolderMap = new Map(local.folders.map((f) => [f.id, f]));
        const remoteFolderMap = new Map(remote.folders.map((f) => [f.id, f]));
        const allFolderIds = new Set([
            ...localFolderMap.keys(),
            ...remoteFolderMap.keys(),
        ]);

        const mergedFolders: ConnectionFolder[] = [];
        const survivingFolderIds = new Set<string>();

        for (const id of allFolderIds) {
            const tombstone = tombstoneMap.get(id);
            const lf = localFolderMap.get(id);
            const rf = remoteFolderMap.get(id);

            let winner: ConnectionFolder;
            if (lf && rf) {
                winner =
                    (lf.updatedAt ?? 0) >= (rf.updatedAt ?? 0) ? lf : rf;
            } else {
                winner = (lf ?? rf)!;
            }

            if (tombstone && tombstone.deletedAt > (winner.updatedAt ?? 0)) {
                continue;
            }

            mergedFolders.push({ ...winner });
            survivingFolderIds.add(id);
        }

        // ── Fix dangling references ───────────────────────────────────────────
        for (const conn of mergedConnections) {
            if (conn.folderId && !survivingFolderIds.has(conn.folderId)) {
                conn.folderId = undefined;
            }
        }
        for (const folder of mergedFolders) {
            if (folder.parentId && !survivingFolderIds.has(folder.parentId)) {
                folder.parentId = undefined;
            }
        }

        // ── Secrets: use the winner connection's source secrets ───────────────
        const mergedSecrets: Record<string, ConnectionSecrets> = {};
        for (const [id, isLocal] of winnerIsLocalMap) {
            if (!survivingConnIds.has(id)) {
                continue;
            }
            const sourceSecrets = isLocal ? local.secrets : remote.secrets;
            if (sourceSecrets?.[id]) {
                mergedSecrets[id] = sourceSecrets[id];
            }
        }

        return {
            version: CONNECTION_STORE_VERSION,
            folders: mergedFolders,
            connections: mergedConnections,
            tombstones: tombstones.length > 0 ? tombstones : undefined,
            secrets:
                Object.keys(mergedSecrets).length > 0
                    ? mergedSecrets
                    : undefined,
        };
    }

    /**
     * Reads secrets from SecretStorage and writes them into the in-memory store
     * so that they are included when the encrypted store is persisted.
     * Called from save() whenever master password encryption is active.
     */
    private async _syncSecretsToStore(): Promise<void> {
        if (!this._store) {
            return;
        }
        const secrets: Record<string, ConnectionSecrets> = {};
        for (const conn of this._store.connections) {
            const entry: ConnectionSecrets = {};
            const pw = await this._secrets.get(secretKeyForPassword(conn.id));
            const pp = await this._secrets.get(secretKeyForPassphrase(conn.id));
            const proxy = await this._secrets.get(secretKeyForProxyPassword(conn.id));
            if (pw) { entry.password = pw; }
            if (pp) { entry.passphrase = pp; }
            if (proxy) { entry.proxyPassword = proxy; }
            if (Object.keys(entry).length > 0) {
                secrets[conn.id] = entry;
            }
        }
        this._store.secrets = Object.keys(secrets).length > 0 ? secrets : undefined;
    }

    /**
     * Reads secrets bundled in the store (populated on another device during sync
     * or restored from a backup) and writes them into local SecretStorage.
     * Called from load() after the store has been decrypted.
     *
     * @param forceOverwrite  When true, existing SecretStorage values are overwritten
     *                        (used after backup restore where the backup is authoritative).
     */
    private async _restoreSecretsFromStore(
        forceOverwrite = false
    ): Promise<void> {
        if (!this._store?.secrets) {
            return;
        }
        for (const [id, entry] of Object.entries(this._store.secrets)) {
            if (entry.password) {
                if (forceOverwrite || !(await this._secrets.get(secretKeyForPassword(id)))) {
                    await this._secrets.store(secretKeyForPassword(id), entry.password);
                }
            }
            if (entry.passphrase) {
                if (forceOverwrite || !(await this._secrets.get(secretKeyForPassphrase(id)))) {
                    await this._secrets.store(secretKeyForPassphrase(id), entry.passphrase);
                }
            }
            if (entry.proxyPassword) {
                if (forceOverwrite || !(await this._secrets.get(secretKeyForProxyPassword(id)))) {
                    await this._secrets.store(secretKeyForProxyPassword(id), entry.proxyPassword);
                }
            }
        }
        // Remove secrets from the in-memory store — they live in SecretStorage locally
        delete this._store.secrets;
    }

    // ─── Connections ───────────────────────────────────────────

    getConnections(): ConnectionConfig[] {
        return this._requireStore().connections;
    }

    getConnection(id: string): ConnectionConfig | undefined {
        return this._requireStore().connections.find((c) => c.id === id);
    }

    /**
     * Find a connection by name (case-insensitive).
     */
    findConnectionByName(name: string): ConnectionConfig | undefined {
        const lower = name.toLowerCase();
        return this._requireStore().connections.find(
            (c) => c.name.toLowerCase() === lower
        );
    }

    /**
     * Fuzzy-find a connection when exact name match fails.
     * Tries: (1) host substring match, (2) partial name match.
     * Returns the first match, or undefined if nothing fits.
     */
    findConnectionFuzzy(input: string): ConnectionConfig | undefined {
        const lower = input.toLowerCase();
        const connections = this._requireStore().connections;
        // Host match: input contains the host or host contains input
        const byHost = connections.find(
            (c) => lower.includes(c.host.toLowerCase()) || c.host.toLowerCase().includes(lower)
        );
        if (byHost) { return byHost; }
        // Partial name match: input is a substring of name or vice-versa
        return connections.find(
            (c) =>
                c.name.toLowerCase().includes(lower) ||
                lower.includes(c.name.toLowerCase())
        );
    }

    async addConnection(
        config: Omit<ConnectionConfig, 'id' | 'sortOrder'>,
        password?: string,
        passphrase?: string,
        proxyPassword?: string
    ): Promise<ConnectionConfig> {
        const store = this._requireStore();

        // Ensure connection name is unique
        const nameLower = config.name.trim().toLowerCase();
        if (store.connections.some(c => c.name.toLowerCase() === nameLower)) {
            throw new Error(vscode.l10n.t('A connection named "{0}" already exists', config.name));
        }

        this._storeVersion++;
        const id = generateId();
        const sortOrder = store.connections.filter(
            (c) => c.folderId === config.folderId
        ).length;

        const connection: ConnectionConfig = {
            ...config,
            id,
            sortOrder,
            updatedAt: Date.now(),
        };

        store.connections.push(connection);

        // Store secrets
        if (password) {
            await this._secrets.store(secretKeyForPassword(id), password);
        }
        if (passphrase) {
            await this._secrets.store(secretKeyForPassphrase(id), passphrase);
        }
        if (proxyPassword) {
            await this._secrets.store(secretKeyForProxyPassword(id), proxyPassword);
        }

        await this._saveCore();
        this._onDidChange.fire();
        return connection;
    }

    async updateConnection(
        id: string,
        updates: Partial<Omit<ConnectionConfig, 'id'>>,
        password?: string,
        passphrase?: string,
        proxyPassword?: string
    ): Promise<void> {
        const store = this._requireStore();
        const index = store.connections.findIndex((c) => c.id === id);
        if (index === -1) {
            throw new Error(vscode.l10n.t('Connection not found'));
        }

        this._storeVersion++;
        store.connections[index] = { ...store.connections[index], ...updates, updatedAt: Date.now() };

        if (password !== undefined) {
            if (password) {
                await this._secrets.store(secretKeyForPassword(id), password);
            } else {
                await this._secrets.delete(secretKeyForPassword(id));
            }
        }
        if (passphrase !== undefined) {
            if (passphrase) {
                await this._secrets.store(secretKeyForPassphrase(id), passphrase);
            } else {
                await this._secrets.delete(secretKeyForPassphrase(id));
            }
        }
        if (proxyPassword !== undefined) {
            if (proxyPassword) {
                await this._secrets.store(secretKeyForProxyPassword(id), proxyPassword);
            } else {
                await this._secrets.delete(secretKeyForProxyPassword(id));
            }
        }

        await this._saveCore();
        this._onDidChange.fire();
    }

    async deleteConnection(id: string): Promise<void> {
        const store = this._requireStore();
        this._storeVersion++;
        store.connections = store.connections.filter((c) => c.id !== id);
        store.tombstones = [...(store.tombstones ?? []), { id, deletedAt: Date.now() }];

        // Clean up secrets
        await this._secrets.delete(secretKeyForPassword(id));
        await this._secrets.delete(secretKeyForPassphrase(id));
        await this._secrets.delete(secretKeyForProxyPassword(id));

        await this._saveCore();
        this._onDidChange.fire();
    }

    async deleteConnections(ids: string[]): Promise<void> {
        if (ids.length === 0) {
            return;
        }

        const uniqueIds = [...new Set(ids)];
        const idsSet = new Set(uniqueIds);
        const store = this._requireStore();
        this._storeVersion++;
        store.connections = store.connections.filter((c) => !idsSet.has(c.id));

        const deletedAt = Date.now();
        store.tombstones = [
            ...(store.tombstones ?? []),
            ...uniqueIds.map((id) => ({ id, deletedAt })),
        ];

        for (const id of uniqueIds) {
            await this._secrets.delete(secretKeyForPassword(id));
            await this._secrets.delete(secretKeyForPassphrase(id));
            await this._secrets.delete(secretKeyForProxyPassword(id));
        }

        await this._saveCore();
        this._onDidChange.fire();
    }

    async duplicateConnection(id: string): Promise<ConnectionConfig> {
        const original = this.getConnection(id);
        if (!original) {
            throw new Error(vscode.l10n.t('Connection not found'));
        }

        const { id: _id, sortOrder: _sort, ...rest } = original;
        const password = await this._secrets.get(secretKeyForPassword(id));
        const passphrase = await this._secrets.get(secretKeyForPassphrase(id));
        const proxyPassword = await this._secrets.get(secretKeyForProxyPassword(id));

        return this.addConnection(
            { ...rest, name: vscode.l10n.t('{0} (copy)', original.name) },
            password ?? undefined,
            passphrase ?? undefined,
            proxyPassword ?? undefined
        );
    }

    async moveToFolder(connectionId: string, folderId: string | undefined): Promise<void> {
        await this.updateConnection(connectionId, { folderId });
    }

    async moveMultipleToFolder(connectionIds: string[], folderId: string | undefined): Promise<void> {
        if (connectionIds.length === 0) {
            return;
        }

        const uniqueIds = new Set(connectionIds);
        const store = this._requireStore();
        this._storeVersion++;
        for (const connection of store.connections) {
            if (uniqueIds.has(connection.id)) {
                connection.folderId = folderId;
                connection.updatedAt = Date.now();
            }
        }

        await this._saveCore();
        this._onDidChange.fire();
    }

    // ─── Folders ───────────────────────────────────────────────

    getFolders(): ConnectionFolder[] {
        return this._requireStore().folders;
    }

    getFolder(id: string): ConnectionFolder | undefined {
        return this._requireStore().folders.find((f) => f.id === id);
    }

    async addFolder(name: string, parentId?: string): Promise<ConnectionFolder> {
        const store = this._requireStore();
        this._storeVersion++;
        const sortOrder = store.folders.filter(
            (f) => f.parentId === parentId
        ).length;

        const folder: ConnectionFolder = {
            id: generateId(),
            name,
            parentId,
            sortOrder,
            updatedAt: Date.now(),
        };

        store.folders.push(folder);
        await this._saveCore();
        this._onDidChange.fire();
        return folder;
    }

    async renameFolder(id: string, newName: string): Promise<void> {
        const store = this._requireStore();
        const folder = store.folders.find((f) => f.id === id);
        if (!folder) {
            throw new Error(vscode.l10n.t('Folder not found'));
        }
        this._storeVersion++;
        folder.name = newName;
        folder.updatedAt = Date.now();
        await this._saveCore();
        this._onDidChange.fire();
    }

    async deleteFolder(id: string, moveConnectionsToParent = true): Promise<void> {
        const store = this._requireStore();
        const folder = store.folders.find((f) => f.id === id);
        if (!folder) {
            return;
        }

        this._storeVersion++;
        if (moveConnectionsToParent) {
            // Move connections to parent folder
            for (const conn of store.connections) {
                if (conn.folderId === id) {
                    conn.folderId = folder.parentId;
                }
            }
            // Move subfolders to parent
            for (const sub of store.folders) {
                if (sub.parentId === id) {
                    sub.parentId = folder.parentId;
                }
            }
        } else {
            // Delete connections in this folder
            const connectionsToDelete = store.connections
                .filter((c) => c.folderId === id)
                .map((c) => c.id);
            for (const connId of connectionsToDelete) {
                await this.deleteConnection(connId);
            }
        }

        store.folders = store.folders.filter((f) => f.id !== id);
        // Record the folder deletion so sync can propagate it to other devices.
        store.tombstones = [
            ...(store.tombstones ?? []),
            { id, deletedAt: Date.now() },
        ];
        await this._saveCore();
        this._onDidChange.fire();
    }

    // ─── Bulk Import ───────────────────────────────────────────

    async importConnections(
        connections: Array<Omit<ConnectionConfig, 'id' | 'sortOrder'>>,
        credentials?: {
            passwords?: Map<string, string>;
            proxyPasswords?: Map<string, string>;
        },
        targetFolderId?: string
    ): Promise<{ imported: number; errors: string[] }> {
        let imported = 0;
        const errors: string[] = [];
        for (const config of connections) {
            try {
                // Auto-suffix duplicate names
                let name = config.name;
                const existingNames = new Set(
                    this._requireStore().connections.map(c => c.name.toLowerCase())
                );
                let suffix = 2;
                while (existingNames.has(name.toLowerCase())) {
                    name = `${config.name} (${suffix++})`;
                }
                const connConfig = { ...config, name, folderId: targetFolderId ?? config.folderId };
                const key = `${config.folderId ?? ''}::${config.name}`;
                const password = credentials?.passwords?.get(key) ?? credentials?.passwords?.get(config.name);
                const proxyPassword = credentials?.proxyPasswords?.get(key) ?? credentials?.proxyPasswords?.get(config.name);
                await this.addConnection(connConfig, password, undefined, proxyPassword);
                imported++;
            } catch (err) {
                errors.push(
                    vscode.l10n.t('Failed to import "{0}": {1}', config.name, String(err instanceof Error ? err.message : err))
                );
            }
        }
        return { imported, errors };
    }

    // ─── Private Helpers ───────────────────────────────────────

    async restoreFromBackup(store: ConnectionStore): Promise<void> {
        return this._withLock(async () => {
            this._storeVersion++;
            this._store = store;
            this._loaded = true;
            this._pendingLocalStore = null; // backup is now authoritative; discard any cached shadow
            await this._restoreSecretsFromStore(true); // force overwrite — backup is authoritative
            await this._saveCore();
            this._onDidChange.fire();
        });
    }

    private _requireStore(): ConnectionStore {
        if (!this._loaded || !this._store) {
            throw new Error('Connection store not loaded');
        }
        return this._store;
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
