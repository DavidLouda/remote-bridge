import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';

/**
 * LM Tool: List all saved remote connections with their status.
 * No connectionName parameter — this is a global introspection tool.
 */
export class ListConnectionsTool extends BaseTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ) {
        return {
            invocationMessage: vscode.l10n.t('Listing remote connections...'),
        };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const connections = this._connectionManager.getConnections();

        if (connections.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t('No remote connections configured.')
                ),
            ]);
        }

        const lines: string[] = [`[${connections.length} connection(s)]`];

        for (const conn of connections) {
            const status = this._pool.isConnected(conn.id) ? vscode.l10n.t('connected') : vscode.l10n.t('disconnected');
            const port = conn.port ? `:${conn.port}` : '';
            const root = conn.remotePath || '/';
            lines.push(
                `- ${conn.name} | ${conn.protocol.toUpperCase()} | ${conn.host}${port} | root: ${root} | ${status}`
            );
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(lines.join('\n')),
        ]);
    }
}
