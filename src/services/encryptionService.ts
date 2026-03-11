import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConnectionStore, EncryptionMeta } from '../types/connection';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const DIGEST = 'sha512';

const STORE_KEY = 'remote-bridge.connectionStore';
const ENCRYPTED_STORE_KEY = 'remote-bridge.encryptedStore';
const ENCRYPTION_META_KEY = 'remote-bridge.encryptionMeta';
/** Local-only shadow of the encrypted store — never registered for Settings Sync. */
const LOCAL_ENCRYPTED_STORE_KEY = 'remote-bridge.localEncryptedStore';

/**
 * Manages encryption of the connection store with an optional master password.
 *
 * When master password is enabled:
 * - The connection store JSON is encrypted with AES-256-GCM
 * - The key is derived from the master password via PBKDF2
 * - Salt and verification hash are stored in globalState
 * - The master password itself is never persisted
 */
export class EncryptionService {
    private _derivedKey: Buffer | null = null;
    private _lastVerificationHash: string | null = null;

    private readonly _onDidLock = new vscode.EventEmitter<void>();
    readonly onDidLock = this._onDidLock.event;

    private readonly _onDidUnlock = new vscode.EventEmitter<void>();
    readonly onDidUnlock = this._onDidUnlock.event;

    private readonly _onDidDetectRemotePasswordChange = new vscode.EventEmitter<void>();
    readonly onDidDetectRemotePasswordChange = this._onDidDetectRemotePasswordChange.event;

    constructor(private readonly _globalState: vscode.Memento & { setKeysForSync(keys: string[]): void }) {}

    /**
     * Check if master password encryption is enabled.
     */
    isEnabled(): boolean {
        const meta = this._globalState.get<EncryptionMeta>(ENCRYPTION_META_KEY);
        return !!meta?.enabled;
    }

    /**
     * Check if the encryption service is currently unlocked.
     */
    isUnlocked(): boolean {
        return this._derivedKey !== null;
    }

    /**
     * Register (or deregister) the encrypted store keys for VS Code Settings Sync.
     * Sync is only meaningful when master password encryption is active — the plain
     * store key is intentionally never registered for sync.
     *
     * @param enabled true = register encrypted store + meta for sync; false = clear the list
     */
    setSyncEnabled(enabled: boolean): void {
        this._globalState.setKeysForSync(
            enabled ? [ENCRYPTED_STORE_KEY, ENCRYPTION_META_KEY] : []
        );
    }

    /**
     * Dispose event emitters and clear the derived key.
     */
    dispose(): void {
        this.lock();
        this._onDidLock.dispose();
        this._onDidUnlock.dispose();
        this._onDidDetectRemotePasswordChange.dispose();
    }

    /**
     * Set up a new master password. Encrypts existing store data.
     */
    async setupMasterPassword(masterPassword: string): Promise<void> {
        const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
        const key = await this._deriveKey(masterPassword, salt);

        // Create verification hash
        const verificationHash = crypto
            .createHash('sha256')
            .update(key)
            .digest('hex');

        const meta: EncryptionMeta = {
            enabled: true,
            salt,
            verificationHash,
        };

        // Encrypt existing store if any
        const existingStore = this._globalState.get<ConnectionStore>(STORE_KEY);
        if (existingStore) {
            const encrypted = this._encrypt(JSON.stringify(existingStore), key);
            await this._globalState.update(ENCRYPTED_STORE_KEY, encrypted);
            await this._globalState.update(STORE_KEY, undefined);
        }

        await this._globalState.update(ENCRYPTION_META_KEY, meta);
        this._derivedKey = key;
        this._lastVerificationHash = verificationHash;
    }

    /**
     * Unlock the store with the master password.
     * @returns true if the password is correct, false otherwise.
     */
    async unlock(masterPassword: string): Promise<boolean> {
        const meta = this._globalState.get<EncryptionMeta>(ENCRYPTION_META_KEY);
        if (!meta?.enabled) {
            return true;
        }

        const key = await this._deriveKey(masterPassword, meta.salt);
        const verificationHash = crypto
            .createHash('sha256')
            .update(key)
            .digest('hex');

        if (verificationHash !== meta.verificationHash) {
            return false;
        }

        this._derivedKey = key;
        this._lastVerificationHash = meta.verificationHash;
        this._onDidUnlock.fire();
        return true;
    }

