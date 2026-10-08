import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SSHConfig from 'ssh-config';
import { readImportFileSync } from '../utils/importerFile';
import { normalizePrivateKeyPath, isOutsideHome } from '../utils/keyPath';
import { expandIncludes, IncludeWarning } from '../utils/sshConfigInclude';
import { ALGORITHM_CATEGORIES, OPENSSH_ALGORITHM_KEYWORDS, sanitizeAlgorithmSettings } from '../utils/sshAlgorithms';
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
            content = readImportFileSync(filePath);
        } catch (err) {
            result.errors.push(err instanceof Error ? err.message : vscode.l10n.t('Failed to read SSH config: {0}', String(err)));
            return result;
        }

        const sshDir = path.join(os.homedir(), '.ssh');
        const expansion = expandIncludes(content, {
            sshDir,
            homeDir: os.homedir(),
            readFile: (includePath) => readImportFileSync(includePath),
        }, filePath);
        for (const warning of expansion.warnings) {
            result.errors.push(this._describeIncludeWarning(warning));
        }

        let config: ReturnType<typeof SSHConfig.parse>;
        try {
            config = SSHConfig.parse(expansion.text);
        } catch (err) {
            result.errors.push(
                vscode.l10n.t('Failed to parse SSH config: {0}', String(err))
            );
            return result;
        }

        const removed = removeUnsafeDirectives(config);
        if (removed > 0) {
            result.errors.push(
                vscode.l10n.t('Ignored {0} "Match exec" / "CanonicalizeHostName" directive(s): they would run commands or DNS lookups during import.', String(removed))
            );
        }

        // Iterate over Host blocks. One connection per block, named after its
        // first concrete alias (e.g. "Host prod prod.example.com" → "prod").
        const importedAliases = new Set<string>();
        for (const section of config) {
            if (section.type !== SSHConfig.DIRECTIVE || !/^host$/i.test(section.param)) {
                continue;
            }

            const alias = hostPatterns(section.value).find(
                (pattern) => !pattern.startsWith('!') && !/[*?]/.test(pattern)
            );
            // Wildcard-only and negation entries are defaults, not hosts
            if (!alias) {
                result.skipped++;
                continue;
            }
            // The same host may appear in several blocks; compute() merges them.
            if (importedAliases.has(alias)) {
                continue;
            }
            importedAliases.add(alias);

            try {
                result.imported.push(this._buildConnection(config, alias, result) as ConnectionConfig);
            } catch (err) {
                result.errors.push(
                    vscode.l10n.t('Failed to import host "{0}": {1}', alias, String(err))
                );
                result.skipped++;
            }
        }

        return result;
    }

    private _buildConnection(
        config: ReturnType<typeof SSHConfig.parse>,
        alias: string,
        result: ImportResult
    ): Omit<ConnectionConfig, 'id' | 'sortOrder'> {
        const computed = config.compute(alias, { ignoreCase: true });
        const hostname = firstValue(computed['hostname']) || alias;
        const user = firstValue(computed['user']) || process.env.USER || process.env.USERNAME || 'root';
        const port = parseInt(firstValue(computed['port']) ?? '', 10);
        const identityFile = firstValue(computed['identityfile']);
        const identityAgent = firstValue(computed['identityagent']);
        const useAgent = !identityFile && !!identityAgent && identityAgent.toLowerCase() !== 'none';

        const connection: Omit<ConnectionConfig, 'id' | 'sortOrder'> = {
            name: alias,
            protocol: 'ssh' as ConnectionProtocol,
            host: hostname,
            port: isNaN(port) ? DEFAULT_PORTS.ssh : port,
            username: user,
            authMethod: identityFile ? 'key' : useAgent ? 'agent' : 'password',
            remotePath: '/',
            keepaliveInterval: 10,
            os: 'linux',
        };

        if (identityFile) {
            // SSH config can have multiple IdentityFile; take the first one
            connection.privateKeyPath = this._importKeyPath(identityFile, alias, result);
        } else if (useAgent) {
            connection.agent = identityAgent;
        }

        const algorithmSource: Record<string, string> = {};
        for (const category of ALGORITHM_CATEGORIES) {
            const value = firstValue(computed[OPENSSH_ALGORITHM_KEYWORDS[category].toLowerCase()]);
            if (value) {
                algorithmSource[category] = value;
            }
        }
        const { algorithms, dropped } = sanitizeAlgorithmSettings(algorithmSource);
        connection.algorithms = algorithms;
        if (dropped.length > 0) {
            result.errors.push(
                vscode.l10n.t('Connection "{0}": ignored unsupported SSH algorithm settings: {1}', alias, dropped.join('; '))
            );
        }

        // ProxyJump: [ssh://][user@]host[:port], comma-separated for several
        // hops (only the first hop is supported). "none" disables it.
        const proxyJump = firstValue(computed['proxyjump']);
        if (proxyJump && proxyJump.toLowerCase() !== 'none') {
            connection.jumpHost = this._buildJumpHost(config, proxyJump.split(',')[0].trim(), connection.username, result);
        }

        return connection;
    }

    private _buildJumpHost(
        config: ReturnType<typeof SSHConfig.parse>,
        hop: string,
        defaultUser: string,
        result: ImportResult
    ): JumpHostConfig {
        const userHostPort = hop.replace(/^ssh:\/\//, '');
        let jumpUser: string | undefined;
        let jumpHostPort = userHostPort;
        if (userHostPort.includes('@')) {
            const at = userHostPort.lastIndexOf('@');
            jumpUser = userHostPort.slice(0, at);
            jumpHostPort = userHostPort.slice(at + 1);
        }

        let jumpHostname = jumpHostPort;
        let jumpPort: number | undefined;
        const colonIdx = jumpHostPort.lastIndexOf(':');
        if (colonIdx > 0) {
            jumpHostname = jumpHostPort.slice(0, colonIdx);
            jumpPort = parseInt(jumpHostPort.slice(colonIdx + 1), 10) || undefined;
        }

        // The hop is usually an alias defined in the same config: resolve its
        // HostName, User, Port and IdentityFile like ssh does.
        const computed = config.compute(jumpHostname, { ignoreCase: true });
        const resolvedPort = parseInt(firstValue(computed['port']) ?? '', 10);
        const identityFile = firstValue(computed['identityfile']);
        const identityAgent = firstValue(computed['identityagent']);
        const useAgent = !identityFile && !!identityAgent && identityAgent.toLowerCase() !== 'none';

        const jumpConfig: JumpHostConfig = {
            host: firstValue(computed['hostname']) || jumpHostname,
            port: jumpPort ?? (isNaN(resolvedPort) ? DEFAULT_PORTS.ssh : resolvedPort),
            username: jumpUser || firstValue(computed['user']) || defaultUser,
            // Without a key or agent, the jump host most likely relies on the
            // default ~/.ssh keys, which need to be selected in the form.
            authMethod: useAgent ? 'agent' : 'key',
        };
        if (identityFile) {
            jumpConfig.privateKeyPath = this._importKeyPath(identityFile, jumpHostname, result);
        } else if (useAgent) {
            jumpConfig.agent = identityAgent;
        }
        return jumpConfig;
    }

    private _importKeyPath(keyPath: string, hostAlias: string, result: ImportResult): string {
        const normalizedKey = normalizePrivateKeyPath(keyPath);
        if (isOutsideHome(normalizedKey)) {
            result.errors.push(
                vscode.l10n.t('SSH config host "{0}" references key outside home: {1}', hostAlias, normalizedKey)
            );
        }
        return normalizedKey;
    }

    private _describeIncludeWarning(warning: IncludeWarning): string {
        switch (warning.kind) {
            case 'notFound':
                return vscode.l10n.t('SSH config Include not found: {0}', warning.pattern);
            case 'notFile':
                return vscode.l10n.t('SSH config Include is not a regular file: {0}', warning.path);
            case 'cycle':
                return vscode.l10n.t('SSH config Include loop ignored: {0}', warning.path);
            case 'depth':
                return vscode.l10n.t('SSH config Include nested too deeply: {0}', warning.path);
            case 'tooManyFiles':
                return vscode.l10n.t('SSH config includes more than {0} files; the rest were ignored.', String(warning.limit));
            case 'tooLarge':
                return vscode.l10n.t('SSH config includes more than {0} bytes; the rest were ignored.', String(warning.limit));
            case 'readError':
                return vscode.l10n.t('Failed to read SSH config Include {0}: {1}', warning.path, warning.message);
        }
    }
}

