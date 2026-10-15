import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { tenantStorage } from '../src/tenancy/als.js';
import { TenantRegistry, initControlSchema, type TenantRow } from '../src/tenancy/registry.js';
import { createMultiTenant, type MultiTenant } from '../src/tenancy/runtime.js';
import { buildDataset } from './web/dataset.js';

vi.setConfig({ testTimeout: 180_000 });
const T = process.env.TEST_DB2_NAME, C = process.env.TEST_CONTROL_DB_NAME;
const base = { DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_USER: process.env.TEST_DB_USER ?? '', DB_PASS: process.env.TEST_DB_PASS ?? '' };
const env = () => loadEnv({ NODE_ENV: 'test', ...base, DB_NAME: T ?? 'x', CONTROL_DB_NAME: C ?? 'x', CONTROL_MASTER_KEY: 'master-key-for-tests', APP_SECRET_KEY: 'unused', UPLOAD_DIR: '/tmp/udc-mt-uploads' } as NodeJS.ProcessEnv);

describe('subscription state (pure)', () => {
  const reg = new TenantRegistry(env(), {} as never);
  const row = (o: Partial<TenantRow>): TenantRow => ({ id: 1, slug: 's', name: 'S', status: 'active', db_host: '', db_port: 0, db_name: '', db_user: '', db_pass_enc: '', app_url: '', app_secret_enc: '', upload_dir: '', timezone: '', trial_ends_at: null, plan_id: null, plan_ends_at: null, grace_days: 5, ...o });
  const at = (d: string) => Date.parse(d + 'T12:00:00Z');
  it('trial → read-only after its end', () => {
    expect(reg.infoFor(row({ status: 'trial', trial_ends_at: '2026-10-10 10:00:00' }), at('2026-10-09')).access).toBe('full');
    expect(reg.infoFor(row({ status: 'trial', trial_ends_at: '2026-10-10 10:00:00' }), at('2026-10-11')).access).toBe('readonly');
  });
  it('paid plan → read-only only after paid-through date + grace days; no date = never', () => {
    const r = row({ plan_ends_at: '2026-10-10', grace_days: 5 });
    expect(reg.infoFor(r, at('2026-10-10')).access).toBe('full');
    expect(reg.infoFor(r, at('2026-10-15')).access).toBe('full');
    expect(reg.infoFor(r, at('2026-10-16')).access).toBe('readonly');
    expect(reg.infoFor(row({}), at('2030-01-01')).access).toBe('full');
  });
  it('limits default to unlimited', () => { expect(reg.infoFor(row({})).limits).toEqual({ stores: 0, users: 0, ordersPerMonth: 0 }); });
});

