import * as vscode from 'vscode';
import { EncryptionService } from './services/encryptionService';
import { CacheService } from './services/cacheService';
import { ConnectionManager } from './services/connectionManager';
import { ConnectionPool } from './services/connectionPool';
import { RemoteBridgeFileSystemProvider } from './providers/fileSystemProvider';
import { ConnectionTreeProvider } from './providers/connectionTreeProvider';
import { ActiveSessionsProvider } from './providers/activeSessionsProvider';
import { SshConfigImporter } from './importers/sshConfigImporter';
import { WinSCPImporter } from './importers/winscpImporter';
import { SshFsImporter } from './importers/sshFsImporter';
import { FileZillaImporter } from './importers/fileZillaImporter';
import { PuTTYImporter } from './importers/puttyImporter';
import { TotalCmdImporter } from './importers/totalCmdImporter';
import { JsonExporter } from './exporters/jsonExporter';
import { SshConfigExporter } from './exporters/sshConfigExporter';
import { openSshTerminal } from './terminal/sshTerminalProvider';
import { registerChatParticipant } from './chat/chatParticipant';
import { ReadFileTool } from './chat/tools/readFileTool';
import { SearchFilesTool } from './chat/tools/searchFilesTool';
import { RunCommandTool } from './chat/tools/runCommandTool';
import { StatusBarService } from './statusBar/statusBarService';
import { TransferTracker } from './services/transferTracker';
import { BackupService } from './services/backupService';
import { SyncService } from './services/syncService';
import { buildRemoteUri, parseRemoteUri } from './utils/uriParser';
import {
    createWorkspaceFile,
    addFolderToWorkspaceFile,
    isOurWorkspaceFile,
    openWorkspaceFile,
    deleteWorkspaceFileForConnection,
} from './utils/workspaceFileManager';
import { ConnectionFormPanel } from './webview/connectionFormPanel';
import {
    ConnectionConfig,
    DEFAULT_PORTS,
    secretKeyForPassword,
    secretKeyForPassphrase,
    ImportResult,
} from './types/connection';

let encryptionService: EncryptionService;
let cacheService: CacheService;
let connectionManager: ConnectionManager;
let connectionPool: ConnectionPool;
let transferTracker: TransferTracker;
let backupService: BackupService;
let syncService: SyncService;
let applySyncRegistration: () => void;

type TreeConnectionNode = { type: 'connection'; connection: ConnectionConfig };
type TreeFolderNode = { type: 'folder'; folder: { id: string; name: string; parentId?: string } };
type TreeNode = TreeConnectionNode | TreeFolderNode;

function getSelectedConnections(node: TreeNode | undefined, selectedNodes?: readonly TreeNode[]): TreeConnectionNode[] {
    const candidates = selectedNodes && selectedNodes.length > 0
        ? [...selectedNodes]
        : (node ? [node] : []);

    if (node && node.type === 'connection') {
        candidates.push(node);
    }

    const seen = new Set<string>();
    const result: TreeConnectionNode[] = [];
    for (const candidate of candidates) {
        if (!candidate || candidate.type !== 'connection') {
            continue;
        }
        if (seen.has(candidate.connection.id)) {
            continue;
        }
        seen.add(candidate.connection.id);
        result.push(candidate);
    }
    return result;
}

