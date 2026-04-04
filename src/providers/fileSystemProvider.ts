import * as vscode from 'vscode';
import { ConnectionPool } from '../services/connectionPool';
import { ConnectionManager } from '../services/connectionManager';
import { CacheService } from '../services/cacheService';
import { getParentPath, parseRemoteUri } from '../utils/uriParser';
import { ConnectionStatus } from '../types/connection';

/**
 * VS Code FileSystemProvider for the `remote-bridge://` scheme.
 *
 * URI format: remote-bridge://<connectionId>/<remotePath>
 *
 * Delegates all operations to the appropriate RemoteAdapter from the ConnectionPool.
 * Uses CacheService for stat/content/directory caching with TTL.
 */
export class RemoteBridgeFileSystemProvider implements vscode.FileSystemProvider {
    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    private readonly _watchers = new Map<string, { interval: ReturnType<typeof setInterval>; dispose: () => void; refCount: number }>();
    private readonly _pathMutationVersions = new Map<string, number>();
    private _mutationVersion = 0;

    constructor(
        private readonly _pool: ConnectionPool,
        private readonly _connectionManager: ConnectionManager,
        private readonly _cache: CacheService
    ) {}

    // ─── FileSystemProvider Implementation ──────────────────────

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: readonly string[] }): vscode.Disposable {
        // TODO: `options.recursive` is currently ignored — the watcher only
        // polls the immediate directory listing.  Implementing true recursive
        // watching over SSH/FTP is expensive; for now we treat every watch as
        // a single-level poll.
        const key = uri.toString();

        // Ref-count duplicate watchers
        const existing = this._watchers.get(key);
        if (existing) {
            existing.refCount++;
            return new vscode.Disposable(() => {
                existing.refCount--;
                if (existing.refCount <= 0) {
                    existing.dispose();
                }
            });
        }

        const pollInterval = vscode.workspace
            .getConfiguration('remoteBridge.watch')
            .get<number>('pollInterval', 5) * 1000;

        let lastSnapshot = new Map<string, number>();

        const interval = setInterval(async () => {
            try {
                const { connectionId, remotePath } = parseRemoteUri(uri);
                const cacheKey = this._cache.makeKey(connectionId, remotePath);
                const mutationVersionAtStart = this._getMutationVersion(cacheKey);
                if (!this._pool.isConnected(connectionId)) {
                    return;
                }

                const adapter = this._pool.getConnectedAdapter(connectionId);
                if (!adapter) {
                    return;
                }

                const entries = await adapter.readDirectory(remotePath);
                if (this._getMutationVersion(cacheKey) !== mutationVersionAtStart) {
                    return;
                }

                const currentSnapshot = new Map<string, number>();
                const changes: vscode.FileChangeEvent[] = [];

                for (const entry of entries) {
                    const entryUri = vscode.Uri.parse(
                        `remote-bridge://${connectionId}${remotePath === '/' ? '' : remotePath}/${entry.name}`
                    );
                    currentSnapshot.set(entry.name, entry.mtime);

                    const prevMtime = lastSnapshot.get(entry.name);
                    if (prevMtime === undefined) {
                        changes.push({ type: vscode.FileChangeType.Created, uri: entryUri });
                    } else if (prevMtime !== entry.mtime) {
                        changes.push({ type: vscode.FileChangeType.Changed, uri: entryUri });
                    }
                }

                // Check for deleted entries
                for (const [name] of lastSnapshot) {
                    if (!currentSnapshot.has(name)) {
                        const entryUri = vscode.Uri.parse(
                            `remote-bridge://${connectionId}${remotePath === '/' ? '' : remotePath}/${name}`
                        );
                        changes.push({ type: vscode.FileChangeType.Deleted, uri: entryUri });
                    }
                }

                if (changes.length > 0) {
                    // Invalidate stale content/stat cache for changed paths.
                    for (const change of changes) {
                        const parsed = parseRemoteUri(change.uri);
                        this._cache.invalidatePath(parsed.connectionId, parsed.remotePath);
                    }
                }

                this._cacheDirectoryEntries(connectionId, remotePath, cacheKey, entries);
                lastSnapshot = currentSnapshot;

                if (changes.length > 0) {
                    this._onDidChangeFile.fire(changes);
                }
            } catch {
                // Ignore polling errors silently
            }
        }, pollInterval);

        const disposeFn = () => {
            clearInterval(interval);
            this._watchers.delete(key);
        };

        this._watchers.set(key, { interval, dispose: disposeFn, refCount: 1 });

        return new vscode.Disposable(disposeFn);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        const cacheKey = this._cache.makeKey(connectionId, remotePath);

        // Check cache first
        const cached = this._cache.getStat(cacheKey);
        if (cached) {
            return cached;
        }

        const adapter = await this._getAdapter(connectionId);
        const stat = await adapter.stat(remotePath);

        this._cache.setStat(cacheKey, stat);
        return stat;
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        const cacheKey = this._cache.makeKey(connectionId, remotePath);

        // Check cache first
        const cached = this._cache.getDirectory(cacheKey);
        if (cached) {
            return cached as [string, vscode.FileType][];
        }

        const adapter = await this._getAdapter(connectionId);
        const entries = await adapter.readDirectory(remotePath);
        return this._cacheDirectoryEntries(connectionId, remotePath, cacheKey, entries);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        const cacheKey = this._cache.makeKey(connectionId, remotePath);

        // Check cache first
        const cached = this._cache.getContent(cacheKey);
        if (cached) {
            return cached;
        }

        const adapter = await this._getAdapter(connectionId);
        const content = await adapter.readFile(remotePath);

        this._cache.setContent(cacheKey, content);
        return content;
    }

    async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        this._recordMutation(connectionId, remotePath);

        const adapter = await this._getAdapter(connectionId);
        await adapter.writeFile(remotePath, content, options);

        // Invalidate cache
        this._cache.invalidatePath(connectionId, remotePath);

        // Notify change
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Changed, uri },
        ]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        this._recordMutation(connectionId, remotePath);

        const adapter = await this._getAdapter(connectionId);
        await adapter.delete(remotePath, options);

        // Invalidate cache
        this._cache.invalidatePath(connectionId, remotePath);

        // Notify change
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Deleted, uri },
        ]);
    }

    async rename(
        oldUri: vscode.Uri,
        newUri: vscode.Uri,
        options: { overwrite: boolean }
    ): Promise<void> {
        const oldParsed = parseRemoteUri(oldUri);
        const newParsed = parseRemoteUri(newUri);

        if (oldParsed.connectionId !== newParsed.connectionId) {
            throw vscode.FileSystemError.NoPermissions(
                vscode.l10n.t('Cannot move files between different connections')
            );
        }

        this._recordMutation(oldParsed.connectionId, oldParsed.remotePath);
        this._recordMutation(newParsed.connectionId, newParsed.remotePath);

        const adapter = await this._getAdapter(oldParsed.connectionId);
        await adapter.rename(oldParsed.remotePath, newParsed.remotePath, options);

        // Invalidate cache for both paths
        this._cache.invalidatePath(oldParsed.connectionId, oldParsed.remotePath);
        this._cache.invalidatePath(newParsed.connectionId, newParsed.remotePath);

        // Notify changes
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        ]);
    }

    async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const src = parseRemoteUri(source);
        const dst = parseRemoteUri(destination);

        if (src.connectionId !== dst.connectionId) {
            throw vscode.FileSystemError.NoPermissions(
                vscode.l10n.t('Cannot copy files between different connections')
            );
        }

        this._recordMutation(dst.connectionId, dst.remotePath);

        const adapter = await this._getAdapter(src.connectionId);
        if (adapter.copy) {
            await adapter.copy(src.remotePath, dst.remotePath, options);
        } else {
            // Fallback: read + write (permissions not preserved)
            const content = await adapter.readFile(src.remotePath);
            await adapter.writeFile(dst.remotePath, content, { create: true, overwrite: options.overwrite });
        }

        this._cache.invalidatePath(dst.connectionId, dst.remotePath);
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Created, uri: destination },
        ]);
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        this._recordMutation(connectionId, remotePath);

        const adapter = await this._getAdapter(connectionId);
        await adapter.mkdir(remotePath);

        // Invalidate parent cache
        this._cache.invalidatePath(connectionId, remotePath);

        // Notify change
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Created, uri },
        ]);
    }

    // ─── Private Helpers ────────────────────────────────────────

    /**
     * Get a connected adapter for the given connection ID.
     * Returns an existing adapter if already connected, otherwise
     * auto-connects on demand (e.g. when VS Code restarts with
     * workspace folders from a previous session).
     */
    private async _getAdapter(connectionId: string) {
        const config = this._connectionManager.getConnection(connectionId);
        if (!config) {
            throw vscode.FileSystemError.Unavailable(
                vscode.l10n.t('Connection not found: {0}', connectionId)
            );
        }

        try {
            return await this._pool.getAdapter(config);
        } catch (err) {
            const message =
                err instanceof Error ? err.message : String(err);
            throw vscode.FileSystemError.Unavailable(
                vscode.l10n.t('Connection failed: {0}', message)
            );
        }
    }

    private _cacheDirectoryEntries(
        connectionId: string,
        remotePath: string,
        cacheKey: string,
        entries: Array<{ name: string; type: vscode.FileType; size: number; mtime: number; ctime: number; permissions?: vscode.FilePermission }>
    ): [string, vscode.FileType][] {
        const result: [string, vscode.FileType][] = entries.map((entry) => [entry.name, entry.type]);

        this._cache.setDirectory(cacheKey, result as [string, number][]);

        for (const entry of entries) {
            const entryPath = `${remotePath === '/' ? '' : remotePath}/${entry.name}`;
            const entryCacheKey = this._cache.makeKey(connectionId, entryPath);
            this._cache.setStat(entryCacheKey, {
                type: entry.type,
                ctime: entry.ctime,
                mtime: entry.mtime,
                size: entry.size,
                permissions: entry.permissions,
            });
        }

        return result;
    }

    private _recordMutation(connectionId: string, remotePath: string): void {
        const version = ++this._mutationVersion;
        const affectedPaths = new Set([remotePath, getParentPath(remotePath)]);

        for (const affectedPath of affectedPaths) {
            this._pathMutationVersions.set(this._cache.makeKey(connectionId, affectedPath), version);
        }
    }

    private _getMutationVersion(cacheKey: string): number {
        return this._pathMutationVersions.get(cacheKey) ?? 0;
    }

    dispose(): void {
        for (const watcher of this._watchers.values()) {
            watcher.dispose();
        }
        this._watchers.clear();
        this._pathMutationVersions.clear();
        this._onDidChangeFile.dispose();
    }

    /**
     * Notify the Explorer that a file/directory changed externally
     * (e.g. via an LM tool that bypasses the FileSystemProvider).
     */
    notifyExternalChange(
        connectionId: string,
        remotePath: string,
        type: vscode.FileChangeType
    ): void {
        const uri = vscode.Uri.parse(`remote-bridge://${connectionId}${remotePath}`);
        this._onDidChangeFile.fire([{ type, uri }]);

        // Also notify the parent directory so the Explorer refreshes the tree
        if (type === vscode.FileChangeType.Created || type === vscode.FileChangeType.Deleted) {
            const parentPath = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
            const parentUri = vscode.Uri.parse(`remote-bridge://${connectionId}${parentPath}`);
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri: parentUri }]);
        }
    }
}
