import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { XMLParser } from 'fast-xml-parser';
import {
    ConnectionConfig,
    ConnectionProtocol,
    DEFAULT_PORTS,
    ImportFolder,
    ImportResult,
} from '../types/connection';

/** FileZilla <Protocol> numeric values */
const PROTOCOL_MAP: Record<number, ConnectionProtocol> = {
    0: 'ftp',    // FTP
    1: 'sftp',   // SFTP
    3: 'ftps',   // FTP with implicit TLS
    4: 'ftps',   // FTP with explicit TLS (FTPES) — map to ftps
    6: 'ftps',   // FTP with implicit TLS + proxy
};

/** FileZilla <Logontype> numeric values */
const LOGONTYPE_ANONYMOUS = 0;
const LOGONTYPE_NORMAL = 1;
const LOGONTYPE_ASK = 2;
const LOGONTYPE_INTERACTIVE = 3;
const LOGONTYPE_KEY = 6;

function toInt(value: unknown, fallback = 0): number {
    if (value === undefined || value === '') {
        return fallback;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function toString(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    return String(value);
}

/**
 * Imports connections from a FileZilla 3 Site Manager XML file.
 * Supports FTP, SFTP, and FTPS. Passwords stored as plain Base64 are decoded;
 * passwords encrypted with a master password (encoding="crypt") are skipped
 * with a warning.
 */
export class FileZillaImporter {
    async import(): Promise<ImportResult> {
        // Try default FileZilla Site Manager locations
        const candidates = this._getDefaultPaths();

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return this.importFromFile(candidate);
            }
        }

        // Prompt the user to pick a file
        const selected = await vscode.window.showOpenDialog({
            title: vscode.l10n.t('Select FileZilla Site Manager file'),
            filters: {
                [vscode.l10n.t('FileZilla XML')]: ['xml'],
                [vscode.l10n.t('All files')]: ['*'],
            },
            canSelectMany: false,
        });

        if (!selected || selected.length === 0) {
            return {
                source: 'filezilla',
                imported: [],
                skipped: 0,
                errors: [vscode.l10n.t('No file selected')],
            };
        }

        return this.importFromFile(selected[0].fsPath);
    }

    async importFromFile(filePath: string): Promise<ImportResult> {
        const result: ImportResult = {
            source: 'filezilla',
            imported: [],
            skipped: 0,
            errors: [],
            warnings: [],
            folders: [],
        };

        if (!fs.existsSync(filePath)) {
            result.errors!.push(
                vscode.l10n.t('FileZilla config file not found: {0}', filePath)
            );
            return result;
        }

        let xml: string;
        try {
            // Cap input size to keep one bad/oversized file from blocking the
            // extension host. 10 MB is far above any realistic FileZilla XML.
            const stat = fs.statSync(filePath);
            const MAX_BYTES = 10 * 1024 * 1024;
            if (stat.size > MAX_BYTES) {
                result.errors!.push(
                    vscode.l10n.t('FileZilla config too large: {0} bytes (max {1})', String(stat.size), String(MAX_BYTES))
                );
                return result;
            }
            xml = fs.readFileSync(filePath, 'utf-8');
        } catch (err) {
            result.errors!.push(
                vscode.l10n.t('Failed to read FileZilla config: {0}', String(err))
            );
            return result;
        }

        let parsed: unknown;
        try {
            const parser = new XMLParser({
                ignoreAttributes: false,
                attributeNamePrefix: '@_',
                isArray: (tagName) =>
                    tagName === 'Server' || tagName === 'Folder',
                // Defense in depth against XML External Entity (XXE) attacks:
                // disable entity processing entirely. fast-xml-parser does not
                // resolve external entities by default, but explicit flags here
                // make the policy obvious and survive future parser upgrades.
                processEntities: false,
                htmlEntities: false,
            });
            parsed = parser.parse(xml);
        } catch (err) {
            result.errors!.push(
                vscode.l10n.t('Failed to parse FileZilla XML: {0}', String(err))
            );
            return result;
        }

        const root = (parsed as Record<string, unknown>)?.FileZilla3;
        if (!root) {
            result.errors!.push(
                vscode.l10n.t('Invalid FileZilla XML: missing <FileZilla3> root element')
            );
            return result;
        }

        const siteManager = (root as Record<string, unknown>)?.Servers;
        if (!siteManager) {
            result.warnings!.push(
                vscode.l10n.t('FileZilla Site Manager is empty — no connections to import')
            );
            return result;
        }

        const passwords = new Map<string, string>();
        this._processNode(siteManager, undefined, result, passwords);

        (result as ImportResult & { passwords?: Map<string, string> }).passwords = passwords;
        return result;
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    private _getDefaultPaths(): string[] {
        const paths: string[] = [];
        const platform = process.platform;

        if (platform === 'win32') {
            const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
            paths.push(path.join(appData, 'FileZilla', 'sitemanager.xml'));
        } else if (platform === 'darwin') {
            paths.push(path.join(os.homedir(), '.config', 'filezilla', 'sitemanager.xml'));
            paths.push(path.join(os.homedir(), 'Library', 'Application Support', 'FileZilla', 'sitemanager.xml'));
        } else {
            // Linux / other UNIX
            paths.push(path.join(os.homedir(), '.config', 'filezilla', 'sitemanager.xml'));
        }

        return paths;
    }

    private _processNode(
        node: unknown,
        parentFolderPath: string | undefined,
        result: ImportResult,
        passwords: Map<string, string>
    ): void {
        if (!node || typeof node !== 'object') {
            return;
        }

        const obj = node as Record<string, unknown>;

        // Process direct Server entries
        const servers = Array.isArray(obj.Server) ? obj.Server : (obj.Server ? [obj.Server] : []);
        for (const server of servers) {
            this._importServer(server, parentFolderPath, result, passwords);
        }

        // Process Folder entries (recursive groups)
        const folders = Array.isArray(obj.Folder) ? obj.Folder : (obj.Folder ? [obj.Folder] : []);
        for (const folder of folders) {
            this._processFolder(folder, parentFolderPath, result, passwords);
        }
    }

    private _processFolder(
        folder: unknown,
        parentFolderPath: string | undefined,
        result: ImportResult,
        passwords: Map<string, string>
    ): void {
        if (!folder || typeof folder !== 'object') {
            return;
        }

        const obj = folder as Record<string, unknown>;
        const rawName = toString(obj['#text'] ?? obj['@_name']);

        // fast-xml-parser: mixed-content node — name is in #text when attributes also exist
        let folderName = rawName.trim();
        if (!folderName) {
            folderName = vscode.l10n.t('Unnamed Folder');
        }

        const folderPath = parentFolderPath ? `${parentFolderPath}/${folderName}` : folderName;

        result.folders!.push({
            path: folderPath,
            name: folderName,
            parentPath: parentFolderPath,
        });

        this._processNode(obj, folderPath, result, passwords);
    }

    private _importServer(
        server: unknown,
        folderPath: string | undefined,
        result: ImportResult,
        passwords: Map<string, string>
    ): void {
        if (!server || typeof server !== 'object') {
            return;
        }

        const s = server as Record<string, unknown>;

        const host = toString(s.Host).trim();
        if (!host) {
            result.skipped++;
            return;
        }

        const protocolNum = toInt(s.Protocol);
        const protocol = PROTOCOL_MAP[protocolNum];
        if (!protocol) {
            result.skipped++;
            result.warnings!.push(
                vscode.l10n.t(
                    'Skipped "{0}": unsupported protocol (type {1})',
                    host,
                    String(protocolNum)
                )
            );
            return;
        }

        const port = toInt(s.Port) || DEFAULT_PORTS[protocol];
        const username = toString(s.User).trim();
        const logontype = toInt(s.Logontype);
        const name = toString(s.Name).trim() || host;
        const remotePath = toString(s.RemoteDir).trim() || '/';

        // Determine auth method
        let authMethod: ConnectionConfig['authMethod'] = 'password';
        if (logontype === LOGONTYPE_ANONYMOUS) {
            authMethod = 'password';
        } else if (logontype === LOGONTYPE_KEY) {
            authMethod = 'key';
        } else if (logontype === LOGONTYPE_ASK || logontype === LOGONTYPE_INTERACTIVE) {
            authMethod = 'password';
            result.warnings!.push(
                vscode.l10n.t(
                    'Connection "{0}": interactive/ask logon — password not stored',
                    name
                )
            );
        }

        // Decode password
        const passNode = s.Pass;
        let password = '';

        if (passNode && typeof passNode === 'object') {
            const passObj = passNode as Record<string, unknown>;
            const encoding = toString(passObj['@_encoding']);
            const rawPass = toString(passObj['#text']);

            if (encoding === 'base64' && rawPass) {
                try {
                    password = Buffer.from(rawPass, 'base64').toString('utf8');
                } catch {
                    result.errors!.push(
                        vscode.l10n.t('Connection "{0}": failed to decode Base64 password — skipping', name)
                    );
                    result.skipped++;
                    return;
                }
            } else if (encoding === 'crypt') {
                result.warnings!.push(
                    vscode.l10n.t(
                        'Connection "{0}": password is encrypted with a FileZilla master password — cannot import password',
                        name
                    )
                );
            } else if (rawPass) {
                password = rawPass;
            }
        } else if (typeof passNode === 'string' && passNode) {
            password = passNode;
        }

        const connectionKey = `${folderPath ?? ''}::${name}`;

        const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
            name,
            protocol,
            host,
            port,
            username,
            authMethod,
            remotePath,
            keepaliveInterval: 10,
        };

        if (folderPath) {
            (connection as Record<string, unknown>).folderId = folderPath;
        }

        result.imported.push(connection as ConnectionConfig);

        if (password) {
            passwords.set(connectionKey, password);
        }
    }
}
