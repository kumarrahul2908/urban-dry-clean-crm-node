import { describe, expect, it } from 'vitest';
import { normalizeHtml, webEnabled, webHarness, type Client, type Resp } from './web/harness.js';

/**
 * HTML-level parity: the REAL PHP pages (php -S) and the Node pages are requested with identical sessions, forms and
 * cookies on the same database; status, redirect target and the normalised HTML must match.
 */
describe.skipIf(!webEnabled)('web pages: PHP ↔ Node parity', () => {
  const { h, seed, login, phpClient, nodeClient } = webHarness();
  const norm = (r: Resp) => ({ status: r.status, location: r.location?.replace(h.env.APP_URL, 'BASE') ?? null, type: r.type, body: normalizeHtml(r.body, h.env.APP_URL) });

  async function same(php: Client, node: Client, method: 'GET' | 'POST', path: string, form?: Record<string, string>, opts?: { csrf?: boolean }) {
    const a = method === 'GET' ? await php.get(path) : await php.post(path, form ?? {}, opts);
    const b = method === 'GET' ? await node.get(path) : await node.post(path, form ?? {}, opts);
    expect(norm(b), `${method} ${path}`).toEqual(norm(a));
    return { php: a, node: b };
  }

  it('anonymous: root, login page, timeout banner, protected pages redirect', async () => {
    await seed();
    const { php, node } = await login(null);
    for (const p of ['/', '/index.php', '/modules/auth/login.php', '/modules/auth/login.php?timeout=1', '/modules/auth/login.php?timeout=0', '/modules/dashboard/landing.php', '/modules/auth/change-password.php', '/modules/auth/forgot-password.php', '/modules/auth/reset-password.php?token=abc', '/api/customers_search.php?q=ra', '/api/set_active_store.php']) {
      await same(php, node, 'GET', p);
    }
  });

  it('login: empty, wrong, locked-out-free success, csrf failure, redirect for workshop staff', async () => {
    await seed();
    const { php, node } = await login(null);
    await php.get('/modules/auth/login.php'); await node.get('/modules/auth/login.php');
    await same(php, node, 'POST', '/modules/auth/login.php', { username: '', password: '' });
    await same(php, node, 'POST', '/modules/auth/login.php', { username: 'rahul', password: 'nope' });
    await same(php, node, 'POST', '/modules/auth/login.php', { username: 'ghost', password: 'nope' });
    await same(php, node, 'POST', '/modules/auth/login.php', { username: 'rahul', password: 'x' }, { csrf: false });
    await same(php, node, 'POST', '/modules/auth/login.php', { username: '  rahul  ', password: 'pw-12345-ok' }); // → landing
    await same(php, node, 'GET', '/modules/auth/login.php'); // already logged in → redirect
    const ws = await login('ws');
    await same(ws.php, ws.node, 'GET', '/');
    await same(ws.php, ws.node, 'GET', '/modules/dashboard/landing.php'); // workshop staff: 403
  });

  it('landing page + sidebar for each role, store selector, logout', async () => {
    await seed();
    for (const who of ['admin', 'boss', 'viewer', 'fixed'] as const) {
      const { php, node } = await login(who);
      await same(php, node, 'GET', '/modules/dashboard/landing.php');
      await same(php, node, 'GET', '/');
      await same(php, node, 'GET', '/modules/auth/change-password.php');
    }
    const { php, node } = await login('boss');
    const sel = await same(php, node, 'POST', '/api/set_active_store.php', { store_id: '2' });
    expect(JSON.parse(sel.node.body)).toEqual({ success: true });
    await same(php, node, 'GET', '/modules/dashboard/landing.php'); // store name in the selector
    await same(php, node, 'POST', '/api/set_active_store.php', { store_id: '3' });
    await same(php, node, 'POST', '/api/set_active_store.php', { store_id: 'x' });
    await same(php, node, 'GET', '/api/set_active_store.php');
    await same(php, node, 'POST', '/api/set_active_store.php', { store_id: '2' }, { csrf: false });
    const fixed = await login('fixed');
    await same(fixed.php, fixed.node, 'POST', '/api/set_active_store.php', { store_id: '1' });
    await same(php, node, 'GET', '/modules/auth/logout.php');
    await same(php, node, 'GET', '/modules/dashboard/landing.php'); // logged out → login redirect
  });

  it('change password: validation, wrong current, success (then old password fails)', async () => {
    await seed();
    const { php, node } = await login('viewer');
    await same(php, node, 'POST', '/modules/auth/change-password.php', { current_password: 'x', new_password: 'short', new_password_confirm: 'short' });
    await same(php, node, 'POST', '/modules/auth/change-password.php', { current_password: 'x', new_password: 'longenough1', new_password_confirm: 'different11' });
    await same(php, node, 'POST', '/modules/auth/change-password.php', { current_password: 'wrong', new_password: 'longenough1', new_password_confirm: 'longenough1' });
    await same(php, node, 'POST', '/modules/auth/change-password.php', { current_password: 'x', new_password: 'longenough1', new_password_confirm: 'longenough1' }, { csrf: false });
    // success on Node only afterwards for PHP too: do PHP first, restore, then Node (same DB)
    const a = await php.post('/modules/auth/change-password.php', { current_password: 'pw-12345-ok', new_password: 'longenough1', new_password_confirm: 'longenough1' });
    await h.db.execute("UPDATE users SET password_hash = (SELECT password_hash FROM (SELECT password_hash FROM users WHERE id = 1) t) WHERE id = 5");
    const b = await node.post('/modules/auth/change-password.php', { current_password: 'pw-12345-ok', new_password: 'longenough1', new_password_confirm: 'longenough1' });
    expect(norm(b)).toEqual(norm(a));
    expect(b.body).toContain('Password changed successfully.');
  });

  it('forgot / reset password pages', async () => {
    await seed();
    const { php, node } = await login(null);
    await same(php, node, 'GET', '/modules/auth/forgot-password.php');
    await same(php, node, 'POST', '/modules/auth/forgot-password.php', { identifier: 'rahul' }); // not configured
    await same(php, node, 'POST', '/modules/auth/forgot-password.php', { identifier: 'rahul' }, { csrf: false });
    await same(php, node, 'GET', '/modules/auth/reset-password.php?token=abc');
    await same(php, node, 'POST', '/modules/auth/reset-password.php', { token: 'abc', password: 'short', password_confirm: 'short' });
    await same(php, node, 'POST', '/modules/auth/reset-password.php', { token: 'abc', password: 'longenough1', password_confirm: 'different11' });
    await same(php, node, 'POST', '/modules/auth/reset-password.php', { token: 'abc', password: 'longenough1', password_confirm: 'longenough1' });
  });

  it('search APIs: permissions, short query, results', async () => {
    await seed(async (db) => { await db.execute("INSERT INTO customers (customer_code, full_name, mobile, address, area) VALUES ('C9', 'Zed <b>Zee</b>', '9000011111', 'Lane 4', 'Area 51')"); });
    for (const who of ['admin', 'viewer', 'ws'] as const) {
      const { php, node } = await login(who);
      for (const q of ['', 'z', 'ze', 'Zed', '9000', 'C9', '%', 'plain']) {
        await same(php, node, 'GET', `/api/customers_search.php?q=${encodeURIComponent(q)}`);
        await same(php, node, 'GET', `/api/orders_search.php?q=${encodeURIComponent(q)}`);
      }
    }
  });
});