    /**
     * Check whether the encryption meta has changed since we last unlocked —
     * i.e. another device changed the master password via Settings Sync.
     */
    hasPasswordChangedRemotely(): boolean {
        if (!this._lastVerificationHash) {
            return false;
        }
        const meta = this._globalState.get<EncryptionMeta>(ENCRYPTION_META_KEY);
        return !!meta && meta.verificationHash !== this._lastVerificationHash;
    }

    /**
     * Lock — clear the derived key from memory.
     */
    lock(): void {
        const wasUnlocked = this._derivedKey !== null;
        if (this._derivedKey) {
            this._derivedKey.fill(0);
            this._derivedKey = null;
        }
        if (wasUnlocked) {
            this._onDidLock.fire();
        }
    }

    /**
     * Change the master password. Decrypts with the old password and re-encrypts
     * with a new salt and new derived key derived from the new password.
     * Returns false if the old password is incorrect.
     */
    async changeMasterPassword(oldPassword: string, newPassword: string): Promise<boolean> {
        if (!this.isEnabled()) {
            return false;
        }

        // Verify old password
        const meta = this._globalState.get<EncryptionMeta>(ENCRYPTION_META_KEY);
        if (!meta?.enabled) {
            return false;
        }

        const oldKey = await this._deriveKey(oldPassword, meta.salt);
        const oldHash = crypto.createHash('sha256').update(oldKey).digest('hex');
        if (oldHash !== meta.verificationHash) {
            oldKey.fill(0);
            return false;
        }

        // Decrypt current store with old key
        const encrypted = this._globalState.get<string>(ENCRYPTED_STORE_KEY);
        let storeJson: string | null = null;
        if (encrypted) {
            try {
                storeJson = this._decrypt(encrypted, oldKey);
            } catch {
                oldKey.fill(0);
                return false;
            }
        }
        oldKey.fill(0);

        // Derive new key with a fresh salt
        const newSalt = crypto.randomBytes(SALT_LENGTH).toString('hex');
        const newKey = await this._deriveKey(newPassword, newSalt);
        const newVerificationHash = crypto.createHash('sha256').update(newKey).digest('hex');

        const newMeta: EncryptionMeta = {
            enabled: true,
            salt: newSalt,
            verificationHash: newVerificationHash,
        };

        // Re-encrypt store with new key
        if (storeJson !== null) {
            const reEncrypted = this._encrypt(storeJson, newKey);
            await this._globalState.update(ENCRYPTED_STORE_KEY, reEncrypted);
            await this._globalState.update(LOCAL_ENCRYPTED_STORE_KEY, reEncrypted);
        }

        await this._globalState.update(ENCRYPTION_META_KEY, newMeta);

        // Swap in new derived key
        if (this._derivedKey) {
            this._derivedKey.fill(0);
        }
        this._derivedKey = newKey;
        this._lastVerificationHash = newVerificationHash;

        return true;
    }

    /**
     * Remove master password. Decrypts and stores data in plain.
     */
    async removeMasterPassword(): Promise<void> {
        if (!this.isEnabled() || !this._derivedKey) {
            return;
        }

        const store = await this.loadStore();
        this.lock();

        await this._globalState.update(ENCRYPTION_META_KEY, undefined);
        await this._globalState.update(ENCRYPTED_STORE_KEY, undefined);
        await this._globalState.update(LOCAL_ENCRYPTED_STORE_KEY, undefined);

        if (store) {
            await this._globalState.update(STORE_KEY, store);
        }
    }

    /**
     * Load the connection store (decrypting if necessary).
     */
    async loadStore(): Promise<ConnectionStore | null> {
        if (this.isEnabled()) {
            if (!this._derivedKey) {
                return null; // locked
            }
            const encrypted = this._globalState.get<string>(ENCRYPTED_STORE_KEY);
            if (!encrypted) {
                return null;
            }
            try {
                const json = this._decrypt(encrypted, this._derivedKey);
                return JSON.parse(json) as ConnectionStore;
            } catch {
                // Detect if decryption failed because remote sync changed the password
                if (this._lastVerificationHash) {
                    const currentMeta = this._globalState.get<EncryptionMeta>(ENCRYPTION_META_KEY);
                    if (currentMeta && currentMeta.verificationHash !== this._lastVerificationHash) {
                        this._lastVerificationHash = null; // prevent repeated fires
                        this.lock();
                        this._onDidDetectRemotePasswordChange.fire();
                    }
                }
                return null;
            }
        } else {
            return this._globalState.get<ConnectionStore>(STORE_KEY) ?? null;
        }
    }

