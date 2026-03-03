import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { BaseTool } from './baseTool';

/**
 * LM Tool: List files on a remote server.
 */
export class ListFilesTool extends BaseTool implements vscode.LanguageModelTool<{ connectionName: string; path?: string }> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool,
        private readonly _cache: CacheService
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<{ connectionName: string; path?: string }>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t('Listing files on {0}...', connName),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{ connectionName: string; path?: string }>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const { connectionName, path: remotePath } = options.input;

        const config = this._resolveConnection(connectionName);
        const effectivePath = remotePath || config.remotePath || '/';

        const adapter = await this._pool.getAdapter(config);
        const entries = await adapter.readDirectory(effectivePath);

        // Populate stat cache for each entry so StatFileTool/FSP benefit
        for (const entry of entries) {
            const entryPath = `${effectivePath === '/' ? '' : effectivePath}/${entry.name}`;
            const entryCacheKey = this._cache.makeKey(config.id, entryPath);
            this._cache.setStat(entryCacheKey, {
                type: entry.type,
                ctime: entry.ctime,
                mtime: entry.mtime,
                size: entry.size,
                permissions: entry.permissions,
            });
        }
        // Also cache the directory listing itself
        const dirCacheKey = this._cache.makeKey(config.id, effectivePath);
        this._cache.setDirectory(dirCacheKey, entries.map(e => [e.name, e.type] as [string, number]));

        const result = entries.map((e) => ({
            name: e.name,
            type: e.type === 2 ? 'directory' : e.type === 64 ? 'symlink' : 'file',
            size: e.size,
            modified: new Date(e.mtime).toISOString(),
        }));

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
        ]);
    }
}
