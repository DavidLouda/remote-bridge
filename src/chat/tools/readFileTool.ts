import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface ReadFileInput {
    connectionName?: string;
    path: string;
    startLine?: number;
    endLine?: number;
    search?: string;
    contextLines?: number;
    maxResults?: number;
    tail?: number;
}

/**
 * LM Tool: Read a file (or a range of lines) from a remote server.
 */
export class ReadFileTool extends BaseTool implements vscode.LanguageModelTool<ReadFileInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool,
        private readonly _cache: CacheService
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ReadFileInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        let rangeInfo = '';
        if (options.input.search) {
            rangeInfo = ` (${vscode.l10n.t('searching for "{0}"', options.input.search)})`;
        } else if (options.input.tail) {
            rangeInfo = ` (${vscode.l10n.t('last {0} lines', String(options.input.tail))})`;
        } else if (options.input.startLine) {
            rangeInfo = ` (${vscode.l10n.t('lines {0}-{1}', String(options.input.startLine), String(options.input.endLine || '∞'))})`;
        }
        return {
            invocationMessage: vscode.l10n.t('Reading {0} on {1}{2}...', options.input.path, connName, rangeInfo),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: originalPath, startLine, endLine, search, contextLines, maxResults, tail } = options.input;

        const config = this._resolveConnection(connectionName);
        const remotePath = this._ensureWithinWorkspace(originalPath, config);
        const adapter = await this._pool.getAdapter(config);

        // ── Search mode: grep inside a single file ──
        if (search !== undefined) {
            const ctx = contextLines ?? 3;

            const limit = maxResults ?? 50;

            if (adapter.supportsExec && adapter.exec) {
                const os = config.os ?? 'linux';
                const cmd = shell.grepInFile(search, remotePath, ctx, os, limit);
                const result = await adapter.exec(cmd);

                // grep exit 1 = no matches
                if (result.exitCode === 1) {
                    const totalLines = parseInt((result.stdout || '').split('\n')[0]?.trim(), 10) || 0;
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(
                            vscode.l10n.t('No matches for "{0}" in {1} ({2} lines)', search, remotePath, String(totalLines))
                        ),
                    ]);
                }
                if (result.exitCode !== 0 && result.exitCode !== 1) {
                    throw new Error(result.stderr || vscode.l10n.t('Failed to search file'));
                }

                const outputLines = result.stdout.split('\n');
                const totalLines = parseInt(outputLines[0]?.trim(), 10) || 0;
                const grepOutput = outputLines.slice(1).join('\n').trimEnd();

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `[File: ${remotePath} | Total lines: ${totalLines} | Search: "${search}" (±${ctx} context)]\n${grepOutput}`
                    ),
                ]);
            }

            // FTP fallback: download + client-side search
            const content = await this._getFileContent(config.id, remotePath, adapter);
            const allLines = content.split('\n');
            const totalLines = content.endsWith('\n') ? allLines.length - 1 : allLines.length;
            // Guard against ReDoS: limit pattern length and always escape to literal string
            // (LLM-supplied regex with nested quantifiers can cause catastrophic backtracking)
            const safePattern = search.length <= 200
                ? search
                : search.slice(0, 200);
            let regex: RegExp;
            try {
                regex = new RegExp(safePattern, 'gi');
            } catch {
                regex = new RegExp(safePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            }

            const matchIndices: number[] = [];
            for (let i = 0; i < allLines.length; i++) {
                if (regex.test(allLines[i])) {
                    matchIndices.push(i);
                }
                regex.lastIndex = 0;
            }

            if (matchIndices.length === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        vscode.l10n.t('No matches for "{0}" in {1} ({2} lines)', search, remotePath, String(totalLines))
                    ),
                ]);
            }

            const blocks: string[] = [];
            const shown = new Set<number>();
            for (const idx of matchIndices.slice(0, limit)) {
                const start = Math.max(0, idx - ctx);
                const end = Math.min(allLines.length - 1, idx + ctx);
                const blockLines: string[] = [];
                for (let j = start; j <= end; j++) {
                    if (!shown.has(j)) {
                        shown.add(j);
                        const marker = j === idx ? '*' : ' ';
                        blockLines.push(`${j + 1}:${marker}${allLines[j]}`);
                    }
                }
                if (blockLines.length > 0) {
                    blocks.push(blockLines.join('\n'));
                }
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `[File: ${remotePath} | Total lines: ${totalLines} | Matches: ${matchIndices.length} (showing with ±${ctx} context)]\n---\n${blocks.join('\n---\n')}`
                ),
            ]);
        }

        // ── Tail mode: read last N lines ──
        if (tail !== undefined) {
            const tailCount = Math.max(1, tail);

            if (adapter.supportsExec && adapter.exec) {
                const os = config.os ?? 'linux';
                const cmd = shell.tailRead(remotePath, tailCount, os);
                const result = await adapter.exec(cmd);

                if (result.exitCode !== 0) {
                    throw new Error(result.stderr || vscode.l10n.t('Failed to read file'));
                }

                const outputLines = result.stdout.split('\n');
                const totalLines = parseInt(outputLines[0]?.trim(), 10) || 0;
                const contentLines = outputLines.slice(1);
                if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
                    contentLines.pop();
                }

                const startFrom = Math.max(1, totalLines - contentLines.length + 1);
                const resultText = contentLines
                    .map((line, i) => `${startFrom + i}: ${line}`)
                    .join('\n');

                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        `[File: ${remotePath} | Total lines: ${totalLines} | Showing last ${contentLines.length} lines (${startFrom}-${totalLines})]\n${resultText}`
                    ),
                ]);
            }

            // FTP fallback
            const content = await this._getFileContent(config.id, remotePath, adapter);
            const allLines = content.split('\n');
            const totalLines = content.endsWith('\n') ? allLines.length - 1 : allLines.length;
            const start = Math.max(0, totalLines - tailCount);
            const selectedLines = allLines.slice(start, totalLines);

            const resultText = selectedLines
                .map((line, i) => `${start + i + 1}: ${line}`)
                .join('\n');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `[File: ${remotePath} | Total lines: ${totalLines} | Showing last ${selectedLines.length} lines (${start + 1}-${totalLines})]\n${resultText}`
                ),
            ]);
        }

        // ── SSH optimized: partial read via sed (avoids downloading entire file) ──
        if (startLine !== undefined && adapter.supportsExec && adapter.exec) {
            const os = config.os ?? 'linux';
            const endArg = endLine !== undefined ? String(endLine) : '$';
            // Get total line count + requested range in one SSH round-trip
            const cmd = shell.readPartial(remotePath, startLine, endArg, os);
            const result = await adapter.exec(cmd);

            if (result.exitCode !== 0) {
                throw new Error(result.stderr || vscode.l10n.t('Failed to read file'));
            }

            const outputLines = result.stdout.split('\n');
            const totalLines = parseInt(outputLines[0].trim(), 10);
            const contentLines = outputLines.slice(1);
            // Remove trailing empty line from split
            if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
                contentLines.pop();
            }

            const actualEnd = endLine !== undefined ? Math.min(endLine, totalLines) : totalLines;
            const resultText = contentLines
                .map((line, i) => `${startLine + i}: ${line}`)
                .join('\n');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `[File: ${remotePath} | Total lines: ${totalLines} | Showing lines ${startLine}-${actualEnd}]\n${resultText}`
                ),
            ]);
        }

        // ── Fallback: download entire file (FTP, or full reads on SSH) ──
        const content = await this._getFileContent(config.id, remotePath, adapter);
        const allLines = content.split('\n');
        // Don't count trailing empty line from final \n
        const totalLines = content.endsWith('\n') ? allLines.length - 1 : allLines.length;

        if (startLine !== undefined) {
            const start = Math.max(1, startLine) - 1;
            const end = endLine !== undefined ? Math.min(allLines.length, endLine) : allLines.length;
            const selectedLines = allLines.slice(start, end);

            const resultText = selectedLines
                .map((line, i) => `${start + i + 1}: ${line}`)
                .join('\n');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `[File: ${remotePath} | Total lines: ${totalLines} | Showing lines ${startLine}-${end}]\n${resultText}`
                ),
            ]);
        }

        const MAX_FULL_READ_LINES = 2000;
        const TRUNCATED_SHOW_LINES = 50;
        if (totalLines > MAX_FULL_READ_LINES) {
            const truncatedContent = allLines.slice(0, TRUNCATED_SHOW_LINES)
                .map((line, i) => `${i + 1}: ${line}`)
                .join('\n');
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    `\u26a0 FILE TOO LARGE (${totalLines} lines) — only first ${TRUNCATED_SHOW_LINES} lines shown below.\nTo find specific content: call this tool again with the \`search\` parameter (supports regex, e.g. search: "img|overflow|product"). Do NOT use runCommand with grep.\nTo read a range: use \`startLine\`/\`endLine\`. To read the entire file: set \`startLine: 1\`.\n\n[File: ${remotePath} | Total lines: ${totalLines} | Preview: first ${TRUNCATED_SHOW_LINES} lines]\n${truncatedContent}`
                ),
            ]);
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `[File: ${remotePath} | Total lines: ${totalLines}]\n${content}`
            ),
        ]);
    }

    private async _getFileContent(configId: string, remotePath: string, adapter: import('../../adapters/adapter').RemoteAdapter): Promise<string> {
        const cacheKey = this._cache.makeKey(configId, remotePath);
        let content = this._cache.getContent(cacheKey);
        if (!content) {
            content = await adapter.readFile(remotePath);
            this._cache.setContent(cacheKey, content);
        }
        // Binary detection: check first 8 KB for null bytes
        const checkLen = Math.min(content.length, 8192);
        for (let i = 0; i < checkLen; i++) {
            if (content[i] === 0) {
                throw new Error(`File appears to be binary: ${remotePath}`);
            }
        }
        return new TextDecoder().decode(content);
    }
}
