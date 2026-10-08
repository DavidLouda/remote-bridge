import * as vscode from 'vscode';
import { ConnectionConfig } from '../types/connection';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionPool } from '../services/connectionPool';
import { RemoteSearchService, SearchUnavailableError, SearchUnavailableReason } from '../services/remoteSearchService';
import { SearchResultsProvider } from '../providers/searchResultsProvider';
import { RemoteSearchQuery, parseGlobList } from '../utils/remoteSearchShell';
import { normalizeRemotePath, parseRemoteUri } from '../utils/uriParser';

const VIEW_ID = 'remoteBridge.searchResults';
const LAST_QUERY_KEY = 'remote-bridge.lastSearchQuery';

interface SearchTarget {
    connection: ConnectionConfig;
    rootPath: string;
    /** Folder URI as VS Code knows it (for the built-in search fallback). */
    uri: vscode.Uri;
}

interface StoredQuery {
    pattern: string;
    isRegex: boolean;
    matchCase: boolean;
    wholeWord: boolean;
    globs: string;
}

type ConnectionNode = { type: 'connection'; connection: ConnectionConfig };

/**
 * "Search Remote Files": server-side text search (ripgrep or grep over SSH)
 * with results in the Remote Bridge view container.
 */
export function registerRemoteSearch(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionPool: ConnectionPool
): void {
    const service = new RemoteSearchService(connectionPool);
    const provider = new SearchResultsProvider();
    const view = vscode.window.createTreeView(VIEW_ID, {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    context.subscriptions.push(provider, view);

    let running: vscode.CancellationTokenSource | undefined;
    let last: { target: SearchTarget; query: RemoteSearchQuery } | undefined;

    const setRunning = (value: boolean) =>
        void vscode.commands.executeCommand('setContext', 'remoteBridge.searchRunning', value);
    const setHasResults = (value: boolean) =>
        void vscode.commands.executeCommand('setContext', 'remoteBridge.hasSearchResults', value);

    const run = async (target: SearchTarget, query: RemoteSearchQuery): Promise<void> => {
        running?.cancel();
        const cts = new vscode.CancellationTokenSource();
        running = cts;
        last = { target, query };

        provider.reset(target.connection.id, target.rootPath);
        view.description = query.pattern;
        view.message = vscode.l10n.t('Searching {0} on {1}…', target.rootPath, target.connection.name);
        setRunning(true);
        setHasResults(true);
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);

        const maxResults = vscode.workspace
            .getConfiguration('remoteBridge.search')
            .get<number>('maxResults', 5000);
        try {
            const outcome = await vscode.window.withProgress(
                { location: { viewId: VIEW_ID } },
                () => service.search(
                    target.connection,
                    target.rootPath,
                    query,
                    Math.max(1, Math.trunc(maxResults) || 5000),
                    (matches) => provider.add(matches),
                    cts.token
                )
            );
            if (running !== cts) {
                return; // superseded by a newer search
            }
            provider.flush();
            view.message = describeOutcome(provider.matchCount, provider.fileCount, outcome, maxResults);
        } catch (err) {
            if (running !== cts) {
                return;
            }
            provider.clear();
            if (err instanceof SearchUnavailableError) {
                view.message = describeUnavailable(err.reason);
                await fallbackToBuiltInSearch(target, query, err.reason);
            } else {
                const message = err instanceof Error ? err.message : String(err);
                view.message = vscode.l10n.t('Search failed: {0}', message);
                vscode.window.showErrorMessage(vscode.l10n.t('Remote search failed: {0}', message));
            }
        } finally {
            if (running === cts) {
                running = undefined;
                setRunning(false);
            }
            cts.dispose();
        }
    };

    const searchCommand = async (arg?: vscode.Uri | ConnectionNode) => {
        const target = await resolveTarget(arg, connectionManager, connectionPool);
        if (!target) {
            return;
        }
        const query = await promptQuery(context, target);
        if (query) {
            await run(target, query);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.searchRemote', searchCommand),
        vscode.commands.registerCommand('remoteBridge.searchInFolder', searchCommand),
        vscode.commands.registerCommand('remoteBridge.searchRefresh', async () => {
            if (last) {
                await run(last.target, last.query);
            }
        }),
        vscode.commands.registerCommand('remoteBridge.searchCancel', () => {
            running?.cancel();
        }),
        vscode.commands.registerCommand('remoteBridge.searchClear', () => {
            running?.cancel();
            last = undefined;
            provider.clear();
            view.message = undefined;
            view.description = undefined;
            setHasResults(false);
        }),
        // A connection's settings may have changed (OS, protocol): re-detect tools.
        connectionManager.onDidChange(() => {
            for (const connection of connectionManager.getConnections()) {
                service.forget(connection.id);
            }
        }),
        { dispose: () => running?.cancel() }
    );
}

// ─── Target ─────────────────────────────────────────────────────────

async function resolveTarget(
    arg: vscode.Uri | ConnectionNode | undefined,
    connectionManager: ConnectionManager,
    connectionPool: ConnectionPool
): Promise<SearchTarget | undefined> {
    const fromUri = (uri: vscode.Uri): SearchTarget | undefined => {
        const { connectionId, remotePath } = parseRemoteUri(uri);
        const connection = connectionManager.getConnection(connectionId);
        if (!connection) {
            vscode.window.showErrorMessage(vscode.l10n.t('Connection not found: {0}', connectionId));
            return undefined;
        }
        return { connection, rootPath: remotePath, uri };
    };

    if (arg instanceof vscode.Uri) {
        return arg.scheme === 'remote-bridge' ? fromUri(arg) : undefined;
    }
    if (arg && arg.type === 'connection') {
        return fromUri(connectionRootUri(arg.connection));
    }

    // Folder of the active remote editor.
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'remote-bridge') {
        const folder = vscode.workspace.getWorkspaceFolder(active);
        if (folder) {
            return fromUri(folder.uri);
        }
    }

    const remoteFolders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'remote-bridge');
    if (remoteFolders.length === 1) {
        return fromUri(remoteFolders[0].uri);
    }
    if (remoteFolders.length > 1) {
        const picked = await vscode.window.showQuickPick(
            remoteFolders.map((folder) => ({ label: noCodicons(folder.name), description: noCodicons(folder.uri.path), folder })),
            { title: vscode.l10n.t('Search Remote Files'), placeHolder: vscode.l10n.t('Select a folder to search') }
        );
        return picked ? fromUri(picked.folder.uri) : undefined;
    }

    // No remote folder open: pick an SSH connection, connected ones first.
    const connections = connectionManager.getConnections()
        .filter((connection) => connection.protocol === 'ssh' || connection.protocol === 'sftp')
        .sort((a, b) => Number(connectionPool.isConnected(b.id)) - Number(connectionPool.isConnected(a.id)));
    if (connections.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('Server-side search needs an SSH or SFTP connection.'));
        return undefined;
    }
    const picked = await vscode.window.showQuickPick(
        connections.map((connection) => ({
            label: connection.name.replace(/\$\(/g, '$​('),
            description: `${connection.host}:${connection.remotePath}`.replace(/\$\(/g, '$​('),
            connection,
        })),
        { title: vscode.l10n.t('Search Remote Files'), placeHolder: vscode.l10n.t('Select a connection') }
    );
    return picked ? fromUri(connectionRootUri(picked.connection)) : undefined;
}

function connectionRootUri(connection: ConnectionConfig): vscode.Uri {
    return vscode.Uri.from({
        scheme: 'remote-bridge',
        authority: connection.id,
        path: normalizeRemotePath(connection.remotePath || '/'),
    });
}

/** Neutralise `$(icon)` syntax in user-controlled text shown in quick inputs. */
function noCodicons(text: string): string {
    return text.replace(/\$\(/g, '$\u200B(');
}

// ─── Query input ────────────────────────────────────────────────────

async function promptQuery(context: vscode.ExtensionContext, target: SearchTarget): Promise<RemoteSearchQuery | undefined> {
    const stored = context.workspaceState.get<StoredQuery>(LAST_QUERY_KEY);
    const state = {
        isRegex: stored?.isRegex ?? false,
        matchCase: stored?.matchCase ?? false,
        wholeWord: stored?.wholeWord ?? false,
    };
    const selection = selectedText();
    const title = vscode.l10n.t('Search in {0}: {1}', noCodicons(target.connection.name), noCodicons(target.rootPath));

    const pattern = await new Promise<string | undefined>((resolve) => {
        const input = vscode.window.createInputBox();
        input.title = title;
        input.placeholder = vscode.l10n.t('Text to search for on the server');
        input.value = selection ?? stored?.pattern ?? '';
        input.ignoreFocusOut = true;
        const refresh = () => {
            const on = vscode.l10n.t('on');
            const off = vscode.l10n.t('off');
            input.prompt = vscode.l10n.t(
                'Match Case: {0} · Regular Expression: {1} · Whole Word: {2}',
                state.matchCase ? on : off,
                state.isRegex ? on : off,
                state.wholeWord ? on : off
            );
            // Quick input buttons have no toggled state; the prompt shows it.
            input.buttons = [
                { iconPath: new vscode.ThemeIcon('case-sensitive'), tooltip: vscode.l10n.t('Toggle Match Case') },
                { iconPath: new vscode.ThemeIcon('regex'), tooltip: vscode.l10n.t('Toggle Regular Expression') },
                { iconPath: new vscode.ThemeIcon('whole-word'), tooltip: vscode.l10n.t('Toggle Whole Word') },
            ];
        };
        refresh();
        input.onDidTriggerButton((button) => {
            const index = input.buttons.indexOf(button);
            if (index === 0) { state.matchCase = !state.matchCase; }
            if (index === 1) { state.isRegex = !state.isRegex; }
            if (index === 2) { state.wholeWord = !state.wholeWord; }
            refresh();
        });
        input.onDidChangeValue(() => {
            input.validationMessage = undefined;
        });
        input.onDidAccept(() => {
            const value = input.value;
            if (!value) {
                input.validationMessage = vscode.l10n.t('Enter text to search for.');
                return;
            }
            if (/[\r\n\0]/.test(value)) {
                input.validationMessage = vscode.l10n.t('Multi-line search is not supported.');
                return;
            }
            resolve(value);
            input.hide();
        });
        input.onDidHide(() => {
            resolve(undefined);
            input.dispose();
        });
        input.show();
    });
    if (pattern === undefined) {
        return undefined;
    }

    const globs = await vscode.window.showInputBox({
        title,
        prompt: vscode.l10n.t('Files to include, comma-separated (prefix with ! to exclude). Leave empty to search all files.'),
        placeHolder: vscode.l10n.t('e.g. *.yml, src/**, !vendor/**'),
        value: stored?.globs ?? '',
        ignoreFocusOut: true,
    });
    if (globs === undefined) {
        return undefined;
    }

    await context.workspaceState.update(LAST_QUERY_KEY, { pattern, globs, ...state } satisfies StoredQuery);

    const { include, exclude } = parseGlobList(globs);
    return {
        pattern,
        ...state,
        include,
        exclude: [...exclude, ...defaultExcludes(target.uri)],
        useIgnoreFiles: vscode.workspace.getConfiguration('search', target.uri).get<boolean>('useIgnoreFiles', true),
    };
}

function selectedText(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
        return undefined;
    }
    const text = editor.document.getText(editor.selection);
    return text && !/[\r\n]/.test(text) ? text : undefined;
}

/** `files.exclude` and `search.exclude` globs that are switched on. */
function defaultExcludes(scope: vscode.Uri): string[] {
    const globs = new Set<string>();
    for (const section of ['files', 'search']) {
        const value = vscode.workspace.getConfiguration(section, scope).get<Record<string, unknown>>('exclude') ?? {};
        for (const [glob, enabled] of Object.entries(value)) {
            if (enabled === true) {
                globs.add(glob);
            }
        }
    }
    return Array.from(globs);
}

// ─── Messages and fallback ──────────────────────────────────────────

function describeOutcome(
    matchCount: number,
    fileCount: number,
    outcome: { truncated: boolean; cancelled: boolean; partial: boolean; error?: string },
    maxResults: number
): string {
    if (outcome.error && matchCount === 0) {
        return vscode.l10n.t('Search failed: {0}', outcome.error);
    }
    let message = matchCount === 0
        ? vscode.l10n.t('No results found.')
        : vscode.l10n.t('{0} results in {1} files', String(matchCount), String(fileCount));
    if (outcome.cancelled) {
        message = vscode.l10n.t('Search cancelled. {0}', message);
    }
    if (outcome.truncated) {
        message += ' ' + vscode.l10n.t('Only the first {0} results are shown; refine the search.', String(maxResults));
    }
    if (outcome.partial) {
        message += ' ' + vscode.l10n.t('Some files or folders could not be read.');
    }
    return message;
}

function describeUnavailable(reason: SearchUnavailableReason): string {
    switch (reason) {
        case 'windows':
            return vscode.l10n.t('Server-side search is not available for Windows servers.');
        case 'noExec':
            return vscode.l10n.t('Server-side search needs an SSH or SFTP connection.');
        case 'noShell':
            return vscode.l10n.t('The server does not allow running commands (no shell or grep).');
    }
}

/** Run VS Code's own search over the folder when the server cannot search. */
async function fallbackToBuiltInSearch(
    target: SearchTarget,
    query: RemoteSearchQuery,
    reason: SearchUnavailableReason
): Promise<void> {
    if (!vscode.workspace.getWorkspaceFolder(target.uri)) {
        vscode.window.showWarningMessage(describeUnavailable(reason));
        return;
    }
    vscode.window.showInformationMessage(
        vscode.l10n.t('{0} Using the VS Code search instead.', describeUnavailable(reason))
    );
    // asRelativePath prefixes the folder name in multi-root workspaces, which
    // is what filesToInclude expects there.
    const relative = vscode.workspace.asRelativePath(target.uri).replace(/\/+$/, '');
    const base = relative && relative !== target.uri.toString() ? `./${relative}` : '.';
    const includes = query.include.length > 0
        ? query.include.map((glob) => glob.includes('/') ? `${base}/${glob.replace(/^\.\//, '')}` : `${base}/**/${glob}`)
        : [base];
    await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: query.pattern,
        isRegex: query.isRegex,
        isCaseSensitive: query.matchCase,
        matchWholeWord: query.wholeWord,
        filesToInclude: includes.join(', '),
        filesToExclude: query.exclude.join(', '),
        triggerSearch: true,
    });
}