function buildFolderPath(folderId: string, foldersById: Map<string, { id: string; name: string; parentId?: string }>): string {
    const parts: string[] = [];
    let current = foldersById.get(folderId);

    while (current) {
        parts.unshift(current.name);
        current = current.parentId ? foldersById.get(current.parentId) : undefined;
    }

    return parts.join(' / ');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // ─── Initialize Services ────────────────────────────────────
    encryptionService = new EncryptionService(context.globalState);
    context.subscriptions.push({ dispose: () => encryptionService.dispose() });

    // Keep VS Code context keys in sync with encryption state
    await setEncryptionContextKeysAsync(encryptionService);
    context.subscriptions.push(
        encryptionService.onDidLock(() => setEncryptionContextKeys(encryptionService)),
        encryptionService.onDidUnlock(() => setEncryptionContextKeys(encryptionService))
    );

    // Notify user when the master password changed on another device via sync
    context.subscriptions.push(
        encryptionService.onDidDetectRemotePasswordChange(async () => {
            const action = await vscode.window.showWarningMessage(
                vscode.l10n.t('Remote Bridge: The master password was changed on another device. Please enter the new password to unlock connections.'),
                vscode.l10n.t('Unlock')
            );
            if (action) {
                const unlocked = await promptMasterPassword(encryptionService);
                if (unlocked) {
                    await connectionManager.load();
                    // Key rotation: the new encrypted blob may arrive with a delay — schedule retries.
                    syncService?.scheduleRetry();
                }
            }
        })
    );

    // Handle master password unlock
    if (encryptionService.isEnabled()) {
        const unlocked = await promptMasterPassword(encryptionService);
        if (!unlocked) {
            // Don't show a warning — the locked welcome view already communicates this.
        }
        // If unlock succeeded, syncService.scheduleRetry() is called below after SyncService is created.
    }

    // ─── Sync Registration ──────────────────────────────────────
    // Register encrypted store keys for VS Code Settings Sync when the user
    // has both master password AND syncConnections enabled. The unencrypted
    // store is intentionally never registered for sync.
    applySyncRegistration = (): void => {
        const secCfg = vscode.workspace.getConfiguration('remoteBridge.security');
        const syncWanted = !!secCfg.get<boolean>('syncConnections');
        if (syncWanted && !encryptionService.isEnabled()) {
            vscode.window.showWarningMessage(
                vscode.l10n.t('Remote Bridge: Connection sync requires a master password. Please enable master password encryption first.')
            );
        }
        encryptionService.setSyncEnabled(syncWanted && encryptionService.isEnabled());
    };

    applySyncRegistration();

    const config = vscode.workspace.getConfiguration('remoteBridge');
    cacheService = new CacheService(
        config.get<number>('cache.ttl', 30),
        10,
        config.get<number>('cache.maxSize', 10)
    );
    context.subscriptions.push({ dispose: () => cacheService.dispose() });

    transferTracker = new TransferTracker();
    context.subscriptions.push(transferTracker);

    connectionPool = new ConnectionPool(
        context.secrets,
        (id, type) =>
            type === 'password' ? secretKeyForPassword(id) : secretKeyForPassphrase(id),
        transferTracker
    );
    context.subscriptions.push(connectionPool);

    backupService = new BackupService(context.globalStorageUri);
    connectionManager = new ConnectionManager(encryptionService, context.secrets, backupService);
    context.subscriptions.push(connectionManager);

    // ─── Output Channel ──────────────────────────────────────────
    const outputChannel = vscode.window.createOutputChannel('Remote Bridge');
    context.subscriptions.push(outputChannel);

    await connectionManager.load();

    // ─── SyncService ─────────────────────────────────────────────
    syncService = new SyncService(connectionManager, encryptionService, outputChannel);
    context.subscriptions.push(syncService);
    syncService.startPeriodicSync();
    // Schedule retry if sync is active — Settings Sync may deliver data after activation.
    if (encryptionService.isEnabled() && encryptionService.isUnlocked()) {
        const secCfg = vscode.workspace.getConfiguration('remoteBridge.security');
        if (secCfg.get<boolean>('syncConnections')) {
            syncService.scheduleRetry();
        }
    }

    // React to syncConnections setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('remoteBridge.security.syncConnections')) {
                applySyncRegistration();
                // If sync was just enabled and the store is already unlocked,
                // schedule a retry to load any connections delivered via Settings Sync.
                if (encryptionService.isEnabled() && encryptionService.isUnlocked()) {
                    const cfg = vscode.workspace.getConfiguration('remoteBridge.security');
                    if (cfg.get<boolean>('syncConnections')) {
                        syncService.scheduleRetry();
                    } else {
                        syncService.cancelRetry();
                    }
                }
            }
        })
    );

    // ─── FileSystemProvider ─────────────────────────────────────
    const fsProvider = new RemoteBridgeFileSystemProvider(
        connectionPool,
        connectionManager,
        cacheService
    );
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('remote-bridge', fsProvider, {
            isCaseSensitive: true,
        })
    );
    context.subscriptions.push(fsProvider);

    // ─── Workspace Folder Label Sync ────────────────────────────
    // Ensure remote-bridge workspace folders always show the connection name
    const syncWorkspaceFolderNames = (): void => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            return;
        }
        for (const wf of folders) {
            if (wf.uri.scheme !== 'remote-bridge') {
                continue;
            }
            const connId = wf.uri.authority;
            const conn = connectionManager.getConnections().find(c => c.id === connId);
            if (conn) {
                const expectedName = `${conn.name} (${conn.host})`;
                if (wf.name !== expectedName) {
                    vscode.workspace.updateWorkspaceFolders(wf.index, 1, {
                        uri: wf.uri,
                        name: expectedName,
                    });
                }
            }
        }
    };
    connectionManager.onDidChange(syncWorkspaceFolderNames);
    syncWorkspaceFolderNames();

    // ─── Master Password Hint ──────────────────────────────────
    // Show a one-time tip encouraging new users to set up master password
    // encryption after they add their very first connection.
    context.subscriptions.push(
        connectionManager.onDidChange(async () => {
            if (
                connectionManager.getConnections().length === 1 &&
                !encryptionService.isEnabled() &&
                !context.globalState.get('remote-bridge.masterPasswordHintShown')
            ) {
                await context.globalState.update('remote-bridge.masterPasswordHintShown', true);
                const choice = await vscode.window.showInformationMessage(
                    vscode.l10n.t(
                        'Tip: Enable master password to encrypt your connections, get automatic backups, and sync across devices.'
                    ),
                    vscode.l10n.t('Set Master Password'),
                    vscode.l10n.t("Don't Show Again")
                );
                if (choice === vscode.l10n.t('Set Master Password')) {
                    vscode.commands.executeCommand('remoteBridge.setMasterPassword');
                }
            }
        })
    );

    // ─── Auto-Reconnect ───────────────────────────────────────
    // When VS Code reopens a .code-workspace file containing remote-bridge:// folders,
    // proactively reconnect so the status bar and tree view reflect the live state.
    (async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) { return; }
        const remoteFolders = folders.filter(wf => wf.uri.scheme === 'remote-bridge');
        if (remoteFolders.length === 0) { return; }

        for (const wf of remoteFolders) {
            const connId = wf.uri.authority;
            const conn = connectionManager.getConnections().find(c => c.id === connId);
            if (!conn) { continue; }
            connectionPool.getAdapter(conn).catch(() => {
                // Reconnect failed silently — FileSystemProvider will surface errors on access
            });
        }
    })();

    // ─── Tree View ──────────────────────────────────────────────
    const treeProvider = new ConnectionTreeProvider(connectionManager, connectionPool, encryptionService);
    const treeView = vscode.window.createTreeView('remoteBridge.connections', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
        canSelectMany: true,
        dragAndDropController: treeProvider,
    });
    context.subscriptions.push(treeView);
    context.subscriptions.push(treeProvider);

    // ─── Active Sessions View ───────────────────────────────────
    const activeSessionsProvider = new ActiveSessionsProvider(connectionPool);
    const activeSessionsView = vscode.window.createTreeView('remoteBridge.activeSessions', {
        treeDataProvider: activeSessionsProvider,
    });
    context.subscriptions.push(activeSessionsView);
    context.subscriptions.push(activeSessionsProvider);

    // ─── Status Bar ─────────────────────────────────────────────
    const statusBarService = new StatusBarService(connectionManager, connectionPool, encryptionService, context);
    context.subscriptions.push(statusBarService);

    // ─── Register Commands ──────────────────────────────────────
    registerCommands(context, treeProvider);

    // ─── Getting Started Walkthrough (first install only) ───────
    if (!context.globalState.get('remote-bridge.walkthroughShown')) {
        await context.globalState.update('remote-bridge.walkthroughShown', true);
        vscode.commands.executeCommand(
            'workbench.action.openWalkthrough',
            'DavidLouda.remote-bridge#remoteBridge.getStarted',
            false
        );
    }

    // Window-focus sync and periodic polling are now handled by SyncService.

    // ─── LM Tools ───────────────────────────────────────────────
    context.subscriptions.push(
        vscode.lm.registerTool(
            'remote-bridge_runCommand',
            new RunCommandTool(connectionManager, connectionPool)
        )
    );
    context.subscriptions.push(
        vscode.lm.registerTool(
            'remote-bridge_searchFiles',
            new SearchFilesTool(connectionManager, connectionPool)
        )
    );
    context.subscriptions.push(
        vscode.lm.registerTool(
            'remote-bridge_readFile',
            new ReadFileTool(connectionManager, connectionPool, cacheService)
        )
    );

    // ─── Chat Participant (always registered) ──────────────────
    context.subscriptions.push(registerChatParticipant(context, connectionManager, connectionPool));

    // ─── Configuration Change Listener ──────────────────────────
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('remoteBridge.cache')) {
                const cfg = vscode.workspace.getConfiguration('remoteBridge');
                cacheService.updateConfig(
                    cfg.get<number>('cache.ttl', 30),
                    10,
                    cfg.get<number>('cache.maxSize', 10)
                );
            }
            if (e.affectsConfiguration('remoteBridge.pool') || e.affectsConfiguration('remoteBridge.watch') || e.affectsConfiguration('remoteBridge.security')) {
                // These settings are read on-demand (pool.maxConnections,
                // pool.idleTimeout, watch.pollInterval, security.idleTimeout)
                // so no explicit reconfiguration is needed — just log the change.
                console.log('[Remote Bridge] Configuration changed — new values will be used on next operation');
            }
        })
    );
}

