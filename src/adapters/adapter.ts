import * as vscode from 'vscode';
import { RemoteFileInfo, RemoteFileStat, ExecResult } from '../types/connection';

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
    stat(remotePath: string): Promise<RemoteFileStat>;

    /** List directory contents. */
    readDirectory(remotePath: string): Promise<RemoteFileInfo[]>;

    /** Read entire file content. */
    readFile(remotePath: string): Promise<Uint8Array>;

    /**
     * Read a byte range from a file (for efficient partial reads).
     * If not supported, falls back to reading the entire file and slicing.
     */
    readFileRange(remotePath: string, start: number, end: number): Promise<Uint8Array>;

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
}
