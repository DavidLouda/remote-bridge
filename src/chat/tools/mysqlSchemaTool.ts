import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

/** Only allow safe SQL identifiers (alphanumeric + underscore). */
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_]+$/;

interface MysqlSchemaInput {
    connectionName: string;
    database?: string;
    table?: string;
}

/**
 * LM Tool: Inspect MySQL/MariaDB database schema — list databases, tables, or columns.
 * Designed to give the AI agent structural understanding of the database without querying data.
 */
export class MysqlSchemaTool extends BaseTool implements vscode.LanguageModelTool<MysqlSchemaInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<MysqlSchemaInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        const { database, table } = options.input;

        let what: string;
        if (table && database) {
            what = vscode.l10n.t('columns of {0}.{1}', database, table);
        } else if (database) {
            what = vscode.l10n.t('tables in {0}', database);
        } else {
            what = vscode.l10n.t('databases');
        }

        return {
            invocationMessage: vscode.l10n.t('Reading {0} on {1}...', what, connName),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MysqlSchemaInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, database, table } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        if (!adapter.supportsExec || !adapter.exec) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t(
                        'MySQL schema inspection requires an SSH/SFTP connection. {0} uses {1}.',
                        connectionName,
                        config.protocol.toUpperCase()
                    )
                ),
            ]);
        }

        let cmd: string;
        let contextLabel: string;

        if (table && database) {
            if (!SAFE_IDENTIFIER.test(database) || !SAFE_IDENTIFIER.test(table)) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Invalid database or table name. Only alphanumeric characters and underscores are allowed.')
                    ),
                ]);
            }
            // Show table structure: columns, types, keys, defaults + CREATE TABLE + indexes + row count
            const escDb = database.replace(/'/g, "'\\''");
            const escTbl = table.replace(/'/g, "'\\''");
            const dbFlag = ` '${escDb}'`;
            cmd = [
                `echo '=== COLUMNS ==='`,
                shell.mysqlExecInline(`DESCRIBE \\\`${escTbl}\\\``, dbFlag),
                `echo ''`,
                `echo '=== CREATE TABLE ==='`,
                shell.mysqlExecInline(`SHOW CREATE TABLE \\\`${escTbl}\\\`\\\\G`, dbFlag),
                `echo ''`,
                `echo '=== INDEXES ==='`,
                shell.mysqlExecInline(`SHOW INDEX FROM \\\`${escTbl}\\\``, dbFlag),
                `echo ''`,
                `echo '=== ROW COUNT ==='`,
                shell.mysqlExecInline(`SELECT COUNT(*) AS row_count FROM \\\`${escTbl}\\\``, dbFlag),
            ].join(' && ');
            contextLabel = `${database}.${table}`;
        } else if (database) {
            if (!SAFE_IDENTIFIER.test(database)) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Invalid database name. Only alphanumeric characters and underscores are allowed.')
                    ),
                ]);
            }
            // List tables with row counts using information_schema
            const escDb = database.replace(/'/g, "'\\''");
            const dbFlag = ` '${escDb}'`;
            cmd = shell.mysqlExecInline(`SELECT TABLE_NAME, ENGINE, TABLE_ROWS, ROUND(DATA_LENGTH/1024/1024, 2) AS size_mb, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='${escDb}' ORDER BY TABLE_NAME`, dbFlag);
            contextLabel = database;
        } else {
            // List all databases
            cmd = shell.mysqlExecInline('SHOW DATABASES', '');
            contextLabel = vscode.l10n.t('all databases');
        }

        const result = await adapter.exec(cmd);

        if (result.exitCode !== 0) {
            const errorMsg = result.stdout || result.stderr || vscode.l10n.t('Unknown error');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t('MySQL error (exit code {0}):\n{1}', String(result.exitCode), errorMsg)
                ),
            ]);
        }

        const output = result.stdout.trim();
        if (!output) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(vscode.l10n.t('No schema information returned.')),
            ]);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `[Schema: ${contextLabel}]\n${output}`
            ),
        ]);
    }
}
