import * as vscode from 'vscode';
import { ConnectionManager } from '../services/connectionManager';
import { ConnectionPool } from '../services/connectionPool';
import { ConnectionStatus } from '../types/connection';

/**
 * Chat participant `@bridge` for natural language interaction
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
        response.markdown(
            '\n**Available tools:** `#remoteRun`, `#remoteRead`, `#remoteSearch`\n' +
            '- Use `#remoteRead` with `search` to find code patterns in a file (runs grep server-side on SSH).\n' +
            '- To edit remote files, open them via the Explorer and use VS Code native file editing tools on `remote-bridge://` workspace files.\n'
        );

        return {};
    };

    const participant = vscode.chat.createChatParticipant(
        'remote-bridge.bridge',
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
