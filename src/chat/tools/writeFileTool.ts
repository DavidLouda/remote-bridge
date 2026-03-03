import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { RemoteBridgeFileSystemProvider } from '../../providers/fileSystemProvider';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface WriteFileInput {
    connectionName: string;
    path: string;
    content: string;
    startLine?: number;
    endLine?: number;
    mode?: 'replace' | 'insert';
}

/**
 * LM Tool: Write content to a file on a remote server.
 */
export class WriteFileTool extends BaseTool implements vscode.LanguageModelTool<WriteFileInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool,
        private readonly _cache: CacheService,
        private readonly _fsProvider: RemoteBridgeFileSystemProvider
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        const { startLine, endLine, content, path, mode } = options.input;
        const isPartial = startLine !== undefined;
        const isInsert = mode === 'insert';
        let summary: string;
        if (isInsert && startLine !== undefined) {
            summary = vscode.l10n.t('Insert {0} bytes after line {1} in {2} on {3}', String(content.length), String(startLine), path, connName);
        } else if (isPartial && endLine !== undefined) {
            summary = vscode.l10n.t('Replace lines {0}-{1} in {2} on {3}', String(startLine), String(endLine), path, connName);
        } else {
            summary = vscode.l10n.t('Write {0} bytes to {1} on {2}', String(content.length), path, connName);
        }

        return {
            invocationMessage: summary + '...',
            confirmationMessages: {
                title: vscode.l10n.t('Write Remote File'),
                message: new vscode.MarkdownString(summary + '?'),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<WriteFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: remotePath, content, startLine, endLine, mode } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        const isInsert = mode === 'insert';
        const isPartial = startLine !== undefined;

        // Validate line numbers
        if (startLine !== undefined) {
            if (!Number.isInteger(startLine) || startLine < 1) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('startLine must be a positive integer (got {0})', String(startLine))
                    ),
                ]);
            }
        }
        if (endLine !== undefined) {
            if (!Number.isInteger(endLine) || endLine < 1) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('endLine must be a positive integer (got {0})', String(endLine))
                    ),
                ]);
            }
            if (startLine !== undefined && endLine < startLine) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('endLine ({0}) must be >= startLine ({1})', String(endLine), String(startLine))
                    ),
                ]);
            }
        }

        if (isInsert && startLine !== undefined) {
            // ── Insert mode: insert content AFTER startLine ──
            if (adapter.supportsExec && adapter.exec) {
                const os = config.os ?? 'linux';
                let contentToWrite = content;
                if (contentToWrite && !contentToWrite.endsWith('\n')) {
                    contentToWrite += '\n';
                }
                // head -n startLine → keep lines 1..startLine, cat → insert new content, tail → keep rest
                const cmd = shell.writeInsert(remotePath, startLine, os);
                if (adapter.execWithStdin) {
                    const result = await adapter.execWithStdin(cmd, contentToWrite);
                    if (result.exitCode !== 0) {
                        throw new Error(result.stderr || vscode.l10n.t('Failed to write file'));
                    }
                } else {
                    throw new Error(vscode.l10n.t('Insert mode requires SSH exec support'));
                }
            } else {
                // FTP fallback
                const existing = await adapter.readFile(remotePath);
                const existingText = new TextDecoder().decode(existing);
                const lines = existingText.split('\n');
                const newLines = content ? content.split('\n') : [];
                if (content.endsWith('\n') && newLines.length > 0 && newLines[newLines.length - 1] === '') {
                    newLines.pop();
                }
                // Insert after startLine (0 deletions)
                lines.splice(startLine, 0, ...newLines);
                const encoded = new TextEncoder().encode(lines.join('\n'));
                await adapter.writeFile(remotePath, encoded, { create: true, overwrite: true });
            }
        } else if (isPartial && endLine !== undefined) {
            // ── Partial write: replace specific lines ──
            if (adapter.supportsExec && adapter.exec) {
                // SSH: server-side line replacement using head/cat/tail — only changed lines travel over the wire
                const os = config.os ?? 'linux';
                let contentToWrite = content;
                if (contentToWrite && !contentToWrite.endsWith('\n')) {
                    contentToWrite += '\n';
                }

                if (!contentToWrite || contentToWrite === '\n') {
                    // Delete lines only (no stdin needed)
                    const cmd = shell.writeDelete(remotePath, startLine, endLine, os);
                    const result = await adapter.exec(cmd);
                    if (result.exitCode !== 0) {
                        throw new Error(result.stderr || vscode.l10n.t('Failed to write file'));
                    }
                } else {
                    // Replace lines: head (keep before) + cat stdin (new content) + tail (keep after)
                    const cmd = shell.writeReplace(remotePath, startLine, endLine, os);
                    if (adapter.execWithStdin) {
                        const result = await adapter.execWithStdin(cmd, contentToWrite);
                        if (result.exitCode !== 0) {
                            throw new Error(result.stderr || vscode.l10n.t('Failed to write file'));
                        }
                    } else {
                        throw new Error(vscode.l10n.t('Partial write requires SSH exec support'));
                    }
                }
            } else {
                // FTP fallback: download → modify in-memory → upload
                const existing = await adapter.readFile(remotePath);
                const existingText = new TextDecoder().decode(existing);
                const lines = existingText.split('\n');

                const newLines = content ? content.split('\n') : [];
                // If content ends with \n, the split creates an extra empty element — drop it
                if (content.endsWith('\n') && newLines.length > 0 && newLines[newLines.length - 1] === '') {
                    newLines.pop();
                }

                lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
                const encoded = new TextEncoder().encode(lines.join('\n'));
                await adapter.writeFile(remotePath, encoded, { create: true, overwrite: true });
            }
        } else {
            // ── Full write (existing behaviour) ──
            const encoded = new TextEncoder().encode(content);
            await adapter.writeFile(remotePath, encoded, { create: true, overwrite: true });
        }

        // Invalidate cache
        this._cache.invalidatePath(config.id, remotePath);
        const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
        this._cache.invalidatePath(config.id, parentDir);

        // Notify Explorer — use Created for full writes (new files) so the parent directory refreshes
        const changeType = (isPartial || isInsert)
            ? vscode.FileChangeType.Changed
            : vscode.FileChangeType.Created;
        this._fsProvider.notifyExternalChange(config.id, remotePath, changeType);

        let msg: string;
        if (isInsert && startLine !== undefined) {
            msg = vscode.l10n.t('Successfully inserted content after line {0} in {1}', String(startLine), remotePath);
        } else if (isPartial && endLine !== undefined) {
            msg = vscode.l10n.t('Successfully replaced lines {0}-{1} in {2}', String(startLine), String(endLine), remotePath);
        } else {
            msg = vscode.l10n.t('Successfully written {0} bytes to {1}', String(new TextEncoder().encode(content).length), remotePath);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(msg),
        ]);
    }
}
