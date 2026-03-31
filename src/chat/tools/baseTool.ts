import * as vscode from 'vscode';
import { posix } from 'path';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { ConnectionConfig, ConnectionStatus } from '../../types/connection';

/**
 * Base class for Language Model Tools that operate on remote connections.
 *
 * Provides shared helpers for resolving connection names/IDs and common
 * constructor parameters so subclasses don't have to duplicate them.
 */
export abstract class BaseTool {
    constructor(
        protected readonly _connectionManager: ConnectionManager,
        protected readonly _pool: ConnectionPool
    ) {}

    /**
     * Resolve a connection by ID, display name, or auto-select.
     *
     * When `idOrName` is provided: exact match → fuzzy match.
     * When omitted (or no match found): auto-selects when exactly one
     * connection is connected, or exactly one connection is configured.
     */
    protected _resolveConnection(idOrName?: string): ConnectionConfig {
        if (idOrName) {
            const conn =
                this._connectionManager.getConnection(idOrName) ||
                this._connectionManager.findConnectionByName(idOrName) ||
                this._connectionManager.findConnectionFuzzy(idOrName);
            if (conn) {
                return conn;
            }
        }

        // Auto-select: try single connected, then single configured
        const all = this._connectionManager.getConnections();
        const connected = all.filter(
            (c) => this._pool.getStatus(c.id) === ConnectionStatus.Connected
        );
        if (connected.length === 1) {
            return connected[0];
        }
        if (all.length === 1) {
            return all[0];
        }

        const available = all.map((c) => `"${c.name}"`).join(', ');
        const hint = available
            ? vscode.l10n.t('Available connections: {0}', available)
            : vscode.l10n.t('No connections configured.');
        if (idOrName) {
            throw new Error(vscode.l10n.t('Connection "{0}" not found. {1}', idOrName, hint));
        }
        throw new Error(vscode.l10n.t('Multiple connections available — specify connectionName. {0}', hint));
    }

    /**
     * Resolve a connection display name from an ID or name.
     * Falls back to auto-select or the raw input.
     */
    protected _resolveConnectionName(idOrName?: string): string {
        if (idOrName) {
            const conn =
                this._connectionManager.getConnection(idOrName) ||
                this._connectionManager.findConnectionByName(idOrName) ||
                this._connectionManager.findConnectionFuzzy(idOrName);
            if (conn) {
                return conn.name;
            }
        }
        // Auto-select for display purposes
        const all = this._connectionManager.getConnections();
        const connected = all.filter(
            (c) => this._pool.getStatus(c.id) === ConnectionStatus.Connected
        );
        if (connected.length === 1) {
            return connected[0].name;
        }
        if (all.length === 1) {
            return all[0].name;
        }
        return idOrName ?? 'unknown';
    }

    /**
     * Returns a short note about the connection mode (Full SSH Access) to include
     * in tool results so the language model knows which commands are allowed.
     */
    protected _modeNote(config: ConnectionConfig): string {
        return config.fullSshAccess
            ? '\n[Connection mode: Full SSH Access — shell read/write/edit commands via remoteRun are allowed on this connection]'
            : '';
    }

    /**
     * Validates that a remote path is within the connection's workspace root (remotePath).
     *
     * Uses posix.normalize() to resolve '..', '.', and duplicate slashes before checking,
     * which prevents path traversal attacks (e.g. /workspace/../../../etc/passwd).
     *
     * When config.remotePath is '/' or empty, no restriction is applied (whole server is workspace).
     *
     * @throws Error if the path is outside the workspace root.
     * @returns The normalized, validated path.
     */
    protected _ensureWithinWorkspace(inputPath: string, config: ConnectionConfig): string {
        // Reject local file:// URIs and Windows-style paths — this tool is for remote servers only.
        if (/^file:\/\/\//i.test(inputPath) || /^[A-Za-z]:[\\]/.test(inputPath) || /^[\\/]{2}[^\\/]/.test(inputPath)) {
            throw new Error(
                `Path "${inputPath}" is a local file path. This tool only works with remote server paths. Use VS Code native tools for local files.`
            );
        }

        // .trim() — guard against invisible Unicode chars (e.g. NBSP, ZWSP) from user input.
        const trimmedInput = inputPath.trim();

        // Strip remote-bridge://UUID prefix if the agent included it — extract the bare server path.
        let cleanPath = trimmedInput;
        if (cleanPath.startsWith('remote-bridge://')) {
            const afterScheme = cleanPath.substring('remote-bridge://'.length);
            const slashIndex = afterScheme.indexOf('/');
            cleanPath = slashIndex >= 0 ? afterScheme.substring(slashIndex) : '/';
        }

        const rootPath = (config.remotePath || '/').trim();
        if (rootPath === '/') {
            // Always normalize even for root — prevents path traversal via /../
            return posix.normalize(cleanPath);
        }

        // When full SSH access is enabled, skip workspace boundary check
        // but still normalize the path to prevent traversal representations.
        if (config.fullSshAccess) {
            if (!cleanPath.startsWith('/')) {
                cleanPath = rootPath.replace(/\/+$/, '') + '/' + cleanPath;
            }
            return posix.normalize(cleanPath);
        }

        // Resolve relative paths against workspace root.
        if (!cleanPath.startsWith('/')) {
            cleanPath = rootPath.replace(/\/+$/, '') + '/' + cleanPath;
        }

        const normalized = posix.normalize(cleanPath);
        const normalizedRoot = posix.normalize(rootPath).replace(/\/+$/, '');
        if (normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/')) {
            return normalized;
        }
        throw new Error(
            `Path "${inputPath}" is outside the workspace root "${config.remotePath}". ` +
            `(Normalized: "${normalized}" vs root: "${normalizedRoot}"). ` +
            `Use paths within the workspace root directory, or enable Full SSH Access in the connection's Advanced settings to access any path on the server.`
        );
    }
}