describe.skipIf(!webEnabled)('web sessions (Node only)', () => {
  const { h, seed, login } = webHarness();
  it('stores sessions hashed in the DB, expires idle ones, deletes on logout', async () => {
    await seed();
    const { node } = await login('admin');
    const cookie = node.cookie();
    expect(cookie).toMatch(/^udc_sid=[0-9a-f]{64}$/);
    const raw = cookie.split('=')[1]!;
    const rows = await h.db.query<{ id: string; user_id: number }>('SELECT id, user_id FROM web_sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(raw); // only the hash is stored
    expect(rows[0]!.user_id).toBe(1);
    const set = (await h.app.inject({ method: 'GET', url: '/modules/auth/login.php' })).headers['set-cookie'] as string;
    expect(set).toMatch(/HttpOnly; SameSite=Lax/);

    // idle past SESSION_LIFETIME_MINUTES → logged out with ?timeout=1
    await h.db.execute("UPDATE web_sessions SET data = JSON_SET(data, '$.last_activity', JSON_EXTRACT(data, '$.last_activity') - 7300)");
    const t = await node.get('/modules/dashboard/landing.php');
    expect(t.status).toBe(302);
    expect(t.location).toBe('https://example.test/modules/auth/login.php?timeout=1');
    expect(await h.db.query('SELECT 1 FROM web_sessions WHERE user_id IS NOT NULL')).toHaveLength(0);

    const again = await login('admin');
    const out = await again.node.get('/modules/auth/logout.php');
    expect(out.status).toBe(302);
    expect(await h.db.query('SELECT 1 FROM web_sessions WHERE user_id IS NOT NULL')).toHaveLength(0);
    expect((await again.node.get('/modules/dashboard/landing.php')).location).toBe('https://example.test/modules/auth/login.php');
  });

  it('a forged or unknown session cookie is treated as anonymous', async () => {
    await seed();
    const r = await h.app.inject({ method: 'GET', url: '/modules/dashboard/landing.php', headers: { cookie: `udc_sid=${'a'.repeat(64)}` } });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('https://example.test/modules/auth/login.php');
  });
});