export async function deactivate(): Promise<void> {
    if (connectionPool) {
        await connectionPool.disconnectAll();
        connectionPool.dispose();
    }
}

// ─── Command Registration ───────────────────────────────────────

function registerCommands(
    context: vscode.ExtensionContext,
    treeProvider: ConnectionTreeProvider
): void {
    // Add Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.addConnection', () => {
            ConnectionFormPanel.openForNew(
                context.extensionUri,
                connectionManager,
                connectionPool,
                context.secrets
            );
        })
    );

    // Edit Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.editConnection', (node: TreeNode) => {
            if (!node || node.type !== 'connection') {
                return;
            }
            ConnectionFormPanel.openForEdit(
                context.extensionUri,
                connectionManager,
                connectionPool,
                context.secrets,
                node.connection
            );
        })
    );

    // Delete Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.deleteConnection', async (node: TreeNode, selectedNodes?: readonly TreeNode[]) => {
            const connections = getSelectedConnections(node, selectedNodes);
            if (connections.length === 0) {
                return;
            }

            const ids = connections.map((item) => item.connection.id);
            const confirm = await vscode.window.showWarningMessage(
                connections.length === 1
                    ? vscode.l10n.t('Delete connection "{0}"?', connections[0].connection.name)
                    : vscode.l10n.t('Delete {0} connections?', String(connections.length)),
                { modal: true },
                vscode.l10n.t('Delete')
            );

            if (confirm) {
                for (const id of ids) {
                    await connectionPool.disconnect(id);
                    cacheService.invalidateConnection(id);
                    await deleteWorkspaceFileForConnection(context.globalStorageUri, id);
                }
                await connectionManager.deleteConnections(ids);
            }
        })
    );

    // Connect — adds workspace folder, manages .code-workspace file, reveals Explorer
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.connect', async (node: TreeNode, selectedNodes?: readonly TreeNode[]) => {
            const items = getSelectedConnections(node, selectedNodes);
            if (items.length === 0) {
                return;
            }

            // Connect each server (collect successes)
            const connected: typeof items = [];
            for (const item of items) {
                const conn = item.connection;
                try {
                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Notification,
                            title: vscode.l10n.t('Connecting to {0}...', conn.name),
                            cancellable: false,
                        },
                        async () => {
                            await connectionPool.getAdapter(conn);
                        }
                    );
                    connected.push(item);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(
                        vscode.l10n.t('Connection to {0} failed: {1}', conn.name, message)
                    );
                }
            }

            if (connected.length === 0) { return; }

            // Filter to servers not yet present as workspace folders
            const toAdd = connected.filter(item =>
                !vscode.workspace.workspaceFolders?.some(
                    wf => wf.uri.scheme === 'remote-bridge' && wf.uri.authority === item.connection.id
                )
            );

            if (toAdd.length === 0) {
                // All already in workspace — just reveal Explorer
                await vscode.commands.executeCommand('workbench.view.explorer');
                return;
            }

            // True only when our workspace file is open AND still has remote-bridge folders.
            // After a disconnect removes all folders the workspace is "empty" — treat it
            // as if no workspace file is open so a fresh one is created for the new server.
            const hasActiveFolders = vscode.workspace.workspaceFolders?.some(
                wf => wf.uri.scheme === 'remote-bridge'
            ) ?? false;

            if (isOurWorkspaceFile(context.globalStorageUri) && hasActiveFolders) {
                // Already inside one of our .code-workspace files:
                // add new folder(s) in-place (no reload needed).
                const wsFile = vscode.workspace.workspaceFile!;
                for (const item of toAdd) {
                    const conn = item.connection;
                    const uri = buildRemoteUri(conn.id, conn.remotePath);
                    vscode.workspace.updateWorkspaceFolders(
                        vscode.workspace.workspaceFolders?.length ?? 0,
                        null,
                        { uri, name: `${conn.name} (${conn.host})` }
                    );
                    await addFolderToWorkspaceFile(wsFile, conn);
                }
                await vscode.commands.executeCommand('workbench.view.explorer');
            } else {
                // Not yet in our workspace: create a .code-workspace file and open it.
                // This triggers a window reload — code after this call will not run.
                const wsFileUri = await createWorkspaceFile(
                    context.globalStorageUri,
                    toAdd.map(i => i.connection)
                );
                await openWorkspaceFile(wsFileUri);
            }
        })
    );

    // Disconnect — also removes the workspace folder
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.disconnect', async (node: TreeNode, selectedNodes?: readonly TreeNode[]) => {
            const connections = getSelectedConnections(node, selectedNodes);
            if (connections.length === 0) {
                return;
            }

            for (const item of connections) {
                const connId = item.connection.id;

                // Remove workspace folder for this connection
                const folders = vscode.workspace.workspaceFolders;
                if (folders) {
                    const idx = folders.findIndex(
                        wf => wf.uri.scheme === 'remote-bridge' && wf.uri.authority === connId
                    );
                    if (idx !== -1) {
                        vscode.workspace.updateWorkspaceFolders(idx, 1);
                    }
                }

                await connectionPool.disconnect(connId);
                cacheService.invalidateConnection(connId);
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Disconnected from {0}', item.connection.name)
                );
            }
        })
    );

    // Open as Workspace (kept for backward compatibility, delegates to connect)
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.openWorkspace', async (node: TreeNode, selectedNodes?: readonly TreeNode[]) => {
            await vscode.commands.executeCommand('remoteBridge.connect', node, selectedNodes);
        })
    );

    // Open SSH Terminal
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.openTerminal', async (node: TreeNode) => {
            if (!node || node.type !== 'connection') {
                return;
            }
            if (node.connection.protocol !== 'ssh' && node.connection.protocol !== 'sftp') {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('SSH terminal is only available for SSH/SFTP connections.')
                );
                return;
            }
            openSshTerminal(node.connection, connectionPool);
        })
    );

    // Add Folder
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.addFolder', async () => {
            const name = await vscode.window.showInputBox({
                title: vscode.l10n.t('Folder Name'),
                prompt: vscode.l10n.t('Enter a name for the new folder'),
                validateInput: (v) =>
                    v.trim() ? null : vscode.l10n.t('Name is required'),
            });
            if (!name) {
                return;
            }
            await connectionManager.addFolder(name.trim());
        })
    );

    // Rename Folder
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.renameFolder', async (node: { type: string; folder: { id: string; name: string } }) => {
            if (!node || node.type !== 'folder') {
                return;
            }
            const newName = await vscode.window.showInputBox({
                title: vscode.l10n.t('Rename Folder'),
                value: node.folder.name,
                validateInput: (v) =>
                    v.trim() ? null : vscode.l10n.t('Name is required'),
            });
            if (!newName) {
                return;
            }
            await connectionManager.renameFolder(node.folder.id, newName.trim());
        })
    );

    // Delete Folder
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.deleteFolder', async (node: TreeNode) => {
            if (!node || node.type !== 'folder') {
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t('Delete folder "{0}" and all nested content? All connections in this folder and subfolders will be permanently deleted.', node.folder.name),
                { modal: true },
                vscode.l10n.t('Delete')
            );

            if (confirm) {
                await connectionManager.deleteFolder(node.folder.id, false);
            }
        })
    );

    // Duplicate Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.duplicateConnection', async (node: TreeNode) => {
            if (!node || node.type !== 'connection') {
                return;
            }
            await connectionManager.duplicateConnection(node.connection.id);
        })
    );

    // Move Connection(s) to Folder
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.moveToFolder', async (node: TreeNode, selectedNodes?: readonly TreeNode[]) => {
            const connections = getSelectedConnections(node, selectedNodes);
            if (connections.length === 0) {
                return;
            }

            const folders = connectionManager.getFolders();
            const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
            const targetOptions = [
                {
                    label: vscode.l10n.t('Root'),
                    description: vscode.l10n.t('Top level'),
                    folderId: undefined as string | undefined,
                },
                ...folders
                    .map((folder) => ({
                        label: buildFolderPath(folder.id, foldersById),
                        folderId: folder.id,
                    }))
                    .sort((a, b) => a.label.localeCompare(b.label)),
            ];

            const selectedTarget = await vscode.window.showQuickPick(targetOptions, {
                title: vscode.l10n.t('Select target folder'),
                placeHolder: vscode.l10n.t('Move {0} connection(s)', String(connections.length)),
                matchOnDescription: true,
            });
            if (!selectedTarget) {
                return;
            }

            await connectionManager.moveMultipleToFolder(
                connections.map((item) => item.connection.id),
                selectedTarget.folderId
            );
        })
    );

    // Import (quick pick)
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.import', async () => {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: vscode.l10n.t('SSH Config'), description: '~/.ssh/config', value: 'ssh' as const },
                    { label: 'WinSCP', description: 'WinSCP.ini', value: 'winscp' as const },
                    { label: 'SSH FS', description: vscode.l10n.t('VS Code Extension'), value: 'sshfs' as const },
                    { label: 'FileZilla', description: 'sitemanager.xml', value: 'filezilla' as const },
                    { label: 'PuTTY', description: vscode.l10n.t('Registry / ~/.putty/sessions'), value: 'putty' as const },
                    { label: 'Total Commander', description: 'wcx_ftp.ini', value: 'totalcmd' as const },
                ],
                { title: vscode.l10n.t('Import connections from') }
            );
            if (!choice) {
                return;
            }

            switch (choice.value) {
                case 'ssh':
                    await vscode.commands.executeCommand('remoteBridge.importSSH');
                    break;
                case 'winscp':
                    await vscode.commands.executeCommand('remoteBridge.importWinSCP');
                    break;
                case 'sshfs':
                    await vscode.commands.executeCommand('remoteBridge.importSSHFS');
                    break;
                case 'filezilla':
                    await vscode.commands.executeCommand('remoteBridge.importFileZilla');
                    break;
                case 'putty':
                    await vscode.commands.executeCommand('remoteBridge.importPuTTY');
                    break;
                case 'totalcmd':
                    await vscode.commands.executeCommand('remoteBridge.importTotalCmd');
                    break;
            }
        })
    );

    // Import from SSH Config
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.importSSH', async () => {
            const importer = new SshConfigImporter();
            await handleImportResult(importer.import());
        })
    );

    // Import from WinSCP
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.importWinSCP', async () => {
            const importer = new WinSCPImporter();
            await handleImportResult(importer.import());
        })
    );

    // Import from SSH FS
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.importSSHFS', async () => {
            const importer = new SshFsImporter();
            await handleImportResult(importer.import());
        })
    );

    // Import from FileZilla
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.importFileZilla', async () => {
            const importer = new FileZillaImporter();
            await handleImportResult(importer.import());
        })
    );

    // Import from PuTTY
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.importPuTTY', async () => {
            const importer = new PuTTYImporter();
            await handleImportResult(importer.import());
        })
    );

    // Import from Total Commander
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.importTotalCmd', async () => {
            const importer = new TotalCmdImporter();
            await handleImportResult(importer.import());
        })
    );

    // Export Connections
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.exportConnections', async () => {
            const connections = connectionManager.getConnections();
            if (connections.length === 0) {
                vscode.window.showInformationMessage(vscode.l10n.t('No connections to export.'));
                return;
            }

            const formatChoice = await vscode.window.showQuickPick(
                [
                    {
                        label: 'JSON (Remote Bridge)',
                        description: vscode.l10n.t('All connections, re-importable'),
                        value: 'json' as const,
                    },
                    {
                        label: 'SSH Config',
                        description: vscode.l10n.t('SSH/SFTP connections only'),
                        value: 'ssh-config' as const,
                    },
                ],
                { title: vscode.l10n.t('Export connections as') }
            );
            if (!formatChoice) {
                return;
            }

            if (formatChoice.value === 'json') {
                const includePwdChoice = await vscode.window.showWarningMessage(
                    vscode.l10n.t('Include passwords in export? They will be stored as plain text.'),
                    { modal: true },
                    vscode.l10n.t('Include Passwords'),
                    vscode.l10n.t('Skip Passwords')
                );
                if (!includePwdChoice) {
                    return;
                }
                const includePasswords = includePwdChoice === vscode.l10n.t('Include Passwords');

                const saveUri = await vscode.window.showSaveDialog({
                    title: vscode.l10n.t('Export connections as JSON'),
                    defaultUri: vscode.Uri.file('remote-bridge-connections.json'),
                    filters: { JSON: ['json'] },
                });
                if (!saveUri) {
                    return;
                }

                const exporter = new JsonExporter();
                const content = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: vscode.l10n.t('Exporting connections...'),
                        cancellable: false,
                    },
                    () => exporter.export(connections, connectionManager.getFolders(), context.secrets, includePasswords)
                );

                await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf-8'));
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Exported {0} connections.', String(connections.length))
                );
            } else {
                const saveUri = await vscode.window.showSaveDialog({
                    title: vscode.l10n.t('Export connections as SSH Config'),
                    defaultUri: vscode.Uri.file('ssh_config'),
                    filters: { 'SSH Config': ['conf', 'config', ''], All: ['*'] },
                });
                if (!saveUri) {
                    return;
                }

                const exporter = new SshConfigExporter();
                const result = exporter.export(connections);
                await vscode.workspace.fs.writeFile(saveUri, Buffer.from(result.content, 'utf-8'));

                if (result.skipped > 0) {
                    vscode.window.showWarningMessage(
                        vscode.l10n.t(
                            'Exported {0} SSH/SFTP connections. {1} FTP/FTPS connections were skipped (not supported by SSH Config format).',
                            String(result.exported),
                            String(result.skipped)
                        )
                    );
                } else {
                    vscode.window.showInformationMessage(
                        vscode.l10n.t('Exported {0} connections.', String(result.exported))
                    );
                }
            }
        })
    );

    // Set Master Password
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.setMasterPassword', async () => {
            // Guard: if encryption meta already exists (e.g. delivered via Settings Sync
            // from another device) but the store is currently locked, redirect to unlock
            // instead of creating a new incompatible salt — which would destroy synced data.
            if (encryptionService.isEnabled() && !encryptionService.isUnlocked()) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Remote Bridge: Synced connections detected. Enter the master password from your other device to unlock them.')
                );
                const unlocked = await promptMasterPassword(encryptionService);
                if (unlocked) {
                    await connectionManager.load();
                    applySyncRegistration();
                }
                return;
            }

            const password = await vscode.window.showInputBox({
                title: vscode.l10n.t('Set Master Password'),
                prompt: vscode.l10n.t('Enter a master password to encrypt your connections'),
                password: true,
                ignoreFocusOut: true,
                validateInput: (v) =>
                    v.length >= 8
                        ? null
                        : vscode.l10n.t('Password must be at least 8 characters'),
            });
            if (!password) {
                return;
            }

            const confirm = await vscode.window.showInputBox({
                title: vscode.l10n.t('Confirm Master Password'),
                prompt: vscode.l10n.t('Re-enter the master password'),
                password: true,
                ignoreFocusOut: true,
            });

            if (confirm !== password) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Passwords do not match.')
                );
                return;
            }

            await encryptionService.setupMasterPassword(password);
            await connectionManager.save();
            applySyncRegistration();
            // Reload to pick up any connections that may have been delivered via
            // Settings Sync between activation and this point.
            await connectionManager.load();
            // Schedule retry in case the encrypted blob hasn't arrived yet.
            const cfgAfterSetup = vscode.workspace.getConfiguration('remoteBridge.security');
            if (cfgAfterSetup.get<boolean>('syncConnections')) {
                syncService?.scheduleRetry();
            }
            setEncryptionContextKeys(encryptionService);
            vscode.window.showInformationMessage(
                vscode.l10n.t('Master password set successfully.')
            );
        })
    );

    // Remove Master Password
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.removeMasterPassword', async () => {
            if (!encryptionService.isEnabled()) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('No master password is set.')
                );
                return;
            }

            if (!encryptionService.isUnlocked()) {
                const unlocked = await promptMasterPassword(encryptionService);
                if (!unlocked) {
                    return;
                }
            }

            const confirm = await vscode.window.showWarningMessage(
                vscode.l10n.t('Remove master password? Your connections will be stored without encryption.'),
                { modal: true },
                vscode.l10n.t('Remove')
            );

            if (confirm) {
                await encryptionService.removeMasterPassword();
                await connectionManager.load();
                applySyncRegistration();
                setEncryptionContextKeys(encryptionService);
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Master password removed.')
                );
            }
        })
    );

    // Unlock Master Password
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.unlockMasterPassword', async () => {
            if (!encryptionService.isEnabled()) {
                return;
            }
            if (encryptionService.isUnlocked()) {
                return;
            }
            const unlocked = await promptMasterPassword(encryptionService);
            if (unlocked) {
                await connectionManager.load();
                applySyncRegistration();
                if (encryptionService.isEnabled()) {
                    const secCfg = vscode.workspace.getConfiguration('remoteBridge.security');
                    if (secCfg.get<boolean>('syncConnections')) {
                        syncService?.scheduleRetry();
                    }
                }
            }
        })
    );

    // Lock Master Password
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.lockMasterPassword', async () => {
            if (!encryptionService.isEnabled() || !encryptionService.isUnlocked()) {
                return;
            }
            encryptionService.lock();
            syncService?.cancelRetry();
        })
    );

    // Change Master Password
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.changeMasterPassword', async () => {
            if (!encryptionService.isEnabled()) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('No master password is set.')
                );
                return;
            }

            // Ask for the current password first
            const currentPassword = await vscode.window.showInputBox({
                title: vscode.l10n.t('Change Master Password'),
                prompt: vscode.l10n.t('Enter your current master password'),
                password: true,
                ignoreFocusOut: true,
            });
            if (!currentPassword) {
                return;
            }

            // Ask for the new password
            const newPassword = await vscode.window.showInputBox({
                title: vscode.l10n.t('Change Master Password'),
                prompt: vscode.l10n.t('Enter the new master password'),
                password: true,
                ignoreFocusOut: true,
                validateInput: (v) =>
                    v.length >= 8
                        ? null
                        : vscode.l10n.t('Password must be at least 8 characters'),
            });
            if (!newPassword) {
                return;
            }

            // Confirm new password
            const confirmPassword = await vscode.window.showInputBox({
                title: vscode.l10n.t('Change Master Password'),
                prompt: vscode.l10n.t('Re-enter the new master password'),
                password: true,
                ignoreFocusOut: true,
            });
            if (confirmPassword !== newPassword) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Passwords do not match.')
                );
                return;
            }

            const changed = await encryptionService.changeMasterPassword(currentPassword, newPassword);
            if (!changed) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Incorrect current password.')
                );
                return;
            }

            await connectionManager.save();
            const cfgChange = vscode.workspace.getConfiguration('remoteBridge.security');
            if (cfgChange.get<boolean>('syncConnections')) {
                syncService?.scheduleRetry();
            }
            vscode.window.showInformationMessage(
                vscode.l10n.t('Master password changed successfully.')
            );
        })
    );

    // Sync Now
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.syncNow', async () => {
            const secCfg = vscode.workspace.getConfiguration('remoteBridge.security');
            if (!secCfg.get<boolean>('syncConnections')) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Remote Bridge: Connection sync is not enabled. Enable it in Settings → Remote Bridge → Security → Sync Connections.')
                );
                return;
            }
            if (!encryptionService.isUnlocked()) {
                const unlocked = await promptMasterPassword(encryptionService);
                if (!unlocked) { return; }
            }
            await syncService.syncNow();
        })
    );

    // Restore from Backup
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.restoreBackup', async () => {
            if (!encryptionService.isEnabled()) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Backups are only available with master password encryption.')
                );
                return;
            }
            if (!encryptionService.isUnlocked()) {
                const unlocked = await promptMasterPassword(encryptionService);
                if (!unlocked) { return; }
            }

            const entries = await backupService.listBackups();
            if (entries.length === 0) {
                vscode.window.showInformationMessage(
                    vscode.l10n.t('No backups available.')
                );
                return;
            }

            const picked = await vscode.window.showQuickPick(entries, {
                title: vscode.l10n.t('Restore Connections from Backup'),
                placeHolder: vscode.l10n.t('Select a backup to restore'),
            });
            if (!picked) { return; }

            const confirm2 = await vscode.window.showWarningMessage(
                vscode.l10n.t('This will replace all current connections with the backup from {0}. Continue?', picked.label),
                { modal: true },
                vscode.l10n.t('Restore')
            );
            if (!confirm2) { return; }

            const backupFile = await backupService.readBackup(picked.uri);
            let store = await encryptionService.tryDecryptWith(backupFile.data, backupFile.meta);
            if (!store) {
                const oldPassword = await vscode.window.showInputBox({
                    title: vscode.l10n.t('Backup Master Password'),
                    prompt: vscode.l10n.t('This backup was created with a different master password. Enter it to decrypt.'),
                    password: true,
                    ignoreFocusOut: true,
                });
                if (!oldPassword) { return; }

                store = await encryptionService.decryptWithPassword(backupFile.data, backupFile.meta, oldPassword);
                if (!store) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t('Incorrect password. Cannot decrypt backup.')
                    );
                    return;
                }
            }

            await connectionManager.restoreFromBackup(store);
            const count = connectionManager.getConnections().length;
            vscode.window.showInformationMessage(
                vscode.l10n.t('Backup restored successfully. {0} connections recovered.', String(count))
            );
        })
    );

    // Create Backup
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.createBackup', async () => {
            if (!encryptionService.isEnabled()) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('Backups are only available with master password encryption.')
                );
                return;
            }
            if (!encryptionService.isUnlocked()) {
                const unlocked = await promptMasterPassword(encryptionService);
                if (!unlocked) { return; }
            }

            const blob = encryptionService.getEncryptedBlob();
            const meta = encryptionService.getMeta();
            if (!blob || !meta) {
                vscode.window.showWarningMessage(
                    vscode.l10n.t('No connections to back up.')
                );
                return;
            }

            await backupService.createManualBackup(blob, meta);
            vscode.window.showInformationMessage(
                vscode.l10n.t('Backup created successfully.')
            );
        })
    );

    // Refresh
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.refresh', () => {
            treeProvider.refresh();
        })
    );

    // Change Permissions
    context.subscriptions.push(
        vscode.commands.registerCommand('remoteBridge.changePermissions', async (uri: vscode.Uri) => {
            if (!uri || uri.scheme !== 'remote-bridge') {
                vscode.window.showErrorMessage(vscode.l10n.t('Change Permissions requires a remote file or folder.'));
                return;
            }
            const { connectionId, remotePath } = parseRemoteUri(uri);
            const adapter = connectionPool.getConnectedAdapter(connectionId);
            if (!adapter) {
                vscode.window.showErrorMessage(vscode.l10n.t('Not connected. Please connect to the server first.'));
                return;
            }
            if (!adapter.chmod || !adapter.getUnixMode) {
                vscode.window.showWarningMessage(vscode.l10n.t('Permissions not available for this connection or protocol.'));
                return;
            }
            const currentMode = await adapter.getUnixMode(remotePath);
            const currentOctal = currentMode !== undefined ? (currentMode & 0o7777).toString(8).padStart(3, '0') : undefined;
            const currentRwx = currentMode !== undefined ? modeToRwx(currentMode) : undefined;
            const filename = remotePath.split('/').pop() || remotePath;
            const newInput = await vscode.window.showInputBox({
                title: vscode.l10n.t('Change Permissions \u2014 {0}', filename),
                prompt: currentRwx
                    ? vscode.l10n.t('Current permissions: {0} ({1})', currentOctal ?? '???', currentRwx)
                    : vscode.l10n.t('Enter octal permissions'),
                value: currentOctal,
                placeHolder: vscode.l10n.t('e.g. 755 or 644'),
                validateInput: (v) => {
                    if (!/^[0-7]{3,4}$/.test(v.trim())) {
                        return vscode.l10n.t('Invalid mode: use 3 or 4 octal digits (0\u20137), e.g. 755 or 0755');
                    }
                    return null;
                },
            });
            if (!newInput) { return; }
            const newMode = parseInt(newInput.trim(), 8);
            try {
                await adapter.chmod(remotePath, newMode);
                cacheService.invalidatePath(connectionId, remotePath);
                vscode.window.showInformationMessage(
                    vscode.l10n.t('Permissions changed to {0}', newInput.trim().padStart(3, '0'))
                );
            } catch (err) {
                vscode.window.showErrorMessage(
                    vscode.l10n.t('Failed to change permissions: {0}', String(err instanceof Error ? err.message : err))
                );
            }
        })
    );
}

