import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';
import { RemoteAdapter } from '../../adapters/adapter';

interface SearchFilesInput {
    connectionName?: string;
    path: string;
    pattern?: string;
    namePattern?: string;
    contextLines?: number;
    maxResults?: number;
    caseSensitive?: boolean;
    type?: 'file' | 'directory' | 'any';
    excludePattern?: string;
}

/**
 * LM Tool: Unified search — content grep or file-name find on a remote server.
 * Mode is auto-detected: `pattern` → grep mode; `namePattern` only → find mode.
 * SSH uses server-side commands; FTP falls back to client-side recursive scan.
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
        const { pattern, namePattern, path } = options.input;
        if (pattern) {
            return {
                invocationMessage: vscode.l10n.t(
                    'Searching for "{0}" in {1} on {2}...',
                    pattern,
                    path,
                    connName
                ),
            };
        }
        return {
            invocationMessage: vscode.l10n.t(
                'Finding files matching {0} in {1} on {2}...',
                namePattern ?? '*',
                path,
                connName
            ),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchFilesInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: originalPath, pattern, namePattern, contextLines, maxResults, caseSensitive, type, excludePattern } = options.input;

        if (!pattern && !namePattern) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    'Provide either `pattern` (content search) or `namePattern` (file name search).'
                ),
            ]);
        }

        const config = this._resolveConnection(connectionName);
        const remotePath = this._ensureWithinWorkspace(originalPath, config);
        const adapter = await this._pool.getAdapter(config);

        // ── Content search mode ──────────────────────────────────────────────
        if (pattern) {
            const limit = maxResults ?? 100;
            const ctx = contextLines ?? 0;
            const isCaseSensitive = caseSensitive ?? false;

            if (adapter.supportsExec && adapter.exec) {
                const os = config.os ?? 'linux';
                const grepCommand = shell.grepSearch(pattern, remotePath, namePattern, os, ctx, isCaseSensitive, limit, excludePattern);
                const result = await adapter.exec(grepCommand);

                if (result.exitCode === 1) {
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
            }

            // FTP fallback: recursive readDirectory + local regex match
            const results: string[] = [];
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, isCaseSensitive ? 'g' : 'gi');
            } catch {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Invalid regex pattern: "{0}"', pattern)
                    ),
                ]);
            }
            let matchCount = 0;
            const maxMatches = Math.min(limit, 200);
            const globRegex = namePattern ? this._globToRegex(namePattern) : null;
            const excludeRegex = excludePattern ? this._globToRegex(excludePattern) : null;

            const searchDir = async (dirPath: string): Promise<void> => {
                if (matchCount >= maxMatches || token.isCancellationRequested) { return; }
                let entries;
                try { entries = await adapter.readDirectory(dirPath); } catch { return; }

                for (const entry of entries) {
                    if (matchCount >= maxMatches || token.isCancellationRequested) { break; }
                    const fullPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
                    if (excludeRegex && excludeRegex.test(fullPath)) { continue; }
                    if (entry.type === vscode.FileType.Directory) { await searchDir(fullPath); continue; }
                    if (entry.type !== vscode.FileType.File) { continue; }
                    if (globRegex && !globRegex.test(entry.name)) { continue; }
                    if (entry.size > 1024 * 1024) { continue; } // skip >1 MB

                    try {
                        const content = await adapter.readFile(fullPath);
                        const text = new TextDecoder().decode(content);
                        const lines = text.split('\n');
                        for (let i = 0; i < lines.length && matchCount < maxMatches; i++) {
                            if (regex.test(lines[i])) {
                                if (ctx > 0) {
                                    const ctxStart = Math.max(0, i - ctx);
                                    const ctxEnd = Math.min(lines.length - 1, i + ctx);
                                    for (let j = ctxStart; j <= ctxEnd; j++) {
                                        results.push(`${fullPath}:${j + 1}:${lines[j].trimEnd()}`);
                                    }
                                    results.push('--');
                                } else {
                                    results.push(`${fullPath}:${i + 1}:${lines[i].trim()}`);
                                }
                                matchCount++;
                            }
                            regex.lastIndex = 0;
                        }
                    } catch { /* skip unreadable files */ }
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

        // ── File name search mode ────────────────────────────────────────────
        const limit = maxResults ?? 50;
        const typeFilter = type === 'file' || type === 'directory' ? type : undefined;

        if (adapter.supportsExec && adapter.exec) {
            const os = config.os ?? 'linux';
            const cmd = shell.findCmd(remotePath, namePattern!, limit, os, typeFilter, excludePattern);
            const result = await adapter.exec(cmd);

            if (result.exitCode !== 0 && !result.stdout.trim()) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Find command failed: {0}', result.stderr || 'Unknown error')
                    ),
                ]);
            }

            const output = result.stdout.trim();
            if (!output) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('No files found matching {0} in {1}', namePattern!, remotePath)
                    ),
                ]);
            }
            const lines = output.split('\n').filter(l => l.length > 0);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `[${lines.length} result(s) for "${namePattern}" in ${remotePath}]\n${output}`
                ),
            ]);
        }

        // FTP fallback: recursive readDirectory with glob matching
        const matches: string[] = [];
        const excludeRegex = excludePattern ? this._globToRegex(excludePattern) : null;
        await this._findRecursive(adapter, remotePath, namePattern!, matches, limit, 0, 10, typeFilter, excludeRegex);

        if (matches.length === 0) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t('No files found matching {0} in {1}', namePattern!, remotePath)
                ),
            ]);
        }
        const output = matches.join('\n');
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `[${matches.length} result(s) for "${namePattern}" in ${remotePath}]\n${output}`
            ),
        ]);
    }

    private async _findRecursive(
        adapter: RemoteAdapter,
        dir: string,
        pattern: string,
        matches: string[],
        limit: number,
        depth: number,
        maxDepth: number,
        typeFilter?: 'file' | 'directory',
        excludeRegex?: RegExp | null
    ): Promise<void> {
        if (depth > maxDepth || matches.length >= limit) { return; }
        let entries;
        try { entries = await adapter.readDirectory(dir); } catch { return; }

        const regex = this._globToRegex(pattern);

        for (const entry of entries) {
            if (matches.length >= limit) { break; }
            const fullPath = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
            if (excludeRegex && excludeRegex.test(fullPath)) { continue; }

            if (regex.test(entry.name)) {
                const isFile = entry.type === vscode.FileType.File;
                const isDir = entry.type === vscode.FileType.Directory;
                if (!typeFilter || (typeFilter === 'file' && isFile) || (typeFilter === 'directory' && isDir)) {
                    matches.push(fullPath);
                }
            }
            if (entry.type === vscode.FileType.Directory) {
                await this._findRecursive(adapter, fullPath, pattern, matches, limit, depth + 1, maxDepth, typeFilter, excludeRegex);
            }
        }
    }

    private _globToRegex(glob: string): RegExp {
        let regex = '^';
        for (let i = 0; i < glob.length; i++) {
            const c = glob[i];
            switch (c) {
                case '*': regex += '[^/]*'; break;
                case '?': regex += '.'; break;
                case '[': {
                    const closeIdx = glob.indexOf(']', i + 1);
                    if (closeIdx >= 0) {
                        let cls = glob.substring(i, closeIdx + 1);
                        if (cls.startsWith('[!')) { cls = '[^' + cls.substring(2); }
                        regex += cls;
                        i = closeIdx;
                    } else {
                        regex += '\\[';
                    }
                    break;
                }
                case '.': case '(': case ')': case '+': case '|':
                case '^': case '$': case '{': case '}': case '\\':
                    regex += `\\${c}`; break;
                default: regex += c;
            }
        }
        regex += '$';
        return new RegExp(regex, 'i');
    }
}
