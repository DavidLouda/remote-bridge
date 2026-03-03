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
    private _masterPasswordTimeout: ReturnType<typeof setTimeout> | null = null;

    private readonly _onDidLock = new vscode.EventEmitter<void>();
    readonly onDidLock = this._onDidLock.event;

    constructor(private readonly _globalState: vscode.Memento) {}

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
        this._startTimeout();
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
        this._startTimeout();
        return true;
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
        if (this._masterPasswordTimeout) {
            clearTimeout(this._masterPasswordTimeout);
            this._masterPasswordTimeout = null;
        }
        if (wasUnlocked) {
            this._onDidLock.fire();
        }
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
                return null;
            }
        } else {
            return this._globalState.get<ConnectionStore>(STORE_KEY) ?? null;
        }
    }

    /**
     * Save the connection store (encrypting if necessary).
     */
    async saveStore(store: ConnectionStore): Promise<void> {
        if (this.isEnabled()) {
            if (!this._derivedKey) {
                throw new Error('Store is locked');
            }
            const encrypted = this._encrypt(JSON.stringify(store), this._derivedKey);
            await this._globalState.update(ENCRYPTED_STORE_KEY, encrypted);
        } else {
            await this._globalState.update(STORE_KEY, store);
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

    private _startTimeout(): void {
        if (this._masterPasswordTimeout) {
            clearTimeout(this._masterPasswordTimeout);
        }

        const config = vscode.workspace.getConfiguration('remoteBridge.security');
        const timeoutMinutes = config.get<number>('masterPasswordTimeout', 30);
        const timeoutMs = timeoutMinutes * 60 * 1000;

        this._masterPasswordTimeout = setTimeout(() => {
            this.lock();
        }, timeoutMs);
    }

    dispose(): void {
        this.lock();
        this._onDidLock.dispose();
    }
}