// ─── Helper Functions ───────────────────────────────────────────

function modeToRwx(mode: number): string {
    const bits = 'rwxrwxrwx';
    let result = '';
    for (let i = 8; i >= 0; i--) {
        result += (mode & (1 << i)) ? bits[8 - i] : '-';
    }
    return result;
}

/** Fire-and-forget variant used in event handlers. */
function setEncryptionContextKeys(encryption: EncryptionService): void {
    vscode.commands.executeCommand('setContext', 'remoteBridge.encryptionEnabled', encryption.isEnabled());
    vscode.commands.executeCommand('setContext', 'remoteBridge.encryptionUnlocked', encryption.isUnlocked());
}

/** Awaitable variant used during activation to ensure keys are set before the welcome view renders. */
async function setEncryptionContextKeysAsync(encryption: EncryptionService): Promise<void> {
    await Promise.all([
        vscode.commands.executeCommand('setContext', 'remoteBridge.encryptionEnabled', encryption.isEnabled()),
        vscode.commands.executeCommand('setContext', 'remoteBridge.encryptionUnlocked', encryption.isUnlocked()),
    ]);
}

async function promptMasterPassword(encryption: EncryptionService): Promise<boolean> {
    for (let attempts = 0; attempts < 3; attempts++) {
        const password = await vscode.window.showInputBox({
            title: vscode.l10n.t('Master Password'),
            prompt: vscode.l10n.t('Enter master password to unlock connections'),
            password: true,
            ignoreFocusOut: true,
        });

        if (!password) {
            return false;
        }

        const valid = await encryption.unlock(password);
        if (valid) {
            return true;
        }

        vscode.window.showErrorMessage(
            vscode.l10n.t('Incorrect master password. {0} attempts remaining.', String(2 - attempts))
        );
    }

    return false;
}

