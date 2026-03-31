import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SSHConfig from 'ssh-config';
import {
    ConnectionConfig,
    ConnectionProtocol,
    DEFAULT_PORTS,
    ImportResult,
    JumpHostConfig,
} from '../types/connection';

/**
 * Imports connections from the standard SSH config file (~/.ssh/config).
 */
export class SshConfigImporter {
    /**
     * Import SSH connections from the default config file.
     */
    async import(): Promise<ImportResult> {
        const configPath = path.join(os.homedir(), '.ssh', 'config');
        return this.importFromFile(configPath);
    }

    /**
     * Import SSH connections from a specific file path.
     */
    async importFromFile(filePath: string): Promise<ImportResult> {
        const result: ImportResult = {
            source: 'ssh-config',
            imported: [],
            skipped: 0,
            errors: [],
        };

        if (!fs.existsSync(filePath)) {
            result.errors.push(
                vscode.l10n.t('SSH config file not found: {0}', filePath)
            );
            return result;
        }

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch (err) {
            result.errors.push(
                vscode.l10n.t('Failed to read SSH config: {0}', String(err))
            );
            return result;
        }

        let config: ReturnType<typeof SSHConfig.parse>;
        try {
            config = SSHConfig.parse(content);
        } catch (err) {
            result.errors.push(
                vscode.l10n.t('Failed to parse SSH config: {0}', String(err))
            );
            return result;
        }

        // Iterate over Host blocks
        for (const section of config) {
            if (section.type !== SSHConfig.DIRECTIVE) {
                continue;
            }
            if (section.param !== 'Host') {
                continue;
            }

            const hostPattern = String(section.value);

            // Skip wildcard entries and negation patterns
            if (hostPattern.includes('*') || hostPattern.includes('?') || hostPattern.startsWith('!')) {
                result.skipped++;
                continue;
            }

            try {
                // Compute effective config for this host
                const computed = config.compute(hostPattern);
                const hostname = computed['HostName'] || hostPattern;
                const user = computed['User'] || process.env.USER || process.env.USERNAME || 'root';
                const port = computed['Port'] ? parseInt(String(computed['Port']), 10) : 22;
                const identityFile = computed['IdentityFile'];

                const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
                    name: hostPattern,
                    protocol: 'ssh' as ConnectionProtocol,
                    host: String(hostname),
                    port: isNaN(port) ? DEFAULT_PORTS.ssh : port,
                    username: String(user),
                    authMethod: identityFile ? 'key' : 'password',
                    remotePath: '/',
                    keepaliveInterval: 10,
                    os: 'linux',
                };

                if (identityFile) {
                    // SSH config can have multiple IdentityFile; take the first one
                    const keyPath = Array.isArray(identityFile) ? identityFile[0] : identityFile;
                    connection.privateKeyPath = String(keyPath).replace(/^~/, os.homedir());
                }

                // Handle ProxyJump — parse and map to jumpHost config.
                // Format: [user@]host[:port]  or  comma-separated (take first hop only)
                const proxyJump = computed['ProxyJump'];
                if (proxyJump) {
                    const raw = String(proxyJump).split(',')[0].trim(); // first hop only
                    const userHostPort = raw.replace(/^ssh:\/\//, '');
                    let jumpUser: string | undefined;
                    let jumpHostPort = userHostPort;

                    if (userHostPort.includes('@')) {
                        const at = userHostPort.lastIndexOf('@');
                        jumpUser = userHostPort.slice(0, at);
                        jumpHostPort = userHostPort.slice(at + 1);
                    }

                    let jumpHostname = jumpHostPort;
                    let jumpPort = 22;
                    const colonIdx = jumpHostPort.lastIndexOf(':');
                    if (colonIdx > 0) {
                        jumpHostname = jumpHostPort.slice(0, colonIdx);
                        jumpPort = parseInt(jumpHostPort.slice(colonIdx + 1), 10) || 22;
                    }

                    const jumpConfig: JumpHostConfig = {
                        host: jumpHostname,
                        port: jumpPort,
                        username: jumpUser || connection.username,
                        authMethod: 'key',
                    };
                    connection.jumpHost = jumpConfig;
                }

                result.imported.push(connection as ConnectionConfig);
            } catch (err) {
                result.errors.push(
                    vscode.l10n.t('Failed to import host "{0}": {1}', hostPattern, String(err))
                );
                result.skipped++;
            }
        }

        return result;
    }
}
