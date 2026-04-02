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

export interface JumpHostConfig {
    host: string;
    port: number;
    username: string;
    authMethod: AuthMethod;
    privateKeyPath?: string;
    hasPassphrase?: boolean;
    agent?: string;
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
    /** SSH Jump Host (ProxyJump) — SSH/SFTP only. Mutually exclusive with proxy. */
    jumpHost?: JumpHostConfig;
    /** Keep-alive interval in seconds (0 = disabled) */
    keepaliveInterval: number;
    /** Sort order within its folder */
    sortOrder: number;
    /** Use TLS/FTPS (only for FTP connections) */
    secure?: boolean;
    /** Allow self-signed / invalid TLS certificates (FTPS only). Default: false = verify certificates. */
    allowSelfSigned?: boolean;
    /** Remote server operating system (default: 'linux') */
    os?: RemoteOS;
    /**
     * When true, the AI agent (chat tools) is allowed to operate outside the workspace root.
     * Enables reads, searches, and command execution anywhere on the server the SSH user can access.
     * Destructive commands (shutdown, rm -rf /, mkfs, …) remain blocked regardless.
     * Only meaningful for SSH/SFTP connections.
     */
    fullSshAccess?: boolean;
    /**
     * Unix mode bits for newly created files (e.g. 0o644).
     * When undefined, the server default (subject to umask) is used.
     * Applies to SSH/SFTP and FTP/FTPS connections.
     */
    newFileMode?: number;
    /**
     * Unix mode bits for newly created directories (e.g. 0o755).
     * When undefined, the server default (subject to umask) is used.
     * Applies to SSH/SFTP and FTP/FTPS connections.
     */
    newDirectoryMode?: number;
    /** Epoch ms of the last modification. Used for sync merge conflict resolution. */
    updatedAt?: number;
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
    /** Epoch ms of the last modification. Used for sync merge conflict resolution. */
    updatedAt?: number;
}

// ─── Tombstone ─────────────────────────────────────────────────────

/**
 * Records that a connection or folder was deleted, enabling sync merge to
 * propagate deletions from one device to another.
 */
export interface Tombstone {
    /** ID of the deleted connection or folder. */
    id: string;
    /** Epoch ms when the entity was deleted. */
    deletedAt: number;
}

// ─── Connection Store (serialized to globalState) ───────────────────

/** Secrets for a single connection, bundled into the store when sync is enabled. */
export interface ConnectionSecrets {
    password?: string;
    passphrase?: string;
    proxyPassword?: string;
    jumpPassword?: string;
    jumpPassphrase?: string;
}

export interface ConnectionStore {
    /** Schema version for future migrations */
    version: number;
    /** All connection folders */
    folders: ConnectionFolder[];
    /** All connection configurations (secrets stored separately in SecretStorage) */
    connections: ConnectionConfig[];
    /**
     * Secrets bundled into the encrypted store to enable cross-device sync.
     * Only present when `remoteBridge.security.syncConnections` is enabled
     * together with a master password. The store must be encrypted before saving
     * with this field populated.
     * Key = connection ID, value = secrets object.
     */
    secrets?: Record<string, ConnectionSecrets>;
    /**
     * Recently deleted connection and folder IDs with deletion timestamps.
     * Used during sync merge so deletions on one device propagate to others.
     * Entries older than 30 days are pruned on every save.
     */
    tombstones?: Tombstone[];
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

export function secretKeyForJumpPassword(connectionId: string): string {
    return `remote-bridge.connection.${connectionId}.jumpPassword`;
}

export function secretKeyForJumpPassphrase(connectionId: string): string {
    return `remote-bridge.connection.${connectionId}.jumpPassphrase`;
}
