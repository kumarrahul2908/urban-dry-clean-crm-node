import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { addSuperAdmin } from '../src/tenancy/console.js';
import { initControlSchema } from '../src/tenancy/registry.js';
import { createMultiTenant, type MultiTenant } from '../src/tenancy/runtime.js';
import { buildDataset } from './web/dataset.js';

vi.setConfig({ testTimeout: 180_000 });
const T = process.env.TEST_DB2_NAME, C = process.env.TEST_CONTROL_DB_NAME;
const on = !!(T && C);

describe.skipIf(!on)('operator console', () => {
  // loadEnv/createPool below run eagerly (not inside a hook) - guard them so a skipped run never
  // touches an unset DB_NAME/CONTROL_DB_NAME. skipIf still collects this factory to report the
  // suite as skipped, so without this it would throw before the skip ever takes effect.
  if (!on) { it.skip('requires TEST_DB2_NAME / TEST_CONTROL_DB_NAME', () => {}); return; }
  const base ={ DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_USER: process.env.TEST_DB_USER ?? '', DB_PASS: process.env.TEST_DB_PASS ?? '' };
  const env = loadEnv({ NODE_ENV: 'test', ...base, DB_NAME: T!, CONTROL_DB_NAME: C!, CONTROL_MASTER_KEY: 'master-key-for-tests', APP_SECRET_KEY: 'unused', UPLOAD_DIR: '/tmp/udc-mt-uploads', CONTROL_ROOT_HOST: 'root.test', CONTROL_ADMIN_HOST: 'admin.test', TENANT_BASE_DOMAIN: 'apps.test' } as NodeJS.ProcessEnv);
  const dbs = createPool({ ...env, DB_NAME: T! }), ctl = createPool({ ...env, DB_NAME: C! });
  let mt: MultiTenant; let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    await buildDataset(dbs.db, env, undefined, 'pw-12345-ok');
    await dbs.db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('business_name','Console Test Co') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
    await ctl.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const t of ['tenant_domains', 'tenants', 'tenant_events', 'plans', 'signup_requests', 'super_admins', 'admin_sessions', 'impersonation_tokens']) await ctl.db.execute(`DROP TABLE IF EXISTS ${t}`);
    await initControlSchema(ctl.db);
    mt = createMultiTenant(env);
    const r = await ctl.db.execute('INSERT INTO tenants (slug, name, status, db_host, db_port, db_name, db_user, db_pass_enc, app_url, app_secret_enc, upload_dir, plan_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,(SELECT id FROM plans WHERE code = ?))',
      ['conso', 'Console Test Co', 'active', base.DB_HOST, Number(base.DB_PORT), T, base.DB_USER, mt.registry.encrypt(base.DB_PASS), 'https://conso.apps.test', mt.registry.encrypt('s'), '/tmp/udc-mt-uploads/conso', 'pro']);
    await ctl.db.execute('INSERT INTO tenant_domains (hostname, tenant_id, is_primary) VALUES (?,?,1)', ['conso.apps.test', r.insertId]);
    await addSuperAdmin(mt.registry, 'operator', 'operator-pass-123');
    app = await buildApp(mt.services, mt); await app.ready();
  });
  afterAll(async () => { await app?.close(); await mt?.close(); await Promise.all([dbs.close(), ctl.close()]); });

  const req = (host: string, method: 'GET' | 'POST', url: string, o: { cookie?: string; form?: Record<string, string> } = {}) =>
    app.inject({ method, url, headers: { host, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, payload: o.form ? new URLSearchParams(o.form).toString() : undefined });
  const cookieOf = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers['set-cookie'] as string[] | string | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
  let cookie = '', csrf = '';
  const A = (m: 'GET' | 'POST', url: string, form?: Record<string, string>) => req('admin.test', m, url, { cookie, form });

  it('login: wrong password rejected, right one opens the console; no session → redirect to login', async () => {
    expect((await req('admin.test', 'GET', '/console')).headers.location).toBe('/console/login');
    expect((await req('admin.test', 'POST', '/console/login', { form: { username: 'operator', password: 'nope' } })).statusCode).toBe(401);
    const ok = await req('admin.test', 'POST', '/console/login', { form: { username: 'operator', password: 'operator-pass-123' } });
    expect(ok.statusCode).toBe(302); cookie = cookieOf(ok);
    const home = await A('GET', '/console');
    expect(home.statusCode).toBe(200); expect(home.body).toContain('conso'); expect(home.body).toContain('Console Test Co');
    csrf = /name="csrf" value="([0-9a-f]{64})"/.exec(home.body)?.[1] ?? '';
    expect(csrf).toHaveLength(64);
  });
  it('host separation: console only on admin host, signup only on root host, neither on a business host', async () => {
    expect((await req('conso.apps.test', 'GET', '/console')).statusCode).toBe(404);
    expect((await req('conso.apps.test', 'GET', '/signup')).statusCode).toBe(404);
    expect((await req('root.test', 'GET', '/console')).statusCode).toBe(404);
    expect((await req('admin.test', 'GET', '/signup')).statusCode).toBe(404);
    expect((await req('admin.test', 'GET', '/modules/auth/login.php')).statusCode).toBe(404);
  });
  it('detail page, CSRF check, suspend / resume, plan, extend, plan limits edit', async () => {
    expect((await A('GET', '/console/t/conso')).body).toContain('Open as owner');
    expect((await A('POST', '/console/t/conso', { csrf: 'bad', action: 'suspend' })).statusCode).toBe(419);
    await A('POST', '/console/t/conso', { csrf, action: 'suspend' });
    expect((await req('conso.apps.test', 'GET', '/modules/auth/login.php')).statusCode).toBe(402);
    await A('POST', '/console/t/conso', { csrf, action: 'resume' });
    expect((await req('conso.apps.test', 'GET', '/modules/auth/login.php')).statusCode).toBe(200);
    await A('POST', '/console/t/conso', { csrf, action: 'plan', plan: 'starter', until: '2031-01-31' });
    const t = (await ctl.db.query<any>("SELECT p.code, DATE_FORMAT(t.plan_ends_at,'%Y-%m-%d') AS d FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.slug = 'conso'"))[0];
    expect([t.code, t.d]).toEqual(['starter', '2031-01-31']);
    await A('POST', '/console/t/conso', { csrf, action: 'extend', days: '10' });
    expect((await ctl.db.query<any>("SELECT DATE_FORMAT(plan_ends_at,'%Y-%m-%d') AS d FROM tenants WHERE slug='conso'"))[0].d).toBe('2031-02-10');
    const id = (await ctl.db.query<any>("SELECT id FROM plans WHERE code='starter'"))[0].id;
    await A('POST', '/console/plans', { csrf, id: String(id), max_stores: '2', max_users: '9', max_orders_month: '77', price_monthly: '499', price_yearly: '' });
    expect((await ctl.db.query<any>('SELECT max_stores, max_users, max_orders_month, price_monthly, price_yearly FROM plans WHERE id = ?', [id]))[0]).toMatchObject({ max_stores: 2, max_users: 9, max_orders_month: 77, price_yearly: null });
    expect((await A('GET', '/console/plans')).body).toContain('499');
    expect((await ctl.db.query<any>("SELECT COUNT(*) AS n FROM tenant_events WHERE event IN ('suspended','active','plan_set','extended')"))[0].n).toBeGreaterThanOrEqual(4);
  });
  it('impersonation: single-use 60 s link logs in as the owner, audited on both sides', async () => {
    const r = await A('POST', '/console/t/conso', { csrf, action: 'impersonate' });
    expect(r.statusCode).toBe(302);
    const loc = new URL(String(r.headers.location));
    expect(loc.origin).toBe('https://conso.apps.test'); expect(loc.pathname).toBe('/__impersonate');
    const use = await req('conso.apps.test', 'GET', loc.pathname + loc.search);
    expect(use.statusCode).toBe(302);
    const page = await req('conso.apps.test', 'GET', '/modules/dashboard/landing.php', { cookie: cookieOf(use) });
    expect(page.statusCode).toBe(200); expect(page.body).toContain('Console Test Co');
    expect((await req('conso.apps.test', 'GET', loc.pathname + loc.search)).statusCode).toBe(410); // already used
    expect((await req('conso.apps.test', 'GET', '/__impersonate?token=' + 'a'.repeat(64))).statusCode).toBe(410);
    expect((await dbs.db.query<any>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'impersonate'"))[0].n).toBe(1);
    expect((await ctl.db.query<any>("SELECT COUNT(*) AS n FROM tenant_events WHERE event = 'impersonate'"))[0].n).toBe(1);
  });
  it('database backup download is a real gzip SQL dump; logout ends the session', async () => {
    const ex = await A('GET', '/console/t/conso/export');
    expect(ex.statusCode).toBe(200); expect(String(ex.headers['content-type'])).toContain('gzip');
    expect(gunzipSync(ex.rawPayload).toString()).toContain('CREATE TABLE');
    await A('POST', '/console/logout', { csrf });
    expect((await A('GET', '/console')).headers.location).toBe('/console/login');
  });
});
