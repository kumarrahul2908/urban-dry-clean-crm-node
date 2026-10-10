import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password.js';

describe('password', () => {
  it('treats PHP $2y$ and bcryptjs $2a$ hashes as equivalent', async () => {
    const own = await hashPassword('secret123');
    const asPhp = own.replace('$2a$', '$2y$');
    expect(await verifyPassword('secret123', own)).toBe(true);
    expect(await verifyPassword('secret123', asPhp)).toBe(true);
    expect(await verifyPassword('wrong', asPhp)).toBe(false);
  });
});
