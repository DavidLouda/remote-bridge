import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { CacheService } from '../../services/cacheService';
import { BaseTool } from './baseTool';
import * as shell from '../../utils/shellCommands';

interface ReadFileInput {
    connectionName: string;
    path: string;
    startLine?: number;
    endLine?: number;
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
        const rangeInfo = options.input.startLine
            ? ` (${vscode.l10n.t('lines {0}-{1}', String(options.input.startLine), String(options.input.endLine || '∞'))})`
            : '';
        return {
            invocationMessage: vscode.l10n.t('Reading {0} on {1}{2}...', options.input.path, connName, rangeInfo),
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, path: remotePath, startLine, endLine } = options.input;

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

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
        const cacheKey = this._cache.makeKey(config.id, remotePath);
        let content = this._cache.getContent(cacheKey);
        if (!content) {
            content = await adapter.readFile(remotePath);
            this._cache.setContent(cacheKey, content);
        }
        const text = new TextDecoder().decode(content);
        const allLines = text.split('\n');
        // Don't count trailing empty line from final \n
        const totalLines = text.endsWith('\n') ? allLines.length - 1 : allLines.length;

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

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                `[File: ${remotePath} | Total lines: ${totalLines}]\n${text}`
            ),
        ]);
    }
}
