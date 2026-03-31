import * as vscode from 'vscode';
import { ConnectionManager } from '../../services/connectionManager';
import { ConnectionPool } from '../../services/connectionPool';
import { BaseTool } from './baseTool';

interface RunCommandInput {
    connectionName?: string;
    command: string;
}

function detectDedicatedToolAlternative(command: string, fullSshAccess?: boolean): { blocked: boolean; guidance?: string } {
    const normalized = command.toLowerCase();

    // SSH write commands — blocked unless full SSH access is enabled on the connection.
    // When fullSshAccess is true, the agent may modify files anywhere on the server.
    if (!fullSshAccess) {
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

        // File reading/searching commands — blocked unless full SSH access is enabled.
        // Use readFile and searchFiles tools instead (they run server-side and are workspace-aware).
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
    }

    // Dangerous/destructive commands are ALWAYS blocked — even with full SSH access.
    // Strip shell comment lines before checking — prevents false positives when comment
    // text mentions keywords like "reboot", "shutdown", etc. (e.g. sed commands with
    // context comments, or multi-line scripts explaining what they do).
    const withoutComments = command.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
    const dangerousNormalized = withoutComments.toLowerCase();

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

    if (dangerousRules.some((r) => r.test(dangerousNormalized))) {
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
        // Determine if full SSH access is enabled so blocked-command detection is accurate.
        let fullSshAccess = false;
        try {
            const config = this._resolveConnection(options.input.connectionName);
            fullSshAccess = !!config.fullSshAccess;
        } catch {
            // Connection may not be resolvable at prepare time — fall back to strict mode.
        }
        // If this command will be rejected, skip the confirmation dialog — invoke() will return
        // the block guidance immediately without executing anything on the server.
        if (detectDedicatedToolAlternative(options.input.command, fullSshAccess).blocked) {
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

        const config = this._resolveConnection(connectionName);
        const policy = detectDedicatedToolAlternative(command, config.fullSshAccess);
        if (policy.blocked) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(
                    vscode.l10n.t(
                        'Command blocked: {0}',
                        policy.guidance ?? ''
                    ) + this._modeNote(config)
                ),
            ]);
        }

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

        const modeNote = this._modeNote(config);
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(parts.join('\n\n') + modeNote),
        ]);
    }
}
