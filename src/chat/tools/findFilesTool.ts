import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface FindFilesInput {
    connectionName?: string;
    path: string;
    namePattern: string;
    maxResults?: number;
    type?: 'file' | 'directory' | 'any';
    excludePattern?: string;
}

/**
 * LM Tool: Find files and directories by name pattern (glob).
 * SSH: uses `find` command server-side.
 * FTP: recursive readDirectory with glob matching.
 */
export class FindFilesTool extends BaseTool implements vscode.LanguageModelTool<FindFilesInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindFilesInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t(
                'Finding files matching {0} in {1} on {2}...',
                options.input.namePattern,
                options.input.path,
                connName
            ),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindFilesInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: searchPath, namePattern, maxResults, type, excludePattern } = options.input;
        const limit = maxResults ?? 50;
        const typeFilter = type === 'file' || type === 'directory' ? type : undefined;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        let output: string;

        if (adapter.supportsExec && adapter.exec) {
            // SSH: use find command server-side — fast, no data transfer
            const os = config.os ?? 'linux';
            const cmd = shell.findCmd(searchPath, namePattern, limit, os, typeFilter, excludePattern);
            const result = await adapter.exec(cmd);

            if (result.exitCode !== 0 && !result.stdout.trim()) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('Find command failed: {0}', result.stderr || 'Unknown error')
                    ),
                ]);
            }

            output = result.stdout.trim();
        } else {
            // FTP fallback: recursive readDirectory with glob matching
            const matches: string[] = [];
            const excludeRegex = excludePattern ? this._globToRegex(excludePattern) : null;
            await this._findRecursive(adapter, searchPath, namePattern, matches, limit, 0, 10, typeFilter, excludeRegex);
            output = matches.join('\n');
        }

        if (!output) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t('No files found matching {0} in {1}', namePattern, searchPath)
                ),
            ]);
        }

        const lines = output.split('\n').filter(l => l.length > 0);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `[${lines.length} result(s) for "${namePattern}" in ${searchPath}]\n${output}`
            ),
        ]);
    }

    /**
     * Recursively search directories on FTP using glob matching.
     */
    private async _findRecursive(
        adapter: import('../../adapters/adapter').RemoteAdapter,
        dir: string,
        pattern: string,
        matches: string[],
        limit: number,
        depth: number,
        maxDepth: number,
        typeFilter?: 'file' | 'directory',
        excludeRegex?: RegExp | null
    ): Promise<void> {
        if (depth > maxDepth || matches.length >= limit) {
            return;
        }

        let entries;
        try {
            entries = await adapter.readDirectory(dir);
        } catch {
            return; // Skip unreadable directories
        }

        const regex = this._globToRegex(pattern);

        for (const entry of entries) {
            if (matches.length >= limit) {
                break;
            }

            const fullPath = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;

            // Apply exclude filter
            if (excludeRegex && excludeRegex.test(fullPath)) {
                continue;
            }

            if (regex.test(entry.name)) {
                // Apply type filter
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

    /**
     * Convert a simple glob pattern to a RegExp.
     * Supports: * (any chars), ? (single char), [abc] (char class).
     */
    private _globToRegex(glob: string): RegExp {
        let regex = '^';
        for (let i = 0; i < glob.length; i++) {
            const c = glob[i];
            switch (c) {
                case '*':
                    regex += '.*';
                    break;
                case '?':
                    regex += '.';
                    break;
                case '[':
                    // Find matching ]
                    const closeIdx = glob.indexOf(']', i + 1);
                    if (closeIdx >= 0) {
                        regex += glob.substring(i, closeIdx + 1);
                        i = closeIdx;
                    } else {
                        regex += '\\[';
                    }
                    break;
                case '.':
                case '(':
                case ')':
                case '+':
                case '|':
                case '^':
                case '$':
                case '{':
                case '}':
                case '\\':
                    regex += `\\${c}`;
                    break;
                default:
                    regex += c;
            }
        }
        regex += '$';
        return new RegExp(regex, 'i');
    }
}
