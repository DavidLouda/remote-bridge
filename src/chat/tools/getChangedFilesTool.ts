import * as vscode from 'vscode';
import { RemoteBridgeFileDecorationProvider } from '../../providers/fileDecorationProvider';

/**
 * LM Tool: Get a summary of all remote files changed during this session.
 *
 * Returns one line per changed file:
 *   [M] connectionId:/path/to/file   (modified)
 *   [A] connectionId:/path/to/file   (added / created)
 *   [R] connectionId:/path/to/file   (renamed / moved — new path)
 *   [D] connectionId:/path/to/file   (deleted)
 *
 * Use this tool to review or verify all changes before finishing a task,
 * or to produce a concise change summary for the user.
 */
export class GetChangedFilesTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(
        private readonly _decorations: RemoteBridgeFileDecorationProvider
    ) {}

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ) {
        return { invocationMessage: vscode.l10n.t('Retrieving session change summary...') };
    }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const summary = this._decorations.getSummary();
        const text = summary !== ''
            ? summary
            : vscode.l10n.t('No files have been modified in this session.');
        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text),
        ]);
    }
}
