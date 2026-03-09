import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { RemoteBridgeFileSystemProvider } from '../../providers/fileSystemProvider';
import { RemoteBridgeFileDecorationProvider } from '../../providers/fileDecorationProvider';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface WriteFileInput {
    connectionName?: string;
    path: string;
    content: string;
    search?: string;
    startLine?: number;
    endLine?: number;
    mode?: 'replace' | 'insert' | 'append';
    insertPosition?: 'before' | 'after';
    replaceAll?: boolean;
}

/**
 * LM Tool: Write content to a file on a remote server.
 */
export class WriteFileTool extends BaseTool implements vscode.LanguageModelTool<WriteFileInput> {
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
        options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        const { startLine, endLine, content, path, mode, search, insertPosition } = options.input;
        const isPartial = startLine !== undefined;
        const isInsert = mode === 'insert';
        const isAppend = mode === 'append';
        let summary: string;
        if (isAppend) {
            summary = vscode.l10n.t('Append {0} bytes to {1} on {2}', String(content.length), path, connName);
        } else if (search !== undefined && insertPosition) {
            summary = vscode.l10n.t('Insert content {0} "{1}" in {2} on {3}', insertPosition === 'before' ? 'before' : 'after', search.length > 60 ? search.substring(0, 60) + '…' : search, path, connName);
        } else if (search !== undefined) {
            summary = vscode.l10n.t('Replace text in {0} on {1}', path, connName);
        } else if (isInsert && startLine !== undefined) {
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

        const { connectionName, path: remotePath, content, search, startLine, endLine, mode, insertPosition, replaceAll } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        // ── Append mode ──
        if (mode === 'append') {
            let contentToWrite = content;
            if (contentToWrite && !contentToWrite.startsWith('\n')) {
                contentToWrite = '\n' + contentToWrite;
            }

            if (adapter.supportsExec && adapter.execWithStdin) {
                const os = config.os ?? 'linux';
                const cmd = shell.writeAppend(remotePath, os);
                const result = await adapter.execWithStdin(cmd, contentToWrite);
                if (result.exitCode !== 0) {
                    throw new Error(result.stderr || vscode.l10n.t('Failed to write file'));
                }
            } else {
                // FTP fallback: download → concat → upload
                const existing = await adapter.readFile(remotePath);
                const existingText = new TextDecoder().decode(existing);
                const modified = existingText + contentToWrite;
                await adapter.writeFile(remotePath, new TextEncoder().encode(modified), { create: true, overwrite: true });
            }

            this._cache.invalidatePath(config.id, remotePath);
            const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
            this._cache.invalidatePath(config.id, parentDir);
            this._fsProvider.notifyExternalChange(config.id, remotePath, vscode.FileChangeType.Changed);
            this._decorations.markModified(config.id, remotePath);

            // Return context: read last few lines so agent can verify
            const confirmMsg = vscode.l10n.t('Successfully appended {0} bytes to {1}', String(new TextEncoder().encode(content).length), remotePath);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(confirmMsg),
            ]);
        }

        // ── Search-based modes: replace, insertBefore/After, replaceAll ──
        if (search !== undefined) {
            const existing = await adapter.readFile(remotePath);
            const rawText = new TextDecoder().decode(existing);

            // Normalize line endings and Unicode (NFC) for reliable matching on both ends.
            // We normalize a working copy for searching only; the original rawText is used
            // for slicing so CRLF files on Windows remote OS are preserved.
            const existingText = rawText.replace(/\r\n/g, '\n').normalize('NFC');
            const normalizedSearch = search.replace(/\r\n/g, '\n').normalize('NFC');

            const idx = existingText.indexOf(normalizedSearch);
            if (idx === -1) {
                const lines = existingText.split('\n');
                const lineCount = lines.length;
                // Try to find just the first line of search to give a useful hint
                const firstSearchLine = normalizedSearch.split('\n')[0].trim();
                let hintMsg = '';
                if (firstSearchLine) {
                    const firstLineIdx = lines.findIndex((l) => l.includes(firstSearchLine));
                    if (firstLineIdx !== -1) {
                        const ctxStart = Math.max(0, firstLineIdx - 2);
                        const ctxEnd = Math.min(lines.length - 1, firstLineIdx + 2);
                        const ctxSnippet = lines.slice(ctxStart, ctxEnd + 1)
                            .map((l, i) => `${ctxStart + i + 1}: ${l}`)
                            .join('\n');
                        hintMsg = vscode.l10n.t(
                            ' First line of search text found at line {0} but full multi-line match failed — check whitespace or line ending differences. Context:\n{1}',
                            String(firstLineIdx + 1),
                            ctxSnippet
                        );
                    }
                }
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Search text not found in {0} ({1} lines). Use readFile with search parameter to inspect exact content before retrying.', remotePath, String(lineCount))
                        + hintMsg
                    ),
                ]);
            }

            let modified: string;
            let replacementCount = 1;
            let actionLine: number;

            if (insertPosition === 'before') {
                // Insert content BEFORE the search text (search text stays)
                modified = existingText.substring(0, idx) + content + existingText.substring(idx);
                actionLine = existingText.substring(0, idx).split('\n').length;
            } else if (insertPosition === 'after') {
                // Insert content AFTER the search text (search text stays)
                const afterIdx = idx + normalizedSearch.length;
                modified = existingText.substring(0, afterIdx) + content + existingText.substring(afterIdx);
                actionLine = existingText.substring(0, afterIdx).split('\n').length;
            } else if (replaceAll) {
                // Replace ALL occurrences
                modified = existingText;
                let searchIdx = 0;
                replacementCount = 0;
                const parts: string[] = [];
                while (true) {
                    const foundIdx = modified.indexOf(normalizedSearch, searchIdx);
                    if (foundIdx === -1) {
                        parts.push(modified.substring(searchIdx));
                        break;
                    }
                    parts.push(modified.substring(searchIdx, foundIdx));
                    parts.push(content);
                    replacementCount++;
                    searchIdx = foundIdx + normalizedSearch.length;
                }
                modified = parts.join('');
                actionLine = existingText.substring(0, idx).split('\n').length;
            } else {
                // Replace first occurrence
                modified = existingText.substring(0, idx) + content + existingText.substring(idx + normalizedSearch.length);
                actionLine = existingText.substring(0, idx).split('\n').length;
            }

            const encoded = new TextEncoder().encode(modified);
            await adapter.writeFile(remotePath, encoded, { create: true, overwrite: true });

            // Extract context (up to 3 lines before and after the edited block)
            const modifiedLines = modified.split('\n');
            const newContentLineCount = content === '' ? 0
                : content.endsWith('\n') ? content.split('\n').length - 1
                : content.split('\n').length;
            const contextStartIdx = Math.max(0, actionLine - 1 - 2);  // 0-indexed
            const contextEndIdx = Math.min(modifiedLines.length - 1, actionLine - 1 + Math.max(newContentLineCount, 1) + 2);
            const contextSlice = modifiedLines.slice(contextStartIdx, contextEndIdx + 1);
            const numberedContext = contextSlice.map((line, i) => `${contextStartIdx + i + 1}: ${line}`).join('\n');

            // Invalidate cache
            this._cache.invalidatePath(config.id, remotePath);
            const parentDirSearch = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
            this._cache.invalidatePath(config.id, parentDirSearch);
            this._fsProvider.notifyExternalChange(config.id, remotePath, vscode.FileChangeType.Changed);
            this._decorations.markModified(config.id, remotePath);

            let successMsg: string;
            if (insertPosition) {
                successMsg = vscode.l10n.t('Successfully inserted content {0} line {1} in {2}', insertPosition === 'before' ? 'before' : 'after', String(actionLine), remotePath);
            } else if (replaceAll) {
                successMsg = vscode.l10n.t('Successfully replaced {0} occurrence(s) in {1}', String(replacementCount), remotePath);
            } else {
                successMsg = vscode.l10n.t('Successfully replaced text at line {0} in {1}', String(actionLine), remotePath);
            }
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `${successMsg}\n\nContext around edit (lines ${contextStartIdx + 1}-${contextEndIdx + 1}):\n\`\`\`\n${numberedContext}\n\`\`\``
                ),
            ]);
        }

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

        // Track change for AI agent self-audit
        if (isPartial || isInsert) {
            this._decorations.markModified(config.id, remotePath);
        } else {
            this._decorations.markAdded(config.id, remotePath);
        }

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