async function handleImportResult(resultPromise: Promise<ImportResult>): Promise<void> {
    try {
        const result = await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Importing connections...'),
                cancellable: false,
            },
            () => resultPromise
        );

        if (result.errors.length > 0) {
            for (const error of result.errors) {
                vscode.window.showWarningMessage(error);
            }
        }

        if (result.warnings && result.warnings.length > 0) {
            for (const warning of result.warnings) {
                vscode.window.showWarningMessage(warning);
            }
        }

        if (result.imported.length === 0) {
            vscode.window.showInformationMessage(
                vscode.l10n.t('No connections were imported.')
            );
            return;
        }

        // Create folder hierarchy first (WinSCP import)
        const folderPathToId = new Map<string, string>();
        const normalizeFolderPath = (value: string): string =>
            value
                .split('/')
                .map((segment) => segment.trim().toLowerCase())
                .filter((segment) => segment.length > 0)
                .join('/');
        const existingFolders = connectionManager.getFolders();
        const byId = new Map(existingFolders.map((folder) => [folder.id, folder]));

        const getExistingPath = (folderId: string): string => {
            const folder = byId.get(folderId);
            if (!folder) {
                return '';
            }
            if (!folder.parentId) {
                return folder.name;
            }
            const parentPath = getExistingPath(folder.parentId);
            return parentPath ? `${parentPath}/${folder.name}` : folder.name;
        };

        for (const folder of existingFolders) {
            const normalizedPath = normalizeFolderPath(getExistingPath(folder.id));
            if (!normalizedPath) {
                continue;
            }
            if (!folderPathToId.has(normalizedPath)) {
                folderPathToId.set(normalizedPath, folder.id);
            }
        }

        if (result.folders && result.folders.length > 0) {
            const sortedFolders = [...result.folders].sort(
                (a, b) => a.path.split('/').length - b.path.split('/').length
            );

            for (const folder of sortedFolders) {
                const normalizedPath = normalizeFolderPath(folder.path);
                if (!normalizedPath || folderPathToId.has(normalizedPath)) {
                    continue;
                }

                const parentId = folder.parentPath
                    ? folderPathToId.get(normalizeFolderPath(folder.parentPath))
                    : undefined;

                const alreadyExisting = connectionManager
                    .getFolders()
                    .find((item) => item.name.trim().toLowerCase() === folder.name.trim().toLowerCase() && item.parentId === parentId);

                if (alreadyExisting) {
                    folderPathToId.set(normalizedPath, alreadyExisting.id);
                    continue;
                }

                const created = await connectionManager.addFolder(folder.name, parentId);
                folderPathToId.set(normalizedPath, created.id);
            }
        }

        const importedConnections = result.imported.map((connection) => {
            if (!connection.folderId) {
                return connection;
            }
            const mappedFolderId = folderPathToId.get(normalizeFolderPath(connection.folderId));
            if (!mappedFolderId) {
                return connection;
            }
            return {
                ...connection,
                folderId: mappedFolderId,
            };
        });

        // Store imported connections
        const passwords = (result as ImportResult & { passwords?: Map<string, string> }).passwords;
        const proxyPasswords = (result as ImportResult & { proxyPasswords?: Map<string, string> }).proxyPasswords;
        const importResult = await connectionManager.importConnections(
            importedConnections,
            {
                passwords,
                proxyPasswords,
            }
        );

        if (importResult.errors.length > 0) {
            vscode.window.showWarningMessage(
                vscode.l10n.t('Some connections failed to import: {0}', importResult.errors.join('; '))
            );
        }

        const count = importResult.imported;
        const message =
            count === 1
                ? vscode.l10n.t('Imported 1 connection from {0}.', result.source)
                : vscode.l10n.t('Imported {0} connections from {1}.', String(count), result.source);

        vscode.window.showInformationMessage(message);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
            vscode.l10n.t('Import failed: {0}', message)
        );
    }
}
