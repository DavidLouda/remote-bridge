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
import { PerfLogger } from '../services/perfLogger';
import { createProxySocket } from '../utils/proxyTunnel';

type QueuePriority = 'high' | 'normal' | 'low';

interface QueuedOperation {
    operation: string;
    client: FTPClient;
    queuedAt: number;
    priority: QueuePriority;
    run: (client: FTPClient) => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
}

const LOW_PRIORITY_PROBE_BASENAMES = new Set([
    'pom.xml',
    'build.gradle',
    'pyproject.toml',
    'setup.cfg',
    'tox.ini',
    '.pep8',
    '.pylintrc',
    'pylintrc',
    '.mypy.ini',
    '.flake8',
]);

const LOW_PRIORITY_PROBE_PREFIXES = [
    '/.vscode',
    '/.github',
    '/.claude',
    '/.devcontainer',
    '/.agents',
    '/.git',
    '/node_modules',
];

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

    /** Priority queues for serialized FTP operations */
    private readonly _highPriorityQueue: QueuedOperation[] = [];
    private readonly _normalPriorityQueue: QueuedOperation[] = [];
    private readonly _lowPriorityQueue: QueuedOperation[] = [];
    private _queueRunning = false;
    private _queueDrainScheduled = false;

    private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
    readonly onDidDisconnect = this._onDidDisconnect.event;

    readonly supportsExec = false;
    readonly supportsShell = false;

    private _tracker?: TransferTracker;

    constructor(
        private readonly _config: ConnectionConfig,
        private readonly _getPassword: () => Promise<string | undefined>,
        private readonly _getProxyPassword: () => Promise<string | undefined>,
        tracker?: TransferTracker,
        private readonly _perf?: PerfLogger,
        private readonly _debug: boolean = false
    ) {
        this._tracker = tracker;
    }

    // ─── Connection ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const start = Date.now();
        this._logPerf('connect start');

        // Pass timeout (ms) to the constructor — this sets the timeout on
        // the actual connected socket, not on a premature dummy socket.
        const timeoutMs = 30000;
        const client = new FTPClient(timeoutMs);
        client.ftp.verbose = this._debug;

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
            this._logPerf(`connect complete (${Date.now() - start}ms)`);

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
            this._logPerf(`connect failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
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
    private _enqueue<T>(operation: string, fn: (client: FTPClient) => Promise<T>): Promise<T> {
        const client = this._requireClient();
        const priority = this._inferQueuePriority(operation);

        return new Promise<T>((resolve, reject) => {
            this._pushQueuedOperation({
                operation,
                client,
                queuedAt: Date.now(),
                priority,
                run: (activeClient) => fn(activeClient),
                resolve: resolve as (value: unknown) => void,
                reject,
            });
            this._scheduleQueueDrain();
        });
    }

    private _pushQueuedOperation(task: QueuedOperation): void {
        switch (task.priority) {
            case 'high':
                this._highPriorityQueue.push(task);
                break;
            case 'low':
                this._lowPriorityQueue.push(task);
                break;
            case 'normal':
            default:
                this._normalPriorityQueue.push(task);
                break;
        }
    }

    private _scheduleQueueDrain(): void {
        if (this._queueRunning || this._queueDrainScheduled) {
            return;
        }

        this._queueDrainScheduled = true;
        queueMicrotask(() => {
            this._queueDrainScheduled = false;
            void this._drainQueue();
        });
    }

    private async _drainQueue(): Promise<void> {
        if (this._queueRunning) {
            return;
        }

        this._queueRunning = true;

        try {
            for (;;) {
                const task = this._shiftQueuedOperation();
                if (!task) {
                    return;
                }

                try {
                    const result = await this._executeQueuedOperation(
                        task.operation,
                        task.client,
                        task.queuedAt,
                        task.priority,
                        task.run
                    );
                    task.resolve(result);
                } catch (err) {
                    task.reject(err);
                }
            }
        } finally {
            this._queueRunning = false;
            if (this._hasQueuedOperations()) {
                this._scheduleQueueDrain();
            }
        }
    }

    private _shiftQueuedOperation(): QueuedOperation | undefined {
        return this._highPriorityQueue.shift()
            ?? this._normalPriorityQueue.shift()
            ?? this._lowPriorityQueue.shift();
    }

    private _hasQueuedOperations(): boolean {
        return this._highPriorityQueue.length > 0
            || this._normalPriorityQueue.length > 0
            || this._lowPriorityQueue.length > 0;
    }

    private async _executeQueuedOperation<T>(
        operation: string,
        client: FTPClient,
        queuedAt: number,
        priority: QueuePriority,
        fn: (client: FTPClient) => Promise<T>
    ): Promise<T> {
        const waitMs = Date.now() - queuedAt;
        const start = Date.now();

        try {
            const result = await fn(client);
            this._logPerf(`${operation} -> priority ${priority}, queue ${waitMs}ms, run ${Date.now() - start}ms`);
            return result;
        } catch (err) {
            this._logPerf(`${operation} -> priority ${priority}, queue ${waitMs}ms, failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
            throw err;
        }
    }

    private _inferQueuePriority(operation: string): QueuePriority {
        if (
            operation.startsWith('readDirectory ')
            || operation.startsWith('writeFile ')
            || operation.startsWith('delete ')
            || operation.startsWith('rename ')
            || operation.startsWith('mkdir ')
            || operation.startsWith('chmod ')
        ) {
            return 'high';
        }

        const remotePath = this._extractOperationPath(operation);
        if (
            remotePath
            && this._isLowPriorityProbePath(remotePath)
            && (
                operation.startsWith('stat ')
                || operation.startsWith('readFile ')
                || operation.startsWith('readFileRange ')
                || operation.startsWith('exists ')
            )
        ) {
            return 'low';
        }

        return 'normal';
    }

    private _extractOperationPath(operation: string): string | undefined {
        if (operation.startsWith('rename ')) {
            const separator = operation.indexOf(' -> ');
            return separator >= 0 ? operation.slice(separator + 4) : undefined;
        }

        const firstSpace = operation.indexOf(' ');
        return firstSpace >= 0 ? operation.slice(firstSpace + 1) : undefined;
    }

    private _isLowPriorityProbePath(remotePath: string): boolean {
        const normalizedPath = remotePath.toLowerCase();

        for (const prefix of LOW_PRIORITY_PROBE_PREFIXES) {
            if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
                return true;
            }
        }

        const baseName = normalizedPath.substring(normalizedPath.lastIndexOf('/') + 1);
        return LOW_PRIORITY_PROBE_BASENAMES.has(baseName);
    }

    async stat(remotePath: string): Promise<RemoteFileStat> {
        if (remotePath === '/' || remotePath === '') {
            return {
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            };
        }

        return this._enqueue(`stat ${remotePath}`, (client) => this._statRaw(client, remotePath));
    }

    async readDirectory(remotePath: string): Promise<RemoteFileInfo[]> {
        return this._enqueue(`readDirectory ${remotePath}`, async (client) => {
            let list: FileInfo[];
            try {
                list = await client.list(remotePath);
            } catch (err) {
                throw this._mapFtpFsError(err, remotePath);
            }

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
        return this._enqueue(`readFile ${remotePath}`, async (client) => {
            const chunks: Buffer[] = [];

            const writable = new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    callback();
                },
            });

            try {
                await client.downloadTo(writable, remotePath);
            } catch (err) {
                throw this._mapFtpFsError(err, remotePath);
            }
            const result = Buffer.concat(chunks);
            this._tracker?.recordDownload(result.length);
            return result;
        });
    }

    async readFileRange(remotePath: string, start: number, end: number): Promise<Uint8Array> {
        return this._enqueue(`readFileRange ${remotePath}`, async (client) => {
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
                    throw this._mapFtpFsError(err, remotePath);
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
        return this._enqueue(`writeFile ${remotePath}`, async (client) => {
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
                } else if (this._config.newFileMode !== undefined) {
                    // New file: apply the configured default permissions.
                    const modeStr = this._config.newFileMode.toString(8).padStart(3, '0');
                    await client.sendIgnoringError(`SITE CHMOD ${modeStr} ${remotePath}`);
                }
            }
        });
    }

    async delete(remotePath: string, options: { recursive: boolean }): Promise<void> {
        return this._enqueue(`delete ${remotePath}`, async (client) => {
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
        return this._enqueue(`rename ${oldPath} -> ${newPath}`, async (client) => {
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
        return this._enqueue(`mkdir ${remotePath}`, async (client) => {
            // Use direct MKD — single control command, does not change CWD.
            await client.send('MKD ' + remotePath);
            if (this._config.newDirectoryMode !== undefined) {
                const modeStr = this._config.newDirectoryMode.toString(8).padStart(3, '0');
                await client.sendIgnoringError(`SITE CHMOD ${modeStr} ${remotePath}`);
            }
        });
    }

    // ─── Not Supported ──────────────────────────────────────────

    async getUnixMode(remotePath: string): Promise<number | undefined> {
        return this._enqueue(`getUnixMode ${remotePath}`, (client) => this._getUnixModeRaw(client, remotePath));
    }

    async chmod(remotePath: string, mode: number): Promise<void> {
        return this._enqueue(`chmod ${remotePath}`, async (client) => {
            const modeStr = mode.toString(8).padStart(3, '0');
            await client.sendIgnoringError(`SITE CHMOD ${modeStr} ${remotePath}`);
        });
    }

    async copy(src: string, dst: string, options: { overwrite: boolean }): Promise<void> {
        const srcStat = await this.stat(src);

        if (srcStat.type === vscode.FileType.Directory) {
            const destinationExists = await this._enqueue(`exists ${dst}`, (client) => this._existsRaw(client, dst));
            if (destinationExists) {
                if (!options.overwrite) {
                    throw vscode.FileSystemError.FileExists(dst);
                }
                await this.delete(dst, { recursive: true });
            }

            await this.mkdir(dst);
            const srcMode = await this.getUnixMode(src);
            if (srcMode !== undefined) {
                await this.chmod(dst, srcMode);
            }

            const entries = await this.readDirectory(src);
            for (const entry of entries) {
                const childSrc = `${src === '/' ? '' : src}/${entry.name}`;
                const childDst = `${dst === '/' ? '' : dst}/${entry.name}`;
                await this.copy(childSrc, childDst, { overwrite: false });
            }
            return;
        }

        const [content, srcMode] = await Promise.all([
            this.readFile(src),
            this.getUnixMode(src),
        ]);
        await this.writeFile(dst, content, { create: true, overwrite: options.overwrite });
        if (srcMode !== undefined) {
            await this.chmod(dst, srcMode);
        }
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

    /**
     * Raw stat without going through the queue (for use inside _enqueue callbacks).
     * Uses SIZE for files and falls back to listing the parent directory for
     * directory detection — never changes CWD.
     */
    private async _statRaw(client: FTPClient, remotePath: string): Promise<RemoteFileStat> {
        if (remotePath === '/' || remotePath === '') {
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }
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
            // SIZE failed — check the parent listing to distinguish
            // "directory" from "does not exist" without changing CWD.
            const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/')) || '/';
            const baseName = remotePath.substring(remotePath.lastIndexOf('/') + 1);
            let entries: FileInfo[];
            try {
                entries = await client.list(parentDir);
            } catch (err) {
                throw this._mapFtpFsError(err, remotePath);
            }
            const entry = entries.find(e => e.name === baseName);
            if (!entry) {
                throw vscode.FileSystemError.FileNotFound(remotePath);
            }
            return {
                type: this._mapFtpFileType(entry),
                ctime: 0,
                mtime: entry.modifiedAt ? entry.modifiedAt.getTime() : 0,
                size: entry.size,
            };
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

    private _mapFtpFsError(error: unknown, remotePath: string): Error {
        if (this._isMissingPathError(error)) {
            return vscode.FileSystemError.FileNotFound(remotePath);
        }

        return error instanceof Error ? error : new Error(String(error));
    }

    private _isMissingPathError(error: unknown): boolean {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

        return message.includes('no such file or directory')
            || message.includes("can't open")
            || message.includes('cannot open')
            || message.includes("can't check for file existence")
            || message.includes('not found');
    }

    private _logPerf(message: string): void {
        if (!this._perf) {
            return;
        }
        this._perf.log(`${this._config.protocol.toUpperCase()} ${this._config.name}@${this._config.host}`, message);
    }

    dispose(): void {
        this.disconnect().catch(() => { /* ignore */ });
        this._onDidDisconnect.dispose();
    }
}
