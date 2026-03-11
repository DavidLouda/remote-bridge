import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { RemoteBridgeFileSystemProvider } from '../../providers/fileSystemProvider';
import { RemoteBridgeFileDecorationProvider } from '../../providers/fileDecorationProvider';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface CopyFileInput {
    connectionName?: string;
    sourcePath: string;
    destinationPath: string;
    recursive?: boolean;
}

/**
 * LM Tool: Copy a file or directory on a remote server.
 * On SSH: server-side copy via `cp` (zero data transfer).
 * On FTP: download + upload fallback.
 */
export class CopyFileTool extends BaseTool implements vscode.LanguageModelTool<CopyFileInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool,
        private readonly _cache: CacheService,
        private readonly _fsProvider: RemoteBridgeFileSystemProvider,
        private readonly _decorations: RemoteBridgeFileDecorationProvider
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<CopyFileInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t(
                'Copying {0} → {1} on {2}...',
                options.input.sourcePath,
                options.input.destinationPath,
                connName
            ),
            confirmationMessages: {
                title: vscode.l10n.t('Copy Remote File'),
                message: new vscode.MarkdownString(
                    vscode.l10n.t(
                        'Copy `{0}` → `{1}` on **{2}**?',
                        options.input.sourcePath,
                        options.input.destinationPath,
                        connName
                    )
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CopyFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, sourcePath, destinationPath, recursive } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        if (adapter.supportsExec && adapter.exec) {
            // SSH: server-side copy — no data transferred over the wire
            const os = config.os ?? 'linux';
            const result = await adapter.exec(shell.copyCmd(sourcePath, destinationPath, recursive ?? true, os));
            if (result.exitCode !== 0) {
                const errorMsg = result.stdout || result.stderr || vscode.l10n.t('Unknown error');
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Copy failed (exit code {0}): {1}', String(result.exitCode), errorMsg)
                    ),
                ]);
            }
        } else {
            // FTP fallback: read source → write destination
            try {
                const stat = await adapter.stat(sourcePath);
                if (stat.type === vscode.FileType.Directory) {
                    // Recursive directory copy on FTP
                    if (recursive === false) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(
                                vscode.l10n.t('Cannot copy directory without recursive flag.')
                            ),
                        ]);
                    }
                    await this._copyDirectoryFtp(adapter, sourcePath, destinationPath);
                } else {
                    const sourceMode = adapter.getUnixMode
                        ? await adapter.getUnixMode(sourcePath)
                        : undefined;
                    const content = await adapter.readFile(sourcePath);
                    await adapter.writeFile(destinationPath, content, { create: true, overwrite: true });
                    if (sourceMode !== undefined && adapter.chmod) {
                        await adapter.chmod(destinationPath, sourceMode);
                    }
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(vscode.l10n.t('Copy failed: {0}', msg)),
                ]);
            }
        }

        // Invalidate cache for destination and its parent
        this._cache.invalidatePath(config.id, destinationPath);
        const destParent = destinationPath.substring(0, destinationPath.lastIndexOf('/')) || '/';
        this._cache.invalidatePath(config.id, destParent);

        // Notify Explorer
        this._fsProvider.notifyExternalChange(config.id, destinationPath, vscode.FileChangeType.Created);
        this._decorations.markAdded(config.id, destinationPath);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                vscode.l10n.t('Successfully copied {0} → {1}', sourcePath, destinationPath)
            ),
        ]);
    }

    /**
     * Recursively copy a directory on FTP (download + upload each file).
     */
    private async _copyDirectoryFtp(
        adapter: import('../../adapters/adapter').RemoteAdapter,
        srcDir: string,
        dstDir: string
    ): Promise<void> {
        await adapter.mkdir(dstDir);
        const entries = await adapter.readDirectory(srcDir);
        for (const entry of entries) {
            const srcPath = srcDir === '/' ? `/${entry.name}` : `${srcDir}/${entry.name}`;
            const dstPath = dstDir === '/' ? `/${entry.name}` : `${dstDir}/${entry.name}`;
            if (entry.type === vscode.FileType.Directory) {
                await this._copyDirectoryFtp(adapter, srcPath, dstPath);
            } else {
                const srcMode = adapter.getUnixMode
                    ? await adapter.getUnixMode(srcPath)
                    : undefined;
                const content = await adapter.readFile(srcPath);
                await adapter.writeFile(dstPath, content, { create: true, overwrite: true });
                if (srcMode !== undefined && adapter.chmod) {
                    await adapter.chmod(dstPath, srcMode);
                }
            }
        }
    }
}
