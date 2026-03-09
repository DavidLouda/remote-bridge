import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { RemoteBridgeFileSystemProvider } from '../../providers/fileSystemProvider';
import { RemoteBridgeFileDecorationProvider } from '../../providers/fileDecorationProvider';
import { BaseTool } from './baseTool';

interface RenameFileInput {
    connectionName?: string;
    oldPath: string;
    newPath: string;
    overwrite?: boolean;
}

/**
 * LM Tool: Rename or move a file/directory on a remote server.
 * Works with all protocols (SSH, SFTP, FTP).
 */
export class RenameFileTool extends BaseTool implements vscode.LanguageModelTool<RenameFileInput> {
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
        options: vscode.LanguageModelToolInvocationPrepareOptions<RenameFileInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t(
                'Renaming {0} → {1} on {2}...',
                options.input.oldPath,
                options.input.newPath,
                connName
            ),
            confirmationMessages: {
                title: vscode.l10n.t('Rename Remote File'),
                message: new vscode.MarkdownString(
                    vscode.l10n.t(
                        'Rename `{0}` → `{1}` on **{2}**?',
                        options.input.oldPath,
                        options.input.newPath,
                        connName
                    )
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RenameFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, oldPath, newPath, overwrite } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        await adapter.rename(oldPath, newPath, { overwrite: overwrite ?? false });

        // Invalidate cache for both paths and their parent directories
        this._cache.invalidatePath(config.id, oldPath);
        this._cache.invalidatePath(config.id, newPath);
        const oldParent = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
        const newParent = newPath.substring(0, newPath.lastIndexOf('/')) || '/';
        this._cache.invalidatePath(config.id, oldParent);
        if (newParent !== oldParent) {
            this._cache.invalidatePath(config.id, newParent);
        }

        // Notify Explorer
        this._fsProvider.notifyExternalChange(config.id, oldPath, vscode.FileChangeType.Deleted);
        this._fsProvider.notifyExternalChange(config.id, newPath, vscode.FileChangeType.Created);
        this._decorations.markDeleted(config.id, oldPath);
        this._decorations.markRenamed(config.id, newPath);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                vscode.l10n.t('Successfully renamed {0} → {1}', oldPath, newPath)
            ),
        ]);
    }
}
