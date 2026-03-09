import * as vscode from 'vscode';
import { RemoteBridgeFileDecorationProvider } from '../../providers/fileDecorationProvider';

/**
 * LM Tool: Clear all file change decorations for the current session.
 *
 * Removes all M/A/R/D badges from remote files in the Explorer and resets
 * the session change tracking. Use after reviewing changes with getChangedFiles,
 * or to start a clean tracking session for the next task.
 */
export class ClearDecorationsTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(
        private readonly _decorations: RemoteBridgeFileDecorationProvider
    ) {}

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ) {
        return { invocationMessage: vscode.l10n.t('Clearing session change decorations...') };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        this._decorations.clearAll();
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
                vscode.l10n.t('Session change tracking has been reset. All file decorations cleared.')
            ),
        ]);
    }
}
