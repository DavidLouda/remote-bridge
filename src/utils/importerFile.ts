import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Default cap for any importer source file. Imports happen on the extension
 * host so a hostile or fuzzed config (e.g. a 1 GB INI / XML) must never
 * exhaust memory just because the user pointed the importer at it.
 */
export const DEFAULT_IMPORT_FILE_LIMIT = 10 * 1024 * 1024; // 10 MB

/**
 * Read a config file synchronously while enforcing a size cap.
 *
 * Throws a localized Error if the file is missing, unreadable, or exceeds
 * `maxBytes`. The error message is safe to surface to importer UIs (it does
 * not include file content).
 */
export function readImportFileSync(filePath: string, maxBytes: number = DEFAULT_IMPORT_FILE_LIMIT): string {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        throw new Error(vscode.l10n.t('Failed to read import file: {0}', filePath));
    }
    if (stat.size > maxBytes) {
        throw new Error(
            vscode.l10n.t('Import file too large: {0} bytes (max {1})', String(stat.size), String(maxBytes))
        );
    }
    return fs.readFileSync(filePath, 'utf-8');
}
