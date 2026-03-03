import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

/** Allowed statement prefixes for read-only queries. */
const READ_ONLY_PREFIXES = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;

interface MysqlQueryInput {
    connectionName: string;
    query: string;
    database?: string;
}

/**
 * LM Tool: Execute a read-only SQL query (SELECT, SHOW, DESCRIBE, EXPLAIN)
 * on a remote MySQL/MariaDB server via SSH.
 */
export class MysqlQueryTool extends BaseTool implements vscode.LanguageModelTool<MysqlQueryInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<MysqlQueryInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        const dbInfo = options.input.database ? ` (${options.input.database})` : '';
        return {
            invocationMessage: vscode.l10n.t(
                'Running SQL query on {0}{1}...',
                connName,
                dbInfo
            ),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MysqlQueryInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, query, database } = options.input;

        // Validate that the query is read-only
        if (!READ_ONLY_PREFIXES.test(query)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t(
                        'Only SELECT, SHOW, DESCRIBE, and EXPLAIN queries are allowed. Use the MySQL Execute tool for data-modifying statements.'
                    )
                ),
            ]);
        }

        // Block multi-statement injection (e.g. "SELECT 1; DROP TABLE users")
        const strippedQuery = query.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/;\s*\S/.test(strippedQuery)) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t('Multi-statement queries are not allowed for safety reasons.')
                ),
            ]);
        }

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        if (!adapter.supportsExec || !adapter.execWithStdin) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t(
                        'MySQL queries require an SSH/SFTP connection. {0} uses {1}.',
                        connectionName,
                        config.protocol.toUpperCase()
                    )
                ),
            ]);
        }

        // Use execWithStdin to pipe SQL via stdin — avoids shell escaping issues
        const dbArg = database ? ` '${database.replace(/'/g, "'\\''")}'` : '';
        const os = config.os ?? 'linux';
        const cmd = shell.mysqlCmd(dbArg, os);

        const result = await adapter.execWithStdin(cmd, query);

        if (result.exitCode !== 0) {
            const errorMsg = result.stdout || result.stderr || vscode.l10n.t('Unknown error');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t('SQL error (exit code {0}):\n{1}', String(result.exitCode), errorMsg)
                ),
            ]);
        }

        const output = result.stdout.trim();
        if (!output) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(vscode.l10n.t('Query returned no results.')),
            ]);
        }

        // Count rows (subtract header line)
        const lines = output.split('\n');
        const rowCount = Math.max(0, lines.length - 1);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `[${rowCount} row(s)]\n${output}`
            ),
        ]);
    }
}
