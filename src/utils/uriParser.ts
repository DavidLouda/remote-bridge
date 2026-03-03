import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Parsed representation of a remote-bridge:// URI.
 *
 * Format: remote-bridge://<connectionId>/<remotePath>
 */
export interface ParsedRemoteUri {
    connectionId: string;
    remotePath: string;
}

/**
 * Parse a remote-bridge:// URI into its components.
 */
export function parseRemoteUri(uri: vscode.Uri): ParsedRemoteUri {
    if (uri.scheme !== 'remote-bridge') {
        throw new Error(`Invalid URI scheme: ${uri.scheme}`);
    }

    const connectionId = uri.authority;
    if (!connectionId) {
        throw new Error('Missing connection ID in URI');
    }

    // Ensure path starts with /
    const remotePath = uri.path || '/';

    return { connectionId, remotePath };
}

/**
 * Build a remote-bridge:// URI from connection ID and remote path.
 */
export function buildRemoteUri(connectionId: string, remotePath: string): vscode.Uri {
    // Normalize path to always start with /
    const normalizedPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
    return vscode.Uri.parse(`remote-bridge://${connectionId}${normalizedPath}`);
}

/**
 * Get the parent directory path from a remote path.
 */
export function getParentPath(remotePath: string): string {
    if (remotePath === '/' || remotePath === '') {
        return '/';
    }
    const trimmed = remotePath.endsWith('/') ? remotePath.slice(0, -1) : remotePath;
    const lastSlash = trimmed.lastIndexOf('/');
    return lastSlash <= 0 ? '/' : trimmed.substring(0, lastSlash);
}

/**
 * Get the file/directory name from a remote path.
 */
export function getBaseName(remotePath: string): string {
    if (remotePath === '/' || remotePath === '') {
        return '';
    }
    const trimmed = remotePath.endsWith('/') ? remotePath.slice(0, -1) : remotePath;
    const lastSlash = trimmed.lastIndexOf('/');
    return trimmed.substring(lastSlash + 1);
}

/**
 * Join two path segments.
 */
export function joinRemotePath(base: string, segment: string): string {
    const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const normalizedSegment = segment.startsWith('/') ? segment.slice(1) : segment;
    return `${normalizedBase}/${normalizedSegment}`;
}

/**
 * Generate a cryptographically secure UUID v4 string.
 */
export function generateId(): string {
    return crypto.randomUUID();
}
