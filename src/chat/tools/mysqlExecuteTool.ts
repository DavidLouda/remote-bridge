import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface MysqlExecuteInput {
    connectionName?: string;
    sql: string;
    database?: string;
    user?: string;
    password?: string;
    host?: string;
}

/**
 * LM Tool: Execute a data-modifying SQL statement (INSERT, UPDATE, DELETE, CREATE, ALTER, DROP)
 * on a remote MySQL/MariaDB server via SSH.
 * Requires user confirmation before execution.
 */
export class MysqlExecuteTool extends BaseTool implements vscode.LanguageModelTool<MysqlExecuteInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<MysqlExecuteInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        const dbInfo = options.input.database ? ` (${options.input.database})` : '';
        const userInfo = options.input.user ? ` as ${options.input.user}` : '';
        const pwInfo = options.input.password ? ' (password: ****)' : '';
        const sqlPreview = options.input.sql.length > 120
            ? options.input.sql.substring(0, 120) + '…'
            : options.input.sql;

        return {
            invocationMessage: vscode.l10n.t(
                'Executing SQL on {0}{1}{2}{3}...',
                connName,
                dbInfo,
                userInfo,
                pwInfo
            ),
            confirmationMessages: {
                title: vscode.l10n.t('Execute SQL Statement'),
                message: new vscode.MarkdownString(
                    vscode.l10n.t(
                        'Execute on **{0}**{1}?\n\n```sql\n{2}\n```',
                        connName,
                        dbInfo,
                        sqlPreview
                    )
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MysqlExecuteInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, sql, database, user, password, host } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        if (!adapter.supportsExec || !adapter.execWithStdin) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t(
                        'MySQL execution requires an SSH/SFTP connection. {0} uses {1}.',
                        config.name,
                        config.protocol.toUpperCase()
                    )
                ),
            ]);
        }

        // Use execWithStdin to pipe SQL via stdin — avoids shell escaping issues with complex SQL
        const dbArg = database ? ` '${database.replace(/'/g, "'\\''")}'` : '';
        const os = config.os ?? 'linux';
        const cmd = shell.mysqlCmd(dbArg, os, user, password, host);

        const result = await adapter.execWithStdin(cmd, sql);

        if (result.exitCode !== 0) {
            const errorMsg = result.stdout || result.stderr || vscode.l10n.t('Unknown error');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t('SQL error (exit code {0}):\n{1}', String(result.exitCode), errorMsg)
                ),
            ]);
        }

        const output = result.stdout.trim();
        const msg = output
            ? vscode.l10n.t('SQL executed successfully.\n{0}', output)
            : vscode.l10n.t('SQL executed successfully.');

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(msg),
        ]);
    }
}
