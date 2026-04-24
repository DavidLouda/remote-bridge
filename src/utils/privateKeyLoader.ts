import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Maximum size in bytes that we accept for an SSH private key file.
 * RSA-8192 keys hover around 12 KB and PuTTY's PPK adds a small wrapper —
 * 1 MB is comfortably above any realistic key while still preventing a
 * misconfigured path from streaming a multi-gigabyte file into memory.
 */
const MAX_PRIVATE_KEY_BYTES = 1 * 1024 * 1024;

/**
 * Read a private key file synchronously with a hard size cap.
 *
 * @param keyPath Absolute path to the key file (already tilde-expanded).
 * @throws A localized error if the file is missing, unreadable, or oversized.
 */
export function readPrivateKeySync(keyPath: string): Buffer {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(keyPath);
    } catch {
        throw new Error(
            vscode.l10n.t('Failed to read private key: {0}', keyPath)
        );
    }

    if (stat.size > MAX_PRIVATE_KEY_BYTES) {
        throw new Error(
            vscode.l10n.t(
                'Private key file is too large ({0} bytes, max {1}): {2}',
                String(stat.size),
                String(MAX_PRIVATE_KEY_BYTES),
                keyPath
            )
        );
    }

    try {
        return fs.readFileSync(keyPath);
    } catch {
        throw new Error(
            vscode.l10n.t('Failed to read private key: {0}', keyPath)
        );
    }
}
