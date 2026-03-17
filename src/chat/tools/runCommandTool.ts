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

    // SSH write commands are always blocked — you MUST edit files via VS Code native
    // file editing tools on remote-bridge:// workspace files.
    const writeRules: Array<RegExp> = [
        /\bpython\d*\b.*\s+-c\b|\bpython\d*\b[\s\S]*<</,
        /\becho\b[\s\S]*(>>?)|\bprintf\b[\s\S]*(>>?)|\btee\b/,
        /\bsed\b.*\s+-i\b/,
    ];

    if (writeRules.some((r) => r.test(normalized))) {
        return {
            blocked: true,
            guidance: 'SSH file write commands are blocked. You MUST use VS Code native file editing tools on remote-bridge:// workspace files to modify files.',
        };
    }

    // File reading/searching commands are blocked — use readFile and searchFiles tools instead.
    const readSearchRules: Array<RegExp> = [
        /^\s*grep\b/,
        /\|\s*grep\b/,
        /^\s*cat\b/,
        /^\s*head\b/,
        /^\s*tail\b/,
        /^\s*sed\b.*\bp\b/,
        /^\s*awk\b/,
        /^\s*find\b/,
        /^\s*less\b/,
        /^\s*more\b/,
        /^\s*wc\b/,
    ];

    if (readSearchRules.some((r) => r.test(normalized))) {
        return {
            blocked: true,
            guidance: 'Use the dedicated readFile tool (with `search` parameter for grep, `tail` for tail, `startLine`/`endLine` for line ranges) and searchFiles tool (for find/grep across directories). Do NOT use runCommand for reading or searching files.',
        };
    }

    // Dangerous/destructive commands are blocked — these could cause irreversible server damage.
    const dangerousRules: Array<RegExp> = [
        // System halt/reboot
        /\bhalt\b/,
        /\bshutdown\b/,
        /\breboot\b/,
        /\bpoweroff\b/,
        /\binit\s+[06]\b/,
        /\bsystemctl\b.*\b(poweroff|reboot|halt)\b/,
        // Destructive filesystem
        /\brm\s+(-\w*\s+)*-[a-z]*r[a-z]*f[a-z]*\s+(\/\*?|\/\s*$|\s*"\/"|'\/')/i,  // rm -rf / or rm -rf /*
        /\bmkfs\b/,
        /\bwipefs\b/,
        /\bdd\b.*\b(if|of)=/,
        // Fork bomb
        /:\(\)\s*\{/,
        // Firewall flush
        /\biptables\s+-F\b/,
        /\bufw\s+disable\b/,
        // Kernel modules removal
        /\brmmod\b/,
        /\bmodprobe\s+-r\b/,
    ];

    if (dangerousRules.some((r) => r.test(normalized))) {
        return {
            blocked: true,
            guidance: 'This command could cause irreversible damage to the server. If you need to perform this operation, ask the user to run it manually via SSH terminal.',
        };
    }

    return { blocked: false };
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
        // If this command will be rejected, skip the confirmation dialog — invoke() will return
        // the block guidance immediately without executing anything on the server.
        if (detectDedicatedToolAlternative(options.input.command).blocked) {
            return {
                invocationMessage: vscode.l10n.t('Running command on {0}...', connName),
            };
        }
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
                        'Command blocked: {0}',
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
