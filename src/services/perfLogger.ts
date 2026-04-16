import * as vscode from 'vscode';

export class PerfLogger {
    private _enabled = false;

    constructor(private readonly _outputChannel: vscode.OutputChannel) {}

    setEnabled(value: boolean): void {
        this._enabled = value;
    }

    log(scope: string, message: string): void {
        if (!this._enabled) { return; }
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
        this._outputChannel.appendLine(`[${ts}] [Perf] [${scope}] ${message}`);
    }

    formatError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
}