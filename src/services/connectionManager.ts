import * as vscode from 'vscode';
import {
    ConnectionConfig,
    ConnectionFolder,
    ConnectionStore,
    CONNECTION_STORE_VERSION,
    secretKeyForPassword,
    secretKeyForPassphrase,
    secretKeyForProxyPassword,
} from '../types/connection';
import { EncryptionService } from './encryptionService';
import { generateId } from '../utils/uriParser';

/**
 * Manages CRUD operations on connections and folders.
 * Handles persistence via EncryptionService (which handles globalState + optional encryption).
 * Secrets (passwords, passphrases) are stored separately in VS Code SecretStorage.
 */
export class ConnectionManager implements vscode.Disposable {
    private _store: ConnectionStore | null = null;
    private _loaded = false;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly _encryption: EncryptionService,
        private readonly _secrets: vscode.SecretStorage
    ) {}

    // ─── Initialization ────────────────────────────────────────

    /**
     * Load the connection store from persistence.
     * Must be called after master password unlock (if applicable).
     */
    async load(): Promise<void> {
        const store = await this._encryption.loadStore();
        this._store = store ?? {
            version: CONNECTION_STORE_VERSION,
            folders: [],
            connections: [],
        };
        this._loaded = true;
    }

    /**
     * Save the current store state to persistence.
     */
    async save(): Promise<void> {
        if (!this._store) {
            return;
        }
        await this._encryption.saveStore(this._store);
    }

    // ─── Connections ───────────────────────────────────────────

    getConnections(): ConnectionConfig[] {
        return this._requireStore().connections;
    }

    getConnection(id: string): ConnectionConfig | undefined {
        return this._requireStore().connections.find((c) => c.id === id);
    }

    /**
     * Find a connection by name (case-insensitive).
     */
    findConnectionByName(name: string): ConnectionConfig | undefined {
        const lower = name.toLowerCase();
        return this._requireStore().connections.find(
            (c) => c.name.toLowerCase() === lower
        );
    }

    /**
     * Fuzzy-find a connection when exact name match fails.
     * Tries: (1) host substring match, (2) partial name match.
     * Returns the first match, or undefined if nothing fits.
     */
    findConnectionFuzzy(input: string): ConnectionConfig | undefined {
        const lower = input.toLowerCase();
        const connections = this._requireStore().connections;
        // Host match: input contains the host or host contains input
        const byHost = connections.find(
            (c) => lower.includes(c.host.toLowerCase()) || c.host.toLowerCase().includes(lower)
        );
        if (byHost) { return byHost; }
        // Partial name match: input is a substring of name or vice-versa
        return connections.find(
            (c) =>
                c.name.toLowerCase().includes(lower) ||
                lower.includes(c.name.toLowerCase())
        );
    }

    async addConnection(
        config: Omit<ConnectionConfig, 'id' | 'sortOrder'>,
        password?: string,
        passphrase?: string,
        proxyPassword?: string
    ): Promise<ConnectionConfig> {
        const store = this._requireStore();

        // Ensure connection name is unique
        const nameLower = config.name.trim().toLowerCase();
        if (store.connections.some(c => c.name.toLowerCase() === nameLower)) {
            throw new Error(vscode.l10n.t('A connection named "{0}" already exists', config.name));
        }

        const id = generateId();
        const sortOrder = store.connections.filter(
            (c) => c.folderId === config.folderId
        ).length;

        const connection: ConnectionConfig = {
            ...config,
            id,
            sortOrder,
        };

        store.connections.push(connection);

        // Store secrets
        if (password) {
            await this._secrets.store(secretKeyForPassword(id), password);
        }
        if (passphrase) {
            await this._secrets.store(secretKeyForPassphrase(id), passphrase);
        }
        if (proxyPassword) {
            await this._secrets.store(secretKeyForProxyPassword(id), proxyPassword);
        }

        await this.save();
        this._onDidChange.fire();
        return connection;
    }

    async updateConnection(
        id: string,
        updates: Partial<Omit<ConnectionConfig, 'id'>>,
        password?: string,
        passphrase?: string,
        proxyPassword?: string
    ): Promise<void> {
        const store = this._requireStore();
        const index = store.connections.findIndex((c) => c.id === id);
        if (index === -1) {
            throw new Error(vscode.l10n.t('Connection not found'));
        }

        store.connections[index] = { ...store.connections[index], ...updates };

        if (password !== undefined) {
            if (password) {
                await this._secrets.store(secretKeyForPassword(id), password);
            } else {
                await this._secrets.delete(secretKeyForPassword(id));
            }
        }
        if (passphrase !== undefined) {
            if (passphrase) {
                await this._secrets.store(secretKeyForPassphrase(id), passphrase);
            } else {
                await this._secrets.delete(secretKeyForPassphrase(id));
            }
        }
        if (proxyPassword !== undefined) {
            if (proxyPassword) {
                await this._secrets.store(secretKeyForProxyPassword(id), proxyPassword);
            } else {
                await this._secrets.delete(secretKeyForProxyPassword(id));
            }
        }

        await this.save();
        this._onDidChange.fire();
    }

    async deleteConnection(id: string): Promise<void> {
        const store = this._requireStore();
        store.connections = store.connections.filter((c) => c.id !== id);

        // Clean up secrets
        await this._secrets.delete(secretKeyForPassword(id));
        await this._secrets.delete(secretKeyForPassphrase(id));
        await this._secrets.delete(secretKeyForProxyPassword(id));

        await this.save();
        this._onDidChange.fire();
    }

    async deleteConnections(ids: string[]): Promise<void> {
        if (ids.length === 0) {
            return;
        }

        const uniqueIds = [...new Set(ids)];
        const idsSet = new Set(uniqueIds);
        const store = this._requireStore();
        store.connections = store.connections.filter((c) => !idsSet.has(c.id));

        for (const id of uniqueIds) {
            await this._secrets.delete(secretKeyForPassword(id));
            await this._secrets.delete(secretKeyForPassphrase(id));
            await this._secrets.delete(secretKeyForProxyPassword(id));
        }

        await this.save();
        this._onDidChange.fire();
    }

    async duplicateConnection(id: string): Promise<ConnectionConfig> {
        const original = this.getConnection(id);
        if (!original) {
            throw new Error(vscode.l10n.t('Connection not found'));
        }

        const { id: _id, sortOrder: _sort, ...rest } = original;
        const password = await this._secrets.get(secretKeyForPassword(id));
        const passphrase = await this._secrets.get(secretKeyForPassphrase(id));
        const proxyPassword = await this._secrets.get(secretKeyForProxyPassword(id));

        return this.addConnection(
            { ...rest, name: vscode.l10n.t('{0} (copy)', original.name) },
            password ?? undefined,
            passphrase ?? undefined,
            proxyPassword ?? undefined
        );
    }

    async moveToFolder(connectionId: string, folderId: string | undefined): Promise<void> {
        await this.updateConnection(connectionId, { folderId });
    }

    async moveMultipleToFolder(connectionIds: string[], folderId: string | undefined): Promise<void> {
        if (connectionIds.length === 0) {
            return;
        }

        const uniqueIds = new Set(connectionIds);
        const store = this._requireStore();
        for (const connection of store.connections) {
            if (uniqueIds.has(connection.id)) {
                connection.folderId = folderId;
            }
        }

        await this.save();
        this._onDidChange.fire();
    }

    // ─── Folders ───────────────────────────────────────────────

    getFolders(): ConnectionFolder[] {
        return this._requireStore().folders;
    }

    getFolder(id: string): ConnectionFolder | undefined {
        return this._requireStore().folders.find((f) => f.id === id);
    }

    async addFolder(name: string, parentId?: string): Promise<ConnectionFolder> {
        const store = this._requireStore();
        const sortOrder = store.folders.filter(
            (f) => f.parentId === parentId
        ).length;

        const folder: ConnectionFolder = {
            id: generateId(),
            name,
            parentId,
            sortOrder,
        };

        store.folders.push(folder);
        await this.save();
        this._onDidChange.fire();
        return folder;
    }

    async renameFolder(id: string, newName: string): Promise<void> {
        const store = this._requireStore();
        const folder = store.folders.find((f) => f.id === id);
        if (!folder) {
            throw new Error(vscode.l10n.t('Folder not found'));
        }
        folder.name = newName;
        await this.save();
        this._onDidChange.fire();
    }

    async deleteFolder(id: string, moveConnectionsToParent = true): Promise<void> {
        const store = this._requireStore();
        const folder = store.folders.find((f) => f.id === id);
        if (!folder) {
            return;
        }

        if (moveConnectionsToParent) {
            // Move connections to parent folder
            for (const conn of store.connections) {
                if (conn.folderId === id) {
                    conn.folderId = folder.parentId;
                }
            }
            // Move subfolders to parent
            for (const sub of store.folders) {
                if (sub.parentId === id) {
                    sub.parentId = folder.parentId;
                }
            }
        } else {
            // Delete connections in this folder
            const connectionsToDelete = store.connections
                .filter((c) => c.folderId === id)
                .map((c) => c.id);
            for (const connId of connectionsToDelete) {
                await this.deleteConnection(connId);
            }
        }

        store.folders = store.folders.filter((f) => f.id !== id);
        await this.save();
        this._onDidChange.fire();
    }

    // ─── Bulk Import ───────────────────────────────────────────

    async importConnections(
        connections: Array<Omit<ConnectionConfig, 'id' | 'sortOrder'>>,
        credentials?: {
            passwords?: Map<string, string>;
            proxyPasswords?: Map<string, string>;
        },
        targetFolderId?: string
    ): Promise<{ imported: number; errors: string[] }> {
        let imported = 0;
        const errors: string[] = [];
        for (const config of connections) {
            try {
                // Auto-suffix duplicate names
                let name = config.name;
                const existingNames = new Set(
                    this._requireStore().connections.map(c => c.name.toLowerCase())
                );
                let suffix = 2;
                while (existingNames.has(name.toLowerCase())) {
                    name = `${config.name} (${suffix++})`;
                }
                const connConfig = { ...config, name, folderId: targetFolderId ?? config.folderId };
                const key = `${config.folderId ?? ''}::${config.name}`;
                const password = credentials?.passwords?.get(key) ?? credentials?.passwords?.get(config.name);
                const proxyPassword = credentials?.proxyPasswords?.get(key) ?? credentials?.proxyPasswords?.get(config.name);
                await this.addConnection(connConfig, password, undefined, proxyPassword);
                imported++;
            } catch (err) {
                errors.push(
                    vscode.l10n.t('Failed to import "{0}": {1}', config.name, String(err instanceof Error ? err.message : err))
                );
            }
        }
        return { imported, errors };
    }

    // ─── Private Helpers ───────────────────────────────────────

    private _requireStore(): ConnectionStore {
        if (!this._loaded || !this._store) {
            throw new Error('Connection store not loaded');
        }
        return this._store;
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
