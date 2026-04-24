import * as vscode from 'vscode';
import { EncryptionMeta } from '../types/connection';

/**
 * A single backup file written to globalStorageUri/backups/.
 *
 * `data` is the AES-256-GCM encrypted connection store blob (same format as
 * the main encrypted store) — i.e. BackupService never sees plaintext.
 * `meta` carries the salt and verificationHash needed to decrypt `data`.
 */
export interface BackupFile {
    /** Schema version for future migrations */
    version: number;
    /** ISO 8601 timestamp of when the backup was created */
    created: string;
    /** EncryptionMeta at the time of backup (may differ from current if password changed) */
    meta: EncryptionMeta;
    /** Encrypted store blob: iv(hex):authTag(hex):ciphertext(hex) */
    data: string;
}

export interface BackupEntry {
    /** Human-readable label, e.g. "Daily — 2026-03-09" */
    label: string;
    /** "daily" or "weekly" */
    detail: string;
    /** File URI */
    uri: vscode.Uri;
    /** YYYY-MM-DD */
    date: string;
}

/**
 * Manages daily/weekly encrypted backups of the connection store.
 *
 * Retention policy:
 *   - 7 most recent daily  backups (one per calendar day)
 *   - 4 most recent weekly backups (promoted from daily every Monday)
 *
 * BackupService works exclusively with already-encrypted blobs — it never
 * has access to the derived key or plaintext store data.
 */
export class BackupService {
    private _lastBackupDate: string | null = null;
    /**
     * Serialize backup writes so a fire-and-forget call from
     * ConnectionManager.save() cannot interleave with a manual createBackup
     * (or two daily writes that race past the date check).
     */
    private _writeChain: Promise<void> = Promise.resolve();

    constructor(private readonly _storageUri: vscode.Uri) {}

    /**
     * Atomically write a JSON backup: write to a temp file in the same
     * directory, then rename over the destination. Prevents truncated /
     * partially-written backups if the host crashes mid-write.
     */
    private async _atomicWriteJson(dir: vscode.Uri, filename: string, content: Uint8Array): Promise<void> {
        const tmpName = `.${filename}.tmp-${process.pid}-${Date.now()}`;
        const tmpUri = vscode.Uri.joinPath(dir, tmpName);
        const finalUri = vscode.Uri.joinPath(dir, filename);
        await vscode.workspace.fs.writeFile(tmpUri, content);
        try {
            await vscode.workspace.fs.rename(tmpUri, finalUri, { overwrite: true });
        } catch (err) {
            // Best-effort cleanup: remove the temp file if rename failed.
            try { await vscode.workspace.fs.delete(tmpUri); } catch { /* ignore */ }
            throw err;
        }
    }

    /** Run `task` after the previous backup write completes (success or failure). */
    private _enqueue(task: () => Promise<void>): Promise<void> {
        const next = this._writeChain.then(task, task);
        this._writeChain = next.catch(() => { /* swallow so future tasks still run */ });
        return next;
    }

    /**
     * Wait for any in-flight backup writes to finish. Safe to call from
     * `deactivate()` — never rejects because `_writeChain` already swallows
     * errors. Pair with a timeout in the caller to bound shutdown latency.
     */
    flush(): Promise<void> {
        return this._writeChain;
    }

    /**
     * Write a daily backup if none exists for today yet.
     * Called fire-and-forget from ConnectionManager.save() — must not throw.
     *
     * @param encryptedData  The encrypted blob that was just written to globalState.
     * @param meta           The EncryptionMeta corresponding to that blob.
     */
    async createBackupIfNeeded(
        encryptedData: string,
        meta: EncryptionMeta
    ): Promise<void> {
        return this._enqueue(async () => {
            const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
            if (this._lastBackupDate === today) {
                return;
            }

            const backupDir = vscode.Uri.joinPath(this._storageUri, 'backups');
            await vscode.workspace.fs.createDirectory(backupDir);

            const backup: BackupFile = {
                version: 1,
                created: new Date().toISOString(),
                meta,
                data: encryptedData,
            };

            await this._atomicWriteJson(
                backupDir,
                `daily-${today}.json`,
                Buffer.from(JSON.stringify(backup), 'utf8')
            );
            this._lastBackupDate = today;

            await this._promoteWeekly(backupDir, today);
            await this._pruneOldBackups(backupDir);
        });
    }

