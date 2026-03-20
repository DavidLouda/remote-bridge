import * as vscode from 'vscode';
import { Client as FTPClient, FileInfo, FileType as FTPFileType } from 'basic-ftp';
import { Writable, Readable } from 'stream';
import { RemoteAdapter } from './adapter';
import {
    RemoteFileInfo,
    RemoteFileStat,
    ExecResult,
    ConnectionConfig,
} from '../types/connection';
import { TransferTracker } from '../services/transferTracker';
import { createProxySocket } from '../utils/proxyTunnel';

/**
 * FTP/FTPS adapter using the basic-ftp library.
 * Provides file system access but no command execution or shell.
 *
 * basic-ftp does NOT support concurrent operations on a single client.
 * All FTP commands are serialized through a mutex (_enqueue).
 */
export class FtpAdapter implements RemoteAdapter {
    private _client: FTPClient | null = null;
    private _connected = false;

    /** Serialization queue for FTP operations */
    private _queue: Promise<unknown> = Promise.resolve();

    private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
    readonly onDidDisconnect = this._onDidDisconnect.event;

    readonly supportsExec = false;
    readonly supportsShell = false;

    private _tracker?: TransferTracker;

    constructor(
        private readonly _config: ConnectionConfig,
        private readonly _getPassword: () => Promise<string | undefined>,
        private readonly _getProxyPassword: () => Promise<string | undefined>,
        tracker?: TransferTracker
    ) {
        this._tracker = tracker;
    }

    // ─── Connection ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        // Pass timeout (ms) to the constructor — this sets the timeout on
        // the actual connected socket, not on a premature dummy socket.
        const timeoutMs = 30000;
        const client = new FTPClient(timeoutMs);
        client.ftp.verbose = false;

