import * as vscode from 'vscode';
import { RemoteFileInfo, RemoteFileStat, ExecResult } from '../types/connection';

export type RemoteOperationSource = 'user' | 'probe' | 'watch' | 'keepalive';

export interface RemoteOperationOptions {
    source?: RemoteOperationSource;
}

/**
 * Abstract interface for remote file system adapters.
 * Implemented by SshAdapter (SSH/SFTP) and FtpAdapter (FTP/FTPS).
 */
export interface RemoteAdapter extends vscode.Disposable {
    /** Connect to the remote server. */
    connect(): Promise<void>;

    /** Disconnect from the remote server. */
    disconnect(): Promise<void>;

    /** Whether the adapter is currently connected. */
    isConnected(): boolean;

    /** Event fired when the connection is lost unexpectedly. */
    readonly onDidDisconnect: vscode.Event<void>;

    // ─── File System Operations ──────────────────────────────────

    /** Get file/directory metadata. */
    stat(remotePath: string, options?: RemoteOperationOptions): Promise<RemoteFileStat>;

    /** List directory contents. */
    readDirectory(remotePath: string, options?: RemoteOperationOptions): Promise<RemoteFileInfo[]>;

    /** Read entire file content. */
    readFile(remotePath: string, options?: RemoteOperationOptions): Promise<Uint8Array>;

    /**
     * Read a byte range from a file (for efficient partial reads).
     * If not supported, falls back to reading the entire file and slicing.
     */
    readFileRange(remotePath: string, start: number, end: number, options?: RemoteOperationOptions): Promise<Uint8Array>;

    /** Write content to a file (create or overwrite). */
    writeFile(remotePath: string, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void>;

    /** Delete a file or directory. */
    delete(remotePath: string, options: { recursive: boolean }): Promise<void>;

    /** Rename/move a file or directory. */
    rename(oldPath: string, newPath: string, options: { overwrite: boolean }): Promise<void>;

    /** Create a directory. */
    mkdir(remotePath: string): Promise<void>;

    // ─── SSH-only Operations ─────────────────────────────────────

    /** Execute a command on the remote server (SSH only). Returns null if not supported. */
    exec?(command: string): Promise<ExecResult>;

    /** Execute a command and pipe data to its stdin (SSH only). */
    execWithStdin?(command: string, stdinData: string): Promise<ExecResult>;

    /** Get an interactive shell stream (SSH only). Returns null if not supported. */
    shell?(): Promise<NodeJS.ReadWriteStream>;

    /** Whether this adapter supports command execution. */
    readonly supportsExec: boolean;

    /** Whether this adapter supports interactive shell. */
    readonly supportsShell: boolean;

    // ─── Optional Unix Permission Operations ─────────────────────

    /** Get Unix file mode bits (e.g. 0o644). Returns undefined if not supported or file not found. */
    getUnixMode?(remotePath: string): Promise<number | undefined>;

    /** Set Unix file mode bits. Silently no-ops if not supported by the protocol. */
    chmod?(remotePath: string, mode: number): Promise<void>;

    /**
     * Copy a file or directory to a new location on the same server, preserving permissions.
     * If not implemented, the FileSystemProvider falls back to read + write (permissions not preserved).
     */
    copy?(src: string, dst: string, options: { overwrite: boolean }): Promise<void>;
}

// ─── Connection loss detection ──────────────────────────────────

/**
 * Thrown by adapters when an operation fails because the underlying transport
 * (TCP socket, SFTP channel) was closed unexpectedly — for example after an
 * idle FTP server sends FIN, or an SSH session is torn down by the network.
 *
 * The FileSystemProvider treats this error as a hint to reconnect once and
 * retry the operation transparently before surfacing a save failure to VS Code.
 */
export class RemoteConnectionLostError extends Error {
    readonly isConnectionLost = true as const;
    readonly cause?: unknown;

    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = 'RemoteConnectionLostError';
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

const CONNECTION_LOST_MESSAGE_PATTERNS = [
    'client is closed',
    'fin packet',
    'not connected',
    'no response from server',
    'channel open failure',
    'connection lost',
    'connection closed',
    'socket hang up',
    'connection reset by peer',
    'broken pipe',
    'sftp: server has disconnected',
];

const CONNECTION_LOST_ERROR_CODES = new Set([
    'ECONNRESET',
    'EPIPE',
    'ENOTCONN',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ESHUTDOWN',
]);

/**
 * Heuristic: does this error look like the remote side or the local socket
 * dropped the connection (vs. a regular protocol-level failure such as
 * "file not found" or "permission denied")? Used both by adapters to mark
 * themselves disconnected and by the FileSystemProvider to decide whether
 * to retry once via a fresh adapter from the pool.
 */
export function looksLikeConnectionLost(err: unknown): boolean {
    if (err == null) {
        return false;
    }
    if (err instanceof RemoteConnectionLostError) {
        return true;
    }
    if (typeof err === 'object' && (err as { isConnectionLost?: unknown }).isConnectionLost === true) {
        return true;
    }
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_LOST_ERROR_CODES.has(code.toUpperCase())) {
        return true;
    }
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (!message) {
        return false;
    }
    for (const pattern of CONNECTION_LOST_MESSAGE_PATTERNS) {
        if (message.includes(pattern)) {
            return true;
        }
    }
    return false;
}

/** Type guard counterpart for `RemoteConnectionLostError`. */
export function isConnectionLostError(err: unknown): err is RemoteConnectionLostError {
    return err instanceof RemoteConnectionLostError
        || (typeof err === 'object' && err !== null && (err as { isConnectionLost?: unknown }).isConnectionLost === true);
}
