import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionPool } from '../services/connectionPool';
import { EncryptionService } from '../services/encryptionService';
import {
    ConnectionConfig,
    ConnectionFolder,
    ConnectionStatus,
    ConnectionProtocol,
} from '../types/connection';

// ─── Tree Node Types ────────────────────────────────────────────────

type TreeNode = FolderNode | ConnectionNode;

interface FolderNode {
    type: 'folder';
    folder: ConnectionFolder;
}

interface ConnectionNode {
    type: 'connection';
    connection: ConnectionConfig;
}

/**
 * Escape characters that are meaningful in MarkdownString tooltips so values
 * pulled from user-entered config cannot inject markup, links, or commands.
 */
function escapeMarkdown(text: string): string {
    if (!text) { return ''; }
    return text.replace(/[\\`*_{}\[\]()#+\-!<>|]/g, '\\$&');
}

/** Escape a value for embedding inside a Markdown inline-code span. */
function escapeMarkdownCode(text: string): string {
    if (!text) { return ''; }
    return text.replace(/`/g, '\\`');
}

// ─── Protocol Icon Map ──────────────────────────────────────────────

function getProtocolIcon(protocol: ConnectionProtocol, status: ConnectionStatus): vscode.ThemeIcon {
    const connected = status === ConnectionStatus.Connected;
    switch (protocol) {
        case 'ssh':
            return new vscode.ThemeIcon(connected ? 'terminal' : 'terminal', connected ? new vscode.ThemeColor('testing.iconPassed') : undefined);
        case 'sftp':
            return new vscode.ThemeIcon(connected ? 'lock' : 'lock', connected ? new vscode.ThemeColor('testing.iconPassed') : undefined);
        case 'ftp':
            return new vscode.ThemeIcon(connected ? 'cloud' : 'cloud', connected ? new vscode.ThemeColor('testing.iconPassed') : undefined);
        case 'ftps':
            return new vscode.ThemeIcon(connected ? 'shield' : 'shield', connected ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    }
}

function getStatusLabel(status: ConnectionStatus): string {
    switch (status) {
        case ConnectionStatus.Connected:
            return vscode.l10n.t('Connected');
        case ConnectionStatus.Connecting:
            return vscode.l10n.t('Connecting...');
        case ConnectionStatus.Disconnected:
            return '';
        case ConnectionStatus.Error:
            return vscode.l10n.t('Error');
    }
}

/**
 * TreeDataProvider for the connection manager sidebar.
 * Displays folders and connections with status indicators,
 * context menus, and drag and drop support.
 */
export class ConnectionTreeProvider
    implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>
{
    // ─── TreeDataProvider ───────────────────────────────────────

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    // ─── DragAndDropController ──────────────────────────────────

    readonly dropMimeTypes = ['application/vnd.code.tree.remoteBridge.connections'];
    readonly dragMimeTypes = ['application/vnd.code.tree.remoteBridge.connections'];

    private readonly _disposables: vscode.Disposable[] = [];
    private _filterQuery = '';

    constructor(
        private readonly _connectionManager: ConnectionManager,
        private readonly _pool: ConnectionPool,
        private readonly _encryptionService: EncryptionService
    ) {
        // Refresh tree when connections change
        this._disposables.push(
            this._connectionManager.onDidChange(() => this.refresh()),
            this._pool.onDidChangeStatus(() => this.refresh()),
            this._encryptionService.onDidLock(() => this.clearFilter()),
            this._encryptionService.onDidUnlock(() => this.refresh())
        );
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setFilterQuery(query: string): void {
        const normalized = query.trim().toLowerCase();
        if (this._filterQuery === normalized) {
            return;
        }
        this._filterQuery = normalized;
        this.refresh();
    }

    clearFilter(): void {
        if (!this._filterQuery) {
            return;
        }
        this._filterQuery = '';
        this.refresh();
    }

    // ─── getTreeItem ────────────────────────────────────────────

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.type === 'folder') {
            return this._createFolderItem(element.folder);
        }
        return this._createConnectionItem(element.connection);
    }

    // ─── getChildren ────────────────────────────────────────────

    getChildren(element?: TreeNode): TreeNode[] {
        // When the store is locked, return nothing — VS Code will show the
        // "connectionsLocked" welcome view with an inline Unlock link.
        if (this._encryptionService.isEnabled() && !this._encryptionService.isUnlocked()) {
            return [];
        }

        const parentId = element?.type === 'folder' ? element.folder.id : undefined;
        const allFolders = this._connectionManager.getFolders();
        const allConnections = this._connectionManager.getConnections();

        // Get folders at this level
        const folders = allFolders
            .filter((f) => f.parentId === parentId)
            .filter((f) => !this._isFiltering() || this._folderHasMatchingDescendant(f.id, allFolders, allConnections))
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((folder): FolderNode => ({ type: 'folder', folder }));

        // Get connections at this level
        const connections = allConnections
            .filter((c) => c.folderId === parentId)
            .filter((c) => !this._isFiltering() || this._matchesConnection(c))
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((connection): ConnectionNode => ({ type: 'connection', connection }));

        return [...folders, ...connections];
    }

    // ─── getParent ──────────────────────────────────────────────

    getParent(element: TreeNode): TreeNode | undefined {
        const parentId =
            element.type === 'folder'
                ? element.folder.parentId
                : element.connection.folderId;

        if (!parentId) {
            return undefined;
        }

        const folder = this._connectionManager.getFolder(parentId);
        return folder ? { type: 'folder', folder } : undefined;
    }

    // ─── Drag and Drop ─────────────────────────────────────────

    handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
        const items = source.map((node) => ({
            type: node.type,
            id: node.type === 'folder' ? node.folder.id : node.connection.id,
        }));
        dataTransfer.set(
            'application/vnd.code.tree.remoteBridge.connections',
            new vscode.DataTransferItem(items)
        );
    }

    async handleDrop(
        target: TreeNode | undefined,
        dataTransfer: vscode.DataTransfer
    ): Promise<void> {
        const transferItem = dataTransfer.get(
            'application/vnd.code.tree.remoteBridge.connections'
        );
        if (!transferItem) {
            return;
        }

        const items = transferItem.value as Array<{ type: string; id: string }>;
        const targetFolderId =
            target?.type === 'folder' ? target.folder.id : undefined;

        // Defensive validation: drop payloads come from the tree view and are
        // already trusted, but a malformed transferItem (or a future external
        // drag source) shouldn't be able to inject arbitrary IDs that bypass
        // the manager. Validate against the current store before mutating.
        const knownConnectionIds = new Set(
            this._connectionManager.getConnections().map((c) => c.id)
        );
        const knownFolderIds = new Set(
            this._connectionManager.getFolders().map((f) => f.id)
        );

        for (const item of items) {
            if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') {
                continue;
            }
            if (item.type === 'connection') {
                if (!knownConnectionIds.has(item.id)) { continue; }
                if (targetFolderId !== undefined && !knownFolderIds.has(targetFolderId)) { continue; }
                await this._connectionManager.moveToFolder(item.id, targetFolderId);
            }
            // Folder move could be added here in the future
        }
    }

    // ─── Private: TreeItem Builders ─────────────────────────────

    private _createFolderItem(folder: ConnectionFolder): vscode.TreeItem {
        const item = new vscode.TreeItem(
            folder.name,
            this._isFiltering()
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed
        );
        item.id = `folder:${folder.id}`;
        item.contextValue = 'folder';
        item.iconPath = new vscode.ThemeIcon('folder');
        item.tooltip = folder.name;
        return item;
    }

    private _createConnectionItem(connection: ConnectionConfig): vscode.TreeItem {
        const status = this._pool.getStatus(connection.id);
        const statusLabel = getStatusLabel(status);

        const item = new vscode.TreeItem(
            connection.name,
            vscode.TreeItemCollapsibleState.None
        );
        item.id = `connection:${connection.id}`;

        // Set contextValue based on status and protocol (e.g. connection.ssh.connected)
        const proto = connection.protocol;
        item.contextValue =
            status === ConnectionStatus.Connected
                ? `connection.${proto}.connected`
                : `connection.${proto}.disconnected`;

        item.iconPath = getProtocolIcon(connection.protocol, status);

        item.description = statusLabel
            ? `${connection.host}:${connection.port} — ${statusLabel}`
            : `${connection.host}:${connection.port}`;

        item.tooltip = new vscode.MarkdownString(
            `**${escapeMarkdown(connection.name)}**\n\n` +
            `$(server) \`${escapeMarkdownCode(connection.host)}:${connection.port}\`\n\n` +
            `$(key) ${connection.protocol.toUpperCase()} · ${escapeMarkdown(connection.username)}\n\n` +
            `$(folder) ${escapeMarkdown(connection.remotePath)}`
        );
        item.tooltip.supportThemeIcons = true;

        return item;
    }

    private _isFiltering(): boolean {
        return this._filterQuery.length > 0;
    }

    private _matchesConnection(connection: ConnectionConfig): boolean {
        if (!this._isFiltering()) {
            return true;
        }

        return connection.name.toLowerCase().includes(this._filterQuery)
            || connection.host.toLowerCase().includes(this._filterQuery);
    }

    private _folderHasMatchingDescendant(
        folderId: string,
        folders: readonly ConnectionFolder[],
        connections: readonly ConnectionConfig[],
        visited = new Set<string>()
    ): boolean {
        if (visited.has(folderId)) {
            return false;
        }
        visited.add(folderId);

        if (connections.some((connection) => connection.folderId === folderId && this._matchesConnection(connection))) {
            return true;
        }

        return folders
            .filter((folder) => folder.parentId === folderId)
            .some((folder) => this._folderHasMatchingDescendant(folder.id, folders, connections, visited));
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