        try {
            const password = await this._getPassword();

            const isSecure = this._config.secure || this._config.protocol === 'ftps';

            // If a proxy is configured, pre-connect through the tunnel and hand
            // basic-ftp the already-connected socket instead of letting it dial directly.
            if (this._config.proxy) {
                const proxyPassword = await this._getProxyPassword();
                const sock = await createProxySocket(
                    this._config.proxy,
                    proxyPassword,
                    this._config.host,
                    this._config.port
                );
                client.ftp.socket = sock as any;
            }

            await client.access({
                host: this._config.host,
                port: this._config.port,
                user: this._config.username,
                password: password || '',
                secure: isSecure,
                ...(isSecure ? { secureOptions: { rejectUnauthorized: !this._config.allowSelfSigned } } : {}),
            });

            this._client = client;
            this._connected = true;

            // Monitor connection state on the CONNECTED socket
            const socket = client.ftp.socket;
            socket.on('close', () => {
                const wasConnected = this._connected;
                this._connected = false;
                if (wasConnected) {
                    this._onDidDisconnect.fire();
                }
            });

            socket.on('error', () => {
                this._connected = false;
            });
        } catch (err) {
            client.close();
            throw err;
        }
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        if (this._client) {
            this._client.close();
            this._client = null;
        }
    }

    isConnected(): boolean {
        return this._connected && this._client !== null;
    }

    // ─── File System Operations ──────────────────────────────────

    /**
     * Enqueue an FTP operation so that only one runs at a time.
     * basic-ftp throws "Client is closed because User launched a task
     * while another one is still running" when operations overlap.
     */
    private _enqueue<T>(fn: (client: FTPClient) => Promise<T>): Promise<T> {
        const client = this._requireClient();
        const next = this._queue.then(
            () => fn(client),
            () => fn(client)  // run even if the previous op failed
        );
        // Keep the queue going regardless of success/failure
        this._queue = next.catch(() => {});
        return next;
    }

    async stat(remotePath: string): Promise<RemoteFileStat> {
        return this._enqueue(async (client) => {
            try {
                // Try to get size (works for files)
                const size = await client.size(remotePath);
                const lastMod = await client.lastMod(remotePath).catch(() => new Date(0));
                return {
                    type: vscode.FileType.File,
                    ctime: lastMod.getTime(),
                    mtime: lastMod.getTime(),
                    size,
                };
            } catch {
                // If size fails, it might be a directory — try listing it
                try {
                    await client.list(remotePath);
                    return {
                        type: vscode.FileType.Directory,
                        ctime: 0,
                        mtime: 0,
                        size: 0,
                    };
                } catch {
                    throw vscode.FileSystemError.FileNotFound(remotePath);
                }
            }
        });
    }

    async readDirectory(remotePath: string): Promise<RemoteFileInfo[]> {
        return this._enqueue(async (client) => {
            const list = await client.list(remotePath);

            return list
                .filter((item) => item.name !== '.' && item.name !== '..')
                .map((item) => ({
                    name: item.name,
                    type: this._mapFtpFileType(item),
                    size: item.size,
                    mtime: item.modifiedAt ? item.modifiedAt.getTime() : 0,
                    ctime: 0,
                }));
        });
    }

    async readFile(remotePath: string): Promise<Uint8Array> {
        return this._enqueue(async (client) => {
            const chunks: Buffer[] = [];

            const writable = new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    callback();
                },
            });

            await client.downloadTo(writable, remotePath);
            const result = Buffer.concat(chunks);
            this._tracker?.recordDownload(result.length);
            return result;
        });
    }

    async readFileRange(remotePath: string, start: number, end: number): Promise<Uint8Array> {
        return this._enqueue(async (client) => {
            const chunks: Buffer[] = [];
            let bytesReceived = 0;
            const bytesToRead = end - start + 1;

            const writable = new Writable({
                write(chunk, _encoding, callback) {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytesReceived += buf.length;

                    if (bytesReceived <= bytesToRead) {
                        chunks.push(buf);
                    } else {
                        // Trim last chunk
                        const excess = bytesReceived - bytesToRead;
                        chunks.push(buf.subarray(0, buf.length - excess));
                    }
                    callback();
                },
            });

            try {
                await client.downloadTo(writable, remotePath, start);
            } catch (err) {
                // Download may be interrupted when we have enough bytes
                // Only ignore the error if we actually received sufficient data
                if (bytesReceived < bytesToRead) {
                    throw err;
                }
            }

            const result = Buffer.concat(chunks).subarray(0, bytesToRead);
            this._tracker?.recordDownload(result.length);
            return result;
        });
    }

    async writeFile(
        remotePath: string,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        return this._enqueue(async (client) => {
            if (!options.overwrite || !options.create) {
                const exists = await this._existsRaw(client, remotePath);
                if (exists && !options.overwrite) {
                    throw vscode.FileSystemError.FileExists(remotePath);
                }
                if (!exists && !options.create) {
                    throw vscode.FileSystemError.FileNotFound(remotePath);
                }
            }

            // Preserve original permissions when overwriting an existing file.
            // uploadFrom() resets permissions to server defaults; restore them
            // via SITE CHMOD after the upload if the server supports it.
            const originalMode = await this._getUnixModeRaw(client, remotePath);

            // Temporary write permission: if the file is read-only and the setting
            // is enabled, temporarily add the owner-write bit before uploading, then
            // restore the original mode in a finally block.
            const needsTemporaryWrite =
                originalMode !== undefined &&
                (originalMode & 0o200) === 0 &&
                vscode.workspace.getConfiguration('remoteBridge.files').get<boolean>('temporaryWritePermission', false);

            if (needsTemporaryWrite) {
                const tmpModeStr = (originalMode! | 0o200).toString(8).padStart(3, '0');
                // Use send() so that an unsupported SITE CHMOD produces a clear error.
                try {
                    await client.send(`SITE CHMOD ${tmpModeStr} ${remotePath}`);
                } catch {
                    throw new Error(
                        vscode.l10n.t(
                            'File is read-only and the server does not support changing permissions (SITE CHMOD): {0}',
                            remotePath
                        )
                    );
                }
            }

            // Auto-create parent directories (FTP doesn't do this implicitly)
            const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
            if (parentDir !== '/') {
                await client.ensureDir(parentDir);
                await client.cd('/');
            }

            try {
                const readable = Readable.from(Buffer.from(content));
                await client.uploadFrom(readable, remotePath);
                this._tracker?.recordUpload(content.length);
            } finally {
                // Always restore the original mode (best-effort).
                if (originalMode !== undefined) {
                    const modeStr = originalMode.toString(8).padStart(3, '0');
                    await client.sendIgnoringError(`SITE CHMOD ${modeStr} ${remotePath}`);
                }
            }
        });
    }

    async delete(remotePath: string, options: { recursive: boolean }): Promise<void> {
        return this._enqueue(async (client) => {
            const stats = await this._statRaw(client, remotePath);

            if (stats.type === vscode.FileType.Directory) {
                if (!options.recursive) {
                    // basic-ftp removeDir is always recursive, so we check if empty first
                    const entries = await client.list(remotePath);
                    const filtered = entries.filter(e => e.name !== '.' && e.name !== '..');
                    if (filtered.length > 0) {
                        throw vscode.FileSystemError.NoPermissions(
                            vscode.l10n.t('Directory is not empty')
                        );
                    }
                }
                // basic-ftp's removeDir uses _exitAtCurrentDirectory which
                // saves the current CWD and tries to cd back to it in finally.
                // If CWD is the directory being deleted, that cd fails with 550.
                // Move to root first so _exitAtCurrentDirectory restores to '/'.
                await client.cd('/');
                await client.removeDir(remotePath);
            } else {
                await client.remove(remotePath);
            }
        });
    }

    async rename(oldPath: string, newPath: string, options: { overwrite: boolean }): Promise<void> {
        return this._enqueue(async (client) => {
            if (!options.overwrite) {
                const exists = await this._existsRaw(client, newPath);
                if (exists) {
                    throw vscode.FileSystemError.FileExists(newPath);
                }
            }

            await client.rename(oldPath, newPath);
        });
    }

    async mkdir(remotePath: string): Promise<void> {
        return this._enqueue(async (client) => {
            await client.ensureDir(remotePath);
            // ensureDir changes CWD, go back to root
            await client.cd('/');
        });
    }

    // ─── Not Supported ──────────────────────────────────────────

    async getUnixMode(remotePath: string): Promise<number | undefined> {
        return this._enqueue((client) => this._getUnixModeRaw(client, remotePath));
    }

    async chmod(remotePath: string, mode: number): Promise<void> {
        return this._enqueue(async (client) => {
            const modeStr = mode.toString(8).padStart(3, '0');
            await client.sendIgnoringError(`SITE CHMOD ${modeStr} ${remotePath}`);
        });
    }

    async exec(_command: string): Promise<ExecResult> {
        throw new Error(vscode.l10n.t('Command execution is not supported over FTP'));
    }

    async shell(): Promise<NodeJS.ReadWriteStream> {
        throw new Error(vscode.l10n.t('Interactive shell is not supported over FTP'));
    }

    // ─── Private Helpers ─────────────────────────────────────────

    private _requireClient(): FTPClient {
        if (!this._client || !this._connected) {
            throw new Error(vscode.l10n.t('Not connected'));
        }
        return this._client;
    }

    /** Raw stat without going through the queue (for use inside _enqueue callbacks) */
    private async _statRaw(client: FTPClient, remotePath: string): Promise<RemoteFileStat> {
        try {
            const size = await client.size(remotePath);
            const lastMod = await client.lastMod(remotePath).catch(() => new Date(0));
            return {
                type: vscode.FileType.File,
                ctime: lastMod.getTime(),
                mtime: lastMod.getTime(),
                size,
            };
        } catch {
            try {
                await client.list(remotePath);
                return {
                    type: vscode.FileType.Directory,
                    ctime: 0,
                    mtime: 0,
                    size: 0,
                };
            } catch {
                throw vscode.FileSystemError.FileNotFound(remotePath);
            }
        }
    }

    /** Raw exists check without going through the queue */
    private async _existsRaw(client: FTPClient, remotePath: string): Promise<boolean> {
        try {
            await this._statRaw(client, remotePath);
            return true;
        } catch {
            return false;
        }
    }

    /** Get Unix mode bits from a directory listing, without going through the queue. */
    private async _getUnixModeRaw(client: FTPClient, remotePath: string): Promise<number | undefined> {
        try {
            const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
            const fileName = remotePath.substring(remotePath.lastIndexOf('/') + 1);
            const entries = await client.list(parentDir);
            const entry = entries.find(e => e.name === fileName);
            if (!entry?.permissions) {
                return undefined;
            }
            const { user, group, world } = entry.permissions;
            return (user << 6) | (group << 3) | world;
        } catch {
            return undefined;
        }
    }

    private _mapFtpFileType(info: FileInfo): vscode.FileType {
        switch (info.type) {
            case FTPFileType.Directory:
                return vscode.FileType.Directory;
            case FTPFileType.SymbolicLink:
                return vscode.FileType.SymbolicLink;
            case FTPFileType.File:
            default:
                return vscode.FileType.File;
        }
    }

    dispose(): void {
        this.disconnect().catch(() => { /* ignore */ });
        this._onDidDisconnect.dispose();
    }
}
