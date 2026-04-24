import * as vscode from 'vscode';
import * as fs from 'fs';
import { readImportFileSync } from '../utils/importerFile';
import { ConnectionExportItem, JsonExportData } from '../exporters/jsonExporter';
import {
    AuthMethod,
    ConnectionConfig,
    ConnectionFolder,
    ConnectionProtocol,
    DEFAULT_PORTS,
    ImportFolder,
    ImportResult,
    RemoteOS,
} from '../types/connection';

const SUPPORTED_PROTOCOLS: ReadonlySet<ConnectionProtocol> = new Set(['ssh', 'sftp', 'ftp', 'ftps']);
const SUPPORTED_AUTH_METHODS: ReadonlySet<AuthMethod> = new Set([
    'password',
    'key',
    'agent',
    'keyboard-interactive',
]);
const SUPPORTED_PROXY_TYPES: ReadonlySet<NonNullable<ConnectionConfig['proxy']>['type']> = new Set([
    'socks4',
    'socks5',
    'http',
]);
const SUPPORTED_OS: ReadonlySet<RemoteOS> = new Set(['linux', 'macos', 'windows']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

export class JsonImporter {
    async import(): Promise<ImportResult> {
        const selected = await vscode.window.showOpenDialog({
            title: vscode.l10n.t('Select Remote Bridge JSON export file'),
            filters: {
                JSON: ['json'],
                [vscode.l10n.t('All files')]: ['*'],
            },
            canSelectMany: false,
        });

        if (!selected || selected.length === 0) {
            return {
                source: 'json',
                imported: [],
                skipped: 0,
                errors: [vscode.l10n.t('No file selected')],
            };
        }

        return this.importFromFile(selected[0].fsPath);
    }

    async importFromFile(filePath: string): Promise<ImportResult> {
        const result: ImportResult = {
            source: 'json',
            imported: [],
            skipped: 0,
            errors: [],
            warnings: [],
            folders: [],
            passwords: new Map<string, string>(),
            passphrases: new Map<string, string>(),
            proxyPasswords: new Map<string, string>(),
        };

        if (!fs.existsSync(filePath)) {
            result.errors.push(vscode.l10n.t('JSON import file not found: {0}', filePath));
            return result;
        }

        let content: string;
        try {
            content = readImportFileSync(filePath);
        } catch (err) {
            result.errors.push(err instanceof Error ? err.message : vscode.l10n.t('Failed to read JSON import file: {0}', String(err)));
            return result;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            result.errors.push(vscode.l10n.t('Failed to parse JSON import file: {0}', String(err)));
            return result;
        }

        let exportData: JsonExportData;
        try {
            exportData = this._validateExportData(parsed);
        } catch (err) {
            result.errors.push(
                vscode.l10n.t(
                    'Invalid Remote Bridge JSON export: {0}',
                    err instanceof Error ? err.message : String(err)
                )
            );
            return result;
        }

        const { folders, pathsById } = this._buildFolderMappings(exportData.folders);
        result.folders = folders;

        for (const rawConnection of exportData.connections) {
            try {
                const connection = this._importConnection(rawConnection, pathsById, result);
                result.imported.push(connection as ConnectionConfig);
            } catch (err) {
                const name = isRecord(rawConnection) && isString(rawConnection.name)
                    ? rawConnection.name
                    : vscode.l10n.t('Unnamed connection');
                result.errors.push(
                    vscode.l10n.t(
                        'Failed to import "{0}": {1}',
                        name,
                        err instanceof Error ? err.message : String(err)
                    )
                );
                result.skipped++;
            }
        }

        return result;
    }

    private _validateExportData(value: unknown): JsonExportData {
        if (!isRecord(value)) {
            throw new Error(vscode.l10n.t('Root JSON value must be an object'));
        }
        if (value.source !== 'remote-bridge') {
            throw new Error(vscode.l10n.t('Missing or invalid source'));
        }
        if (value.version !== 1) {
            throw new Error(vscode.l10n.t('Unsupported export version: {0}', String(value.version)));
        }
        if (!Array.isArray(value.folders)) {
            throw new Error(vscode.l10n.t('Missing folders array'));
        }
        if (!Array.isArray(value.connections)) {
            throw new Error(vscode.l10n.t('Missing connections array'));
        }
        return value as unknown as JsonExportData;
    }

    private _buildFolderMappings(folders: ConnectionFolder[]): {
        folders: ImportFolder[];
        pathsById: Map<string, string>;
    } {
        const foldersById = new Map<string, ConnectionFolder>();

        for (const [index, folder] of folders.entries()) {
            if (!isRecord(folder) || !isString(folder.id) || !isString(folder.name) || folder.name.trim().length === 0) {
                throw new Error(vscode.l10n.t('Invalid folder entry at index {0}', String(index)));
            }

            foldersById.set(folder.id, {
                id: folder.id,
                name: folder.name,
                parentId: isString(folder.parentId) ? folder.parentId : undefined,
                sortOrder: typeof folder.sortOrder === 'number' ? folder.sortOrder : index,
                updatedAt: typeof folder.updatedAt === 'number' ? folder.updatedAt : undefined,
            });
        }

        const pathsById = new Map<string, string>();
        const buildPath = (folderId: string, stack = new Set<string>()): string => {
            const cached = pathsById.get(folderId);
            if (cached) {
                return cached;
            }

            if (stack.has(folderId)) {
                throw new Error(vscode.l10n.t('Folder hierarchy contains a cycle'));
            }

            const folder = foldersById.get(folderId);
            if (!folder) {
                throw new Error(vscode.l10n.t('Folder "{0}" was not found', folderId));
            }

            stack.add(folderId);
            const parentPath = folder.parentId ? buildPath(folder.parentId, stack) : '';
            stack.delete(folderId);

            const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
            pathsById.set(folderId, path);
            return path;
        };

        const importFolders = [...foldersById.values()]
            .sort((left, right) => {
                const leftPath = buildPath(left.id);
                const rightPath = buildPath(right.id);
                const depthDiff = leftPath.split('/').length - rightPath.split('/').length;
                if (depthDiff !== 0) {
                    return depthDiff;
                }

                if ((left.parentId ?? '') !== (right.parentId ?? '')) {
                    return leftPath.localeCompare(rightPath);
                }

                return left.sortOrder - right.sortOrder;
            })
            .map((folder) => ({
                path: buildPath(folder.id),
                name: folder.name,
                parentPath: folder.parentId ? buildPath(folder.parentId) : undefined,
            }));

        return { folders: importFolders, pathsById };
    }

    private _importConnection(
        item: ConnectionExportItem,
        folderPaths: Map<string, string>,
        result: ImportResult
    ): Omit<ConnectionConfig, 'id' | 'sortOrder'> {
        if (!isRecord(item)) {
            throw new Error(vscode.l10n.t('Connection entry must be an object'));
        }

        const name = this._requiredNonEmptyString(item.name, 'name');
        const protocol = this._parseProtocol(item.protocol);
        const authMethod = this._parseAuthMethod(item.authMethod);
        const folderPath = isString(item.folderId) ? folderPaths.get(item.folderId) : undefined;
        const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
            name,
            protocol,
            host: this._requiredNonEmptyString(item.host, 'host'),
            port: this._parsePort(item.port, protocol),
            username: isString(item.username) ? item.username : '',
            authMethod,
            remotePath: isString(item.remotePath) && item.remotePath.length > 0 ? item.remotePath : '/',
            keepaliveInterval: this._parseKeepalive(item.keepaliveInterval),
            os: this._parseOs(item.os),
        };

        if (folderPath) {
            connection.folderId = folderPath;
        }

        if (isString(item.privateKeyPath) && item.privateKeyPath.length > 0) {
            connection.privateKeyPath = item.privateKeyPath;
        }

        if (typeof item.hasPassphrase === 'boolean') {
            connection.hasPassphrase = item.hasPassphrase;
        }

        if (isString(item.agent) && item.agent.length > 0) {
            connection.agent = item.agent;
        }

        if (isRecord(item.proxy)) {
            const proxyType = item.proxy.type;
            const proxyHost = item.proxy.host;
            if (!SUPPORTED_PROXY_TYPES.has(proxyType) || !isString(proxyHost) || proxyHost.trim().length === 0) {
                throw new Error(vscode.l10n.t('Connection "{0}" has invalid proxy settings', name));
            }
            connection.proxy = {
                type: proxyType,
                host: proxyHost,
                port: this._parseNumericValue(item.proxy.port, 1080),
                username: isString(item.proxy.username) && item.proxy.username.length > 0
                    ? item.proxy.username
                    : undefined,
            };
        }

        if (isRecord(item.jumpHost)) {
            const jumpHost = item.jumpHost;
            const jumpAuthMethod = this._parseAuthMethod(jumpHost.authMethod);
            connection.jumpHost = {
                host: this._requiredNonEmptyString(jumpHost.host, 'jumpHost.host'),
                port: this._parseNumericValue(jumpHost.port, DEFAULT_PORTS.ssh),
                username: isString(jumpHost.username) ? jumpHost.username : '',
                authMethod: jumpAuthMethod,
                privateKeyPath: isString(jumpHost.privateKeyPath) && jumpHost.privateKeyPath.length > 0
                    ? jumpHost.privateKeyPath
                    : undefined,
                hasPassphrase: typeof jumpHost.hasPassphrase === 'boolean'
                    ? jumpHost.hasPassphrase
                    : undefined,
                agent: isString(jumpHost.agent) && jumpHost.agent.length > 0 ? jumpHost.agent : undefined,
            };
        }

        if (typeof item.secure === 'boolean') {
            connection.secure = item.secure;
        } else if (protocol === 'ftps') {
            connection.secure = true;
        }

        if (typeof item.allowSelfSigned === 'boolean') {
            connection.allowSelfSigned = item.allowSelfSigned;
        }

        if (typeof item.fullSshAccess === 'boolean') {
            connection.fullSshAccess = item.fullSshAccess;
        }

        if (typeof item.newFileMode === 'number' && Number.isFinite(item.newFileMode)) {
            connection.newFileMode = Math.trunc(item.newFileMode);
        }

        if (typeof item.newDirectoryMode === 'number' && Number.isFinite(item.newDirectoryMode)) {
            connection.newDirectoryMode = Math.trunc(item.newDirectoryMode);
        }

        const importKey = this._buildImportKey(folderPath, name);
        if (isString(item.password) && item.password.length > 0) {
            result.passwords?.set(importKey, item.password);
        }
        if (isString(item.passphrase) && item.passphrase.length > 0) {
            result.passphrases?.set(importKey, item.passphrase);
            connection.hasPassphrase = true;
        }
        if (connection.proxy && isString(item.proxyPassword) && item.proxyPassword.length > 0) {
            result.proxyPasswords?.set(importKey, item.proxyPassword);
        }

        return connection;
    }

    private _buildImportKey(folderPath: string | undefined, name: string): string {
        return `${folderPath ?? ''}::${name}`;
    }

    private _requiredNonEmptyString(value: unknown, field: string): string {
        if (!isString(value) || value.trim().length === 0) {
            throw new Error(vscode.l10n.t('Missing required field: {0}', field));
        }
        return value;
    }

    private _parseProtocol(value: unknown): ConnectionProtocol {
        if (!isString(value) || !SUPPORTED_PROTOCOLS.has(value as ConnectionProtocol)) {
            throw new Error(vscode.l10n.t('Unsupported protocol: {0}', String(value)));
        }
        return value as ConnectionProtocol;
    }

    private _parseAuthMethod(value: unknown): AuthMethod {
        if (!isString(value) || !SUPPORTED_AUTH_METHODS.has(value as AuthMethod)) {
            throw new Error(vscode.l10n.t('Unsupported auth method: {0}', String(value)));
        }
        return value as AuthMethod;
    }

    private _parsePort(value: unknown, protocol: ConnectionProtocol): number {
        return this._parseNumericValue(value, DEFAULT_PORTS[protocol]);
    }

    private _parseKeepalive(value: unknown): number {
        return Math.max(0, this._parseNumericValue(value, 10));
    }

    private _parseNumericValue(value: unknown, fallback: number): number {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return fallback;
        }
        return Math.trunc(value);
    }

    private _parseOs(value: unknown): RemoteOS {
        if (isString(value) && SUPPORTED_OS.has(value as RemoteOS)) {
            return value as RemoteOS;
        }
        return 'linux';
    }
}