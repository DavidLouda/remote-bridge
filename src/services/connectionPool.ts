import * as vscode from 'vscode';
import { RemoteAdapter } from '../adapters/adapter';
import { SshAdapter } from '../adapters/sshAdapter';
import { FtpAdapter } from '../adapters/ftpAdapter';
import { ConnectionConfig, ConnectionStatus, secretKeyForProxyPassword, secretKeyForJumpPassword, secretKeyForJumpPassphrase } from '../types/connection';
import { TransferTracker } from './transferTracker';
import { PerfLogger } from './perfLogger';

interface PoolEntry {
    adapter: RemoteAdapter;
    config: ConnectionConfig;
    status: ConnectionStatus;
    lastActivity: number;
    disconnectListener: vscode.Disposable;
}

/**
 * Manages a pool of remote connections with automatic reconnection,
 * idle timeout, and connection limit enforcement.
 */
export class ConnectionPool implements vscode.Disposable {
    private readonly _pool = new Map<string, PoolEntry>();
    private readonly _pending = new Map<string, Promise<RemoteAdapter>>();
    private readonly _pendingGenerations = new Map<string, number>();
    private readonly _autoConnectSuspended = new Set<string>();
    private readonly _connectGenerations = new Map<string, number>();
    private _idleTimer: ReturnType<typeof setInterval> | null = null;
    private _disposed = false;

    private readonly _onDidChangeStatus = new vscode.EventEmitter<{
        connectionId: string;
        status: ConnectionStatus;
    }>();
    readonly onDidChangeStatus = this._onDidChangeStatus.event;

    constructor(
        private readonly _secretStorage: vscode.SecretStorage,
        private readonly _getSecretKey: (id: string, type: 'password' | 'passphrase') => string,
        private readonly _tracker?: TransferTracker,
        private readonly _perf?: PerfLogger,
        private _debug: boolean = false
    ) {
        this._startIdleMonitor();
    }

    setDebug(enabled: boolean): void {
        this._debug = enabled;
    }

    /**
     * Get or create a connected adapter for the given connection config.
     * Uses a pending-connections map to prevent duplicate concurrent connections.
     */
    async getAdapter(config: ConnectionConfig): Promise<RemoteAdapter> {
        if (this._disposed) {
            throw new Error(vscode.l10n.t('Connection pool has been disposed'));
        }
        if (this._autoConnectSuspended.has(config.id)) {
            throw new Error(vscode.l10n.t('Connection is disconnected: {0}', config.name));
        }

        const generation = this._getConnectGeneration(config.id);
        const existing = this._pool.get(config.id);
        if (existing && existing.adapter.isConnected()) {
            existing.lastActivity = Date.now();
            return existing.adapter;
        }

        // If a connection attempt is already in progress, wait for it
        const pending = this._pending.get(config.id);
        if (pending) {
            const pendingGeneration = this._pendingGenerations.get(config.id);
            if (pendingGeneration !== generation) {
                this._pending.delete(config.id);
                this._pendingGenerations.delete(config.id);
            } else {
                const start = Date.now();
                try {
                    return await pending;
                } finally {
                    this._logPerf(config, `pool getAdapter waited for pending connect (${Date.now() - start}ms)`);
                }
            }
        }

        const promise = this._connectAdapter(config, generation);
        this._pending.set(config.id, promise);
        this._pendingGenerations.set(config.id, generation);

        try {
            return await promise;
        } finally {
            if (this._pending.get(config.id) === promise) {
                this._pending.delete(config.id);
                this._pendingGenerations.delete(config.id);
            }
        }
    }

    suspendAutoConnect(connectionId: string): void {
        this._autoConnectSuspended.add(connectionId);
        this._invalidatePendingConnect(connectionId);
    }

    resumeAutoConnect(connectionId: string): void {
        this._autoConnectSuspended.delete(connectionId);
    }

    isAutoConnectSuspended(connectionId: string): boolean {
        return this._autoConnectSuspended.has(connectionId);
    }

