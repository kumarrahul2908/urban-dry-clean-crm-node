import { describe, expect, it } from 'vitest';
import { AuthService, type UserRow } from '../src/auth/authService.js';
import { LoginRateLimiter } from '../src/auth/loginRateLimiter.js';
import { hashPassword } from '../src/lib/password.js';
import { fakeDb } from './helpers.js';

const baseUser = async (over: Partial<UserRow> = {}): Promise<UserRow> => ({
  id: 7, username: 'rahul', email: 'r@x.in', full_name: 'Rahul', password_hash: await hashPassword('pw'),
  role_id: 2, role_name: 'Admin', store_id: null, is_active: 1, failed_login_count: 0, locked_until: null, ...over,
});

function setup(user: UserRow | null, blockedSeconds: number | null = null) {
  const { db, calls } = fakeDb([
    [/FROM login_ip_attempts/, () => (blockedSeconds === null ? [] : [{ s: blockedSeconds }])],
    [/FROM users u JOIN roles/, () => (user ? [user] : [])],
  ]);
  const svc = new AuthService(db, new LoginRateLimiter(db, 15, () => {}), { maxLoginAttempts: 3, lockoutMinutes: 15 });
  return { svc, calls };
}

describe('AuthService.verifyCredentials', () => {
  it('succeeds and resets counters', async () => {
    const { svc, calls } = setup(await baseUser());
    const r = await svc.verifyCredentials('rahul', 'pw', '1.2.3.4');
    expect(r.success).toBe(true);
    expect(calls.some((c) => /failed_login_count = 0/.test(c.sql))).toBe(true);
  });
  it('unknown user records IP failure', async () => {
    const { svc, calls } = setup(null);
    const r = await svc.verifyCredentials('nobody', 'pw', '1.2.3.4');
    expect(r).toMatchObject({ success: false, message: 'Invalid username or password.' });
    expect(calls.some((c) => /INSERT INTO login_ip_attempts/.test(c.sql))).toBe(true);
  });
  it('wrong password increments and locks at threshold', async () => {
    const { svc, calls } = setup(await baseUser({ failed_login_count: 2 }));
    const r = await svc.verifyCredentials('rahul', 'bad', '1.2.3.4');
    expect(r.success).toBe(false);
    const upd = calls.find((c) => /UPDATE users SET failed_login_count = \?/.test(c.sql))!;
    expect(upd.params[0]).toBe(3);
    expect(upd.sql).toMatch(/locked_until = NOW\(\) \+ INTERVAL 15 MINUTE/);
  });
  it('rejects locked account', async () => {
    const future = new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace('T', ' ');
    const { svc } = setup(await baseUser({ locked_until: future }));
    const r = await svc.verifyCredentials('rahul', 'pw', null);
    expect(r.message).toMatch(/^Account locked\. Try again in [56] minute/);
  });
  it('rejects inactive account', async () => {
    const { svc } = setup(await baseUser({ is_active: 0 }));
    expect((await svc.verifyCredentials('rahul', 'pw', null)).message).toMatch(/deactivated/);
  });
  it('rejects blocked IP before any user lookup', async () => {
    const { svc, calls } = setup(await baseUser(), 600);
    const r = await svc.verifyCredentials('rahul', 'pw', '1.2.3.4');
    expect(r.message).toBe('Login temporarily locked for this network. Try again in 10 minute(s).');
    expect(calls.some((c) => /FROM users u/.test(c.sql))).toBe(false);
  });
});