    /**
     * List available backups, sorted newest-first.
     */
    async listBackups(): Promise<BackupEntry[]> {
        const backupDir = vscode.Uri.joinPath(this._storageUri, 'backups');
        try {
            const entries = await vscode.workspace.fs.readDirectory(backupDir);
            const backups: BackupEntry[] = [];

            for (const [name, type] of entries) {
                if (type !== vscode.FileType.File || !name.endsWith('.json')) {
                    continue;
                }

                // daily / weekly: daily-2026-03-10.json
                const autoMatch = name.match(/^(daily|weekly)-(\d{4}-\d{2}-\d{2})\.json$/);
                if (autoMatch) {
                    const [, kind, date] = autoMatch;
                    backups.push({
                        label: kind === 'weekly' ? `Weekly — ${date}` : `Daily — ${date}`,
                        detail: kind === 'weekly' ? 'weekly' : 'daily',
                        uri: vscode.Uri.joinPath(backupDir, name),
                        date,
                    });
                    continue;
                }

                // manual: manual-2026-03-10T14-30-00.json
                const manualMatch = name.match(/^manual-(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})\.json$/);
                if (manualMatch) {
                    const [, date, time] = manualMatch;
                    const timeFormatted = time.replace(/-/g, ':');
                    backups.push({
                        label: `Manual — ${date} ${timeFormatted}`,
                        detail: 'manual',
                        uri: vscode.Uri.joinPath(backupDir, name),
                        date: `${date}T${time}`, // keeps sort order correct
                    });
                }
            }

            return backups.sort((a, b) => b.date.localeCompare(a.date));
        } catch {
            return [];
        }
    }

    /**
     * Read and parse a backup file.
     */
    async readBackup(uri: vscode.Uri): Promise<BackupFile> {
        const raw = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(Buffer.from(raw).toString('utf8')) as BackupFile;
    }

    /**
     * Write a manual backup immediately, regardless of the daily guard.
     * Manual backups use a timestamp-based filename so multiple can be
     * created on the same day. Keeps the 5 most recent manual backups.
     *
     * @param encryptedData  The encrypted blob from globalState.
     * @param meta           The EncryptionMeta corresponding to that blob.
     */
    async createManualBackup(
        encryptedData: string,
        meta: EncryptionMeta
    ): Promise<void> {
        const now = new Date();
        // Build a filesystem-safe timestamp: 2026-03-10T14-30-00
        const timestamp = now.toISOString().slice(0, 19).replace(/:/g, '-');

        const backupDir = vscode.Uri.joinPath(this._storageUri, 'backups');
        await vscode.workspace.fs.createDirectory(backupDir);

        const backup: BackupFile = {
            version: 1,
            created: now.toISOString(),
            meta,
            data: encryptedData,
        };

        await this._enqueue(async () => {
            await this._atomicWriteJson(
                backupDir,
                `manual-${timestamp}.json`,
                Buffer.from(JSON.stringify(backup), 'utf8')
            );
            await this._pruneOldBackups(backupDir);
        });
    }

    // ─── Private Helpers ────────────────────────────────────────────

    /** On Mondays, copy today's daily backup to a weekly backup file. */
    private async _promoteWeekly(dir: vscode.Uri, today: string): Promise<void> {
        // getDay() returns 1 for Monday
        if (new Date(today).getDay() !== 1) { return; }

        const src = vscode.Uri.joinPath(dir, `daily-${today}.json`);
        const dst = vscode.Uri.joinPath(dir, `weekly-${today}.json`);
        try {
            await vscode.workspace.fs.copy(src, dst, { overwrite: true });
        } catch {
            // ignore — best-effort
        }
    }

    /** Keep only 7 daily and 4 weekly backups. Delete the rest. */
    private async _pruneOldBackups(dir: vscode.Uri): Promise<void> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(dir);
            const daily: string[] = [];
            const weekly: string[] = [];
            const manual: string[] = [];

            for (const [name, type] of entries) {
                if (type !== vscode.FileType.File) { continue; }
                if (name.startsWith('daily-')) { daily.push(name); }
                else if (name.startsWith('weekly-')) { weekly.push(name); }
                else if (name.startsWith('manual-')) { manual.push(name); }
            }

            daily.sort().reverse();
            for (const name of daily.slice(7)) {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
            }

            weekly.sort().reverse();
            for (const name of weekly.slice(4)) {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
            }

            manual.sort().reverse();
            for (const name of manual.slice(5)) {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
            }
        } catch {
            // pruning is best-effort
        }
    }
}
