import * as vscode from 'vscode';
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
}
