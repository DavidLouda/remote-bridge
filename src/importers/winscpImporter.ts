import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    ConnectionConfig,
    DEFAULT_PORTS,
    ImportFolder,
    ImportResult,
} from '../types/connection';
import {
    decryptWinSCPPassword,
    decryptWinSCPPasswordWithMaster,
    mapWinSCPProtocol,
    hasMasterPassword,
} from '../utils/winscpCrypto';

/**
 * Imports connections from WinSCP configuration (INI file or registry).
 */
export class WinSCPImporter {
    /**
     * Auto-detect WinSCP config location and import.
     */
    async import(): Promise<ImportResult> {
        // Try common WinSCP INI locations
        const candidates = [
            path.join(os.homedir(), 'AppData', 'Roaming', 'WinSCP.ini'),
            // Portable: next to WinSCP.exe (user must select this via file picker)
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return this.importFromIni(candidate);
            }
        }

        // If no INI found, prompt user to select file
        const selected = await vscode.window.showOpenDialog({
            title: vscode.l10n.t('Select WinSCP configuration file'),
            filters: {
                [vscode.l10n.t('WinSCP INI')]: ['ini'],
                [vscode.l10n.t('All files')]: ['*'],
            },
            canSelectMany: false,
        });

        if (!selected || selected.length === 0) {
            return {
                source: 'winscp',
                imported: [],
                skipped: 0,
                errors: [vscode.l10n.t('No file selected')],
            };
        }