    private async _connectAdapter(config: ConnectionConfig, generation: number): Promise<RemoteAdapter> {
        const start = Date.now();

        // Remove stale entry
        const existing = this._pool.get(config.id);
        if (existing) {
            existing.disconnectListener.dispose();
            existing.adapter.dispose();
            this._pool.delete(config.id);
        }

        // Check pool limit
        const maxConnections = vscode.workspace
            .getConfiguration('remoteBridge.pool')
            .get<number>('maxConnections', 10);

        if (this._pool.size >= maxConnections) {
            await this._evictOldest();
        }

        // Create adapter
        const adapter = this._createAdapter(config);

        // Set status to connecting
        this._setStatus(config.id, ConnectionStatus.Connecting);
        this._logPerf(config, 'pool connect start');

        try {
            await adapter.connect();
        } catch (err) {
            this._setStatus(config.id, ConnectionStatus.Error);
            adapter.dispose();
            this._logPerf(config, `pool connect failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
            throw err;
        }

        if (this._autoConnectSuspended.has(config.id) || this._getConnectGeneration(config.id) !== generation) {
            this._setStatus(config.id, ConnectionStatus.Disconnected);
            await adapter.disconnect().catch(() => { /* ignore */ });
            adapter.dispose();
            this._logPerf(config, `pool connect discarded after ${Date.now() - start}ms`);
            throw new Error(vscode.l10n.t('Connection is disconnected: {0}', config.name));
        }

        // Listen for unexpected disconnects
        const disconnectListener = adapter.onDidDisconnect(() => {
            this._setStatus(config.id, ConnectionStatus.Disconnected);
        });

        // Add to pool BEFORE firing the Connected event so that
        // getActiveSessions() returns the entry in status-change listeners.
        this._pool.set(config.id, {
            adapter,
            config,
            status: ConnectionStatus.Connected,
            lastActivity: Date.now(),
            disconnectListener,
        });

        this._setStatus(config.id, ConnectionStatus.Connected);
        this._logPerf(config, `pool connect complete (${Date.now() - start}ms)`);

        return adapter;
    }

    /**
     * Disconnect a specific connection.
     */
    async disconnect(connectionId: string): Promise<void> {
        this._invalidatePendingConnect(connectionId);
        const entry = this._pool.get(connectionId);
        if (!entry) {
            this._setStatus(connectionId, ConnectionStatus.Disconnected);
            return;
        }

        entry.disconnectListener.dispose();
        await entry.adapter.disconnect();
        entry.adapter.dispose();
        this._pool.delete(connectionId);
        this._setStatus(connectionId, ConnectionStatus.Disconnected);
    }

    /**
     * Disconnect all connections.
     */
    async disconnectAll(): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const id of this._pool.keys()) {
            promises.push(this.disconnect(id));
        }
        await Promise.allSettled(promises);
    }

    /**
     * Get the current status of a connection.
     */
    getStatus(connectionId: string): ConnectionStatus {
        return this._pool.get(connectionId)?.status ?? ConnectionStatus.Disconnected;
    }

    /**
     * Check if a connection is currently active.
     */
    isConnected(connectionId: string): boolean {
        const entry = this._pool.get(connectionId);
        return !!entry && entry.adapter.isConnected();
    }

    /**
     * Get adapter if already connected (no auto-connect).
     */
    getConnectedAdapter(connectionId: string): RemoteAdapter | undefined {
        const entry = this._pool.get(connectionId);
        if (entry && entry.adapter.isConnected()) {
            entry.lastActivity = Date.now();
            return entry.adapter;
        }
        return undefined;
    }

    /**
     * Get info about all active (connected) sessions.
     */
    getActiveSessions(): { id: string; config: ConnectionConfig; lastActivity: number }[] {
        const result: { id: string; config: ConnectionConfig; lastActivity: number }[] = [];
        for (const [id, entry] of this._pool) {
            if (entry.adapter.isConnected()) {
                result.push({ id, config: entry.config, lastActivity: entry.lastActivity });
            }
        }
        return result;
    }

    /**
     * Touch — update last activity timestamp.
     */
    touch(connectionId: string): void {
        const entry = this._pool.get(connectionId);
        if (entry) {
            entry.lastActivity = Date.now();
        }
    }

    // ─── Private Helpers ─────────────────────────────────────────

    private _createAdapter(config: ConnectionConfig): RemoteAdapter {
        const getPassword = async () =>
            this._secretStorage.get(this._getSecretKey(config.id, 'password'));
        const getPassphrase = async () =>
            this._secretStorage.get(this._getSecretKey(config.id, 'passphrase'));
        const getProxyPassword = async () =>
            this._secretStorage.get(secretKeyForProxyPassword(config.id));
        const getJumpPassword = async () =>
            this._secretStorage.get(secretKeyForJumpPassword(config.id));
        const getJumpPassphrase = async () =>
            this._secretStorage.get(secretKeyForJumpPassphrase(config.id));

        switch (config.protocol) {
            case 'ssh':
            case 'sftp':
                return new SshAdapter(config, getPassword, getPassphrase, getProxyPassword, this._tracker, getJumpPassword, getJumpPassphrase, this._perf);
            case 'ftp':
            case 'ftps':
                return new FtpAdapter(config, getPassword, getProxyPassword, this._tracker, this._perf, this._debug);
            default:
                throw new Error(vscode.l10n.t('Unsupported protocol: {0}', config.protocol));
        }
    }

    private _logPerf(config: ConnectionConfig, message: string): void {
        if (!this._perf) {
            return;
        }
        this._perf.log(`${config.protocol.toUpperCase()} ${config.name}@${config.host}`, message);
    }

    private _getConnectGeneration(connectionId: string): number {
        return this._connectGenerations.get(connectionId) ?? 0;
    }

    private _invalidatePendingConnect(connectionId: string): void {
        this._connectGenerations.set(connectionId, this._getConnectGeneration(connectionId) + 1);
        this._pending.delete(connectionId);
        this._pendingGenerations.delete(connectionId);
    }

    private _setStatus(connectionId: string, status: ConnectionStatus): void {
        const entry = this._pool.get(connectionId);
        if (entry) {
            entry.status = status;
        }
        this._onDidChangeStatus.fire({ connectionId, status });
    }

    private async _evictOldest(): Promise<void> {
        let oldestId: string | null = null;
        let oldestTime = Infinity;

        for (const [id, entry] of this._pool) {
            if (entry.lastActivity < oldestTime) {
                oldestTime = entry.lastActivity;
                oldestId = id;
            }
        }

        if (oldestId) {
            await this.disconnect(oldestId);
        }
    }

    private _startIdleMonitor(): void {
        // Check every 60 seconds for idle connections
        this._idleTimer = setInterval(() => {
            const idleTimeoutMinutesRaw = vscode.workspace
                .getConfiguration('remoteBridge.pool')
                .get<number>('idleTimeout', 10);
            // Clamp to a sane range (1 minute — 24 hours) so a misconfigured
            // value (negative, NaN, absurdly large) cannot disable eviction
            // or thrash the pool.
            const idleTimeoutMinutes = Number.isFinite(idleTimeoutMinutesRaw) && idleTimeoutMinutesRaw >= 1
                ? Math.min(idleTimeoutMinutesRaw, 24 * 60)
                : 10;
            const idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
            const now = Date.now();

            for (const [id, entry] of this._pool) {
                if (now - entry.lastActivity > idleTimeoutMs) {
                    this.disconnect(id).catch((err) => {
                        // Surfacing in the perf log keeps a paper trail when an
                        // idle disconnect can't tear down a broken adapter.
                        try { this._perf?.log('pool', `idle disconnect failed for ${id}: ${String(err)}`); } catch { /* ignore */ }
                    });
                }
            }
        }, 60_000);
    }

    dispose(): void {
        this._disposed = true;
        if (this._idleTimer) {
            clearInterval(this._idleTimer);
            this._idleTimer = null;
        }
        this.disconnectAll().catch(() => { /* ignore */ });
        this._pending.clear();
        this._pendingGenerations.clear();
        this._autoConnectSuspended.clear();
        this._connectGenerations.clear();
        this._onDidChangeStatus.dispose();
    }
}
