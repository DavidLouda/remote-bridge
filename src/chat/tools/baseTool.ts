import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { ConnectionConfig } from '../../types/connection';

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
     * Resolve a connection by ID or display name.
     * Throws if not found.
     */
    protected _resolveConnection(idOrName: string): ConnectionConfig {
        const conn =
            this._connectionManager.getConnection(idOrName) ||
            this._connectionManager.findConnectionByName(idOrName);
        if (!conn) {
            throw new Error(vscode.l10n.t('Connection "{0}" not found', idOrName));
        }
        return conn;
    }

    /**
     * Resolve a connection display name from an ID or name.
     * Falls back to the raw input if not found.
     */
    protected _resolveConnectionName(idOrName: string): string {
        const conn =
            this._connectionManager.getConnection(idOrName) ||
            this._connectionManager.findConnectionByName(idOrName);
        return conn?.name ?? idOrName;
    }
}