        return this.importFromIni(selected[0].fsPath);
    }

    /**
     * Import connections from a WinSCP INI file.
     */
    async importFromIni(filePath: string): Promise<ImportResult> {
        const result: ImportResult = {
            source: 'winscp',
            imported: [],
            skipped: 0,
            errors: [],
            warnings: [],
            folders: [],
        };

        if (!fs.existsSync(filePath)) {
            result.errors.push(
                vscode.l10n.t('WinSCP config file not found: {0}', filePath)
            );
            return result;
        }

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch (err) {
            result.errors.push(
                vscode.l10n.t('Failed to read WinSCP config: {0}', String(err))
            );
            return result;
        }

        // Parse INI file
        const sections = this._parseIni(content);

        // Check for master password
        const usesMasterPassword = hasMasterPassword(sections);
        let winscpMasterPassword: string | undefined;

        if (usesMasterPassword) {
            winscpMasterPassword = await vscode.window.showInputBox({
                title: vscode.l10n.t('WinSCP Master Password'),
                prompt: vscode.l10n.t(
                    'This WinSCP configuration is protected by a master password. Enter the master password to decrypt saved passwords.'
                ),
                password: true,
                ignoreFocusOut: true,
            });

            if (!winscpMasterPassword) {
                // Continue without passwords
                vscode.window.showWarningMessage(
                    vscode.l10n.t(
                        'Importing without passwords. You will need to enter passwords manually for each connection.'
                    )
                );
            }
        }

        // Extract session sections
        const passwords = new Map<string, string>();
        const proxyPasswords = new Map<string, string>();
        const folderMap = new Map<string, ImportFolder>();

        for (const [sectionName, values] of Object.entries(sections)) {
            if (!sectionName.startsWith('Sessions\\') && !sectionName.startsWith('Sessions/')) {
                continue;
            }

            const rawSessionPath = sectionName.replace(/^Sessions[\\/]/, '');
            const decodedPath = rawSessionPath
                .split(/[\\/]/)
                .map((segment) => this._decodeSessionName(segment).trim())
                .filter((segment) => segment.length > 0);

            if (decodedPath.length === 0) {
                result.skipped++;
                continue;
            }

            const sessionName = decodedPath[decodedPath.length - 1];
            const folderSegments = decodedPath.slice(0, -1);
            const folderPath = folderSegments.length > 0 ? folderSegments.join('/') : undefined;

            if (folderSegments.length > 0) {
                let parentPath: string | undefined;
                let currentPath = '';
                for (const segment of folderSegments) {
                    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
                    if (!folderMap.has(currentPath)) {
                        folderMap.set(currentPath, {
                            path: currentPath,
                            name: segment,
                            parentPath,
                        });
                    }
                    parentPath = currentPath;
                }
            }

            try {
                const hostname = values['HostName'];
                if (!hostname) {
                    result.skipped++;
                    continue;
                }

                const fsProtocol = parseInt(values['FSProtocol'] || '5', 10);
                const ftps = parseInt(values['Ftps'] || '0', 10);
                const protocol = mapWinSCPProtocol(fsProtocol, ftps);

                if (!protocol) {
                    result.skipped++;
                    continue;
                }

                const username = values['UserName'] || '';
                const port = parseInt(values['PortNumber'] || String(DEFAULT_PORTS[protocol]), 10);
                const pingInterval = parseInt(values['PingIntervalSecs'] || '10', 10);
                const useAgent = this._truthy(values['TryAgent']);
                const hasPublicKey = Boolean(values['PublicKeyFile']);

                const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
                    name: sessionName,
                    protocol,
                    host: hostname,
                    port: isNaN(port) ? DEFAULT_PORTS[protocol] : port,
                    username,
                    authMethod: hasPublicKey ? 'key' : useAgent ? 'agent' : 'password',
                    remotePath: values['RemoteDirectory'] || '/',
                    keepaliveInterval: Number.isNaN(pingInterval) ? 10 : Math.max(0, pingInterval),
                    os: 'linux',
                };

                if (folderPath) {
                    connection.folderId = folderPath;
                }

                if (protocol === 'ftps') {
                    connection.secure = true;
                }

                if (hasPublicKey) {
                    connection.privateKeyPath = values['PublicKeyFile'];
                }

                const proxyMethod = parseInt(values['ProxyMethod'] || '0', 10);
                if (proxyMethod > 0) {
                    const proxyType = proxyMethod === 1
                        ? 'socks4'
                        : proxyMethod === 2
                            ? 'socks5'
                            : proxyMethod === 3
                                ? 'http'
                                : undefined;

                    if (proxyType && values['ProxyHost']) {
                        const parsedProxyPort = parseInt(values['ProxyPort'] || '', 10);
                        const defaultProxyPort = proxyType === 'http' ? 8080 : 1080;
                        connection.proxy = {
                            type: proxyType,
                            host: values['ProxyHost'],
                            port: Number.isNaN(parsedProxyPort) ? defaultProxyPort : parsedProxyPort,
                            username: values['ProxyUsername'] || undefined,
                        };

                        const proxyEncrypted = values['ProxyPassword'];
                        if (proxyEncrypted) {
                            let decryptedProxyPassword: string | null = null;
                            const proxyUser = values['ProxyUsername'] || username;
                            const proxyHost = values['ProxyHost'] || hostname;

                            if (usesMasterPassword && winscpMasterPassword) {
                                decryptedProxyPassword = decryptWinSCPPasswordWithMaster(
                                    winscpMasterPassword,
                                    proxyEncrypted
                                );
                            } else if (!usesMasterPassword) {
                                decryptedProxyPassword = decryptWinSCPPassword(
                                    proxyHost,
                                    proxyUser,
                                    proxyEncrypted
                                );
                            }

                            if (decryptedProxyPassword) {
                                const importKey = `${connection.folderId ?? ''}::${sessionName}`;
                                proxyPasswords.set(importKey, decryptedProxyPassword);
                            }
                        }
                    } else if (!proxyType) {
                        result.warnings?.push(
                            vscode.l10n.t(
                                'Session "{0}" uses unsupported ProxyMethod={1} and was imported without proxy settings.',
                                sessionName,
                                String(proxyMethod)
                            )
                        );
                    }
                }

                // Decrypt password
                const encryptedPassword = values['Password'] || values['PasswordPlain'];
                if (encryptedPassword) {
                    let decryptedPassword: string | null = null;

                    if (usesMasterPassword && winscpMasterPassword) {
                        decryptedPassword = decryptWinSCPPasswordWithMaster(
                            winscpMasterPassword,
                            encryptedPassword
                        );
                    } else if (!usesMasterPassword) {
                        decryptedPassword = decryptWinSCPPassword(
                            hostname,
                            username,
                            encryptedPassword
                        );
                    }

                    if (decryptedPassword) {
                        const importKey = `${connection.folderId ?? ''}::${sessionName}`;
                        passwords.set(importKey, decryptedPassword);
                    }
                }

                result.imported.push(connection as ConnectionConfig);
            } catch (err) {
                result.errors.push(
                    vscode.l10n.t('Failed to import session "{0}": {1}', sessionName, String(err))
                );
                result.skipped++;
            }
        }

        result.folders = Array.from(folderMap.values());

        // Attach passwords to result for caller to store in SecretStorage
        (
            result as ImportResult & {
                passwords?: Map<string, string>;
                proxyPasswords?: Map<string, string>;
            }
        ).passwords = passwords;
        (
            result as ImportResult & {
                passwords?: Map<string, string>;
                proxyPasswords?: Map<string, string>;
            }
        ).proxyPasswords = proxyPasswords;

        return result;
    }

    // ─── INI Parser ──────────────────────────────────────────────

    private _parseIni(content: string): Record<string, Record<string, string>> {
        const sections: Record<string, Record<string, string>> = {};
        let currentSection = '';

        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();

            if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
                continue;
            }

            const sectionMatch = trimmed.match(/^\[(.+)\]$/);
            if (sectionMatch) {
                currentSection = sectionMatch[1];
                if (!sections[currentSection]) {
                    sections[currentSection] = {};
                }
                continue;
            }

            const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
            if (kvMatch && currentSection) {
                sections[currentSection][kvMatch[1].trim()] = kvMatch[2].trim();
            }
        }

        return sections;
    }

    /**
     * Decode URL-encoded WinSCP session names (e.g., `My%20Server` → `My Server`).
     */
    private _decodeSessionName(encoded: string): string {
        try {
            return decodeURIComponent(encoded);
        } catch {
            return encoded;
        }
    }

    private _truthy(value: string | undefined): boolean {
        if (!value) {
            return false;
        }
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'on' || normalized === 'true' || normalized === 'yes';
    }
}
