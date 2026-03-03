import * as vscode from 'vscode';
import { ConnectionPool } from '../services/connectionPool';
import { ConnectionConfig } from '../types/connection';

/**
 * Provides an integrated VS Code terminal backed by an SSH shell session.
 * Implements the Pseudoterminal interface for full terminal integration.
 */
export class SshTerminalProvider implements vscode.Pseudoterminal {
    private readonly _onDidWrite = new vscode.EventEmitter<string>();
    readonly onDidWrite = this._onDidWrite.event;

    private readonly _onDidClose = new vscode.EventEmitter<number | void>();
    readonly onDidClose = this._onDidClose.event;

    private readonly _onDidChangeName = new vscode.EventEmitter<string>();
    readonly onDidChangeName = this._onDidChangeName.event;

    private _shellStream: NodeJS.ReadWriteStream | null = null;
    private _dimensions: { columns: number; rows: number } = { columns: 120, rows: 30 };

    constructor(
        private readonly _config: ConnectionConfig,
        private readonly _pool: ConnectionPool
    ) {}

    /**
     * Open the terminal (called by VS Code when the terminal is created).
     */
    async open(initialDimensions: vscode.TerminalDimensions | undefined): Promise<void> {
        if (initialDimensions) {
            this._dimensions = {
                columns: initialDimensions.columns,
                rows: initialDimensions.rows,
            };
        }

        this._onDidWrite.fire(
            vscode.l10n.t('Connecting to {0}@{1}:{2}...\r\n', this._config.username, this._config.host, String(this._config.port))
        );

        try {
            const adapter = await this._pool.getAdapter(this._config);

            if (!adapter.supportsShell || !adapter.shell) {
                this._onDidWrite.fire(
                    vscode.l10n.t('This connection does not support interactive shell.\r\n')
                );
                this._onDidClose.fire(1);
                return;
            }

            const stream = await adapter.shell();
            this._shellStream = stream;

            this._onDidChangeName.fire(`SSH: ${this._config.name}`);

            // Pipe remote output to terminal
            stream.on('data', (data: Buffer | string) => {
                this._onDidWrite.fire(
                    typeof data === 'string' ? data : data.toString('utf-8')
                );
            });

            stream.on('close', () => {
                this._onDidClose.fire(0);
            });

            stream.on('error', (err: Error) => {
                this._onDidWrite.fire(
                    `\r\n${vscode.l10n.t('Connection error: {0}', err.message)}\r\n`
                );
                this._onDidClose.fire(1);
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this._onDidWrite.fire(
                `\r\n${vscode.l10n.t('Failed to connect: {0}', message)}\r\n`
            );
            this._onDidClose.fire(1);
        }
    }

    /**
     * Handle user input (keystrokes) — forward to remote shell.
     */
    handleInput(data: string): void {
        if (this._shellStream) {
            this._shellStream.write(data);
        }
    }

    /**
     * Handle terminal resize.
     */
    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this._dimensions = {
            columns: dimensions.columns,
            rows: dimensions.rows,
        };
        // ssh2 ClientChannel supports setWindow
        if (this._shellStream && 'setWindow' in this._shellStream) {
            (this._shellStream as unknown as { setWindow: (rows: number, cols: number, height: number, width: number) => void })
                .setWindow(dimensions.rows, dimensions.columns, 0, 0);
        }
    }

    /**
     * Close the terminal.
     */
    close(): void {
        if (this._shellStream) {
            this._shellStream.end();
            this._shellStream = null;
        }
        this._onDidWrite.dispose();
        this._onDidClose.dispose();
        this._onDidChangeName.dispose();
    }
}

/**
 * Create and open an SSH terminal for a connection.
 */
export function openSshTerminal(
    config: ConnectionConfig,
    pool: ConnectionPool
): vscode.Terminal {
    const pty = new SshTerminalProvider(config, pool);
    const terminal = vscode.window.createTerminal({
        name: `SSH: ${config.name}`,
        pty,
        iconPath: new vscode.ThemeIcon('terminal'),
    });
    terminal.show();
    return terminal;
}
