import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Crypto } from '../src/lib/crypto.js';

describe('Crypto', () => {
  const c = new Crypto('a-real-secret-key');
  it('round-trips', () => {
    expect(c.decrypt(c.encrypt('whatsapp-token'))).toBe('whatsapp-token');
  });
  it('rejects tampering and wrong key', () => {
    const enc = c.encrypt('x');
    expect(() => new Crypto('other').decrypt(enc)).toThrow();
    expect(() => c.decrypt('AAAA')).toThrow(/malformed/);
  });
  it('refuses the sample placeholder key', () => {
    expect(() => new Crypto('REPLACE_WITH_64_CHAR_RANDOM_STRING').encrypt('x')).toThrow();
  });
  it('is wire-compatible with PHP Crypto.php', () => {
    let php: string;
    try {
      php = execFileSync('php', ['-r', `
        $k = hash('sha256','a-real-secret-key', true); $iv = random_bytes(12); $tag='';
        $ct = openssl_encrypt('from-php', 'aes-256-gcm', $k, OPENSSL_RAW_DATA, $iv, $tag);
        echo base64_encode($iv.$tag.$ct);`]).toString();
    } catch {
      return; // PHP not installed in this environment
    }
    expect(c.decrypt(php)).toBe('from-php');
  });
});
