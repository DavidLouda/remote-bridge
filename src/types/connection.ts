import * as vscode from 'vscode';

// ─── Protocol Types ─────────────────────────────────────────────────

export type ConnectionProtocol = 'ssh' | 'sftp' | 'ftp' | 'ftps';

export type AuthMethod = 'password' | 'key' | 'agent' | 'keyboard-interactive';

/** Remote server operating system. Determines which shell commands are generated. */
export type RemoteOS = 'linux' | 'macos' | 'windows';

// ─── Connection Configuration ───────────────────────────────────────

export interface ProxyConfig {
    type: 'socks4' | 'socks5' | 'http';
    host: string;
    port: number;
    username?: string;
    /** @deprecated Proxy passwords are now stored in SecretStorage. This field is kept for migration only. */
    password?: string;
}

export interface ConnectionConfig {
    /** Unique identifier (UUID v4) */
    id: string;
    /** Display name */
    name: string;
    /** Connection protocol */
    protocol: ConnectionProtocol;
    /** Server hostname or IP */
    host: string;
    /** Server port */
    port: number;
    /** Username for authentication */
    username: string;
    /** Authentication method */
    authMethod: AuthMethod;
    /** Default remote root path */
    remotePath: string;
    /** Parent folder ID (undefined = root level) */
    folderId?: string;
    /** Path to private key file */
    privateKeyPath?: string;
    /** Whether a passphrase is stored for the private key */
    hasPassphrase?: boolean;
    /** SSH agent socket path or 'pageant' */
    agent?: string;
    /** Proxy configuration */
    proxy?: ProxyConfig;
    /** Keep-alive interval in seconds (0 = disabled) */
    keepaliveInterval: number;
    /** Sort order within its folder */
    sortOrder: number;
    /** Use TLS/FTPS (only for FTP connections) */
    secure?: boolean;
    /** Remote server operating system (default: 'linux') */
    os?: RemoteOS;
}

// ─── Connection Folder ──────────────────────────────────────────────

export interface ConnectionFolder {
    /** Unique identifier (UUID v4) */
    id: string;
    /** Folder display name */
    name: string;
    /** Parent folder ID (undefined = root level) */
    parentId?: string;
    /** Sort order */
    sortOrder: number;
}

// ─── Connection Store (serialized to globalState) ───────────────────

export interface ConnectionStore {
    /** Schema version for future migrations */
    version: number;
    /** All connection folders */
    folders: ConnectionFolder[];
    /** All connection configurations (secrets stored separately) */
    connections: ConnectionConfig[];
}

// ─── Encryption Metadata ────────────────────────────────────────────

export interface EncryptionMeta {
    /** Whether master password encryption is enabled */
    enabled: boolean;
    /** Salt for PBKDF2 key derivation (hex) */
    salt: string;
    /** Verification hash to validate master password (hex) */
    verificationHash: string;
}

// ─── Connection Status ──────────────────────────────────────────────

export enum ConnectionStatus {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Error = 'error',
}

// ─── File Stat ──────────────────────────────────────────────────────

export interface RemoteFileStat {
    type: vscode.FileType;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: vscode.FilePermission;
}

// ─── Tree Item Types ────────────────────────────────────────────────

export type ConnectionTreeItemType = 'folder' | 'connection';

export interface ConnectionTreeNode {
    type: ConnectionTreeItemType;
    id: string;
    label: string;
    /** For connections: protocol icon, for folders: folder icon */
    protocol?: ConnectionProtocol;
    status?: ConnectionStatus;
    folderId?: string;
    sortOrder: number;
    children?: ConnectionTreeNode[];
}

// ─── Import Source Types ────────────────────────────────────────────

export type ImportSource = 'ssh-config' | 'winscp' | 'sshfs' | 'filezilla' | 'putty' | 'totalcmd';

export interface ImportFolder {
    /** Slash-separated folder path, e.g. "Production/DB" */
    path: string;
    /** Folder display name (last segment) */
    name: string;
    /** Parent path (undefined = root level) */
    parentPath?: string;
}

export interface ImportResult {
    source: ImportSource;
    imported: ConnectionConfig[];
    skipped: number;
    errors: string[];
    warnings?: string[];
    folders?: ImportFolder[];
}

// ─── Remote Adapter File Info ───────────────────────────────────────

export interface RemoteFileInfo {
    name: string;
    type: vscode.FileType;
    size: number;
    mtime: number;
    ctime: number;
    permissions?: vscode.FilePermission;
}

// ─── Command Execution Result ───────────────────────────────────────

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

// ─── Default Values ─────────────────────────────────────────────────

export const DEFAULT_PORTS: Record<ConnectionProtocol, number> = {
    ssh: 22,
    sftp: 22,
    ftp: 21,
    ftps: 990,
};

export const CONNECTION_STORE_VERSION = 1;

// ─── Secret Storage Keys ────────────────────────────────────────────

export function secretKeyForPassword(connectionId: string): string {
    return `remote-bridge.connection.${connectionId}.password`;
}

export function secretKeyForPassphrase(connectionId: string): string {
    return `remote-bridge.connection.${connectionId}.passphrase`;
}

export function secretKeyForProxyPassword(connectionId: string): string {
    return `remote-bridge.connection.${connectionId}.proxyPassword`;
}
