import * as vscode from 'vscode';
import { RemoteAdapter } from '../adapters/adapter';
import { SshAdapter } from '../adapters/sshAdapter';
import { FtpAdapter } from '../adapters/ftpAdapter';
import { ConnectionConfig, ConnectionStatus } from '../types/connection';
import { TransferTracker } from './transferTracker';

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
    private _idleTimer: ReturnType<typeof setInterval> | null = null;

    private readonly _onDidChangeStatus = new vscode.EventEmitter<{
        connectionId: string;
        status: ConnectionStatus;
    }>();
    readonly onDidChangeStatus = this._onDidChangeStatus.event;

    constructor(
        private readonly _secretStorage: vscode.SecretStorage,
        private readonly _getSecretKey: (id: string, type: 'password' | 'passphrase') => string,
        private readonly _tracker?: TransferTracker
    ) {
        this._startIdleMonitor();
    }

    /**
     * Get or create a connected adapter for the given connection config.
     * Uses a pending-connections map to prevent duplicate concurrent connections.
     */
    async getAdapter(config: ConnectionConfig): Promise<RemoteAdapter> {
        const existing = this._pool.get(config.id);
        if (existing && existing.adapter.isConnected()) {
            existing.lastActivity = Date.now();
            return existing.adapter;
        }

        // If a connection attempt is already in progress, wait for it
        const pending = this._pending.get(config.id);
        if (pending) {
            return pending;
        }

        const promise = this._connectAdapter(config);
        this._pending.set(config.id, promise);

        try {
            return await promise;
        } finally {
            this._pending.delete(config.id);
        }
    }

    private async _connectAdapter(config: ConnectionConfig): Promise<RemoteAdapter> {
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

        try {
            await adapter.connect();
        } catch (err) {
            this._setStatus(config.id, ConnectionStatus.Error);
            adapter.dispose();
            throw err;
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

        return adapter;
    }

    /**
     * Disconnect a specific connection.
     */
    async disconnect(connectionId: string): Promise<void> {
        const entry = this._pool.get(connectionId);
        if (!entry) {
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

        switch (config.protocol) {
            case 'ssh':
            case 'sftp':
                return new SshAdapter(config, getPassword, getPassphrase, this._tracker);
            case 'ftp':
            case 'ftps':
                return new FtpAdapter(config, getPassword, this._tracker);
            default:
                throw new Error(vscode.l10n.t('Unsupported protocol: {0}', config.protocol));
        }
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
            const idleTimeoutMinutes = vscode.workspace
                .getConfiguration('remoteBridge.pool')
                .get<number>('idleTimeout', 10);
            const idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
            const now = Date.now();

            for (const [id, entry] of this._pool) {
                if (now - entry.lastActivity > idleTimeoutMs) {
                    this.disconnect(id).catch(() => { /* ignore */ });
                }
            }
        }, 60_000);
    }

    dispose(): void {
        if (this._idleTimer) {
            clearInterval(this._idleTimer);
            this._idleTimer = null;
        }
        this.disconnectAll().catch(() => { /* ignore */ });
        this._onDidChangeStatus.dispose();
    }
}
