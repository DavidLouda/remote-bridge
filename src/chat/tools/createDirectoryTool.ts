import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { RemoteBridgeFileSystemProvider } from '../../providers/fileSystemProvider';
import { BaseTool } from './baseTool';

interface CreateDirectoryInput {
    connectionName: string;
    path: string;
}

/**
 * LM Tool: Create a directory on a remote server.
 * Creates parent directories as needed.
 */
export class CreateDirectoryTool extends BaseTool implements vscode.LanguageModelTool<CreateDirectoryInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool,
        private readonly _cache: CacheService,
        private readonly _fsProvider: RemoteBridgeFileSystemProvider
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<CreateDirectoryInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t(
                'Creating directory {0} on {1}...',
                options.input.path,
                connName
            ),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CreateDirectoryInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: remotePath } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        await adapter.mkdir(remotePath);

        // Invalidate cache for the parent
        const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
        this._cache.invalidatePath(config.id, parentDir);

        // Notify Explorer
        this._fsProvider.notifyExternalChange(config.id, remotePath, vscode.FileChangeType.Created);

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                vscode.l10n.t('Successfully created directory {0}', remotePath)
            ),
        ]);
    }
}
