import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionPool } from '../services/connectionPool';
import { ConnectionStatus } from '../types/connection';
import { openSshTerminal } from '../terminal/sshTerminalProvider';

/**
 * Provides a simple status bar item (left, lowest priority) showing
 * a plug icon and live transfer speeds (↓/↑). Clicking it opens a
 * QuickPick with all configured connections and their current state.
 */
export class StatusBarService implements vscode.Disposable {
    private readonly _item: vscode.StatusBarItem;
    private readonly _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _connectionManager: ConnectionManager,
        private readonly _connectionPool: ConnectionPool,
        context: vscode.ExtensionContext
    ) {
        // Create status bar item — left side, priority 0 (far left)
        this._item = vscode.window.createStatusBarItem(
            'remoteBridge.status',
            vscode.StatusBarAlignment.Left,
            0
        );
        this._item.name = 'Remote Bridge';
        this._item.tooltip = vscode.l10n.t('Show remote connections');
        this._item.command = 'remoteBridge.showConnections';

        // Set initial text based on current connection state
        this._updateText();

        // Only show the status bar when there are connections
        this._updateVisibility();

        // Listen for connection changes to toggle visibility and update text
        this._disposables.push(
            this._connectionManager.onDidChange(() => {
                this._updateVisibility();
                this._updateText();
            })
        );

        // Listen for connection status changes to update server name display
        this._disposables.push(
            this._connectionPool.onDidChangeStatus(() => this._updateText())
        );

        // Register the QuickPick command
        this._disposables.push(
            vscode.commands.registerCommand(
                'remoteBridge.showConnections',
                () => this._showConnectionQuickPick()
            )
        );

        context.subscriptions.push(this._item);
    }

    /** Show the status bar only when at least one connection is configured. */
    private _updateVisibility(): void {
        if (this._connectionManager.getConnections().length > 0) {
            this._item.show();
        } else {
            this._item.hide();
        }
    }

    /** Update the status bar text to show currently connected server names. */
    private _updateText(): void {
        const sessions = this._connectionPool.getActiveSessions();
        if (sessions.length === 0) {
            this._item.text = '$(plug) Remote Bridge';
            this._item.tooltip = vscode.l10n.t('Show remote connections');
        } else {
            const names = sessions.map(s => s.config.name).join(', ');
            this._item.text = `$(plug) ${names}`;
            this._item.tooltip = vscode.l10n.t('Connected: {0}', names);
        }
    }

    private async _showConnectionQuickPick(): Promise<void> {
        const connections = this._connectionManager.getConnections();

        if (connections.length === 0) {
            const action = await vscode.window.showInformationMessage(
                vscode.l10n.t('No connections configured.'),
                vscode.l10n.t('Add Connection')
            );
            if (action) {
                await vscode.commands.executeCommand('remoteBridge.addConnection');
            }
            return;
        }

        // Build QuickPick items
        interface ConnectionQuickPickItem extends vscode.QuickPickItem {
            connectionId: string;
        }

        const items: ConnectionQuickPickItem[] = connections.map(conn => {
            const status = this._connectionPool.getStatus(conn.id);
            let icon: string;
            let statusLabel: string;
            switch (status) {
                case ConnectionStatus.Connected:
                    icon = '$(circle-filled)';
                    statusLabel = vscode.l10n.t('Connected');
                    break;
                case ConnectionStatus.Connecting:
                    icon = '$(sync~spin)';
                    statusLabel = vscode.l10n.t('Connecting');
                    break;
                case ConnectionStatus.Error:
                    icon = '$(error)';
                    statusLabel = vscode.l10n.t('Error');
                    break;
                default:
                    icon = '$(circle-outline)';
                    statusLabel = vscode.l10n.t('Disconnected');
                    break;
            }

            return {
                label: `${icon} ${conn.name}`,
                description: `${conn.protocol}://${conn.host}:${conn.port}`,
                detail: `${statusLabel} — ${conn.remotePath}`,
                connectionId: conn.id,
            };
        });

        const selected = await vscode.window.showQuickPick(items, {
            title: vscode.l10n.t('Remote Bridge — Connections'),
            placeHolder: vscode.l10n.t('Select a connection'),
        });

        if (!selected) {
            return;
        }

        const conn = connections.find(c => c.id === selected.connectionId);
        if (!conn) {
            return;
        }

        // Show actions for the selected connection
        const isConnected = this._connectionPool.isConnected(conn.id);
        const isSsh = conn.protocol === 'ssh' || conn.protocol === 'sftp';

        interface ActionItem extends vscode.QuickPickItem {
            action: string;
        }

        const actions: ActionItem[] = [];

        if (isConnected) {
            actions.push({
                label: `$(debug-disconnect) ${vscode.l10n.t('Disconnect')}`,
                action: 'disconnect',
            });
            actions.push({
                label: `$(folder-opened) ${vscode.l10n.t('Open Workspace')}`,
                action: 'openWorkspace',
            });
        } else {
            actions.push({
                label: `$(plug) ${vscode.l10n.t('Connect')}`,
                action: 'connect',
            });
        }

        if (isSsh) {
            actions.push({
                label: `$(terminal) ${vscode.l10n.t('Open SSH Terminal')}`,
                action: 'terminal',
            });
        }

        const actionSelected = await vscode.window.showQuickPick(actions, {
            title: `${conn.name} — ${conn.host}`,
            placeHolder: vscode.l10n.t('Select an action'),
        });

        if (!actionSelected) {
            return;
        }

        const node = { type: 'connection', connection: conn };

        switch (actionSelected.action) {
            case 'connect':
                await vscode.commands.executeCommand('remoteBridge.connect', node);
                break;
            case 'disconnect':
                await vscode.commands.executeCommand('remoteBridge.disconnect', node);
                break;
            case 'openWorkspace':
                await vscode.commands.executeCommand('remoteBridge.connect', node);
                break;
            case 'terminal':
                openSshTerminal(conn, this._connectionPool);
                break;
        }
    }

    dispose(): void {
        this._item.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
