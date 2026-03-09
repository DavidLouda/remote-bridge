import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';

interface RunCommandInput {
    connectionName?: string;
    command: string;
}

function detectDedicatedToolAlternative(command: string): { blocked: boolean; guidance?: string } {
    const normalized = command.toLowerCase();
    const rules: Array<{ pattern: RegExp; guidance: string }> = [
        {
            pattern: /(^|\s)(sed|awk|perl)\b|head\s+-|tail\s+-|\bcat\b/,
            guidance: 'Use `remote-bridge_readFile` for reading and `remote-bridge_writeFile` for edits instead of sed/head/tail/cat.',
        },
        {
            pattern: /\bpython\d*\b[\s\S]*<<|\becho\b[\s\S]*(>|>>)/,
            guidance: 'Use `remote-bridge_writeFile` with `startLine`/`endLine` or `mode=insert` instead of heredoc or shell redirection edits.',
        },
        {
            pattern: /(^|\s)grep\b/,
            guidance: 'Use `remote-bridge_searchFiles` for content search instead of grep.',
        },
        {
            pattern: /(^|\s)find\b/,
            guidance: 'Use `remote-bridge_findFiles` for name-based file discovery instead of find.',
        },
        {
            pattern: /(^|\s)rm\b/,
            guidance: 'Use `remote-bridge_deleteFile` for deletions instead of rm.',
        },
        {
            pattern: /(^|\s)mv\b/,
            guidance: 'Use `remote-bridge_renameFile` for moves/renames instead of mv.',
        },
        {
            pattern: /(^|\s)cp\b/,
            guidance: 'Use `remote-bridge_copyFile` for copies instead of cp.',
        },
        {
            pattern: /(^|\s)mkdir\b/,
            guidance: 'Use `remote-bridge_createDirectory` for directory creation instead of mkdir.',
        },
    ];

    const aiEnabled = vscode.workspace.getConfiguration('remoteBridge').get<boolean>('ai.enabled', true);
    if (!aiEnabled) {
        return { blocked: false };
    }

    const matchedGuidance = rules
        .filter((rule) => rule.pattern.test(normalized))
        .map((rule) => rule.guidance);

    if (matchedGuidance.length === 0) {
        return { blocked: false };
    }

    const uniqueGuidance = [...new Set(matchedGuidance)];
    return {
        blocked: true,
        guidance: uniqueGuidance.join(' '),
    };
}

/**
 * LM Tool: Execute a shell command on a remote server via SSH.
 */
export class RunCommandTool extends BaseTool implements vscode.LanguageModelTool<RunCommandInput> {
    constructor(
        _connectionManager: ConnectionManager,
        _pool: ConnectionPool
    ) {
        super(_connectionManager, _pool);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<RunCommandInput>,
        _token: vscode.CancellationToken
    ) {
        const connName = this._resolveConnectionName(options.input.connectionName);
        return {
            invocationMessage: vscode.l10n.t(
                'Running command on {0}...',
                connName
            ),
            confirmationMessages: {
                title: vscode.l10n.t('Run Remote Command'),
                message: new vscode.MarkdownString(
                    vscode.l10n.t(
                        'Execute `{0}` on **{1}**?',
                        options.input.command,
                        connName
                    )
                ),
            },
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunCommandInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (token.isCancellationRequested) { throw new vscode.CancellationError(); }

        const { connectionName, command } = options.input;

        const policy = detectDedicatedToolAlternative(command);
        if (policy.blocked) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t(
                        'Command blocked: this looks like a file operation that has a dedicated Remote Bridge tool. {0}',
                        policy.guidance ?? ''
                    )
                ),
            ]);
        }

        const config = this._resolveConnection(connectionName);
        const adapter = await this._pool.getAdapter(config);

        if (!adapter.supportsExec || !adapter.exec) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t(
                        'Command execution is not supported for {0} connections. Only SSH/SFTP connections support this.',
                        config.protocol.toUpperCase()
                    )
                ),
            ]);
        }

        const result = await adapter.exec(command);

        const parts: string[] = [];

        if (result.stdout) {
            parts.push(result.stdout);
        }

        if (result.stderr) {
            parts.push(`STDERR:\n${result.stderr}`);
        }

        parts.push(
            vscode.l10n.t('Exit code: {0}', String(result.exitCode))
        );

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n\n')),
        ]);
    }
}
