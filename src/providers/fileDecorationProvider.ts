import * as vscode from 'vscode';

export type DecorationKind = 'modified' | 'added' | 'renamed' | 'deleted';

const BADGE: Record<DecorationKind, string> = {
    modified: 'M',
    added: 'A',
    renamed: 'R',
    deleted: 'D',
};

const COLOR: Record<DecorationKind, vscode.ThemeColor> = {
    modified: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
    added:    new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
    renamed:  new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
    deleted:  new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
};

function tooltips(): Record<DecorationKind, string> {
    return {
        modified: vscode.l10n.t('Modified by AI agent'),
        added:    vscode.l10n.t('Created by AI agent'),
        renamed:  vscode.l10n.t('Renamed by AI agent'),
        deleted:  vscode.l10n.t('Deleted by AI agent'),
    };
}

/**
 * Provides file decorations (M/A/R/D badges) in the Explorer for remote files
 * modified by AI agent tools during the current session.
 *
 * AI agents can query the current state via getSummary() or clear all decorations
 * via clearAll() to start a fresh tracking session.
 */
export class RemoteBridgeFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly _decorations = new Map<string, DecorationKind>();
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();

    readonly onDidChangeFileDecorations = this._onDidChange.event;

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== 'remote-bridge') {
            return undefined;
        }
        const kind = this._decorations.get(uri.toString());
        if (!kind) {
            return undefined;
        }
        const dec = new vscode.FileDecoration(BADGE[kind], tooltips()[kind], COLOR[kind]);
        // Propagate M/A badges to parent folders so the agent can see which
        // connection/directory subtrees have been touched. D/R are not propagated
        // because propagating "Deleted" up to parent folders would be misleading.
        dec.propagate = kind === 'modified' || kind === 'added';
        return dec;
    }

    markModified(connectionId: string, remotePath: string): void {
        this._mark(connectionId, remotePath, 'modified');
    }

    markAdded(connectionId: string, remotePath: string): void {
        this._mark(connectionId, remotePath, 'added');
    }

    markRenamed(connectionId: string, remotePath: string): void {
        this._mark(connectionId, remotePath, 'renamed');
    }

    markDeleted(connectionId: string, remotePath: string): void {
        this._mark(connectionId, remotePath, 'deleted');
    }

    /** Remove decoration for a single file. */
    clear(connectionId: string, remotePath: string): void {
        const uri = this._buildUri(connectionId, remotePath);
        if (this._decorations.delete(uri.toString())) {
            this._onDidChange.fire(uri);
        }
    }

    /** Remove all decorations for a given connection. */
    clearConnection(connectionId: string): void {
        const prefix = `remote-bridge://${connectionId}`;
        const changed: vscode.Uri[] = [];
        for (const key of this._decorations.keys()) {
            if (key.startsWith(prefix)) {
                this._decorations.delete(key);
                changed.push(vscode.Uri.parse(key));
            }
        }
        if (changed.length > 0) {
            this._onDidChange.fire(changed);
        }
    }

    /** Remove all decorations across all connections. */
    clearAll(): void {
        if (this._decorations.size === 0) {
            return;
        }
        const uris = [...this._decorations.keys()].map(k => vscode.Uri.parse(k));
        this._decorations.clear();
        this._onDidChange.fire(uris);
    }

    /**
     * Returns a human-readable summary of all tracked file changes for the
     * current session. Designed for AI agent self-audit.
     *
     * Format: "[M] connectionId:/path/to/file\n[A] connectionId:/other/file"
     * Returns empty string when no files have been changed.
     */
    getSummary(): string {
        if (this._decorations.size === 0) {
            return '';
        }
        return [...this._decorations.entries()]
            .map(([key, kind]) => {
                const uri = vscode.Uri.parse(key);
                return `[${BADGE[kind]}] ${uri.authority}:${uri.path}`;
            })
            .join('\n');
    }

    dispose(): void {
        this._onDidChange.dispose();
    }

    private _mark(connectionId: string, remotePath: string, kind: DecorationKind): void {
        const uri = this._buildUri(connectionId, remotePath);
        this._decorations.set(uri.toString(), kind);
        this._onDidChange.fire(uri);
    }

    private _buildUri(connectionId: string, remotePath: string): vscode.Uri {
        const p = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
        return vscode.Uri.parse(`remote-bridge://${connectionId}${p}`);
    }
}