/** Patterns of a Host line (the value is a list for `Host a b`). */
function hostPatterns(value: string | { val: string }[]): string[] {
    return (Array.isArray(value) ? value.map((entry) => entry.val) : [value])
        .flatMap((pattern) => pattern.split(/\s+/))
        .filter(Boolean);
}

/** First value of a computed option (repeatable options are lists). */
function firstValue(value: string | string[] | undefined): string | undefined {
    const first = Array.isArray(value) ? value[0] : value;
    return first ? String(first) : undefined;
}

/**
 * Remove directives that make `compute()` run local commands: `Match exec`
 * blocks (run through a shell) and `CanonicalizeHostName` (nslookup).
 * Returns how many were removed.
 */
function removeUnsafeDirectives(config: ReturnType<typeof SSHConfig.parse>): number {
    let removed = 0;
    for (let i = config.length - 1; i >= 0; i--) {
        const line = config[i];
        if (line.type !== SSHConfig.DIRECTIVE) {
            continue;
        }
        if ('criteria' in line && Object.keys(line.criteria).some((key) => /^exec$/i.test(key))) {
            config.splice(i, 1);
            removed++;
            continue;
        }
        if (/^CanonicalizeHostName$/i.test(line.param) && !/^no$/i.test(String(line.value))) {
            config.splice(i, 1);
            removed++;
            continue;
        }
        if ('config' in line) {
            removed += removeUnsafeDirectives(line.config);
        }
    }
    return removed;
}
