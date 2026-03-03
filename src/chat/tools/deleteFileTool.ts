import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { RemoteBridgeFileSystemProvider } from '../../providers/fileSystemProvider';
import { BaseTool } from './baseTool';

interface DeleteFileInput {
    connectionName: string;
    path: string;
    recursive?: boolean;
}

/**
 * LM Tool: Delete a file or directory on a remote server.
 */
export class DeleteFileTool extends BaseTool implements vscode.LanguageModelTool<DeleteFileInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool,
        private readonly _cache: CacheService,
        private readonly _fsProvider: RemoteBridgeFileSystemProvider
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteFileInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t('Deleting {0} on {1}...', options.input.path, connName),
            confirmationMessages: {
                title: vscode.l10n.t('Delete Remote File'),
                message: new vscode.MarkdownString(
                    vscode.l10n.t(
                        'Delete `{0}` on **{1}**?{2}',
                        options.input.path,
                        connName,
                        options.input.recursive
                            ? ' ' + vscode.l10n.t('(recursive)')
                            : ''
                    )
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DeleteFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: remotePath, recursive } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        await adapter.delete(remotePath, { recursive: recursive ?? true });

        // Invalidate cache for the deleted path and parent
        this._cache.invalidatePath(config.id, remotePath);
        const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
        this._cache.invalidatePath(config.id, parentDir);

        // Notify Explorer
        this._fsProvider.notifyExternalChange(config.id, remotePath, vscode.FileChangeType.Deleted);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                vscode.l10n.t('Successfully deleted {0}', remotePath)
            ),
        ]);
    }
}
