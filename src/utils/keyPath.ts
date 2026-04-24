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
    let p = input.trim();
    // Strip matched single or double quotes
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
        p = p.slice(1, -1);
    }
    if (p.startsWith('~/') || p === '~') {
        p = path.join(os.homedir(), p.slice(1));
    } else if (p.startsWith('~\\')) {
        p = path.join(os.homedir(), p.slice(2));
    }
    return path.normalize(p);
}

/**
 * Returns true when `keyPath` resolves to a location outside the user's home
 * directory. Importers should warn (not block) when this is true so users can
 * spot suspicious key references coming from imported configs.
 */
export function isOutsideHome(keyPath: string): boolean {
    if (!keyPath) { return false; }
    const home = path.normalize(os.homedir());
    const normalized = path.normalize(keyPath);
    return !normalized.toLowerCase().startsWith(home.toLowerCase() + path.sep)
        && normalized.toLowerCase() !== home.toLowerCase();
}
