import * as vscode from 'vscode';
import {
    ConnectionConfig,
    ConnectionProtocol,
    DEFAULT_PORTS,
    ImportResult,
} from '../types/connection';

/**
 * SSH FS extension configuration interface (from Kelvin.vscode-sshfs).
 */
interface SshFsConfig {
    name: string;
    label?: string;
    group?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string | boolean;
    privateKeyPath?: string;
    privateKey?: string;
    passphrase?: string | boolean;
    agent?: string;
    root?: string;
    hop?: string;
    proxy?: {
        type: string;
        host: string;
        port: number;
    };
    putty?: string | boolean;
    sftpCommand?: string;
    sftpSudo?: string | boolean;
}

/**
 * Imports connections from the SSH FS VS Code extension settings.
 */
export class SshFsImporter {
    /**
     * Import connections from sshfs.configs in VS Code settings.
     */
    async import(): Promise<ImportResult> {
        const result: ImportResult = {
            source: 'sshfs',
            imported: [],
            skipped: 0,
            errors: [],
        };

        const sshfsConfig = vscode.workspace.getConfiguration('sshfs');
        const configs = sshfsConfig.get<SshFsConfig[]>('configs');

        if (!configs || configs.length === 0) {
            result.errors.push(
                vscode.l10n.t(
                    'No SSH FS configurations found. Make sure the SSH FS extension is installed and has saved connections.'
                )
            );
            return result;
        }

        const passwords = new Map<string, string>();

        for (const config of configs) {
            try {
                if (!config.host) {
                    result.skipped++;
                    continue;
                }

                const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
                    name: config.label || config.name,
                    protocol: 'sftp' as ConnectionProtocol,
                    host: config.host,
                    port: config.port || DEFAULT_PORTS.sftp,
                    username: config.username || '',
                    authMethod: this._detectAuthMethod(config),
                    remotePath: config.root || '/',
                    keepaliveInterval: 10,
                    os: 'linux',
                };

                // Private key path
                if (config.privateKeyPath) {
                    connection.privateKeyPath = config.privateKeyPath;
                }

                // Agent
                if (config.agent) {
                    connection.agent = config.agent;
                }

                // Password (if stored as string — SSH FS may store `true` meaning "prompt")
                if (typeof config.password === 'string' && config.password) {
                    passwords.set(connection.name, config.password);
                }

                // Proxy
                if (config.proxy) {
                    connection.proxy = {
                        type: config.proxy.type as 'socks4' | 'socks5' | 'http',
                        host: config.proxy.host,
                        port: config.proxy.port,
                    };
                }

                // Group → will be mapped to folder by caller
                if (config.group) {
                    // Store group info for post-processing
                    (connection as ConnectionConfig & { _sshfsGroup?: string })._sshfsGroup = config.group;
                }

                result.imported.push(connection as ConnectionConfig);
            } catch (err) {
                result.errors.push(
                    vscode.l10n.t('Failed to import SSH FS config "{0}": {1}', config.name, String(err))
                );
                result.skipped++;
            }
        }

        // Attach passwords
        (result as ImportResult & { passwords?: Map<string, string> }).passwords = passwords;

        return result;
    }

    private _detectAuthMethod(config: SshFsConfig): ConnectionConfig['authMethod'] {
        if (config.agent || config.putty) {
            return 'agent';
        }
        if (config.privateKeyPath || config.privateKey) {
            return 'key';
        }
        return 'password';
    }
}
