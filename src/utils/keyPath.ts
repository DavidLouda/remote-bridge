import * as path from 'path';
import * as os from 'os';

/**
 * Normalize a private-key path coming from a third-party importer (PuTTY,
 * OpenSSH config, etc.).
 *
 * - Strips surrounding quotes (PuTTY/SSH config sometimes include them).
 * - Expands a leading `~` or `~/` to the user's home directory.
 * - Returns an absolute, normalized path ready to be stored in `ConnectionConfig`.
 *
 * Returns the input unchanged when it's empty.
 */
export function normalizePrivateKeyPath(input: string): string {
    if (!input) {
        return input;
    }
    return path.normalize(expandTilde(stripQuotes(input.trim())));
}

/** Strip one pair of matching surrounding single or double quotes. */
function stripQuotes(value: string): string {
    if (value.length >= 2
        && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        return value.slice(1, -1);
    }
    return value;
}

/** Expand a leading `~`, `~/` or `~\` to the user's home directory. */
function expandTilde(value: string): string {
    if (value === '~' || value.startsWith('~/')) {
        return path.join(os.homedir(), value.slice(1));
    }
    if (value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_()]*)%/g;

/**
 * Expand `$VAR` and `${VAR}` references (and `%VAR%` on Windows) from the
 * environment. References to unset or empty variables are left untouched so
 * literal `$` characters in existing paths keep working.
 */
export function expandEnvVars(
    value: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): string {
    return value.replace(ENV_VAR_PATTERN, (match, braced?: string, bare?: string, percent?: string) => {
        if (percent !== undefined && platform !== 'win32') {
            return match;
        }
        const resolved = env[braced ?? bare ?? percent ?? ''];
        return resolved ? resolved : match;
    });
}

/** True when `value` still contains a `$VAR`/`${VAR}` (or `%VAR%` on Windows) reference. */
function hasEnvVarReference(value: string, platform: NodeJS.Platform): boolean {
    for (const match of value.matchAll(ENV_VAR_PATTERN)) {
        if (match[3] === undefined || platform === 'win32') {
            return true;
        }
    }
    return false;
}

/**
 * Expand a user-entered local path at connect time: strips surrounding quotes,
 * expands environment variables (see {@link expandEnvVars}) and a leading `~`.
 * Stored connection settings keep the original template.
 */
export function expandUserPath(
    input: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): string {
    return expandTilde(expandEnvVars(stripQuotes(input.trim()), env, platform));
}

/** Default agent pipe of the Windows OpenSSH agent service. */
const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/**
 * Resolve a connection's SSH agent setting to the value ssh2 expects.
 *
 * - `pageant` (any case) is passed through for PuTTY's Pageant on Windows.
 * - `SSH_AUTH_SOCK` (OpenSSH `IdentityAgent` syntax), `$SSH_AUTH_SOCK` and an
 *   empty value use the `SSH_AUTH_SOCK` environment variable, falling back to
 *   the Windows OpenSSH agent pipe on Windows.
 * - Anything else is expanded with {@link expandUserPath}.
 *
 * Returns `undefined` when no agent can be located, e.g. the setting refers
 * to an environment variable that is not set.
 */
export function resolveAgentPath(
    value: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): string | undefined {
    const raw = stripQuotes((value ?? '').trim());
    if (/^pageant$/i.test(raw)) {
        return 'pageant';
    }
    if (raw && !/^(\$\{?SSH_AUTH_SOCK\}?|SSH_AUTH_SOCK)$/.test(raw)) {
        const expanded = expandUserPath(raw, env, platform);
        return hasEnvVarReference(expanded, platform) ? undefined : expanded;
    }
    if (env.SSH_AUTH_SOCK) {
        return env.SSH_AUTH_SOCK;
    }
    return platform === 'win32' ? WINDOWS_OPENSSH_AGENT_PIPE : undefined;
}

/**
 * Returns true when `keyPath` resolves to a location outside the user's home
 * directory. Importers should warn (not block) when this is true so users can
 * spot suspicious key references coming from imported configs.
 */
export function isOutsideHome(keyPath: string): boolean {
    if (!keyPath) { return false; }
    const home = path.normalize(os.homedir());
    const normalized = path.normalize(expandUserPath(keyPath));
    return !normalized.toLowerCase().startsWith(home.toLowerCase() + path.sep)
        && normalized.toLowerCase() !== home.toLowerCase();
}
