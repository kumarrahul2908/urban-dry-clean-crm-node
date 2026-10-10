import { describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';
import { fakeDb } from './helpers.js';

const env = loadEnv({ NODE_ENV: 'test', DB_NAME: 'x', DB_USER: 'x', APP_SECRET_KEY: 'k' } as NodeJS.ProcessEnv);

async function app() {
  const hash = await hashPassword('pw');
  const user = { id: 7, username: 'rahul', email: null, full_name: 'Rahul', password_hash: hash, role_id: 2, role_name: 'Admin', store_id: null, is_active: 1, failed_login_count: 0, locked_until: null };
  const tokens: Record<string, any> = {};
  const { db } = fakeDb([
    [/FROM users u JOIN roles/, () => [user]],
    [/FROM role_permissions/, () => [{ permission_key: 'orders.view' }]],
    [/INSERT INTO api_tokens/, (_s, p) => { tokens[p[1] as string] = { token_id: 1, expires_at: p[5], revoked_at: null, ...user }; return { affectedRows: 1, insertId: 1 }; }],
    [/FROM api_tokens t JOIN users/, (_s, p) => (tokens[p[0] as string] ? [tokens[p[0] as string]] : [])],
    [/UPDATE api_tokens SET revoked_at/, (_s, p) => { const t = tokens[p[0] as string]; if (t && !t.revoked_at) { t.revoked_at = 'x'; return { affectedRows: 1, insertId: 0 }; } return { affectedRows: 0, insertId: 0 }; }],
    [/FROM stores WHERE is_active/, () => [{ id: 1, store_name: 'Main', store_type: 'retail' }]],
  ]);
  return buildApp(buildServices(env, db));
}

describe('mobile auth routes', () => {
  it('login → me → logout → me(401)', async () => {
    const a = await app();
    const bad = await a.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ success: false, error: { code: 'authentication_failed', message: 'Invalid username or password.' } });

    const login = await a.inject({ method: 'POST', url: '/api/mobile/login.php', payload: { username: 'rahul', password: 'pw', device_name: 'Pixel' } });
    expect(login.statusCode).toBe(200);
    const { token, user } = login.json().data;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(user.permissions).toEqual(['orders.view']);

    const headers = { authorization: `Bearer ${token}` };
    const me = await a.inject({ method: 'GET', url: '/api/mobile/me', headers });
    expect(me.json().data.store.requires_store_selection).toBe(true);

    const out = await a.inject({ method: 'POST', url: '/api/mobile/logout', headers });
    expect(out.json()).toEqual({ success: true, data: { revoked: true } });
    expect((await a.inject({ method: 'GET', url: '/api/mobile/me', headers })).statusCode).toBe(401);
  });
  it('validates input and header', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: '' } })).statusCode).toBe(422);
    expect((await a.inject({ method: 'GET', url: '/api/mobile/me' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});
