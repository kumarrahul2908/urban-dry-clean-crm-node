import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Port of includes/Crypto.php. Wire-compatible: AES-256-GCM, key = SHA-256(APP_SECRET_KEY),
 * output = base64(iv[12] | tag[16] | ciphertext) so values encrypted by the PHP app decrypt here
 * and vice versa.
 */
const PLACEHOLDER = 'REPLACE_WITH_64_CHAR_RANDOM_STRING';

export class Crypto {
  constructor(private readonly secret: string) {}

  isConfigured(): boolean {
    return this.secret !== '' && this.secret !== PLACEHOLDER;
  }

  private key(): Buffer {
    if (!this.isConfigured()) {
      throw new Error('APP_SECRET_KEY is not configured — cannot encrypt or decrypt secrets.');
    }
    return createHash('sha256').update(this.secret).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(encoded: string): string {
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length < 28) throw new Error('Stored secret is malformed or corrupted.');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    try {
      const d = createDecipheriv('aes-256-gcm', this.key(), iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch {
      throw new Error('Could not decrypt stored secret — it may be corrupted or APP_SECRET_KEY may have changed.');
    }
  }
}