    /**
     * Save the connection store (encrypting if necessary).
     * When encryption is active the ciphertext is written to both the synced
     * key and the local-only shadow key so that a fallback copy is always
     * available on this device even if sync delivers incompatible data.
     */
    async saveStore(store: ConnectionStore): Promise<void> {
        if (this.isEnabled()) {
            if (!this._derivedKey) {
                throw new Error('Store is locked');
            }
            const encrypted = this._encrypt(JSON.stringify(store), this._derivedKey);
            await this._globalState.update(ENCRYPTED_STORE_KEY, encrypted);
            await this._globalState.update(LOCAL_ENCRYPTED_STORE_KEY, encrypted);
        } else {
            await this._globalState.update(STORE_KEY, store);
        }
    }

    /**
     * Return the current encrypted blob from globalState.
     * Used by BackupService to copy already-encrypted data to backup files.
     */
    getEncryptedBlob(): string | undefined {
        return this._globalState.get<string>(ENCRYPTED_STORE_KEY);
    }

    /**
     * Load the local shadow copy of the connection store.
     *
     * The shadow is written by `saveStore()` in parallel with the synced key,
     * but is never registered for Settings Sync.  It therefore always reflects
     * the last state saved on *this* device and is used as a merge baseline
     * when sync delivers data from another device.
     *
     * Returns `null` if there is no shadow, encryption is disabled, the store
     * is currently locked, or decryption fails.
     */
    async loadLocalStore(): Promise<ConnectionStore | null> {
        if (!this.isEnabled() || !this._derivedKey) {
            return null;
        }
        const encrypted = this._globalState.get<string>(LOCAL_ENCRYPTED_STORE_KEY);
        if (!encrypted) {
            return null;
        }
        try {
            const json = this._decrypt(encrypted, this._derivedKey);
            return JSON.parse(json) as ConnectionStore;
        } catch {
            return null;
        }
    }

    /**
     * Return the current encryption metadata.
     */
    getMeta(): EncryptionMeta | undefined {
        return this._globalState.get<EncryptionMeta>(ENCRYPTION_META_KEY);
    }

    /**
     * Try to decrypt backup data using the currently derived key.
     * Returns null if the key doesn't match the backup's verificationHash.
     */
    async tryDecryptWith(
        encryptedData: string,
        backupMeta: EncryptionMeta
    ): Promise<ConnectionStore | null> {
        if (!this._derivedKey) { return null; }
        const currentHash = crypto
            .createHash('sha256')
            .update(this._derivedKey)
            .digest('hex');
        if (currentHash !== backupMeta.verificationHash) {
            return null;
        }
        try {
            const json = this._decrypt(encryptedData, this._derivedKey);
            return JSON.parse(json) as ConnectionStore;
        } catch {
            return null;
        }
    }

    /**
     * Decrypt backup data with an explicit password.
     * Used when a backup was created with a different (older) master password.
     */
    async decryptWithPassword(
        encryptedData: string,
        backupMeta: EncryptionMeta,
        password: string
    ): Promise<ConnectionStore | null> {
        const key = await this._deriveKey(password, backupMeta.salt);
        const hash = crypto.createHash('sha256').update(key).digest('hex');
        if (hash !== backupMeta.verificationHash) {
            key.fill(0);
            return null;
        }
        try {
            const json = this._decrypt(encryptedData, key);
            key.fill(0);
            return JSON.parse(json) as ConnectionStore;
        } catch {
            key.fill(0);
            return null;
        }
    }

    // ─── Private Helpers ────────────────────────────────────────────

    private _deriveKey(password: string, salt: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            crypto.pbkdf2(
                password,
                Buffer.from(salt, 'hex'),
                PBKDF2_ITERATIONS,
                KEY_LENGTH,
                DIGEST,
                (err, key) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(key);
                    }
                }
            );
        });
    }

    private _encrypt(plaintext: string, key: Buffer): string {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH,
        });
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();

        // Format: iv(hex):authTag(hex):ciphertext(hex)
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
    }

    private _decrypt(data: string, key: Buffer): string {
        const parts = data.split(':');
        if (parts.length !== 3) {
            throw new Error('Invalid encrypted data format');
        }

        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const ciphertext = Buffer.from(parts[2], 'hex');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
            authTagLength: AUTH_TAG_LENGTH,
        });
        decipher.setAuthTag(authTag);

        return decipher.update(ciphertext) + decipher.final('utf8');
    }

}

