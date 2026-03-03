import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface SearchFilesInput {
    connectionName: string;
    path: string;
    pattern: string;
    fileGlob?: string;
}

/**
 * LM Tool: Search for text patterns in files on a remote server.
 * Uses `grep` over SSH, or downloads and searches locally for FTP.
 */
export class SearchFilesTool extends BaseTool implements vscode.LanguageModelTool<SearchFilesInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<SearchFilesInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t(
                'Searching for "{0}" in {1} on {2}...',
                options.input.pattern,
                options.input.path,
                connName
            ),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchFilesInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: remotePath, pattern, fileGlob } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        if (adapter.supportsExec && adapter.exec) {
            // Use grep over SSH for fast searching
            const os = config.os ?? 'linux';
            const grepCommand = shell.grepSearch(pattern, remotePath, fileGlob, os);

            const result = await adapter.exec(grepCommand);

            if (result.exitCode === 1) {
                // grep returns 1 when no matches found
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('No matches found for "{0}" in {1}', pattern, remotePath)
                    ),
                ]);
            }

            if (result.exitCode !== 0 && result.stderr) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Search error: {0}', result.stderr)
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(result.stdout || vscode.l10n.t('No matches found')),
            ]);
        } else {
            // FTP fallback: recursively list files and search locally
            const results: string[] = [];
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, 'gi');
            } catch {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Invalid regex pattern: "{0}"', pattern)
                    ),
                ]);
            }
            let matchCount = 0;
            const maxMatches = 50;

            const globRegex = fileGlob
                ? new RegExp(
                    '^' +
                    fileGlob
                        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                        .replace(/\*/g, '.*')
                        .replace(/\?/g, '.') +
                    '$'
                  )
                : null;

            const searchDir = async (dirPath: string): Promise<void> => {
                if (matchCount >= maxMatches || token.isCancellationRequested) {
                    return;
                }

                let entries;
                try {
                    entries = await adapter.readDirectory(dirPath);
                } catch {
                    return; // Skip unreadable directories
                }

                for (const entry of entries) {
                    if (matchCount >= maxMatches || token.isCancellationRequested) {
                        break;
                    }

                    const fullPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;

                    if (entry.type === vscode.FileType.Directory) {
                        await searchDir(fullPath);
                        continue;
                    }

                    if (entry.type !== vscode.FileType.File) {
                        continue;
                    }

                    // Apply file glob filter
                    if (globRegex && !globRegex.test(entry.name)) {
                        continue;
                    }

                    // Skip large files (> 1MB)
                    if (entry.size > 1024 * 1024) {
                        continue;
                    }

                    try {
                        const content = await adapter.readFile(fullPath);
                        const text = new TextDecoder().decode(content);
                        const lines = text.split('\n');

                        for (let i = 0; i < lines.length && matchCount < maxMatches; i++) {
                            if (regex.test(lines[i])) {
                                results.push(`${fullPath}:${i + 1}:${lines[i].trim()}`);
                                matchCount++;
                            }
                            regex.lastIndex = 0;
                        }
                    } catch {
                        // Skip unreadable files
                    }
                }
            };

            await searchDir(remotePath);

            if (results.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('No matches found for "{0}" in {1}', pattern, remotePath)
                    ),
                ]);
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(results.join('\n')),
            ]);
        }
    }
}
