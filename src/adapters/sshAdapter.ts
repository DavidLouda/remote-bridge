import * as vscode from 'vscode';
import { Client, SFTPWrapper, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import { RemoteAdapter, RemoteOperationOptions, RemoteConnectionLostError, looksLikeConnectionLost } from './adapter';
import { RemoteFileInfo, RemoteFileStat, ExecResult, ConnectionConfig } from '../types/connection';
import { TransferTracker } from '../services/transferTracker';
import { PerfLogger } from '../services/perfLogger';
import * as shell from '../utils/shellCommands';
import { createProxySocket } from '../utils/proxyTunnel';
import { createJumpSocket } from '../utils/jumpTunnel';
import { readPrivateKeySync } from '../utils/privateKeyLoader';

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
        private readonly _getJumpPassphrase: () => Promise<string | undefined> = async () => undefined,
        private readonly _perf?: PerfLogger
    ) {}

    // ─── Connection ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const start = Date.now();
        this._logPerf('connect start');

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
                        connectConfig.privateKey = readPrivateKeySync(keyPath);
                    } catch (err) {
                        throw err instanceof Error
                            ? err
                            : new Error(vscode.l10n.t('Failed to read private key: {0}', keyPath));
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
            // Track whether we've already settled — guards against the race where
            // 'error' fires after 'ready' (or vice versa), and ensures we only
            // run cleanup once.
            let settled = false;
            const settleReject = (err: unknown) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanupConnectListeners();
                reject(err);
            };
            const settleResolve = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanupConnectListeners();
                resolve();
            };

            const cleanupConnectListeners = (): void => {
                // Remove only the *connect-time* listeners; keep close/end attached
                // for unexpected-disconnect detection during the connection's lifetime.
                client.removeAllListeners('keyboard-interactive');
                client.removeAllListeners('ready');
                client.removeAllListeners('error');
            };

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
                        this._logPerf(`connect failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
                        settleReject(err);
                        return;
                    }
                    this._sftp = sftp;
                    this._logPerf(`connect complete (${Date.now() - start}ms)`);
                    settleResolve();
                });
            });

            client.on('error', (err) => {
                this._connected = false;
                this._sftp = null;
                this._logPerf(`connect failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
                settleReject(err);
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

    async stat(remotePath: string, _options?: RemoteOperationOptions): Promise<RemoteFileStat> {
        const sftp = this._requireSftp();
        const start = Date.now();
        return new Promise((resolve, reject) => {
            sftp.stat(remotePath, (err, stats) => {
                if (err) {
                    this._logPerf(`stat ${remotePath} failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
                    reject(this._mapSftpError(err, remotePath));
                    return;
                }
                this._logPerf(`stat ${remotePath} complete (${Date.now() - start}ms)`);
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

    async readDirectory(remotePath: string, _options?: RemoteOperationOptions): Promise<RemoteFileInfo[]> {
        const sftp = this._requireSftp();
        const start = Date.now();
        return new Promise((resolve, reject) => {
            sftp.readdir(remotePath, (err, list) => {
                if (err) {
                    this._logPerf(`readDirectory ${remotePath} failed after ${Date.now() - start}ms: ${this._perf?.formatError(err) ?? String(err)}`);
                    reject(this._mapSftpError(err, remotePath));
                    return;
                }
                this._logPerf(`readDirectory ${remotePath} complete (${Date.now() - start}ms, ${list.length} raw entries)`);
                resolve(
                    list.map((entry) => ({
                        name: entry.filename,
                        type: this._mapFileType(entry.attrs),
                        size: entry.attrs.size,
                        mtime: (entry.attrs.mtime || 0) * 1000,
                        ctime: (entry.attrs.mtime || 0) * 1000,
                        permissions: this._mapPermissions(entry.attrs),
                    }))
                );
            });
        });
    }

    async readFile(remotePath: string, _options?: RemoteOperationOptions): Promise<Uint8Array> {
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

    async readFileRange(remotePath: string, start: number, end: number, _options?: RemoteOperationOptions): Promise<Uint8Array> {
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

        let chmodApplied = false;
        if (needsTemporaryWrite) {
            // If chmod fails here we MUST abort — proceeding would either fail with
            // a less clear permission error from createWriteStream, or (worse) succeed
            // and silently lose the original permission bits.
            await this.chmod(remotePath, originalMode! | 0o200);
            chmodApplied = true;
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
            if (chmodApplied) {
                // Best-effort restore — at this point the file exists with elevated
                // permissions and we always want to put them back to the original.
                await this.chmod(remotePath, originalMode!).catch((err) => {
                    this._logPerf(`writeFile ${remotePath} -> failed to restore mode ${originalMode!.toString(8)}: ${this._perf?.formatError(err) ?? String(err)}`);
                });
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
                    // Many servers report "file already exists" / SSH_FX_FILE_ALREADY_EXISTS
                    // when the rename target collides — surface the target path in that case.
                    const errorPath = this._isTargetCollisionError(err) ? newPath : oldPath;
                    reject(this._mapSftpError(err, errorPath));
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
        // copyCmd already uses `cp -p` (single file) and `cp -a` / `cp -Rp` (recursive)
        // which preserves mode, ownership, and timestamps on POSIX systems.
        // PowerShell's Copy-Item preserves attributes by default on Windows.
        const cmd = shell.copyCmd(src, dst, recursive, os);
        const result = await this.exec(cmd);
        if (result.exitCode !== 0) {
            const detail = (result.stderr || result.stdout).trim();
            throw new Error(
                detail
                    ? vscode.l10n.t('Copy {0} to {1} failed: {2}', src, dst, detail)
                    : vscode.l10n.t('Copy {0} to {1} failed', src, dst)
            );
        }

        // Sanity-check: copy permissions explicitly for single-file copies. cp -p
        // can silently lose mode bits on some filesystems (e.g. when src is on a
        // FAT-mounted volume, or when a non-root user runs cp on a file owned by
        // another user). For directory trees we rely on cp -a / -Rp.
        if (!recursive) {
            try {
                const srcMode = await this.getUnixMode(src);
                const dstMode = await this.getUnixMode(dst);
                if (srcMode !== undefined && dstMode !== undefined && srcMode !== dstMode) {
                    await this.chmod(dst, srcMode);
                }
            } catch (err) {
                this._logPerf(`copy ${src} -> ${dst}: post-copy mode reconciliation failed: ${this._perf?.formatError(err) ?? String(err)}`);
            }
        }
    }

    // ─── SSH-only Operations ─────────────────────────────────────

    async detectHomeDirectory(): Promise<string> {
        let lastError: Error | undefined;

        try {
            const sftpPath = await this._resolveAccessibleDetectedPath(await this._detectCurrentDirectoryViaSftp());
            if (sftpPath) {
                this._logPerf(`detectHomeDirectory -> resolved via SFTP as ${sftpPath}`);
                return sftpPath;
            }
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            this._logPerf(`detectHomeDirectory -> SFTP detection failed: ${lastError.message}`);
        }

        try {
            const execPath = await this._resolveAccessibleDetectedPath(await this._detectCurrentDirectoryViaExec());
            if (execPath) {
                this._logPerf(`detectHomeDirectory -> resolved via exec as ${execPath}`);
                return execPath;
            }
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            this._logPerf(`detectHomeDirectory -> exec detection failed: ${lastError.message}`);
        }

        throw lastError ?? new Error(vscode.l10n.t('Could not detect an accessible remote path automatically.'));
    }

    async exec(command: string): Promise<ExecResult> {
        const client = this._requireClient();
        return new Promise((resolve, reject) => {
            client.exec(command, (err, stream) => {
                if (err) {
                    reject(this._classifyTransportError(err));
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
                    reject(this._classifyTransportError(err));
                });
            });
        });
    }

    async execWithStdin(command: string, stdinData: string): Promise<ExecResult> {
        const client = this._requireClient();
        return new Promise((resolve, reject) => {
            client.exec(command, (err, stream) => {
                if (err) {
                    reject(this._classifyTransportError(err));
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
                    reject(this._classifyTransportError(err));
                });

                // Write data to stdin and close
                stream.end(stdinData);
            });
        });
    }

    /**
     * If the error indicates the SSH transport went away, mark the adapter
     * disconnected and return a typed `RemoteConnectionLostError` so the
     * FileSystemProvider can reconnect once and retry. Otherwise return the
     * original error untouched.
     */
    private _classifyTransportError(err: unknown): unknown {
        if (!looksLikeConnectionLost(err)) {
            return err;
        }
        this._markDisconnectedAfterTransportLoss();
        if (err instanceof RemoteConnectionLostError) {
            return err;
        }
        const message = err instanceof Error ? err.message : String(err);
        return new RemoteConnectionLostError(message || 'SSH connection lost', err);
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

    private async _detectCurrentDirectoryViaSftp(): Promise<string> {
        const sftp = this._requireSftp();
        return new Promise((resolve, reject) => {
            sftp.realpath('.', (err, absPath) => {
                if (err) {
                    reject(this._mapSftpError(err, '.'));
                    return;
                }
                resolve(absPath);
            });
        });
    }

    private async _detectCurrentDirectoryViaExec(): Promise<string> {
        const result = await this.exec(shell.detectCurrentDirectory(this._config.os ?? 'linux'));
        if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || vscode.l10n.t('Could not detect an accessible remote path automatically.'));
        }

        const output = result.stdout.trim();
        if (!output) {
            throw new Error(vscode.l10n.t('Could not detect an accessible remote path automatically.'));
        }

        return output;
    }

    private async _resolveAccessibleDetectedPath(rawPath: string): Promise<string | undefined> {
        for (const candidate of this._buildDetectedPathCandidates(rawPath)) {
            if (!this._isAbsoluteDetectedPath(candidate)) {
                continue;
            }

            try {
                await this.readDirectory(candidate);
                return candidate;
            } catch {
                // Try the next normalized candidate.
            }
        }

        return undefined;
    }

    private _buildDetectedPathCandidates(rawPath: string): string[] {
        const normalized = rawPath.trim().replace(/^(["'])(.*)\1$/, '$2');
        if (!normalized) {
            return [];
        }

        const candidates = new Set<string>([normalized]);
        if ((this._config.os ?? 'linux') === 'windows') {
            const slashPath = normalized.replace(/\\/g, '/');
            candidates.add(slashPath);
            if (/^[A-Za-z]:\//.test(slashPath)) {
                candidates.add(`/${slashPath}`);
            }
        }

        return [...candidates];
    }

    private _isAbsoluteDetectedPath(remotePath: string): boolean {
        return remotePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(remotePath);
    }

    private async _exists(remotePath: string): Promise<boolean> {
        try {
            await this.stat(remotePath);
            return true;
        } catch {
            return false;
        }
    }

    private async _deleteRecursive(remotePath: string, depth: number = 0): Promise<void> {
        // Defensive depth cap — protects against pathological symlink-induced
        // cycles on servers that resolve symlinks during readdir.
        if (depth > 32) {
            throw new Error(vscode.l10n.t('Recursion depth exceeded while deleting {0}', remotePath));
        }
        const entries = await this.readDirectory(remotePath);
        for (const entry of entries) {
            const fullPath = `${remotePath}/${entry.name}`;
            const isSymlink = (entry.type & vscode.FileType.SymbolicLink) !== 0;
            // Never traverse into symlinks — unlink the link itself instead.
            if (entry.type === vscode.FileType.Directory && !isSymlink) {
                await this._deleteRecursive(fullPath, depth + 1);
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

    private _logPerf(message: string): void {
        if (!this._perf) {
            return;
        }
        this._perf.log(`${this._config.protocol.toUpperCase()} ${this._config.name}@${this._config.host}`, message);
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

    private _isTargetCollisionError(error: unknown): boolean {
        if (error && typeof error === 'object') {
            const code = (error as { code?: unknown }).code;
            const numeric = typeof code === 'number' ? code : parseInt(String(code), 10);
            // SSH_FX_FILE_ALREADY_EXISTS (non-standard 11) — used by some servers.
            if (numeric === 11) {
                return true;
            }
        }
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        return message.includes('already exists')
            || message.includes('file exists');
    }

    /**
     * Best-effort: flag the adapter disconnected when an operation hits a
     * transport-level failure before the ssh2 'close' handler has fired. The
     * close handler is still expected to fire afterwards — this just makes the
     * pool's next `getAdapter` see `isConnected() === false` immediately, so a
     * retry from the FileSystemProvider gets a freshly reconnected adapter
     * instead of reusing the broken one.
     */
    private _markDisconnectedAfterTransportLoss(): void {
        if (!this._connected) {
            return;
        }
        this._connected = false;
        // Defer the event so we don't fire while we're inside a synchronous
        // SFTP error callback — keeps listener semantics consistent with the
        // ssh2 'close' path.
        queueMicrotask(() => {
            try {
                this._onDidDisconnect.fire();
            } catch {
                // EventEmitter listeners are user-supplied; never let them break us.
            }
        });
    }

    private _mapSftpError(err: Error & { code?: number | string }, path: string): Error {
        // Detect transport-level failures first — SFTP errors that arrive after
        // the SSH transport went away (server reset, broken pipe, idle timeout).
        // Returning a typed error lets the FileSystemProvider reconnect once and
        // retry the failing operation transparently instead of bubbling up an
        // opaque save failure.
        if (looksLikeConnectionLost(err)) {
            this._markDisconnectedAfterTransportLoss();
            return err instanceof RemoteConnectionLostError
                ? err
                : new RemoteConnectionLostError(err.message || 'SSH connection lost', err);
        }

        const code = typeof err.code === 'number' ? err.code : parseInt(String(err.code), 10);
        const message = (err.message || '').toLowerCase();

        switch (code) {
            case 2: // SSH_FX_NO_SUCH_FILE
                return vscode.FileSystemError.FileNotFound(path);
            case 3: // SSH_FX_PERMISSION_DENIED
                return vscode.FileSystemError.NoPermissions(path);
            case 11: // SSH_FX_FILE_ALREADY_EXISTS (non-standard but used)
                return vscode.FileSystemError.FileExists(path);
            case 4: {
                // SSH_FX_FAILURE — generic, used for many distinct conditions:
                // "is a directory", "directory not empty", "operation failed", etc.
                // Inspect the message rather than collapsing all of them to Unavailable.
                if (message.includes('is a directory')) {
                    return vscode.FileSystemError.FileIsADirectory(path);
                }
                if (message.includes('directory not empty')) {
                    return vscode.FileSystemError.NoPermissions(
                        vscode.l10n.t('Directory is not empty: {0}', path)
                    );
                }
                // Fall through to the wrapped-error path below.
                break;
            }
        }

        // Pattern fallbacks for servers that don't set a code reliably.
        if (message.includes('no such file') || message.includes('not found')) {
            return vscode.FileSystemError.FileNotFound(path);
        }
        if (message.includes('permission denied')) {
            return vscode.FileSystemError.NoPermissions(path);
        }
        if (message.includes('already exists')) {
            return vscode.FileSystemError.FileExists(path);
        }

        // Always return an Error instance, never a raw object — preserve cause for diagnostics.
        if (err instanceof Error) {
            return err;
        }
        const wrapped = new Error(String(err));
        (wrapped as Error & { cause?: unknown }).cause = err;
        return wrapped;
    }

    dispose(): void {
        this.disconnect().catch(() => { /* ignore */ });
        this._onDidDisconnect.dispose();
    }
}
