import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SSHConfig from 'ssh-config';
import { readImportFileSync } from '../utils/importerFile';
import { normalizePrivateKeyPath, isOutsideHome } from '../utils/keyPath';
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
     * Expand Include directives recursively so imported SSH config files are
     * treated the same as the main file.
     */
    private _expandIncludes(
        config: ReturnType<typeof SSHConfig.parse>,
        baseDir: string,
        seen: Set<string> = new Set<string>()
    ): ReturnType<typeof SSHConfig.parse> {
        const expanded: ReturnType<typeof SSHConfig.parse> = [];

        for (const section of config) {
            if (section.type !== SSHConfig.DIRECTIVE || section.param !== 'Include') {
                expanded.push(section);
                continue;
            }

            const rawValues = Array.isArray(section.value)
                ? section.value
                : [section.value];

            for (const rawValue of rawValues) {
                for (const includePattern of this._splitIncludePatterns(String(rawValue))) {
                    for (const includePath of this._expandIncludePattern(includePattern, baseDir)) {
                        if (!fs.existsSync(includePath)) {
                            continue;
                        }

                        let realPath: string;
                        try {
                            realPath = fs.realpathSync(includePath);
                        } catch {
                            realPath = includePath;
                        }

                        if (seen.has(realPath)) {
                            continue;
                        }
                        seen.add(realPath);

                        try {
                            const content = readImportFileSync(includePath);
                            const childConfig = SSHConfig.parse(content);
                            expanded.push(...this._expandIncludes(childConfig, path.dirname(includePath), seen));
                        } catch {
                            // Ignore unreadable include files and keep processing the rest.
                        }
                    }
                }
            }
        }

        return expanded;
    }

    private _splitIncludePatterns(rawValue: string): string[] {
        const matches = rawValue.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
        return matches
            .map((token) => token.replace(/^['"](.+)['"]$/, '$1').trim())
            .filter(Boolean);
    }

    private _expandIncludePattern(includePattern: string, baseDir: string): string[] {
        if (!includePattern) {
            return [];
        }

        let pattern = includePattern.trim();
        if (!pattern) {
            return [];
        }

        if (pattern.startsWith('~')) {
            pattern = path.join(os.homedir(), pattern.slice(1));
        } else if (!path.isAbsolute(pattern)) {
            pattern = path.resolve(baseDir, pattern);
        }

        if (!/[\\*?]/.test(pattern)) {
            return [pattern];
        }

        const directory = path.dirname(pattern);
        const filePattern = path.basename(pattern);
        if (!fs.existsSync(directory)) {
            return [];
        }

        const regex = this._globToRegExp(filePattern);
        const matches: string[] = [];

        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile()) {
                continue;
            }
            if (regex.test(entry.name)) {
                matches.push(path.join(directory, entry.name));
            }
        }

        return matches.sort();
    }

    private _globToRegExp(pattern: string): RegExp {
        let regex = '^';

        for (const char of pattern) {
            if (char === '*') {
                regex += '.*';
            } else if (char === '?') {
                regex += '.';
            } else {
                regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
            }
        }

        return new RegExp(regex + '$');
    }

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
            content = readImportFileSync(filePath);
        } catch (err) {
            result.errors.push(err instanceof Error ? err.message : vscode.l10n.t('Failed to read SSH config: {0}', String(err)));
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

        config = this._expandIncludes(config, path.dirname(filePath));

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
                    const normalizedKey = normalizePrivateKeyPath(String(keyPath));
                    connection.privateKeyPath = normalizedKey;
                    if (isOutsideHome(normalizedKey)) {
                        result.errors.push(
                            vscode.l10n.t('SSH config host "{0}" references key outside home: {1}', connection.name, normalizedKey)
                        );
                    }
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
