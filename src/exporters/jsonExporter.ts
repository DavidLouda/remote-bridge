import * as vscode from 'vscode';
import {
    ConnectionConfig,
    ConnectionFolder,
    secretKeyForPassword,
    secretKeyForPassphrase,
    secretKeyForProxyPassword,
} from '../types/connection';

export interface JsonExportData {
    version: 1;
    source: 'remote-bridge';
    exported: string;
    folders: ConnectionFolder[];
    connections: ConnectionExportItem[];
}

export interface ConnectionExportItem extends ConnectionConfig {
    password?: string;
    passphrase?: string;
    proxyPassword?: string;
}

export class JsonExporter {
    async export(
        connections: ConnectionConfig[],
        folders: ConnectionFolder[],
        secrets: vscode.SecretStorage,
        includePasswords: boolean
    ): Promise<string> {
        const items: ConnectionExportItem[] = [];

        for (const conn of connections) {
            const item: ConnectionExportItem = { ...conn };

            if (includePasswords) {
                const password = await secrets.get(secretKeyForPassword(conn.id));
                if (password) {
                    item.password = password;
                }
                const passphrase = await secrets.get(secretKeyForPassphrase(conn.id));
                if (passphrase) {
                    item.passphrase = passphrase;
                }
                if (conn.proxy) {
                    const proxyPassword = await secrets.get(secretKeyForProxyPassword(conn.id));
                    if (proxyPassword) {
                        item.proxyPassword = proxyPassword;
                    }
                }
            }

            items.push(item);
        }

        const exportData: JsonExportData = {
            version: 1,
            source: 'remote-bridge',
            exported: new Date().toISOString(),
            folders,
            connections: items,
        };

        return JSON.stringify(exportData, null, 2);
    }
}