describe.skipIf(!(T && C))('plan limits and read-only mode in a live app', () => {
  const dbs = createPool({ ...env(), DB_NAME: T! }), ctl = createPool({ ...env(), DB_NAME: C! });
  let mt: MultiTenant; let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    await buildDataset(dbs.db, env(), undefined, 'pw-12345-ok');
    await dbs.db.execute("INSERT INTO permissions (permission_key, module) VALUES ('users.manage','x'),('master.manage','x')");
    await dbs.db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN ('users.manage','master.manage')");
    await ctl.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const t of ['tenant_domains', 'tenants', 'tenant_events', 'plans', 'signup_requests']) await ctl.db.execute(`DROP TABLE IF EXISTS ${t}`);
    await initControlSchema(ctl.db);
    await ctl.db.execute("UPDATE plans SET max_stores = 1, max_users = 1, max_orders_month = 1 WHERE code = 'starter'");
    mt = createMultiTenant(env());
    const plan = (await ctl.db.query<{ id: number }>("SELECT id FROM plans WHERE code = 'starter'"))[0]!.id;
    const r = await ctl.db.execute('INSERT INTO tenants (slug, name, status, db_host, db_port, db_name, db_user, db_pass_enc, app_url, app_secret_enc, upload_dir, plan_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ['lim', 'Limited Co', 'active', base.DB_HOST, Number(base.DB_PORT), T, base.DB_USER, mt.registry.encrypt(base.DB_PASS), 'https://lim.test', mt.registry.encrypt('s'), '/tmp/udc-mt-uploads/lim', plan]);
    await ctl.db.execute('INSERT INTO tenant_domains (hostname, tenant_id, is_primary) VALUES (?,?,1)', ['lim.test', r.insertId]);
    app = await buildApp(mt.services, mt); await app.ready();
  });
  afterAll(async () => { await app?.close(); await mt?.close(); await Promise.all([dbs.close(), ctl.close()]); });

  const req = (method: 'GET' | 'POST', url: string, o: { cookie?: string; form?: Record<string, string>; json?: unknown } = {}) =>
    app.inject({ method, url, headers: { host: 'lim.test', ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.form ? { 'content-type': 'application/x-www-form-urlencoded' } : o.json ? { 'content-type': 'application/json' } : {}) }, payload: o.form ? new URLSearchParams(o.form).toString() : o.json ? JSON.stringify(o.json) : undefined });
  const jar = (...rs: { headers: Record<string, unknown> }[]) => { const m = new Map<string, string>(); for (const r of rs) for (const c of ([] as string[]).concat((r.headers['set-cookie'] as string[] | string | undefined) ?? [])) { const kv = c.split(';')[0]!; m.set(kv.split('=')[0]!, kv); } return [...m.values()].join('; '); };
  const login = async () => {
    const g = await req('GET', '/modules/auth/login.php');
    const csrf = /name="csrf_token" value="([0-9a-f]{64})"/.exec(g.body)?.[1] ?? '';
    const p = await req('POST', '/modules/auth/login.php', { cookie: jar(g), form: { csrf_token: csrf, username: 'boss', password: 'pw-12345-ok' } });
    expect(p.statusCode).toBe(302);
    const cookie = jar(g, p);
    const page = await req('GET', '/modules/admin/users.php', { cookie });
    return { cookie, csrf: /name="csrf_token" value="([0-9a-f]{64})"/.exec(page.body)?.[1] ?? csrf };
  };

  it('user / store / order limits of the plan are enforced', async () => {
    const { cookie, csrf } = await login();
    const u = await req('POST', '/modules/admin/users.php', { cookie, form: { csrf_token: csrf, action: 'create', full_name: 'New', username: 'newone', password: 'longenough1', role_id: '3', is_active: 'on' } });
    expect(u.body).toContain('plan allows up to 1 active users');
    const s = await req('POST', '/api/master_data.php', { cookie, json: { csrf_token: csrf, entity: 'stores', action: 'create', store_name: 'Third', store_type: 'branch' } });
    expect(s.statusCode).toBe(422); expect(s.body).toContain('plan allows up to 1 active store');
    const row = (await mt.registry.list())[0]!; const rt = await mt.registry.runtimeFor(row);
    const r = await tenantStorage.run({ tenant: mt.registry.infoFor({ ...row, plan_code: 'starter', max_stores: 1, max_users: 1, max_orders_month: 1 } as TenantRow), services: rt.services }, () => rt.services.orders.createOrder({ customer_id: 1, items: [] }, { userId: 1 }, false, 1));
    expect(r.success).toBe(false); expect(String(r.errors)).toContain('1 orders per month');
  });

  it('expired subscription = read-only (GET and login still work, changes get 402); renewing restores it', async () => {
    const { cookie, csrf } = await login();
    await ctl.db.execute("UPDATE tenants SET status = 'trial', trial_ends_at = '2020-01-01 00:00:00'"); mt.registry.invalidate();
    expect((await req('GET', '/modules/admin/users.php', { cookie })).statusCode).toBe(200);
    const w = await req('POST', '/modules/admin/users.php', { cookie, form: { csrf_token: csrf, action: 'toggle_active', user_id: '5' } });
    expect(w.statusCode).toBe(402); expect(w.body).toContain('read-only');
    const api = await req('POST', '/api/master_data.php', { cookie, json: { csrf_token: csrf, entity: 'brands', action: 'create', brand_name: 'X' } });
    expect(api.statusCode).toBe(402); expect(JSON.parse(api.body).error.code).toBe('subscription_expired');
    await login(); // signing in is still possible
    await ctl.db.execute("UPDATE tenants SET status = 'active', plan_ends_at = DATE_ADD(CURDATE(), INTERVAL 30 DAY), trial_ends_at = NULL"); mt.registry.invalidate();
    expect((await req('POST', '/modules/admin/users.php', { cookie, form: { csrf_token: csrf, action: 'toggle_active', user_id: '5' } })).statusCode).toBe(302);
  });
});
