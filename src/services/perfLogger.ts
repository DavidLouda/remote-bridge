import * as vscode from 'vscode';

/**
 * Patterns that look like credentials embedded in URLs, query strings, or
 * error messages. We rewrite them to a placeholder before they reach the
 * Output Channel so that sensitive data isn't archived in user-shared logs.
 *
 * NOTE: this is best-effort. The canonical defence is to never put secrets
 * in error messages in the first place; this is a safety net.
 */
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
    // userinfo in URLs: scheme://user:pass@host  →  scheme://user:***@host
    [/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, '$1:***@'],
    // password=..., passphrase=..., pwd=..., pass=...
    [/\b(password|passphrase|pwd|pass|secret|token|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=***'],
    // JSON-style "password": "..."
    [/("(?:password|passphrase|pwd|secret|token)"\s*:\s*)"[^"]*"/gi, '$1"***"'],
];

function maskSecrets(input: string): string {
    let out = input;
    for (const [re, replacement] of CREDENTIAL_PATTERNS) {
        out = out.replace(re, replacement);
    }
    return out;
}

export class PerfLogger {
    private _enabled = false;

    constructor(private readonly _outputChannel: vscode.OutputChannel) {}

    setEnabled(value: boolean): void {
        this._enabled = value;
    }

    log(scope: string, message: string): void {
        if (!this._enabled) { return; }
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
        this._outputChannel.appendLine(`[${ts}] [Perf] [${scope}] ${maskSecrets(message)}`);
    }

    formatError(error: unknown): string {
        const raw = error instanceof Error ? error.message : String(error);
        return maskSecrets(raw);
    }
}