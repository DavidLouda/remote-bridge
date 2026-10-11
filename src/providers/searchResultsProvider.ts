import * as vscode from 'vscode';
import * as path from 'path';
import { SearchMatch } from '../utils/remoteSearchShell';

export interface SearchFileNode {
    kind: 'file';
    /** Absolute remote path. */
    path: string;
    /** Path relative to the searched folder. */
    relativePath: string;
    matches: SearchMatchNode[];
}

export interface SearchMatchNode {
    kind: 'match';
    file: SearchFileNode;
    match: SearchMatch;
}

export type SearchNode = SearchFileNode | SearchMatchNode;

/** Characters of context shown before the first match in a long line. */
const PREVIEW_CONTEXT = 30;
const PREVIEW_LENGTH = 250;
const REFRESH_DELAY_MS = 200;

/** Tree of server-side search results: files → matching lines. */
export class SearchResultsProvider implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SearchNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _connectionId = '';
    private _rootPath = '/';
    private readonly _files = new Map<string, SearchFileNode>();
    private _matchCount = 0;
    private _refreshTimer: ReturnType<typeof setTimeout> | undefined;

    get fileCount(): number {
        return this._files.size;
    }

    get matchCount(): number {
        return this._matchCount;
    }

    reset(connectionId: string, rootPath: string): void {
        this._connectionId = connectionId;
        this._rootPath = rootPath.endsWith('/') ? rootPath : `${rootPath}/`;
        this._files.clear();
        this._matchCount = 0;
        this._flush();
    }

    clear(): void {
        this._files.clear();
        this._matchCount = 0;
        this._flush();
    }

    add(matches: readonly SearchMatch[]): void {
        for (const match of matches) {
            let file = this._files.get(match.path);
            if (!file) {
                file = {
                    kind: 'file',
                    path: match.path,
                    relativePath: match.path.startsWith(this._rootPath)
                        ? match.path.slice(this._rootPath.length)
                        : match.path,
                    matches: [],
                };
                this._files.set(match.path, file);
            }
            file.matches.push({ kind: 'match', file, match });
            this._matchCount++;
        }
        // Results arrive in many small batches; refresh the tree at most a
        // few times per second.
        this._refreshTimer ??= setTimeout(() => this._flush(), REFRESH_DELAY_MS);
    }

    /** Push pending changes to the tree now. */
    flush(): void {
        this._flush();
    }

    uriFor(remotePath: string): vscode.Uri {
        // Uri.from keeps '#', '?' and '%' in file names as part of the path.
        return vscode.Uri.from({ scheme: 'remote-bridge', authority: this._connectionId, path: remotePath });
    }

    getChildren(element?: SearchNode): SearchNode[] {
        if (!element) {
            return Array.from(this._files.values());
        }
        return element.kind === 'file' ? element.matches : [];
    }

    getParent(element: SearchNode): SearchNode | undefined {
        return element.kind === 'match' ? element.file : undefined;
    }

    getTreeItem(element: SearchNode): vscode.TreeItem {
        if (element.kind === 'file') {
            const item = new vscode.TreeItem(
                path.posix.basename(element.path),
                vscode.TreeItemCollapsibleState.Expanded
            );
            const dir = path.posix.dirname(element.relativePath);
            item.description = `${dir === '.' ? '' : `${dir} · `}${element.matches.length}`;
            item.resourceUri = this.uriFor(element.path);
            item.iconPath = vscode.ThemeIcon.File;
            item.tooltip = element.relativePath;
            item.contextValue = 'remoteBridge.searchFile';
            return item;
        }

        const { match } = element;
        const preview = buildPreview(match);
        const item = new vscode.TreeItem({ label: preview.text, highlights: preview.highlights });
        item.tooltip = `${match.line}: ${match.text.trim()}`;
        item.contextValue = 'remoteBridge.searchMatch';
        const [start, end] = match.ranges[0] ?? [0, 0];
        item.command = {
            command: 'vscode.open',
            title: vscode.l10n.t('Open'),
            arguments: [
                this.uriFor(match.path),
                {
                    selection: new vscode.Range(match.line - 1, start, match.line - 1, end),
                    preview: true,
                } satisfies vscode.TextDocumentShowOptions,
            ],
        };
        return item;
    }

    private _flush(): void {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = undefined;
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
        }
        this._onDidChangeTreeData.dispose();
    }
}

/** One-line preview around the first match, with shifted highlight ranges. */
export function buildPreview(match: SearchMatch): { text: string; highlights: [number, number][] } {
    const leading = match.text.length - match.text.trimStart().length;
    const firstStart = match.ranges[0]?.[0] ?? leading;
    let start = Math.max(leading, Math.min(firstStart, match.text.length) - PREVIEW_CONTEXT);
    // Do not cut a word in half when there is room to start at a boundary.
    if (start > leading) {
        const space = match.text.lastIndexOf(' ', start);
        if (space >= leading && firstStart - space <= PREVIEW_CONTEXT * 2) {
            start = space + 1;
        }
    }
    const prefix = start > leading ? '…' : '';
    const body = match.text.slice(start, start + PREVIEW_LENGTH).trimEnd();
    const suffix = start + PREVIEW_LENGTH < match.text.length ? '…' : '';
    const shift = prefix.length - start;
    const highlights = match.ranges
        .map(([s, e]) => [s + shift, Math.min(e + shift, prefix.length + body.length)] as [number, number])
        .filter(([s, e]) => s >= prefix.length && e > s);
    return { text: prefix + body + suffix, highlights };
}
