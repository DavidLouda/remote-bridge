/**
 * Deobfuscates Total Commander FTP plugin passwords.
 *
 * Total Commander stores FTP passwords with a simple XOR cipher — the official
 * documentation explicitly notes that this is NOT encryption ("it's impossible
 * by principle to store a password in an unrecoverable way in an unattended
 * client"), so no master‑password or Blowfish step is needed.
 *
 * Algorithm (reverse‑engineered from the TC source and community docs):
 *   1. Decode Base64 → bytes
 *   2. XOR each byte with the repeating key derived from the characters of
 *      `username@hostname` (cycling through the key bytes).
 *
 * Returns an empty string when the input is empty or cannot be decoded.
 */
export function deobfuscateTotalCmdPassword(
    obfuscated: string,
    username: string,
    hostname: string
): string {
    if (!obfuscated) {
        return '';
    }

    try {
        const key = `${username}@${hostname}`;
        const data = Buffer.from(obfuscated, 'base64');
        const result = Buffer.allocUnsafe(data.length);

        for (let i = 0; i < data.length; i++) {
            result[i] = data[i] ^ key.charCodeAt(i % key.length);
        }

        return result.toString('utf8');
    } catch {
        return '';
    }
}
