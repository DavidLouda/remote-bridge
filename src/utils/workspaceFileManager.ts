import * as vscode from 'vscode';
import { ConnectionConfig } from '../types/connection';
import { buildRemoteUri } from './uriParser';

/** Directory inside globalStorageUri where .code-workspace files are stored. */
const WORKSPACES_DIR = 'workspaces';

/** Returns the URI of the workspaces directory, creating it if it doesn't exist. */
async function getWorkspacesDir(globalStorageUri: vscode.Uri): Promise<vscode.Uri> {
    const dir = vscode.Uri.joinPath(globalStorageUri, WORKSPACES_DIR);
    try {
        await vscode.workspace.fs.createDirectory(dir);
    } catch {
        // already exists — ignore
    }
    return dir;
}

/** Sanitize a string fragment so it is safe to use in a filename. */
function sanitizeSegment(value: string): string {
    return value
        .replace(/[/\\:*?"<>|]/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .trim();
}

/** Build the workspace filename (without extension) for a given host + remotePath. */
export function buildWorkspaceFilename(host: string, remotePath: string): string {
    // Trim leading/trailing slashes; if nothing remains, use host name only
    const trimmedPath = remotePath.replace(/^\/+|\/+$/g, '');
    if (!trimmedPath) {
        return sanitizeSegment(host);
    }
    return `${sanitizeSegment(host)} (${sanitizeSegment(trimmedPath)})`;
}

/**
 * Find an existing .code-workspace file that already contains a workspace folder
 * with the given connection ID (remote-bridge://<connectionId>/...).
 */
export async function findExistingWorkspaceFile(
    globalStorageUri: vscode.Uri,
    connectionId: string
): Promise<vscode.Uri | undefined> {
    const dir = vscode.Uri.joinPath(globalStorageUri, WORKSPACES_DIR);
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
        return undefined;
    }

    for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.code-workspace')) {
            continue;
        }
        const fileUri = vscode.Uri.joinPath(dir, name);
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const json = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
                folders?: { uri: string }[];
            };
            if (json.folders?.some(f => f.uri.includes(`remote-bridge://${connectionId}`))) {
                return fileUri;
            }
        } catch {
            // corrupted file — skip
        }
    }
    return undefined;
}

/**
 * Create (or overwrite) a .code-workspace file for one or more connections.
 * The file is named after the first connection's host + remotePath.
 * Returns the URI of the written file.
 */
export async function createWorkspaceFile(
    globalStorageUri: vscode.Uri,
    connections: ConnectionConfig[]
): Promise<vscode.Uri> {
    if (connections.length === 0) {
        throw new Error('At least one connection is required');
    }
    const first = connections[0];
    const dir = await getWorkspacesDir(globalStorageUri);
    const filename = buildWorkspaceFilename(first.host, first.remotePath) + '.code-workspace';
    const fileUri = vscode.Uri.joinPath(dir, filename);

    const folders = connections.map(conn => ({
        uri: buildRemoteUri(conn.id, conn.remotePath).toString(),
        name: `${conn.name} (${conn.host})`,
    }));

    const content = JSON.stringify({ folders, settings: {} }, null, '\t');
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
    return fileUri;
}

/**
 * Add a new folder entry to an existing .code-workspace file.
 */
export async function addFolderToWorkspaceFile(
    workspaceFileUri: vscode.Uri,
    conn: ConnectionConfig
): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(workspaceFileUri);
    const json = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        folders: { uri: string; name?: string }[];
        settings?: Record<string, unknown>;
    };

    const folderUri = buildRemoteUri(conn.id, conn.remotePath);
    const folderName = `${conn.name} (${conn.host})`;

    // Avoid duplicates
    const already = json.folders.some(f => f.uri.includes(`remote-bridge://${conn.id}`));
    if (!already) {
        json.folders.push({ uri: folderUri.toString(), name: folderName });
    }

    await vscode.workspace.fs.writeFile(
        workspaceFileUri,
        Buffer.from(JSON.stringify(json, null, '\t'), 'utf8')
    );
}

/**
 * Delete the .code-workspace file associated with a connection (if found).
 */
export async function deleteWorkspaceFileForConnection(
    globalStorageUri: vscode.Uri,
    connectionId: string
): Promise<void> {
    const fileUri = await findExistingWorkspaceFile(globalStorageUri, connectionId);
    if (fileUri) {
        try {
            await vscode.workspace.fs.delete(fileUri);
        } catch {
            // ignore
        }
    }
}

/**
 * Whether the currently open workspace file is one of ours
 * (lives inside globalStorageUri/workspaces/).
 */
export function isOurWorkspaceFile(globalStorageUri: vscode.Uri): boolean {
    const wsFile = vscode.workspace.workspaceFile;
    if (!wsFile) {
        return false;
    }
    const wsDir = vscode.Uri.joinPath(globalStorageUri, WORKSPACES_DIR);
    // Compare scheme + authority + path prefix
    return wsFile.toString().startsWith(wsDir.toString());
}

/**
 * Open a .code-workspace file in this window (causes window reload).
 */
export async function openWorkspaceFile(workspaceFileUri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('vscode.openFolder', workspaceFileUri, {
        forceNewWindow: false,
    });
}
