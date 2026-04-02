import * as vscode from 'vscode';
import { Client, SFTPWrapper, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import { RemoteAdapter } from './adapter';
import { RemoteFileInfo, RemoteFileStat, ExecResult, ConnectionConfig } from '../types/connection';
import { TransferTracker } from '../services/transferTracker';
import * as shell from '../utils/shellCommands';
import { createProxySocket } from '../utils/proxyTunnel';
import { createJumpSocket } from '../utils/jumpTunnel';

/**
 * SSH/SFTP adapter using the ssh2 library.
 * Provides full file system access plus command execution and interactive shell.
 */
export class SshAdapter implements RemoteAdapter {
    private _client: Client | null = null;
    private _sftp: SFTPWrapper | null = null;
    private _connected = false;
    private _jumpClient: Client | null = null;

    private readonly _onDidDisconnect = new vscode.EventEmitter<void>();
    readonly onDidDisconnect = this._onDidDisconnect.event;

    readonly supportsExec = true;
    readonly supportsShell = true;

    constructor(
        private readonly _config: ConnectionConfig,
        private readonly _getPassword: () => Promise<string | undefined>,
        private readonly _getPassphrase: () => Promise<string | undefined>,
        private readonly _getProxyPassword: () => Promise<string | undefined>,
        private readonly _tracker?: TransferTracker,
        private readonly _getJumpPassword: () => Promise<string | undefined> = async () => undefined,
        private readonly _getJumpPassphrase: () => Promise<string | undefined> = async () => undefined
    ) {}

    // ─── Connection ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const client = new Client();
        this._client = client;

        const connectConfig: ConnectConfig = {
            host: this._config.host,
            port: this._config.port,
            username: this._config.username,
            keepaliveInterval: this._config.keepaliveInterval != null && this._config.keepaliveInterval >= 0
                ? this._config.keepaliveInterval * 1000
                : 10000,
            keepaliveCountMax: 3,
            readyTimeout: 30000,
        };

        // Configure authentication
        switch (this._config.authMethod) {
            case 'password': {
                const password = await this._getPassword();
                if (password) {
                    connectConfig.password = password;
                }
                break;
            }
            case 'key': {
                if (this._config.privateKeyPath) {
                    const keyPath = this._config.privateKeyPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
                    try {
                        connectConfig.privateKey = fs.readFileSync(keyPath);
                    } catch {
                        throw vscode.l10n.t({
                            message: 'Failed to read private key: {0}',
                            args: [keyPath],
                            comment: ['{0} is the file path to the private key'],
                        });
                    }
                }
                if (this._config.hasPassphrase) {
                    const passphrase = await this._getPassphrase();
                    if (passphrase) {
                        connectConfig.passphrase = passphrase;
                    }
                }
                break;
            }
            case 'agent':
                connectConfig.agent = this._config.agent || process.env.SSH_AUTH_SOCK;
                break;
            case 'keyboard-interactive':
                connectConfig.tryKeyboard = true;
                break;
        }

        // If a proxy is configured, create the tunnel socket first
        if (this._config.proxy) {
            const proxyPassword = await this._getProxyPassword();
            connectConfig.sock = await createProxySocket(
                this._config.proxy,
                proxyPassword,
                this._config.host,
                this._config.port
            );
        }

        // If a jump host is configured, open an SSH-forwarded channel to the target
        if (this._config.jumpHost) {
            const { stream, jumpClient } = await createJumpSocket(
                this._config.jumpHost,
                this._getJumpPassword,
                this._getJumpPassphrase,
                this._config.host,
                this._config.port
            );
            this._jumpClient = jumpClient;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            connectConfig.sock = stream as any;
        }

        return new Promise<void>((resolve, reject) => {
            // Handle keyboard-interactive authentication prompts
            client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
                const responses: string[] = [];
                const askNext = async (index: number) => {
                    if (index >= prompts.length) {
                        finish(responses);
                        return;
                    }
                    const prompt = prompts[index];
                    const answer = await vscode.window.showInputBox({
                        title: vscode.l10n.t('SSH Authentication'),
                        prompt: prompt.prompt || vscode.l10n.t('Enter authentication response'),
                        password: !prompt.echo,
                        ignoreFocusOut: true,
                    });
                    responses.push(answer || '');
                    await askNext(index + 1);
                };
                askNext(0).catch(() => finish(responses));
            });

            client.on('ready', () => {
                this._connected = true;
                client.sftp((err, sftp) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    this._sftp = sftp;
                    resolve();
                });
            });

            client.on('error', (err) => {
                this._connected = false;
                this._sftp = null;
                reject(err);
            });

            client.on('close', () => {
                const wasConnected = this._connected;
                this._connected = false;
                this._sftp = null;
                if (wasConnected) {
                    this._onDidDisconnect.fire();
                }
            });

            client.on('end', () => {
                this._connected = false;
                this._sftp = null;
            });

            client.connect(connectConfig);
        });
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        if (this._client) {
            this._client.end();
            this._client = null;
        }
        this._sftp = null;
        if (this._jumpClient) {
            this._jumpClient.end();
            this._jumpClient = null;
        }
    }

    isConnected(): boolean {
        return this._connected;
    }

    // ─── File System Operations ──────────────────────────────────

    async stat(remotePath: string): Promise<RemoteFileStat> {
        const sftp = this._requireSftp();
        return new Promise((resolve, reject) => {
            sftp.stat(remotePath, (err, stats) => {
                if (err) {
                    reject(this._mapSftpError(err, remotePath));
                    return;
                }
                resolve({
                    type: this._mapFileType(stats),
                    ctime: (stats.mtime || 0) * 1000,
                    mtime: (stats.mtime || 0) * 1000,
                    size: stats.size,
                    permissions: this._mapPermissions(stats),
                });
            });
        });
    }

    async getUnixMode(remotePath: string): Promise<number | undefined> {
        const sftp = this._requireSftp();
        try {
            const stats = await new Promise<{ mode?: number }>((resolve, reject) => {
                sftp.stat(remotePath, (err, s) => err ? reject(err) : resolve(s));
            });
            return stats.mode !== undefined ? (stats.mode & 0o7777) : undefined;
        } catch {
            return undefined;
        }
    }

    async chmod(remotePath: string, mode: number): Promise<void> {
        const sftp = this._requireSftp();
        return new Promise((resolve, reject) => {
            sftp.chmod(remotePath, mode, (err) => err ? reject(this._mapSftpError(err, remotePath)) : resolve());
        });
    }

    async readDirectory(remotePath: string): Promise<RemoteFileInfo[]> {
        const sftp = this._requireSftp();
        return new Promise((resolve, reject) => {
            sftp.readdir(remotePath, (err, list) => {
                if (err) {
                    reject(this._mapSftpError(err, remotePath));
                    return;
                }
                resolve(
                    list.map((entry) => ({
                        name: entry.filename,
                        type: this._mapFileType(entry.attrs),
                        size: entry.attrs.size,
                        mtime: (entry.attrs.mtime || 0) * 1000,
                        ctime: (entry.attrs.mtime || 0) * 1000,
                    }))
                );
            });
        });
    }

    async readFile(remotePath: string): Promise<Uint8Array> {
        const sftp = this._requireSftp();
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            const stream = sftp.createReadStream(remotePath);
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
                const result = Buffer.concat(chunks);
                this._tracker?.recordDownload(result.length);
                resolve(result);
            });
            stream.on('error', (err: Error) => {
                stream.destroy();
                reject(this._mapSftpError(err, remotePath));
            });
        });
    }

    async readFileRange(remotePath: string, start: number, end: number): Promise<Uint8Array> {
        const sftp = this._requireSftp();
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            const stream = sftp.createReadStream(remotePath, { start, end });
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
                const result = Buffer.concat(chunks);
                this._tracker?.recordDownload(result.length);
                resolve(result);
            });
            stream.on('error', (err: Error) => {
                stream.destroy();
                reject(this._mapSftpError(err, remotePath));
            });
        });
    }

    async writeFile(
        remotePath: string,
        content: Uint8Array,
        options: { create: boolean; overwrite: boolean }
    ): Promise<void> {
        const sftp = this._requireSftp();

        // Check if file exists
        if (!options.overwrite || !options.create) {
            const exists = await this._exists(remotePath);
            if (exists && !options.overwrite) {
                throw vscode.FileSystemError.FileExists(remotePath);
            }
            if (!exists && !options.create) {
                throw vscode.FileSystemError.FileNotFound(remotePath);
            }
        }

        // Preserve original permissions when overwriting an existing file.
        // createWriteStream() without an explicit mode resets to server defaults
        // (typically 0o666), ignoring the file's existing permissions.
        const originalMode = await this.getUnixMode(remotePath);

        // Temporary write permission: if the file is read-only and the setting
        // is enabled, temporarily add the owner-write bit before writing, then
        // restore the original mode in a finally block.
        const needsTemporaryWrite =
            originalMode !== undefined &&
            (originalMode & 0o200) === 0 &&
            vscode.workspace.getConfiguration('remoteBridge.files').get<boolean>('temporaryWritePermission', false);

        if (needsTemporaryWrite) {
            await this.chmod(remotePath, originalMode! | 0o200);
        }

        try {
            await new Promise<void>((resolve, reject) => {
                const stream = originalMode !== undefined
                    ? sftp.createWriteStream(remotePath, { mode: originalMode })
                    : this._config.newFileMode !== undefined
                        ? sftp.createWriteStream(remotePath, { mode: this._config.newFileMode })
                        : sftp.createWriteStream(remotePath);
                stream.on('close', () => {
                    this._tracker?.recordUpload(content.length);
                    resolve();
                });
                stream.on('error', (err: Error) => reject(this._mapSftpError(err, remotePath)));
                stream.end(Buffer.from(content));
            });
        } finally {
            if (needsTemporaryWrite) {
                await this.chmod(remotePath, originalMode!).catch(() => { /* best-effort restore */ });
            }
        }
    }

    async delete(remotePath: string, options: { recursive: boolean }): Promise<void> {
        const sftp = this._requireSftp();
        const stats = await this.stat(remotePath);

        if (stats.type === vscode.FileType.Directory) {
            if (options.recursive) {
                // Use rm -rf via exec for efficiency instead of walking the tree via SFTP
                if (this.supportsExec) {
                    const os = this._config.os ?? 'linux';
                    const result = await this.exec(shell.rmRecursive(remotePath, os));
                    if (result.exitCode !== 0) {
                        throw new Error(result.stderr || vscode.l10n.t('Failed to delete directory'));
                    }
                } else {
                    await this._deleteRecursive(remotePath);
                }
            } else {
                await new Promise<void>((resolve, reject) => {
                    sftp.rmdir(remotePath, (err) => {
                        if (err) {
                            reject(this._mapSftpError(err, remotePath));
                        } else {
                            resolve();
                        }
                    });
                });
            }
        } else {
            await new Promise<void>((resolve, reject) => {
                sftp.unlink(remotePath, (err) => {
                    if (err) {
                        reject(this._mapSftpError(err, remotePath));
                    } else {
                        resolve();
                    }
                });
            });
        }
    }

    async rename(oldPath: string, newPath: string, options: { overwrite: boolean }): Promise<void> {
        const sftp = this._requireSftp();

        if (!options.overwrite) {
            const exists = await this._exists(newPath);
            if (exists) {
                throw vscode.FileSystemError.FileExists(newPath);
            }
        }

        return new Promise((resolve, reject) => {
            sftp.rename(oldPath, newPath, (err) => {
                if (err) {
                    reject(this._mapSftpError(err, oldPath));
                } else {
                    resolve();
                }
            });
        });
    }

    async mkdir(remotePath: string): Promise<void> {
        const sftp = this._requireSftp();

        // Recursively create parent directories as needed
        const parts = remotePath.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            const exists = await this._exists(current);
            if (!exists) {
                await new Promise<void>((resolve, reject) => {
                    sftp.mkdir(current, (err) => {
                        if (err) {
                            reject(this._mapSftpError(err, current));
                        } else {
                            resolve();
                        }
                    });
                });
                if (this._config.newDirectoryMode !== undefined) {
                    await this.chmod(current, this._config.newDirectoryMode).catch(() => { /* best-effort */ });
                }
            }
        }
    }

    async copy(src: string, dst: string, options: { overwrite: boolean }): Promise<void> {
        const destinationExists = await this._exists(dst);
        if (destinationExists) {
            if (!options.overwrite) {
                throw vscode.FileSystemError.FileExists(dst);
            }
            const destinationStat = await this.stat(dst);
            await this.delete(dst, { recursive: destinationStat.type === vscode.FileType.Directory });
        }

        const os = this._config.os ?? 'linux';
        const stat = await this.stat(src);
        const recursive = stat.type === vscode.FileType.Directory;
        const cmd = shell.copyCmd(src, dst, recursive, os);
        const result = await this.exec(cmd);
        if (result.exitCode !== 0) {
            throw new Error(result.stderr || vscode.l10n.t('Copy failed'));
        }
    }

    // ─── SSH-only Operations ─────────────────────────────────────

    async exec(command: string): Promise<ExecResult> {
        const client = this._requireClient();
        return new Promise((resolve, reject) => {
            client.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (!stream) {
                    reject(new Error('SSH exec: no stream returned'));
                    return;
                }

                let stdout = '';
                let stderr = '';

                stream.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });
                stream.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });
                stream.on('close', (code: number) => {
                    resolve({ stdout, stderr, exitCode: code ?? 0 });
                });
                stream.on('error', (err: Error) => {
                    reject(err);
                });
            });
        });
    }

    async execWithStdin(command: string, stdinData: string): Promise<ExecResult> {
        const client = this._requireClient();
        return new Promise((resolve, reject) => {
            client.exec(command, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }
                if (!stream) {
                    reject(new Error('SSH exec: no stream returned'));
                    return;
                }

                let stdout = '';
                let stderr = '';

                stream.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });
                stream.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });
                stream.on('close', (code: number) => {
                    resolve({ stdout, stderr, exitCode: code ?? 0 });
                });
                stream.on('error', (err: Error) => {
                    reject(err);
                });

                // Write data to stdin and close
                stream.end(stdinData);
            });
        });
    }

    async shell(): Promise<NodeJS.ReadWriteStream> {
        const client = this._requireClient();
        return new Promise((resolve, reject) => {
            client.shell(
                { term: 'xterm-256color', cols: 120, rows: 30 },
                (err, stream) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(stream as unknown as NodeJS.ReadWriteStream);
                }
            );
        });
    }

    // ─── Private Helpers ─────────────────────────────────────────

    private _requireSftp(): SFTPWrapper {
        if (!this._sftp || !this._connected) {
            throw new Error(vscode.l10n.t('Not connected'));
        }
        return this._sftp;
    }

    private _requireClient(): Client {
        if (!this._client || !this._connected) {
            throw new Error(vscode.l10n.t('Not connected'));
        }
        return this._client;
    }

    private async _exists(remotePath: string): Promise<boolean> {
        try {
            await this.stat(remotePath);
            return true;
        } catch {
            return false;
        }
    }

    private async _deleteRecursive(remotePath: string): Promise<void> {
        const entries = await this.readDirectory(remotePath);
        for (const entry of entries) {
            const fullPath = `${remotePath}/${entry.name}`;
            if (entry.type === vscode.FileType.Directory) {
                await this._deleteRecursive(fullPath);
            } else {
                await this.delete(fullPath, { recursive: false });
            }
        }
        await new Promise<void>((resolve, reject) => {
            this._sftp!.rmdir(remotePath, (err) => {
                if (err) {
                    reject(this._mapSftpError(err, remotePath));
                } else {
                    resolve();
                }
            });
        });
    }

    private _mapFileType(attrs: { isDirectory: () => boolean; isSymbolicLink: () => boolean; isFile: () => boolean } | { mode?: number }): vscode.FileType {
        if ('isDirectory' in attrs && typeof attrs.isDirectory === 'function') {
            const isSymlink = attrs.isSymbolicLink();
            const isDir = attrs.isDirectory();
            if (isSymlink && isDir) {
                return vscode.FileType.SymbolicLink | vscode.FileType.Directory;
            }
            if (isSymlink) {
                return vscode.FileType.SymbolicLink | vscode.FileType.File;
            }
            if (isDir) {
                return vscode.FileType.Directory;
            }
            return vscode.FileType.File;
        }
        // fallback for raw mode
        const mode = (attrs as { mode?: number }).mode;
        if (mode !== undefined) {
            const isSymlink = (mode & 0o170000) === 0o120000;
            const isDir = (mode & 0o40000) !== 0;
            if (isSymlink && isDir) {
                return vscode.FileType.SymbolicLink | vscode.FileType.Directory;
            }
            if (isSymlink) {
                return vscode.FileType.SymbolicLink | vscode.FileType.File;
            }
            if (isDir) {
                return vscode.FileType.Directory;
            }
        }
        return vscode.FileType.File;
    }

    private _mapPermissions(stats: { mode?: number }): vscode.FilePermission | undefined {
        if (stats.mode !== undefined) {
            // Check if file is writable by owner
            if ((stats.mode & 0o200) === 0) {
                return vscode.FilePermission.Readonly;
            }
        }
        return undefined;
    }

    private _mapSftpError(err: Error & { code?: number | string }, path: string): Error {
        const code = typeof err.code === 'number' ? err.code : parseInt(String(err.code), 10);
        switch (code) {
            case 2: // SSH_FX_NO_SUCH_FILE
                return vscode.FileSystemError.FileNotFound(path);
            case 3: // SSH_FX_PERMISSION_DENIED
                return vscode.FileSystemError.NoPermissions(path);
            case 4: // SSH_FX_FAILURE (often "directory not empty" or generic)
                return vscode.FileSystemError.Unavailable(path);
            case 11: // SSH_FX_FILE_ALREADY_EXISTS (non-standard but used)
                return vscode.FileSystemError.FileExists(path);
            default:
                return err;
        }
    }

    dispose(): void {
        this.disconnect().catch(() => { /* ignore */ });
        this._onDidDisconnect.dispose();
    }
}
