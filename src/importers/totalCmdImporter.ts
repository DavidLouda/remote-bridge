import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    ConnectionConfig,
    ConnectionProtocol,
    DEFAULT_PORTS,
    ImportResult,
} from '../types/connection';
import { parseIni } from '../utils/iniParser';
import { deobfuscateTotalCmdPassword } from '../utils/totalCmdCrypto';

/**
 * Imports FTP/FTPS connections from Total Commander's built-in FTP plugin.
 *
 * Config file: `%APPDATA%\GHISLER\wcx_ftp.ini` (Windows only).
 *
 * Structure:
 *   [connections]
 *   1=SiteName
 *   2=AnotherSite
 *
 *   [SiteName]
 *   host=hostname:port   (port optional, defaults to 21)
 *   username=user
 *   password=<XOR-obfuscated, Base64-encoded>
 *   directory=/remote/path
 *   anonymous=0|1
 *   usessl=0|1
 */
export class TotalCmdImporter {
    async import(): Promise<ImportResult> {
        const candidate = this._getDefaultPath();

        if (candidate && fs.existsSync(candidate)) {
            return this.importFromFile(candidate);
        }

        // Prompt the user to select the file
        const selected = await vscode.window.showOpenDialog({
            title: vscode.l10n.t('Select Total Commander FTP configuration file'),
            filters: {
                [vscode.l10n.t('Total Commander FTP INI')]: ['ini'],
                [vscode.l10n.t('All files')]: ['*'],
            },
            canSelectMany: false,
        });

        if (!selected || selected.length === 0) {
            return {
                source: 'totalcmd',
                imported: [],
                skipped: 0,
                errors: [vscode.l10n.t('No file selected')],
            };
        }

        return this.importFromFile(selected[0].fsPath);
    }

    async importFromFile(filePath: string): Promise<ImportResult> {
        const result: ImportResult = {
            source: 'totalcmd',
            imported: [],
            skipped: 0,
            errors: [],
            warnings: [],
        };

        if (!fs.existsSync(filePath)) {
            result.errors.push(
                vscode.l10n.t('Total Commander FTP config not found: {0}', filePath)
            );
            return result;
        }

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch (err) {
            result.errors.push(
                vscode.l10n.t('Failed to read Total Commander FTP config: {0}', String(err))
            );
            return result;
        }

        const sections = parseIni(content);
        const passwords = new Map<string, string>();

        // The [connections] section lists connection names by index: 1=Name, 2=Name ...
        const connectionsList = sections['connections'] ?? {};
        const siteNames = Object.values(connectionsList).filter(Boolean);

        if (siteNames.length === 0) {
            result.warnings!.push(
                vscode.l10n.t('No connections found in Total Commander FTP config.')
            );
            return result;
        }

        for (const siteName of siteNames) {
            const section = sections[siteName];
            if (!section) {
                result.skipped++;
                continue;
            }

            this._importSite(siteName, section, result, passwords);
        }

        (result as ImportResult & { passwords?: Map<string, string> }).passwords = passwords;
        return result;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private _getDefaultPath(): string | undefined {
        if (process.platform !== 'win32') {
            return undefined;
        }
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'GHISLER', 'wcx_ftp.ini');
    }

    private _importSite(
        siteName: string,
        section: Record<string, string>,
        result: ImportResult,
        passwords: Map<string, string>
    ): void {
        const rawHost = (section.host ?? '').trim();
        if (!rawHost) {
            result.skipped++;
            return;
        }

        // TC embeds the port in the host field as "hostname:port"
        let host = rawHost;
        let port: number;
        const colonIdx = rawHost.lastIndexOf(':');
        if (colonIdx > 0) {
            const maybePort = parseInt(rawHost.slice(colonIdx + 1), 10);
            if (Number.isFinite(maybePort) && maybePort > 0 && maybePort <= 65535) {
                host = rawHost.slice(0, colonIdx);
                port = maybePort;
            } else {
                port = DEFAULT_PORTS.ftp;
            }
        } else {
            port = DEFAULT_PORTS.ftp;
        }

        const anonymous = this._truthy(section.anonymous);
        const usessl = this._truthy(section.usessl);
        const protocol: ConnectionProtocol = usessl ? 'ftps' : 'ftp';
        if (usessl) {
            port = port === DEFAULT_PORTS.ftp ? DEFAULT_PORTS.ftps : port;
        }

        const username = anonymous ? 'anonymous' : (section.username ?? '').trim();
        const remotePath = (section.directory ?? '/').trim() || '/';

        // Deobfuscate password (XOR, Base64‑encoded key = "username@hostname")
        let password = '';
        const rawPass = (section.password ?? '').trim();
        if (rawPass && !anonymous) {
            password = deobfuscateTotalCmdPassword(rawPass, username, host);
        }

        const connectionKey = `::${siteName}`;

        const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
            name: siteName,
            protocol,
            host,
            port,
            username,
            authMethod: 'password',
            remotePath,
            keepaliveInterval: 0,
        };

        result.imported.push(connection as ConnectionConfig);

        if (password) {
            passwords.set(connectionKey, password);
        }
    }

    private _truthy(value: string | undefined): boolean {
        if (!value) {
            return false;
        }
        const n = value.trim().toLowerCase();
        return n === '1' || n === 'on' || n === 'true' || n === 'yes';
    }
}
