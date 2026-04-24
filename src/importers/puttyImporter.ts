import * as vscode from 'vscode';
import * as fs from 'fs';
import { readImportFileSync } from '../utils/importerFile';
import { normalizePrivateKeyPath, isOutsideHome } from '../utils/keyPath';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import {
    ConnectionConfig,
    DEFAULT_PORTS,
    ImportResult,
} from '../types/connection';
import { parseIni } from '../utils/iniParser';

/**
 * Imports SSH connections from PuTTY sessions.
 *
 * On Windows, sessions are read from the registry:
 *   HKCU\Software\SimonTatham\PuTTY\Sessions\<session>
 *
 * On Linux/macOS, sessions are stored as INI-like files (no section headers)
 * in `~/.putty/sessions/`.
 *
 * PuTTY does NOT store passwords — auth method is inferred from session fields.
 * Non-SSH protocols (telnet, raw, serial …) are skipped with a warning.
 */
export class PuTTYImporter {
    async import(): Promise<ImportResult> {
        const result: ImportResult = {
            source: 'putty',
            imported: [],
            skipped: 0,
            errors: [],
            warnings: [],
        };

        if (process.platform === 'win32') {
            await this._importFromRegistry(result);
        } else {
            await this._importFromFiles(result);
        }

        return result;
    }

    // ─── Windows: Registry ────────────────────────────────────────────────────

    private async _importFromRegistry(result: ImportResult): Promise<void> {
        const regKey = 'HKCU\\Software\\SimonTatham\\PuTTY\\Sessions';

        let sessionNames: string[];
        try {
            const raw = cp.execSync(`reg query "${regKey}"`, { encoding: 'utf8' });
            sessionNames = raw
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter((l) => l.startsWith(regKey + '\\'))
                .map((l) => l.slice(regKey.length + 1).trim())
                .filter(Boolean);
        } catch {
            result.errors.push(
                vscode.l10n.t(
                    'No PuTTY sessions found in the registry. Make sure PuTTY is installed and has saved sessions.'
                )
            );
            return;
        }

        if (sessionNames.length === 0) {
            result.warnings!.push(
                vscode.l10n.t('No PuTTY sessions found in the registry.')
            );
            return;
        }

        for (const encoded of sessionNames) {
            const sessionName = this._decodeSessionName(encoded);
            try {
                // Use execFileSync with an argument array to avoid shell injection
                // (session names extracted from registry could contain ", &, | etc.)
                const raw = cp.execFileSync('reg', ['query', `${regKey}\\${encoded}`], {
                    encoding: 'utf8',
                });
                const values = this._parseRegOutput(raw);
                this._importSession(sessionName, values, result);
            } catch (err) {
                result.errors.push(
                    vscode.l10n.t('Failed to read PuTTY session "{0}": {1}', sessionName, String(err))
                );
            }
        }
    }

    /** Parse `reg query` output into a simple key→value map. */
    private _parseRegOutput(raw: string): Record<string, string> {
        const values: Record<string, string> = {};
        for (const line of raw.split(/\r?\n/)) {
            // Lines look like:  "    HostName    REG_SZ    myserver.example.com"
            const m = line.trim().match(/^(\S+)\s+REG_\w+\s+(.*)$/);
            if (m) {
                values[m[1]] = m[2].trim();
            }
        }
        return values;
    }

    // ─── Linux / macOS: Files ─────────────────────────────────────────────────

    private async _importFromFiles(result: ImportResult): Promise<void> {
        const sessionsDir = path.join(os.homedir(), '.putty', 'sessions');

        if (!fs.existsSync(sessionsDir)) {
            result.errors.push(
                vscode.l10n.t(
                    'PuTTY sessions directory not found at {0}. Make sure PuTTY for Linux is installed and has saved sessions.',
                    sessionsDir
                )
            );
            return;
        }

        let entries: string[];
        try {
            entries = fs.readdirSync(sessionsDir);
        } catch (err) {
            result.errors.push(
                vscode.l10n.t('Failed to read PuTTY sessions directory: {0}', String(err))
            );
            return;
        }

        for (const encoded of entries) {
            const filePath = path.join(sessionsDir, encoded);
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
                continue;
            }

            const sessionName = this._decodeSessionName(encoded);
            try {
                const content = readImportFileSync(filePath, 1 * 1024 * 1024);
                // Session files have no section headers — wrap in a synthetic section
                const values = parseIni(`[session]\n${content}`)['session'] ?? {};
                this._importSession(sessionName, values, result);
            } catch (err) {
                result.errors.push(
                    vscode.l10n.t('Failed to read PuTTY session "{0}": {1}', sessionName, String(err))
                );
            }
        }

        if (entries.length === 0) {
            result.warnings!.push(
                vscode.l10n.t('No PuTTY sessions found in {0}.', sessionsDir)
            );
        }
    }

    // ─── Session → ConnectionConfig conversion ────────────────────────────────

    private _importSession(
        sessionName: string,
        values: Record<string, string>,
        result: ImportResult
    ): void {
        // Skip non-SSH protocols
        const protocol = (values.Protocol ?? values.protocol ?? '').toLowerCase();
        if (protocol && protocol !== 'ssh') {
            result.skipped++;
            result.warnings!.push(
                vscode.l10n.t(
                    'Skipped PuTTY session "{0}": protocol "{1}" is not SSH',
                    sessionName,
                    protocol
                )
            );
            return;
        }

        const host = (values.HostName ?? values.hostname ?? '').trim();
        if (!host) {
            result.skipped++;
            return;
        }

        const port = parseInt(values.PortNumber ?? values.portnumber ?? '22', 10) || DEFAULT_PORTS.ssh;
        const username = (values.UserName ?? values.username ?? '').trim();
        const remotePath = (values.RemoteDirectory ?? values.remotedirectory ?? '/').trim() || '/';
        const keepAlive = parseInt(values.TCPKeepalives ?? values.tcpkeepalives ?? '0', 10) ? 10 : 0;

        // Determine auth method
        let authMethod: ConnectionConfig['authMethod'] = 'password';
        const keyFile = (values.PublicKeyFile ?? values.publickeyfile ?? '').trim();
        const agentFwd = (values.AgentFwd ?? values.agentfwd ?? '0').trim();

        if (keyFile) {
            authMethod = 'key';
        } else if (agentFwd === '1') {
            authMethod = 'agent';
        }

        const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
            name: sessionName,
            protocol: 'ssh',
            host,
            port,
            username,
            authMethod,
            remotePath,
            keepaliveInterval: keepAlive,
        };

        if (keyFile) {
            const normalizedKey = normalizePrivateKeyPath(keyFile);
            (connection as Record<string, unknown>).privateKeyPath = normalizedKey;
            if (isOutsideHome(normalizedKey)) {
                result.warnings!.push(
                    vscode.l10n.t('PuTTY session "{0}" references key outside home: {1}', sessionName, normalizedKey)
                );
            }
        }

        result.imported.push(connection as ConnectionConfig);
    }

    /** Decode URL-encoded PuTTY session names (e.g., `My%20Server` → `My Server`). */
    private _decodeSessionName(encoded: string): string {
        try {
            return decodeURIComponent(encoded);
        } catch {
            return encoded;
        }
    }
}
