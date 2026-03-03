import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface StatFileInput {
    connectionName: string;
    path: string;
}

/**
 * LM Tool: Get metadata (type, size, dates, permissions, existence) of a remote file or directory.
 * Works with all protocols (SSH, SFTP, FTP).
 */
export class StatFileTool extends BaseTool implements vscode.LanguageModelTool<StatFileInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool,
        private readonly _cache: CacheService
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<StatFileInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t(
                'Getting info for {0} on {1}...',
                options.input.path,
                connName
            ),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<StatFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: remotePath } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        try {
            // Check cache first
            const cacheKey = this._cache.makeKey(config.id, remotePath);
            let stat = this._cache.getStat(cacheKey);

            // Run stat and permissions check in parallel when possible
            let permissions: string | undefined;
            if (!stat) {
                const statPromise = adapter.stat(remotePath);
                let permPromise: Promise<string | undefined> = Promise.resolve(undefined);
                if (adapter.supportsExec && adapter.exec) {
                    const os = config.os ?? 'linux';
                    permPromise = adapter.exec(
                        shell.statPermissions(remotePath, os)
                    ).then(r => r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined)
                     .catch(() => undefined);
                }
                [stat, permissions] = await Promise.all([statPromise, permPromise]);
                // Populate cache for future lookups
                this._cache.setStat(cacheKey, stat);
            } else if (adapter.supportsExec && adapter.exec) {
                // Stat is cached, still fetch permissions
                try {
                    const os = config.os ?? 'linux';
                    const permResult = await adapter.exec(
                        shell.statPermissions(remotePath, os)
                    );
                    if (permResult.exitCode === 0 && permResult.stdout.trim()) {
                        permissions = permResult.stdout.trim();
                    }
                } catch {
                    // Ignore permission check errors
                }
            }

            const typeStr =
                stat.type === vscode.FileType.Directory
                    ? 'directory'
                    : stat.type === vscode.FileType.SymbolicLink
                        ? 'symlink'
                        : 'file';

            // Format human-readable size
            let sizeStr: string;
            if (stat.size < 1024) {
                sizeStr = `${stat.size} B`;
            } else if (stat.size < 1024 * 1024) {
                sizeStr = `${(stat.size / 1024).toFixed(1)} KB`;
            } else {
                sizeStr = `${(stat.size / (1024 * 1024)).toFixed(2)} MB`;
            }

            const lines = [
                `[${remotePath}]`,
                `Type: ${typeStr}`,
                `Size: ${sizeStr} (${stat.size} bytes)`,
            ];

            if (stat.mtime) {
                lines.push(`Modified: ${new Date(stat.mtime).toISOString()}`);
            }
            if (stat.ctime) {
                lines.push(`Created: ${new Date(stat.ctime).toISOString()}`);
            }

            if (permissions) {
                lines.push(`Permissions: ${permissions}`);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(lines.join('\n')),
            ]);
        } catch (err: unknown) {
            // Check if file doesn't exist
            if (
                err instanceof vscode.FileSystemError ||
                (err instanceof Error && /no such file|not found|ENOENT/i.test(err.message))
            ) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `[${remotePath}]\nExists: false`
                    ),
                ]);
            }
            throw err;
        }
    }
}
