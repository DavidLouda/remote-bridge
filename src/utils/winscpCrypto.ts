/**
 * WinSCP password decryption utilities.
 *
 * WinSCP uses a simple XOR-based obfuscation when no master password is set.
 * When a master password is set, AES-256-CBC encryption is used.
 *
 * Reference: https://winscp.net/eng/docs/security_credentials
 */

import * as crypto from 'crypto';

const PW_MAGIC = 0xa3;
const PW_FLAG = 0xff;

/**
 * Decrypt a WinSCP password that was stored WITHOUT a master password.
 * Uses the simple XOR obfuscation scheme.
 *
 * @param hostname - The hostname from the same WinSCP session
 * @param username - The username from the same WinSCP session
 * @param encryptedPassword - The hex-encoded encrypted password string
 * @returns The decrypted password
 */
export function decryptWinSCPPassword(
    hostname: string,
    username: string,
    encryptedPassword: string
): string {
    const nibbles: number[] = [];
    for (const ch of encryptedPassword) {
        nibbles.push(parseInt(ch, 16));
    }

    let pos = 0;

    function decNextChar(): number {
        if (pos + 1 >= nibbles.length) {
            return 0;
        }
        const a = nibbles[pos++];
        const b = nibbles[pos++];
        return ~(((a << 4) + b) ^ PW_MAGIC) & 0xff;
    }

    const flag = decNextChar();
    let length: number;

    if (flag === PW_FLAG) {
        /* skip one char */ decNextChar();
        length = decNextChar();
    } else {
        length = flag;
    }

    const toBeDeleted = decNextChar();
    pos += toBeDeleted * 2;

    let clearPass = '';
    for (let i = 0; i < length; i++) {
        clearPass += String.fromCharCode(decNextChar());
    }

    if (flag === PW_FLAG) {
        const key = username + hostname;
        if (clearPass.startsWith(key)) {
            clearPass = clearPass.substring(key.length);
        }
    }

    return clearPass;
}

/**
 * Decrypt a WinSCP password that was stored WITH a master password (AES-256-CBC).
 *
 * WinSCP with master password uses:
 * - Key derivation: The master password + salt → 256-bit AES key
 * - Algorithm: AES-256-CBC
 * - The encrypted blob contains the IV + ciphertext
 *
 * @param masterPassword - The WinSCP master password
 * @param encryptedBlob - The base64 or hex encoded encrypted data
 * @returns The decrypted password, or null if decryption failed
 */
export function decryptWinSCPPasswordWithMaster(
    masterPassword: string,
    encryptedBlob: string
): string | null {
    try {
        // WinSCP master password encryption:
        // The blob is hex-encoded: first 16 bytes = IV, rest = AES-256-CBC ciphertext
        // Key = SHA-256(master_password)
        //
        // NOTE: WinSCP uses a single SHA-256 pass (not PBKDF2/scrypt) for key
        // derivation.  This matches WinSCP’s own implementation but is weaker
        // than modern KDFs against brute-force attacks.  We replicate this
        // behaviour intentionally for import compatibility.
        const data = Buffer.from(encryptedBlob, 'hex');
        if (data.length < 32) {
            return null;
        }

        const iv = data.subarray(0, 16);
        const ciphertext = data.subarray(16);
        const key = crypto.createHash('sha256').update(masterPassword, 'utf8').digest();

        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString('utf8');
    } catch {
        return null;
    }
}

/**
 * Check whether a WinSCP configuration uses a master password.
 * This is indicated by the MasterPasswordVerifier key in [Configuration\Security].
 */
export function hasMasterPassword(configSections: Record<string, Record<string, string>>): boolean {
    const security = configSections['Configuration\\Security'] || configSections['Configuration/Security'];
    if (!security) {
        return false;
    }
    return !!security['MasterPasswordVerifier'];
}

/**
 * Map WinSCP FSProtocol number to our ConnectionProtocol.
 * 0 = SCP → ssh, 5 = SFTP → sftp, 2 = FTP → ftp, 8 = WebDAV → unsupported
 */
export type WinSCPProtocolMapping = 'ssh' | 'sftp' | 'ftp' | 'ftps' | null;

export function mapWinSCPProtocol(fsProtocol: number, ftps?: number): WinSCPProtocolMapping {
    switch (fsProtocol) {
        case 0: // SCP
            return 'ssh';
        case 5: // SFTP
            return 'sftp';
        case 2: // FTP
            return ftps === 1 || ftps === 2 ? 'ftps' : 'ftp';
        default:
            return null; // WebDAV, S3, etc. — not supported
    }
}
