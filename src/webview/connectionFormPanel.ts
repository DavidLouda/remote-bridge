import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConnectionConfig, ConnectionProtocol, DEFAULT_PORTS, secretKeyForPassword, secretKeyForPassphrase, secretKeyForProxyPassword } from '../types/connection';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionPool } from '../services/connectionPool';
import { SshAdapter } from '../adapters/sshAdapter';
import { FtpAdapter } from '../adapters/ftpAdapter';
import { generateId } from '../utils/uriParser';

/**
 * Manages a webview panel for adding / editing a connection.
 * Singleton — only one panel can be open at a time.
 */
export class ConnectionFormPanel {
    public static readonly viewType = 'remoteBridge.connectionForm';

    private static _instance: ConnectionFormPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];

    // Data to prefill when the webview signals "ready"
    private _pendingPrefill: Record<string, unknown> | null = null;

    // ID of the connection being edited (null when creating new)
    private _editingId: string | null = null;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _extensionUri: vscode.Uri,
        private readonly _connectionManager: ConnectionManager,
        private readonly _connectionPool: ConnectionPool,
        private readonly _secrets: vscode.SecretStorage
    ) {
        this._panel = panel;

        // Set the HTML
        this._panel.webview.html = this._getHtml();

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            (msg) => this._handleMessage(msg),
            null,
            this._disposables
        );

        // Clean up when closed
        this._panel.onDidDispose(
            () => this._dispose(),
            null,
            this._disposables
        );
    }

    // ─── Public factory methods ─────────────────────────────────

    /**
     * Open the form for a NEW connection.
     */
    static openForNew(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        connectionPool: ConnectionPool,
        secrets: vscode.SecretStorage
    ): void {
        const panel = ConnectionFormPanel._getOrCreatePanel(
            extensionUri,
            connectionManager,
            connectionPool,
            secrets,
            vscode.l10n.t('New Connection')
        );

        panel._editingId = null;
        panel._pendingPrefill = {
            protocol: 'ssh',
            port: DEFAULT_PORTS.ssh,
            authMethod: 'password',
            remotePath: '/',
            keepaliveInterval: 10,
            username: process.env.USER || process.env.USERNAME || '',
        };
        // If webview is already ready, send immediately
        panel._trySendPrefill();
    }

    /**
     * Open the form for EDITING an existing connection.
     */
    static openForEdit(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        connectionPool: ConnectionPool,
        secrets: vscode.SecretStorage,
        connection: ConnectionConfig
    ): void {
        const panel = ConnectionFormPanel._getOrCreatePanel(
            extensionUri,
            connectionManager,
            connectionPool,
            secrets,
            vscode.l10n.t('Edit Connection — {0}', connection.name)
        );

        panel._editingId = connection.id;
        panel._pendingPrefill = { ...connection };
        panel._trySendPrefill();
    }

    // ─── Panel lifecycle ────────────────────────────────────────

    private static _getOrCreatePanel(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        connectionPool: ConnectionPool,
        secrets: vscode.SecretStorage,
        title: string
    ): ConnectionFormPanel {
        // If already open, reveal & update
        if (ConnectionFormPanel._instance) {
            ConnectionFormPanel._instance._panel.title = title;
            ConnectionFormPanel._instance._panel.reveal(vscode.ViewColumn.One);
            // Reset the HTML so the form is fresh
            ConnectionFormPanel._instance._panel.webview.html =
                ConnectionFormPanel._instance._getHtml();
            return ConnectionFormPanel._instance;
        }

        const panel = vscode.window.createWebviewPanel(
            ConnectionFormPanel.viewType,
            title,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            }
        );

        ConnectionFormPanel._instance = new ConnectionFormPanel(
            panel,
            extensionUri,
            connectionManager,
            connectionPool,
            secrets
        );

        return ConnectionFormPanel._instance;
    }

    private _dispose(): void {
        ConnectionFormPanel._instance = undefined;
        for (const d of this._disposables) {
            d.dispose();
        }
    }

    // ─── Message handler ────────────────────────────────────────

    private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this._trySendPrefill();
                this._sendLabels();
                break;

            case 'save':
                await this._handleSave(
                    msg.data as Record<string, unknown>,
                    msg.editingId as string | null
                );
                break;

            case 'test':
                await this._handleTest(msg.data as Record<string, unknown>);
                break;

            case 'browseKey':
                await this._handleBrowseKey();
                break;

            case 'cancel':
                this._panel.dispose();
                break;
        }
    }

    // ─── Save ───────────────────────────────────────────────────

    private async _handleSave(
        data: Record<string, unknown>,
        editingId: string | null
    ): Promise<void> {
        try {
            const password = data.password as string | undefined;
            const passphrase = data.passphrase as string | undefined;

            const configData = this._mapFormToConfig(data);

            // Extract proxy password — store in SecretStorage, not in config
            let proxyPassword: string | undefined;
            if (configData.proxy?.password) {
                proxyPassword = configData.proxy.password;
                delete configData.proxy.password;
            }

            if (editingId) {
                // Edit existing
                await this._connectionManager.updateConnection(
                    editingId,
                    configData,
                    password,
                    passphrase,
                    proxyPassword
                );
            } else {
                // Create new
                await this._connectionManager.addConnection(
                    configData,
                    password,
                    passphrase,
                    proxyPassword
                );
            }

            await this._panel.webview.postMessage({
                type: 'saveResult',
                success: true,
                labels: { saveBtn: vscode.l10n.t('Save') },
            });

            // Close the panel after save
            this._panel.dispose();

            vscode.window.showInformationMessage(
                editingId
                    ? vscode.l10n.t('Connection updated successfully.')
                    : vscode.l10n.t('Connection added successfully.')
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this._panel.webview.postMessage({
                type: 'saveResult',
                success: false,
                message: vscode.l10n.t('Failed to save: {0}', message),
                labels: { saveBtn: vscode.l10n.t('Save') },
            });
        }
    }

    // ─── Test Connection ────────────────────────────────────────

    private async _handleTest(data: Record<string, unknown>): Promise<void> {
        try {
            const protocol = data.protocol as ConnectionProtocol;
            let password = (data.password as string) || '';
            let passphrase = (data.passphrase as string) || '';
            let proxyPassword = '';

            // When editing an existing connection, the password/passphrase fields
            // in the form are intentionally left empty (credentials live in
            // SecretStorage). Fall back to stored secrets so the test can succeed.
            if (this._editingId) {
                if (!password) {
                    password = (await this._secrets.get(secretKeyForPassword(this._editingId))) ?? '';
                }
                if (!passphrase) {
                    passphrase = (await this._secrets.get(secretKeyForPassphrase(this._editingId))) ?? '';
                }
                proxyPassword = (await this._secrets.get(secretKeyForProxyPassword(this._editingId))) ?? '';
            }

            const tempConfig: ConnectionConfig = {
                id: `test-${generateId()}`,
                sortOrder: 0,
                ...this._mapFormToConfig(data),
            };

            const getPassword = async () => password;
            const getPassphrase = async () => passphrase;
            const getProxyPassword = async () => proxyPassword || undefined;

            let adapter: SshAdapter | FtpAdapter;
            if (protocol === 'ssh' || protocol === 'sftp') {
                adapter = new SshAdapter(tempConfig, getPassword, getPassphrase, getProxyPassword);
            } else {
                adapter = new FtpAdapter(tempConfig, getPassword, getProxyPassword);
            }

            try {
                await adapter.connect();
                await adapter.disconnect();
                adapter.dispose();

                await this._panel.webview.postMessage({
                    type: 'testResult',
                    success: true,
                    message: vscode.l10n.t('Connection successful!'),
                    labels: { testBtn: vscode.l10n.t('Test Connection') },
                });
            } catch (err) {
                adapter.dispose();
                throw err;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this._panel.webview.postMessage({
                type: 'testResult',
                success: false,
                message: vscode.l10n.t('Connection failed: {0}', message),
                labels: { testBtn: vscode.l10n.t('Test Connection') },
            });
        }
    }

    // ─── Browse key ─────────────────────────────────────────────

    private async _handleBrowseKey(): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            title: vscode.l10n.t('Select Private Key'),
            canSelectMany: false,
            openLabel: vscode.l10n.t('Select'),
            filters: {
                // eslint-disable-next-line @typescript-eslint/naming-convention
                [vscode.l10n.t('Key files')]: ['pem', 'key', 'ppk', 'pub', ''],
                // eslint-disable-next-line @typescript-eslint/naming-convention
                [vscode.l10n.t('All files')]: ['*'],
            },
        });

        if (result && result.length > 0) {
            await this._panel.webview.postMessage({
                type: 'keySelected',
                path: result[0].fsPath,
            });
        }
    }

    // ─── Map form data → ConnectionConfig ───────────────────────

    private _mapFormToConfig(
        data: Record<string, unknown>
    ): Omit<ConnectionConfig, 'id' | 'sortOrder'> {
        const protocol = data.protocol as ConnectionProtocol;

        const config: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
            name: (data.name as string).trim(),
            protocol,
            host: (data.host as string).trim(),
            port: Number(data.port) || DEFAULT_PORTS[protocol],
            username: (data.username as string) || '',
            authMethod: data.authMethod as ConnectionConfig['authMethod'],
            remotePath: (data.remotePath as string) || '/',
            keepaliveInterval: Number(data.keepaliveInterval) || 10,
        };

        // Auth-specific
        if (config.authMethod === 'key') {
            config.privateKeyPath = (data.privateKeyPath as string) || undefined;
            config.hasPassphrase = !!data.hasPassphrase;
        }

        if (config.authMethod === 'agent') {
            config.agent = (data.agent as string) || undefined;
        }

        // FTP-specific
        if (protocol === 'ftp' || protocol === 'ftps') {
            config.secure = !!data.secure;
            if (data.allowSelfSigned) {
                config.allowSelfSigned = true;
            }
        }

        // Operating system
        const os = data.os as string;
        if (os === 'macos' || os === 'windows') {
            (config as Record<string, unknown>).os = os;
        }
        // 'linux' is the default — no need to store explicitly

        // Proxy
        if (data.proxy && typeof data.proxy === 'object') {
            const p = data.proxy as Record<string, unknown>;
            if (p.host && p.port) {
                config.proxy = {
                    type: (p.type as 'socks4' | 'socks5' | 'http') || 'socks5',
                    host: p.host as string,
                    port: Number(p.port),
                    username: (p.username as string) || undefined,
                    password: (p.password as string) || undefined,
                };
            }
        }

        return config;
    }

    // ─── Send prefill data ──────────────────────────────────────

    private _trySendPrefill(): void {
        if (this._pendingPrefill) {
            this._panel.webview.postMessage({
                type: 'prefill',
                data: this._pendingPrefill,
            });
        }
    }

    // ─── Send labels for localization ───────────────────────────

    private _sendLabels(): void {
        const labels: Record<string, string> = {
            formTitle: this._panel.title,
            saveBtn: vscode.l10n.t('Save'),
            testBtn: vscode.l10n.t('Test Connection'),
            testingBtn: vscode.l10n.t('Testing…'),
            cancelBtn: vscode.l10n.t('Cancel'),
            browseKeyBtn: vscode.l10n.t('Browse…'),

            sectionBasic: vscode.l10n.t('Basic'),
            sectionAuth: vscode.l10n.t('Authentication'),
            sectionAdvanced: vscode.l10n.t('Advanced'),

            labelName: vscode.l10n.t('Connection Name'),
            labelProtocol: vscode.l10n.t('Protocol'),
            labelHost: vscode.l10n.t('Host'),
            labelPort: vscode.l10n.t('Port'),
            labelUsername: vscode.l10n.t('Username'),
            labelAuthMethod: vscode.l10n.t('Authentication Method'),
            labelPassword: vscode.l10n.t('Password'),
            labelPrivateKey: vscode.l10n.t('Private Key Path'),
            labelHasPassphrase: vscode.l10n.t('Key has a passphrase'),
            labelPassphrase: vscode.l10n.t('Passphrase'),
            labelAgent: vscode.l10n.t('Agent Socket / Pageant'),
            labelRemotePath: vscode.l10n.t('Remote Path'),
            labelKeepalive: vscode.l10n.t('Keep-alive Interval (seconds)'),
            labelSecure: vscode.l10n.t('Use TLS (FTPS)'),
            labelAllowSelfSigned: vscode.l10n.t('Allow self-signed TLS certificates'),
            hintAllowSelfSigned: vscode.l10n.t('Disable certificate verification. Use only for servers with self-signed certificates.'),
            labelUseProxy: vscode.l10n.t('Use Proxy'),
            labelProxyType: vscode.l10n.t('Proxy Type'),
            labelProxyHost: vscode.l10n.t('Proxy Host'),
            labelProxyPort: vscode.l10n.t('Proxy Port'),
            labelProxyUsername: vscode.l10n.t('Proxy Username'),
            labelProxyPassword: vscode.l10n.t('Proxy Password'),
            labelOs: vscode.l10n.t('Operating System'),

            hintRemotePath: vscode.l10n.t('Default directory opened when connecting'),
            hintAgent: vscode.l10n.t('Path to SSH agent socket, or "pageant" on Windows'),
            hintPassword: vscode.l10n.t('Stored securely in VS Code SecretStorage'),
            hintOs: vscode.l10n.t('Determines which shell commands are used for remote operations'),

            nameError: vscode.l10n.t('Connection name is required'),
            hostError: vscode.l10n.t('Host is required'),
            portError: vscode.l10n.t('Enter a valid port (1–65535)'),

            optSsh: 'SSH',
            optSftp: 'SFTP',
            optFtp: 'FTP',
            optFtps: 'FTPS',
            optPassword: vscode.l10n.t('Password'),
            optKey: vscode.l10n.t('Private Key'),
            optAgent: vscode.l10n.t('SSH Agent'),
            optKeyboard: vscode.l10n.t('Keyboard Interactive'),
            optSocks4: 'SOCKS4',
            optSocks5: 'SOCKS5',
            optHttp: 'HTTP',
        };

        this._panel.webview.postMessage({ type: 'setLabels', labels });
    }

    /**
     * Build a map of localized strings for embedding directly in HTML.
     */
    private _getLocalizedStrings(): Record<string, string> {
        return {
            formTitle: escapeHtml(this._panel.title),
            saveBtn: escapeHtml(vscode.l10n.t('Save')),
            testBtn: escapeHtml(vscode.l10n.t('Test Connection')),
            cancelBtn: escapeHtml(vscode.l10n.t('Cancel')),
            browseKeyBtn: escapeHtml(vscode.l10n.t('Browse…')),

            sectionBasic: escapeHtml(vscode.l10n.t('Basic')),
            sectionAuth: escapeHtml(vscode.l10n.t('Authentication')),
            sectionAdvanced: escapeHtml(vscode.l10n.t('Advanced')),

            labelName: escapeHtml(vscode.l10n.t('Connection Name')),
            labelProtocol: escapeHtml(vscode.l10n.t('Protocol')),
            labelHost: escapeHtml(vscode.l10n.t('Host')),
            labelPort: escapeHtml(vscode.l10n.t('Port')),
            labelUsername: escapeHtml(vscode.l10n.t('Username')),
            labelAuthMethod: escapeHtml(vscode.l10n.t('Authentication Method')),
            labelPassword: escapeHtml(vscode.l10n.t('Password')),
            labelPrivateKey: escapeHtml(vscode.l10n.t('Private Key Path')),
            labelHasPassphrase: escapeHtml(vscode.l10n.t('Key has a passphrase')),
            labelPassphrase: escapeHtml(vscode.l10n.t('Passphrase')),
            labelAgent: escapeHtml(vscode.l10n.t('Agent Socket / Pageant')),
            labelRemotePath: escapeHtml(vscode.l10n.t('Remote Path')),
            labelKeepalive: escapeHtml(vscode.l10n.t('Keep-alive Interval (seconds)')),
            labelSecure: escapeHtml(vscode.l10n.t('Use TLS (FTPS)')),
            labelAllowSelfSigned: escapeHtml(vscode.l10n.t('Allow self-signed TLS certificates')),
            hintAllowSelfSigned: escapeHtml(vscode.l10n.t('Disable certificate verification. Use only for servers with self-signed certificates.')),
            labelUseProxy: escapeHtml(vscode.l10n.t('Use Proxy')),
            labelProxyType: escapeHtml(vscode.l10n.t('Proxy Type')),
            labelProxyHost: escapeHtml(vscode.l10n.t('Proxy Host')),
            labelProxyPort: escapeHtml(vscode.l10n.t('Proxy Port')),
            labelProxyUsername: escapeHtml(vscode.l10n.t('Proxy Username')),
            labelProxyPassword: escapeHtml(vscode.l10n.t('Proxy Password')),
            labelOs: escapeHtml(vscode.l10n.t('Operating System')),

            hintRemotePath: escapeHtml(vscode.l10n.t('Default directory opened when connecting')),
            hintAgent: escapeHtml(vscode.l10n.t('Path to SSH agent socket, or "pageant" on Windows')),
            hintPassword: escapeHtml(vscode.l10n.t('Stored securely in VS Code SecretStorage')),
            hintOs: escapeHtml(vscode.l10n.t('Determines which shell commands are used for remote operations')),

            nameError: escapeHtml(vscode.l10n.t('Connection name is required')),
            hostError: escapeHtml(vscode.l10n.t('Host is required')),
            portError: escapeHtml(vscode.l10n.t('Enter a valid port (1–65535)')),

            optPassword: escapeHtml(vscode.l10n.t('Password')),
            optKey: escapeHtml(vscode.l10n.t('Private Key')),
            optAgent: escapeHtml(vscode.l10n.t('SSH Agent')),
            optKeyboard: escapeHtml(vscode.l10n.t('Keyboard Interactive')),

            phName: escapeHtml(vscode.l10n.t('My Server')),
            phHost: escapeHtml(vscode.l10n.t('192.168.1.1 or example.com')),
            phAgent: escapeHtml(vscode.l10n.t('pageant')),
            phKey: escapeHtml(vscode.l10n.t('~/.ssh/id_rsa')),
            phProxy: escapeHtml(vscode.l10n.t('proxy.example.com')),
        };
    }

    // ─── Generate HTML ──────────────────────────────────────────

    private _getHtml(): string {
        const webview = this._panel.webview;
        const mediaUri = vscode.Uri.joinPath(this._extensionUri, 'media');

        const cssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, 'connectionForm.css')
        );
        const jsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(mediaUri, 'connectionForm.js')
        );

        const nonce = crypto.randomBytes(16).toString('hex');
        const s = this._getLocalizedStrings();

        return /* html */ `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource};
                   script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${cssUri}">
    <title>${s.formTitle}</title>
</head>
<body>

<h1 id="formTitle">${s.formTitle}</h1>

<!-- ─── Basic Section ──────────────────────────────────── -->
<div class="form-section">
    <h2 id="sectionBasic">${s.sectionBasic}</h2>
    <div class="form-grid">

        <div class="form-group">
            <label id="labelName" for="name">${s.labelName} <span class="required">*</span></label>
            <input type="text" id="name" placeholder="${s.phName}" required>
            <div class="validation-error" id="nameError">${s.nameError}</div>
        </div>

        <div class="form-group">
            <label id="labelProtocol" for="protocol">${s.labelProtocol}</label>
            <select id="protocol">
                <option id="optSsh" value="ssh">SSH</option>
                <option id="optSftp" value="sftp">SFTP</option>
                <option id="optFtp" value="ftp">FTP</option>
                <option id="optFtps" value="ftps">FTPS</option>
            </select>
        </div>

        <div class="form-group">
            <label id="labelHost" for="host">${s.labelHost} <span class="required">*</span></label>
            <input type="text" id="host" placeholder="${s.phHost}" required>
            <div class="validation-error" id="hostError">${s.hostError}</div>
        </div>

        <div class="form-group">
            <label id="labelPort" for="port">${s.labelPort} <span class="required">*</span></label>
            <input type="number" id="port" value="22" min="1" max="65535">
            <div class="validation-error" id="portError">${s.portError}</div>
        </div>

        <div class="form-group">
            <label id="labelUsername" for="username">${s.labelUsername}</label>
            <input type="text" id="username" placeholder="root">
        </div>

        <div class="form-group">
            <label id="labelRemotePath" for="remotePath">${s.labelRemotePath}</label>
            <input type="text" id="remotePath" value="/" placeholder="/">
            <div class="hint" id="hintRemotePath">${s.hintRemotePath}</div>
        </div>

        <div class="form-group">
            <label id="labelOs" for="os">${s.labelOs}</label>
            <select id="os">
                <option id="optLinux" value="linux" selected>Linux</option>
                <option id="optMacos" value="macos">macOS</option>
                <option id="optWindows" value="windows">Windows</option>
            </select>
            <div class="hint" id="hintOs">${s.hintOs}</div>
        </div>

    </div>
</div>

<!-- ─── Authentication Section ─────────────────────────── -->
<div class="form-section">
    <h2 id="sectionAuth">${s.sectionAuth}</h2>
    <div class="form-grid">

        <div class="form-group full-width">
            <label id="labelAuthMethod" for="authMethod">${s.labelAuthMethod}</label>
            <select id="authMethod">
                <option id="optPassword" value="password">${s.optPassword}</option>
                <option id="optKey" value="key">${s.optKey}</option>
                <option id="optAgent" value="agent">${s.optAgent}</option>
                <option id="optKeyboard" value="keyboard-interactive">${s.optKeyboard}</option>
            </select>
        </div>

        <!-- Password -->
        <div id="passwordSection" class="form-group full-width">
            <label id="labelPassword" for="password">${s.labelPassword}</label>
            <input type="password" id="password" placeholder="••••••••">
            <div class="hint" id="hintPassword">${s.hintPassword}</div>
        </div>

        <!-- Private Key -->
        <div id="keySection" class="hidden">
            <div class="form-grid" style="gap: 12px 20px;">
                <div class="form-group full-width">
                    <label id="labelPrivateKey" for="privateKeyPath">${s.labelPrivateKey}</label>
                    <div class="file-input-group">
                        <input type="text" id="privateKeyPath" placeholder="${s.phKey}">
                        <button type="button" class="secondary" id="browseKeyBtn">${s.browseKeyBtn}</button>
                    </div>
                </div>

                <div class="form-group checkbox-group full-width">
                    <input type="checkbox" id="hasPassphrase">
                    <label id="labelHasPassphrase" for="hasPassphrase">${s.labelHasPassphrase}</label>
                </div>

                <div class="form-group full-width">
                    <label id="labelPassphrase" for="passphrase">${s.labelPassphrase}</label>
                    <input type="password" id="passphrase" placeholder="••••••••">
                </div>
            </div>
        </div>

        <!-- SSH Agent -->
        <div id="agentSection" class="form-group full-width hidden">
            <label id="labelAgent" for="agent">${s.labelAgent}</label>
            <input type="text" id="agent" placeholder="${s.phAgent}">
            <div class="hint" id="hintAgent">${s.hintAgent}</div>
        </div>

    </div>
</div>

<!-- ─── Advanced Section ───────────────────────────────── -->
<div class="form-section">
    <h2 id="sectionAdvanced">${s.sectionAdvanced}</h2>
    <div class="form-grid">

        <div class="form-group">
            <label id="labelKeepalive" for="keepaliveInterval">${s.labelKeepalive}</label>
            <input type="number" id="keepaliveInterval" value="10" min="0" max="3600">
        </div>

        <!-- FTP-only: TLS -->
        <div id="secureSection" class="form-group checkbox-group hidden">
            <input type="checkbox" id="secure">
            <label id="labelSecure" for="secure">${s.labelSecure}</label>
        </div>

        <!-- FTP-only: Allow self-signed TLS certificates -->
        <div id="allowSelfSignedSection" class="form-group checkbox-group hidden">
            <input type="checkbox" id="allowSelfSigned">
            <label id="labelAllowSelfSigned" for="allowSelfSigned">${s.labelAllowSelfSigned}</label>
            <div class="hint" style="grid-column: 1 / -1; margin-top: 2px;" id="hintAllowSelfSigned">${s.hintAllowSelfSigned}</div>
        </div>

        <!-- Proxy -->
        <div class="form-group checkbox-group full-width">
            <input type="checkbox" id="useProxy">
            <label id="labelUseProxy" for="useProxy">${s.labelUseProxy}</label>
        </div>

        <div id="proxyFields" class="full-width hidden">
            <div class="form-grid">
                <div class="form-group">
                    <label id="labelProxyType" for="proxyType">${s.labelProxyType}</label>
                    <select id="proxyType">
                        <option id="optSocks5" value="socks5">SOCKS5</option>
                        <option id="optSocks4" value="socks4">SOCKS4</option>
                        <option id="optHttp" value="http">HTTP</option>
                    </select>
                </div>

                <div class="form-group">
                    <label id="labelProxyHost" for="proxyHost">${s.labelProxyHost}</label>
                    <input type="text" id="proxyHost" placeholder="${s.phProxy}">
                </div>

                <div class="form-group">
                    <label id="labelProxyPort" for="proxyPort">${s.labelProxyPort}</label>
                    <input type="number" id="proxyPort" value="1080" min="1" max="65535">
                </div>

                <div class="form-group">
                    <label id="labelProxyUsername" for="proxyUsername">${s.labelProxyUsername}</label>
                    <input type="text" id="proxyUsername">
                </div>

                <div class="form-group full-width">
                    <label id="labelProxyPassword" for="proxyPassword">${s.labelProxyPassword}</label>
                    <input type="password" id="proxyPassword">
                </div>
            </div>
        </div>

    </div>
</div>

<!-- ─── Status Banner ──────────────────────────────────── -->
<div id="statusBanner" class="status-banner"></div>

<!-- ─── Action Bar ─────────────────────────────────────── -->
<div class="action-bar">
    <button type="button" class="secondary" id="testBtn">${s.testBtn}</button>
    <span class="spacer"></span>
    <button type="button" class="secondary" id="cancelBtn">${s.cancelBtn}</button>
    <button type="button" class="primary" id="saveBtn">${s.saveBtn}</button>
</div>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
