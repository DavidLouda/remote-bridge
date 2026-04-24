import * as vscode from 'vscode';
import { RemoteOperationSource, RemoteAdapter, isConnectionLostError } from '../adapters/adapter';
import { ConnectionPool } from '../services/connectionPool';
import { ConnectionManager } from '../services/connectionManager';
import { CacheService } from '../services/cacheService';
import { PerfLogger } from '../services/perfLogger';
import { buildRemoteUri, getParentPath, normalizeRemotePath, parseRemoteUri } from '../utils/uriParser';
import { ConnectionStatus } from '../types/connection';

const WATCH_SKIP_BACKOFF_MS = 60_000;
const WATCH_PROBE_SKIP_BACKOFF_MS = 5 * 60_000;

const WATCH_PROBE_BASENAMES = new Set([
    'pom.xml',
    'build.gradle',
    'pyproject.toml',
    'setup.cfg',
    'tox.ini',
    '.pep8',
    '.pylintrc',
    'pylintrc',
    '.mypy.ini',
    '.flake8',
]);

const WATCH_PROBE_PREFIXES = [
    '/.vscode',
    '/.github',
    '/.claude',
    '/.devcontainer',
    '/.agents',
    '/.git',
    '/node_modules',
];

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
    private readonly _autoConnectSuspended = new Set<string>();
    private readonly _pendingStats = new Map<string, Promise<vscode.FileStat>>();
    private readonly _pendingDirectories = new Map<string, Promise<[string, vscode.FileType][]>>();
    private readonly _pendingProbeDirectories = new Map<string, Promise<[string, vscode.FileType][]>>();
    private readonly _pendingFiles = new Map<string, Promise<Uint8Array>>();
    private readonly _pathMutationVersions = new Map<string, number>();
    private _mutationVersion = 0;

    constructor(
        private readonly _pool: ConnectionPool,
        private readonly _connectionManager: ConnectionManager,
        private readonly _cache: CacheService,
        private readonly _perf?: PerfLogger
    ) {}

    suspendAutoConnect(connectionId: string): void {
        this._autoConnectSuspended.add(connectionId);
        this._pool.suspendAutoConnect(connectionId);
        this._disposeConnectionWatchers(connectionId);
        this._clearConnectionState(connectionId);
        this._logPerf(connectionId, 'fsp auto-connect suspended');
    }

    resumeAutoConnect(connectionId: string): void {
        this._pool.resumeAutoConnect(connectionId);
        if (this._autoConnectSuspended.delete(connectionId)) {
            this._logPerf(connectionId, 'fsp auto-connect resumed');
        }
    }

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

        const basePollInterval = vscode.workspace
            .getConfiguration('remoteBridge.watch')
            .get<number>('pollInterval', 5) * 1000;
        const largeDirThreshold = Math.max(
            100,
            vscode.workspace
                .getConfiguration('remoteBridge.watch')
                .get<number>('largeDirThreshold', 1000)
        );
        const { connectionId } = parseRemoteUri(uri);
        const config = this._connectionManager.getConnection(connectionId);
        const pollInterval = config && (config.protocol === 'ftp' || config.protocol === 'ftps')
            ? Math.max(basePollInterval, 30000)
            : basePollInterval;

        let lastSnapshot = new Map<string, number>();
        let watchMode: 'unknown' | 'directory' | 'skip' = 'unknown';
        let nextResolveAt = 0;
        // Backoff timer for very large directories: when entries.length exceeds
        // largeDirThreshold we throttle the watcher to ~4× pollInterval to
        // keep CPU and bandwidth from going wild on huge listings.
        let largeDirSkipUntil = 0;
        let largeDirWarned = false;

        const interval = setInterval(async () => {
            try {
                const { connectionId, remotePath } = parseRemoteUri(uri);
                const cacheKey = this._cache.makeKey(connectionId, remotePath);
                const mutationVersionAtStart = this._getMutationVersion(cacheKey);
                if (!this._pool.isConnected(connectionId)) {
                    return;
                }

                // Throttle huge directories: skip this tick if we're inside
                // the large-dir cooldown window.
                if (watchMode === 'directory' && Date.now() < largeDirSkipUntil) {
                    return;
                }

                const adapter = this._pool.getConnectedAdapter(connectionId);
                if (!adapter) {
                    return;
                }

                // Many VS Code and extension watchers target files or missing paths.
                // Poll only confirmed directories; back off for everything else.
                if (watchMode !== 'directory') {
                    const now = Date.now();
                    if (now < nextResolveAt) {
                        return;
                    }

                    if (this._cache.getNotFound(cacheKey)) {
                        watchMode = 'skip';
                    } else {
                        const cachedStat = this._cache.getStat(cacheKey);
                        if (cachedStat) {
                            watchMode = (cachedStat.type & vscode.FileType.Directory) !== 0 ? 'directory' : 'skip';
                        } else {
                            try {
                                const stat = await adapter.stat(remotePath, { source: 'watch' });
                                this._cache.setStat(cacheKey, stat);
                                watchMode = (stat.type & vscode.FileType.Directory) !== 0 ? 'directory' : 'skip';
                            } catch (err) {
                                if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
                                    this._cache.setNotFound(cacheKey);
                                }
                                watchMode = 'skip';
                            }
                        }
                    }

                    if (watchMode !== 'directory') {
                        nextResolveAt = now + this._getWatchSkipBackoffMs(remotePath);
                        this._logPerf(connectionId, `fsp watch ${remotePath} -> skipping until ${new Date(nextResolveAt).toISOString()}`);
                        return;
                    }

                    this._logPerf(connectionId, `fsp watch ${remotePath} -> resolved as directory`);
                }

                const entries = await adapter.readDirectory(remotePath, { source: 'watch' });
                if (this._getMutationVersion(cacheKey) !== mutationVersionAtStart) {
                    return;
                }

                // Large-directory backoff: re-evaluate every tick using the
                // freshly-loaded entry count.
                if (entries.length > largeDirThreshold) {
                    largeDirSkipUntil = Date.now() + pollInterval * 3;
                    if (!largeDirWarned) {
                        largeDirWarned = true;
                        this._logPerf(connectionId, `fsp watch ${remotePath} -> large directory (${entries.length} entries > ${largeDirThreshold}); throttling poll to ~${(pollInterval * 4) / 1000}s`);
                    }
                } else if (largeDirWarned && entries.length <= largeDirThreshold / 2) {
                    // Hysteresis: only un-warn when the directory has shrunk
                    // well below the threshold to avoid flapping logs.
                    largeDirWarned = false;
                    largeDirSkipUntil = 0;
                    this._logPerf(connectionId, `fsp watch ${remotePath} -> directory back to normal size (${entries.length} entries); resuming standard poll`);
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

                // Re-check mutation version immediately before persisting the
                // listing — a user op may have changed the directory between
                // the previous version check and now (the readDirectory await,
                // the snapshot diff, and the cache invalidations above are all
                // potential await points).
                if (this._getMutationVersion(cacheKey) !== mutationVersionAtStart) {
                    return;
                }

                this._cacheDirectoryEntries(connectionId, remotePath, cacheKey, entries);
                lastSnapshot = currentSnapshot;

                if (changes.length > 0) {
                    this._onDidChangeFile.fire(changes);
                }
            } catch {
                watchMode = 'unknown';
                nextResolveAt = Date.now() + this._getWatchSkipBackoffMs(parseRemoteUri(uri).remotePath);
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
        const start = Date.now();
        const { connectionId, remotePath } = parseRemoteUri(uri);
        const cacheKey = this._cache.makeKey(connectionId, remotePath);

        if (this._cache.getNotFound(cacheKey)) {
            this._logPerf(connectionId, `fsp stat ${remotePath} -> cached not-found (${Date.now() - start}ms)`);
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        // Check cache first
        const cached = this._cache.getStat(cacheKey);
        if (cached) {
            this._logPerf(connectionId, `fsp stat ${remotePath} -> cache hit (${Date.now() - start}ms)`);
            return cached;
        }

        const pending = this._pendingStats.get(cacheKey);
        if (pending) {
            this._logPerf(connectionId, `fsp stat ${remotePath} -> pending hit (${Date.now() - start}ms)`);
            return pending;
        }

        const request = (async () => {
            try {
                await this._awaitProbeContext(connectionId, remotePath, cacheKey);
                if (this._cache.getNotFound(cacheKey)) {
                    this._logPerf(connectionId, `fsp stat ${remotePath} -> inferred not-found (${Date.now() - start}ms)`);
                    throw vscode.FileSystemError.FileNotFound(uri);
                }

                const adapterStart = Date.now();
                const stat = await this._retryOnConnectionLost(
                    connectionId,
                    `stat ${remotePath}`,
                    (adapter) => adapter.stat(remotePath, { source: 'user' })
                );

                this._cache.setStat(cacheKey, stat);
                this._logPerf(connectionId, `fsp stat ${remotePath} -> cache miss, adapter ${Date.now() - adapterStart}ms, total ${Date.now() - start}ms`);
                return stat;
            } catch (err) {
                if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
                    this._cache.setNotFound(cacheKey);
                }
                this._logPerf(connectionId, `fsp stat ${remotePath} -> failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
                throw err;
            } finally {
                this._pendingStats.delete(cacheKey);
            }
        })();

        this._pendingStats.set(cacheKey, request);
        return request;
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const start = Date.now();
        const { connectionId, remotePath } = parseRemoteUri(uri);
        return this._readDirectoryWithSource(connectionId, remotePath, 'user', start);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const start = Date.now();
        const { connectionId, remotePath } = parseRemoteUri(uri);
        const cacheKey = this._cache.makeKey(connectionId, remotePath);

        if (this._cache.getNotFound(cacheKey)) {
            this._logPerf(connectionId, `fsp readFile ${remotePath} -> cached not-found (0ms)`);
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        // Check cache first
        const cached = this._cache.getContent(cacheKey);
        if (cached) {
            return cached;
        }

        const pending = this._pendingFiles.get(cacheKey);
        if (pending) {
            this._logPerf(connectionId, `fsp readFile ${remotePath} -> pending hit (0ms)`);
            return pending;
        }

        const request = (async () => {
            try {
                await this._awaitProbeContext(connectionId, remotePath, cacheKey);
                if (this._cache.getNotFound(cacheKey)) {
                    this._logPerf(connectionId, `fsp readFile ${remotePath} -> inferred not-found (${Date.now() - start}ms)`);
                    throw vscode.FileSystemError.FileNotFound(uri);
                }

                const adapterStart = Date.now();
                const content = await this._retryOnConnectionLost(
                    connectionId,
                    `readFile ${remotePath}`,
                    (adapter) => adapter.readFile(remotePath, { source: 'user' })
                );
                this._logPerf(connectionId, `fsp readFile ${remotePath} -> adapter (${Date.now() - adapterStart}ms, ${content.byteLength}B), total ${Date.now() - start}ms`);

                this._cache.setContent(cacheKey, content);
                return content;
            } catch (err) {
                if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
                    this._cache.setNotFound(cacheKey);
                }
                throw err;
            } finally {
                this._pendingFiles.delete(cacheKey);
            }
        })();

        this._pendingFiles.set(cacheKey, request);
        return request;
    }

    async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        this._recordMutation(connectionId, remotePath);

        await this._retryOnConnectionLost(connectionId, `writeFile ${remotePath}`, async (adapter) => {
            // Best-effort: ensure the parent directory exists when creating a new file.
            // VS Code editors often save to paths whose parent directory was created
            // separately or doesn't yet exist (e.g. "Save As..." into a fresh subfolder).
            // mkdir is idempotent (mkdir -p semantics), so a no-op when parent exists.
            if (options.create) {
                const parentPath = remotePath.substring(0, remotePath.lastIndexOf('/'));
                if (parentPath && parentPath !== remotePath) {
                    try {
                        await adapter.mkdir(parentPath);
                    } catch (err) {
                        if (isConnectionLostError(err)) {
                            throw err;
                        }
                        this._logPerf(connectionId, `fsp writeFile ${remotePath} -> parent mkdir failed (continuing): ${this._perf?.formatError(err) ?? String(err)}`);
                    }
                }
            }

            await adapter.writeFile(remotePath, content, options);
        });

        // Invalidate cache (file + parent directory listing)
        this._cache.invalidatePath(connectionId, remotePath);

        // Notify change
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Changed, uri },
        ]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        this._recordMutation(connectionId, remotePath);

        await this._retryOnConnectionLost(
            connectionId,
            `delete ${remotePath}`,
            (adapter) => adapter.delete(remotePath, options)
        );

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

        await this._retryOnConnectionLost(
            oldParsed.connectionId,
            `rename ${oldParsed.remotePath} -> ${newParsed.remotePath}`,
            (adapter) => adapter.rename(oldParsed.remotePath, newParsed.remotePath, options)
        );

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

        await this._retryOnConnectionLost(src.connectionId, `copy ${src.remotePath} -> ${dst.remotePath}`, async (adapter) => {
            if (adapter.copy) {
                await adapter.copy(src.remotePath, dst.remotePath, options);
            } else {
                // Fallback: read + write (permissions not preserved)
                const content = await adapter.readFile(src.remotePath, { source: 'user' });
                await adapter.writeFile(dst.remotePath, content, { create: true, overwrite: options.overwrite });
            }
        });

        this._cache.invalidatePath(dst.connectionId, dst.remotePath);
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Created, uri: destination },
        ]);
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        this._recordMutation(connectionId, remotePath);

        await this._retryOnConnectionLost(
            connectionId,
            `mkdir ${remotePath}`,
            (adapter) => adapter.mkdir(remotePath)
        );

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
    private async _getAdapter(connectionId: string, reason = 'unknown') {
        const config = this._connectionManager.getConnection(connectionId);
        if (!config) {
            throw vscode.FileSystemError.Unavailable(
                vscode.l10n.t('Connection not found: {0}', connectionId)
            );
        }

        if (this._autoConnectSuspended.has(connectionId)) {
            this._logPerf(connectionId, `fsp getAdapter ${reason} -> suppressed`);
            throw vscode.FileSystemError.Unavailable(
                vscode.l10n.t('Connection is disconnected: {0}', config.name)
            );
        }

        const start = Date.now();
        const wasConnected = this._pool.isConnected(connectionId);

        try {
            const adapter = await this._pool.getAdapter(config);
            this._logPerf(connectionId, `fsp getAdapter ${reason} -> ${wasConnected ? 'reuse' : 'connect'} (${Date.now() - start}ms)`);
            return adapter;
        } catch (err) {
            this._logPerf(connectionId, `fsp getAdapter ${reason} -> failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
            const message =
                err instanceof Error ? err.message : String(err);
            throw vscode.FileSystemError.Unavailable(
                vscode.l10n.t('Connection failed: {0}', message)
            );
        }
    }

    /**
     * Run an adapter operation with a single transparent retry if the underlying
     * connection was lost (e.g. FTP server sent FIN after idle timeout, SSH
     * transport reset). The first failure marks the pool entry as not-connected
     * via the adapter's `onDidDisconnect` event, so the second `_getAdapter`
     * call forces a fresh connect-and-retry cycle.
     *
     * Probe and watcher paths intentionally do not use this helper — those run
     * on a polling cadence and benefit from surfacing real outages instead of
     * silently masking them with retries.
     */
    private async _retryOnConnectionLost<T>(
        connectionId: string,
        reason: string,
        fn: (adapter: RemoteAdapter) => Promise<T>
    ): Promise<T> {
        const adapter = await this._getAdapter(connectionId, reason);
        try {
            return await fn(adapter);
        } catch (err) {
            if (!isConnectionLostError(err)) {
                throw err;
            }
            this._logPerf(connectionId, `${reason} -> connection lost, retrying once via fresh adapter`);
            const freshAdapter = await this._getAdapter(connectionId, `${reason} (retry)`);
            return await fn(freshAdapter);
        }
    }

    private async _readDirectoryWithSource(
        connectionId: string,
        remotePath: string,
        source: Extract<RemoteOperationSource, 'user' | 'probe'>,
        start = Date.now()
    ): Promise<[string, vscode.FileType][]> {
        const cacheKey = this._cache.makeKey(connectionId, remotePath);
        const pendingMap = source === 'probe' ? this._pendingProbeDirectories : this._pendingDirectories;
        const uri = buildRemoteUri(connectionId, remotePath);

        if (this._cache.getNotFound(cacheKey)) {
            this._logPerf(connectionId, `fsp readDirectory ${remotePath} [${source}] -> cached not-found (${Date.now() - start}ms)`);
            throw vscode.FileSystemError.FileNotFound(uri);
        }

        const cached = this._cache.getDirectory(cacheKey);
        if (cached) {
            this._logPerf(connectionId, `fsp readDirectory ${remotePath} [${source}] -> cache hit (${Date.now() - start}ms, ${cached.length} entries)`);
            return cached as [string, vscode.FileType][];
        }

        const pending = pendingMap.get(cacheKey);
        if (pending) {
            this._logPerf(connectionId, `fsp readDirectory ${remotePath} [${source}] -> pending hit (${Date.now() - start}ms)`);
            return pending;
        }

        let request!: Promise<[string, vscode.FileType][]>;
        request = (async () => {
            try {
                if (source === 'user') {
                    await this._awaitProbeContext(connectionId, remotePath, cacheKey);
                    if (this._cache.getNotFound(cacheKey)) {
                        this._logPerf(connectionId, `fsp readDirectory ${remotePath} [${source}] -> inferred not-found (${Date.now() - start}ms)`);
                        throw vscode.FileSystemError.FileNotFound(uri);
                    }
                }

                const adapterStart = Date.now();
                const entries = source === 'user'
                    ? await this._retryOnConnectionLost(
                        connectionId,
                        `readDirectory ${remotePath} [user]`,
                        (adapter) => adapter.readDirectory(remotePath, { source })
                    )
                    : await (await this._getAdapter(connectionId, `readDirectory ${remotePath} [${source}]`))
                        .readDirectory(remotePath, { source });
                const result = this._cacheDirectoryEntries(connectionId, remotePath, cacheKey, entries);
                this._logPerf(connectionId, `fsp readDirectory ${remotePath} [${source}] -> cache miss, adapter ${Date.now() - adapterStart}ms, total ${Date.now() - start}ms, ${result.length} entries`);
                return result;
            } catch (err) {
                if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
                    this._cache.setNotFound(cacheKey);
                }
                this._logPerf(connectionId, `fsp readDirectory ${remotePath} [${source}] -> failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
                throw err;
            } finally {
                if (pendingMap.get(cacheKey) === request) {
                    pendingMap.delete(cacheKey);
                }
            }
        })();

        pendingMap.set(cacheKey, request);
        return request;
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

    private _getWatchSkipBackoffMs(remotePath: string): number {
        return this._isLikelyProbePath(remotePath)
            ? WATCH_PROBE_SKIP_BACKOFF_MS
            : WATCH_SKIP_BACKOFF_MS;
    }

    private async _awaitProbeContext(connectionId: string, remotePath: string, cacheKey: string): Promise<void> {
        const config = this._connectionManager.getConnection(connectionId);
        if (!config || (config.protocol !== 'ftp' && config.protocol !== 'ftps')) {
            return;
        }

        if (!this._isLikelyProbePath(remotePath)) {
            return;
        }

        const rootPath = normalizeRemotePath(config.remotePath || '/');
        if (remotePath === rootPath) {
            return;
        }

        await Promise.resolve();

        const rootCacheKey = this._cache.makeKey(connectionId, rootPath);
        let pendingRootDirectory = this._pendingDirectories.get(rootCacheKey)
            ?? this._pendingProbeDirectories.get(rootCacheKey);
        if (!this._cache.getDirectory(rootCacheKey) && !pendingRootDirectory) {
            pendingRootDirectory = this._readDirectoryWithSource(connectionId, rootPath, 'probe');
        }

        if (pendingRootDirectory) {
            try {
                await pendingRootDirectory;
            } catch {
                // Ignore root listing failures and fall back to adapter access.
            }
        }

        if (this._inferNotFoundFromCachedAncestors(connectionId, rootPath, remotePath)) {
            this._cache.setNotFound(cacheKey);
        }
    }

    private _inferNotFoundFromCachedAncestors(connectionId: string, rootPath: string, remotePath: string): boolean {
        const normalizedRootPath = normalizeRemotePath(rootPath);
        const normalizedRemotePath = normalizeRemotePath(remotePath);

        if (normalizedRemotePath === normalizedRootPath) {
            return false;
        }

        const rootPrefix = normalizedRootPath === '/' ? '/' : `${normalizedRootPath}/`;
        if (!normalizedRemotePath.startsWith(rootPrefix)) {
            return false;
        }

        const relativePath = normalizedRootPath === '/'
            ? normalizedRemotePath.slice(1)
            : normalizedRemotePath.slice(rootPrefix.length);
        if (!relativePath) {
            return false;
        }

        const segments = relativePath.split('/').filter(Boolean);
        let currentPath = normalizedRootPath;

        for (let index = 0; index < segments.length; index++) {
            const directoryKey = this._cache.makeKey(connectionId, currentPath);
            const directoryEntries = this._cache.getDirectory(directoryKey);
            if (!directoryEntries) {
                return false;
            }

            const segment = segments[index];
            const entry = directoryEntries.find(([name]) => name === segment);
            if (!entry) {
                return true;
            }

            const isLastSegment = index === segments.length - 1;
            const entryType = entry[1];
            if (!isLastSegment && (entryType & vscode.FileType.Directory) === 0) {
                return true;
            }

            currentPath = currentPath === '/' ? `/${segment}` : `${currentPath}/${segment}`;
        }

        return false;
    }

    private _isLikelyProbePath(remotePath: string): boolean {
        const normalizedPath = remotePath.toLowerCase();

        for (const prefix of WATCH_PROBE_PREFIXES) {
            if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
                return true;
            }
        }

        const baseName = normalizedPath.substring(normalizedPath.lastIndexOf('/') + 1);
        return WATCH_PROBE_BASENAMES.has(baseName);
    }

    private _logPerf(connectionId: string, message: string): void {
        if (!this._perf) {
            return;
        }
        const config = this._connectionManager.getConnection(connectionId);
        if (!config) {
            return;
        }
        this._perf.log(`${config.protocol.toUpperCase()} ${config.name}@${config.host}`, message);
    }

    private _disposeConnectionWatchers(connectionId: string): void {
        const watcherEntries = Array.from(this._watchers.entries()).filter(([uriString]) => {
            try {
                return parseRemoteUri(vscode.Uri.parse(uriString)).connectionId === connectionId;
            } catch {
                return false;
            }
        });

        for (const [, watcher] of watcherEntries) {
            watcher.dispose();
        }
    }

    private _clearConnectionState(connectionId: string): void {
        const prefix = `${connectionId}:`;
        this._deleteMapEntries(this._pendingStats, prefix);
        this._deleteMapEntries(this._pendingDirectories, prefix);
        this._deleteMapEntries(this._pendingProbeDirectories, prefix);
        this._deleteMapEntries(this._pendingFiles, prefix);
        this._deleteMapEntries(this._pathMutationVersions, prefix);
    }

    private _deleteMapEntries<T>(map: Map<string, T>, prefix: string): void {
        for (const key of map.keys()) {
            if (key.startsWith(prefix)) {
                map.delete(key);
            }
        }
    }

    dispose(): void {
        for (const watcher of this._watchers.values()) {
            watcher.dispose();
        }
        this._watchers.clear();
        this._autoConnectSuspended.clear();
        this._pendingStats.clear();
        this._pendingDirectories.clear();
        this._pendingProbeDirectories.clear();
        this._pendingFiles.clear();
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
