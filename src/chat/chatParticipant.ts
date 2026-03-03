import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionPool } from '../services/connectionPool';
import { ConnectionStatus } from '../types/connection';

/**
 * Chat participant `@remote` for natural language interaction
 * with remote servers through GitHub Copilot.
 */
export function registerChatParticipant(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    pool: ConnectionPool
): vscode.Disposable {
    const handler: vscode.ChatRequestHandler = async (
        request,
        chatContext,
        response,
        token
    ) => {
        // Handle commands
        if (request.command === 'status') {
            return handleStatus(response, connectionManager, pool);
        }

        if (request.command === 'connect') {
            return handleConnect(request, response, connectionManager, pool);
        }

        if (request.command === 'ls') {
            return handleLs(request, response, connectionManager, pool);
        }

        // Default: use tool-calling mode — let the LLM decide which tools to invoke
        // Provide context about available connections
        const connections = connectionManager.getConnections();
        const connectionInfo = connections
            .map((c) => {
                const status = pool.getStatus(c.id);
                return `- "${c.name}" (${c.protocol}://${c.host}:${c.port}) [${status}]`;
            })
            .join('\n');

        response.markdown(
            vscode.l10n.t(
                'I can help you work with your remote servers. Here are your configured connections:\n\n'
            )
        );
        response.markdown('```\n' + connectionInfo + '\n```\n\n');
        response.markdown(
            vscode.l10n.t(
                'You can ask me to list files, read/write files (with efficient partial line-range support and insert mode), search for content, find files by name, delete/rename/copy files, create directories, get file info, run commands, or query MySQL databases on any connected server. Use `listConnections` to discover available servers. Use the connection **name** when calling tools. Prefer partial reads and writes for large files. Use `runCommand` only when there is no dedicated file/database tool for the task.'
            )
        );
        response.markdown(
            '\n\n**Efficiency tips:**\n'
            + '- Skip `statFile` before `readFile` — `readFile` returns a clear error if the file does not exist.\n'
            + '- Use `searchFiles` to search file **contents**, use `findFiles` to search file **names**.\n'
            + '- Use `readFile` with `startLine`/`endLine` for large files — only the requested lines travel over SSH.\n'
            + '- Use `writeFile` with `startLine`/`endLine` to replace specific lines, or `mode=insert` to add new code.\n'
            + '- Use `copyFile`, `renameFile`, `deleteFile` instead of `runCommand` with cp/mv/rm.\n'
        );

        return {};
    };

    const participant = vscode.chat.createChatParticipant(
        'remote',
        handler
    );
    participant.iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        'resources',
        'Logo.png'
    );

    return participant;
}

// ─── Command Handlers ───────────────────────────────────────────

async function handleStatus(
    response: vscode.ChatResponseStream,
    connectionManager: ConnectionManager,
    pool: ConnectionPool
): Promise<vscode.ChatResult> {
    const connections = connectionManager.getConnections();

    if (connections.length === 0) {
        response.markdown(vscode.l10n.t('No connections configured.'));
        response.button({
            title: vscode.l10n.t('Add Connection'),
            command: 'remoteBridge.addConnection',
        });
        return {};
    }

    response.markdown(`### ${vscode.l10n.t('Connection Status')}\n\n`);

    for (const conn of connections) {
        const status = pool.getStatus(conn.id);
        const icon =
            status === ConnectionStatus.Connected
                ? '🟢'
                : status === ConnectionStatus.Connecting
                  ? '🟡'
                  : status === ConnectionStatus.Error
                    ? '🔴'
                    : '⚪';
        response.markdown(
            `${icon} **${conn.name}** — \`${conn.protocol}://${conn.host}:${conn.port}\`\n\n`
        );
    }

    return {};
}

async function handleConnect(
    request: vscode.ChatRequest,
    response: vscode.ChatResponseStream,
    connectionManager: ConnectionManager,
    pool: ConnectionPool
): Promise<vscode.ChatResult> {
    const connectionName = request.prompt.trim();

    if (!connectionName) {
        response.markdown(
            vscode.l10n.t('Please specify a connection name. Usage: `/connect myserver`')
        );
        return {};
    }

    const connection = connectionManager.findConnectionByName(connectionName);
    if (!connection) {
        response.markdown(
            vscode.l10n.t('Connection "{0}" not found.', connectionName)
        );
        return {};
    }

    response.progress(vscode.l10n.t('Connecting to {0}...', connection.name));

    try {
        await pool.getAdapter(connection);
        response.markdown(
            vscode.l10n.t('Successfully connected to **{0}**.', connection.name)
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        response.markdown(
            vscode.l10n.t('Failed to connect to {0}: {1}', connection.name, message)
        );
    }

    return {};
}

async function handleLs(
    request: vscode.ChatRequest,
    response: vscode.ChatResponseStream,
    connectionManager: ConnectionManager,
    pool: ConnectionPool
): Promise<vscode.ChatResult> {
    // Parse: everything before the last /-prefixed arg is the connection name,
    // the last /-prefixed arg (if any) is the remote path.
    const rawArgs = request.prompt.trim();
    let connectionName: string;
    let remotePath = '/';

    const lastSlashIdx = rawArgs.lastIndexOf(' /');
    if (lastSlashIdx > 0) {
        connectionName = rawArgs.substring(0, lastSlashIdx).trim();
        remotePath = rawArgs.substring(lastSlashIdx).trim();
    } else if (rawArgs.startsWith('/')) {
        // Only a path, no connection name
        connectionName = '';
    } else {
        connectionName = rawArgs;
    }

    if (!connectionName) {
        response.markdown(
            vscode.l10n.t(
                'Please specify a connection name. Usage: `/ls myserver /path`'
            )
        );
        return {};
    }

    const connection = connectionManager.findConnectionByName(connectionName);
    if (!connection) {
        response.markdown(
            vscode.l10n.t('Connection "{0}" not found.', connectionName)
        );
        return {};
    }

    response.progress(vscode.l10n.t('Listing files...'));

    try {
        const adapter = await pool.getAdapter(connection);
        const entries = await adapter.readDirectory(remotePath);

        response.markdown(
            `### ${vscode.l10n.t('Files in {0}:{1}', connection.name, remotePath)}\n\n`
        );

        for (const entry of entries) {
            const icon = entry.type === 2 /* Directory */ ? '📁' : '📄';
            const size =
                entry.type === 2 ? '' : ` (${formatBytes(entry.size)})`;
            response.markdown(`${icon} \`${entry.name}\`${size}\n\n`);
        }

        response.markdown(
            vscode.l10n.t('\n*{0} items total*', String(entries.length))
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        response.markdown(
            vscode.l10n.t('Failed to list files: {0}', message)
        );
    }

    return {};
}

function formatBytes(bytes: number): string {
    if (bytes === 0) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
