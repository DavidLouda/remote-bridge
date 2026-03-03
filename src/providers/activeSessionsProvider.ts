import * as vscode from 'vscode';
import { ConnectionPool } from '../services/connectionPool';
import { ConnectionConfig, ConnectionStatus } from '../types/connection';

interface SessionNode {
    config: ConnectionConfig;
    lastActivity: number;
}

/**
 * TreeDataProvider for the "Active Sessions" view.
 * Shows currently connected remote sessions with protocol, host, and idle time.
 */
export class ActiveSessionsProvider implements vscode.TreeDataProvider<SessionNode>, vscode.Disposable {

    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SessionNode | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly _statusListener: vscode.Disposable;

    constructor(private readonly _pool: ConnectionPool) {
        this._statusListener = this._pool.onDidChangeStatus(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SessionNode): vscode.TreeItem {
        const { config, lastActivity } = element;
        const status = this._pool.getStatus(config.id);
        const idle = _formatIdleTime(lastActivity);

        const item = new vscode.TreeItem(
            config.name,
            vscode.TreeItemCollapsibleState.None
        );
        item.description = `${config.protocol.toUpperCase()} · ${config.host}${idle ? ` · ${idle}` : ''}`;
        item.tooltip = new vscode.MarkdownString(
            `**${config.name}**\n\n` +
            `$(globe) ${config.host}:${config.port}\n\n` +
            `$(plug) ${config.protocol.toUpperCase()}\n\n` +
            `$(clock) ${idle || vscode.l10n.t('just now')}`
        );
        item.iconPath = _statusIcon(status);
        item.contextValue = 'activeSession';

        return item;
    }

    getChildren(): SessionNode[] {
        return this._pool.getActiveSessions().map(s => ({
            config: s.config,
            lastActivity: s.lastActivity,
        }));
    }

    dispose(): void {
        this._statusListener.dispose();
        this._onDidChangeTreeData.dispose();
    }
}

function _statusIcon(status: ConnectionStatus): vscode.ThemeIcon {
    switch (status) {
        case ConnectionStatus.Connected:
            return new vscode.ThemeIcon('plug', new vscode.ThemeColor('testing.iconPassed'));
        case ConnectionStatus.Connecting:
            return new vscode.ThemeIcon('sync~spin');
        default:
            return new vscode.ThemeIcon('debug-disconnect');
    }
}

function _formatIdleTime(lastActivity: number): string {
    const seconds = Math.floor((Date.now() - lastActivity) / 1000);
    if (seconds < 60) { return ''; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return vscode.l10n.t('{0} min idle', minutes); }
    const hours = Math.floor(minutes / 60);
    return vscode.l10n.t('{0} h idle', hours);
}
