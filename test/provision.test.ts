import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { provisionTenant } from '../src/tenancy/provision.js';
import { initControlSchema } from '../src/tenancy/registry.js';
import { createMultiTenant, type MultiTenant } from '../src/tenancy/runtime.js';
import { resetAndSeed } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });
const T = process.env.TEST_DB2_NAME, C = process.env.TEST_CONTROL_DB_NAME, AU = process.env.TEST_PROVISION_ADMIN_USER;
const on = !!(T && C && AU);

/** `tenant create`: new database + DB user cloned from a template DB, then a real login on the new business's host. */
describe.skipIf(!on)('tenant provisioning', () => {
  // loadEnv/createPool below run eagerly (not inside a hook) - guard them so a skipped run never
  // touches an unset DB_NAME/CONTROL_DB_NAME. skipIf still collects this factory to report the
  // suite as skipped, so without this it would throw before the skip ever takes effect.
  if (!on) { it.skip('requires TEST_DB2_NAME / TEST_CONTROL_DB_NAME / TEST_PROVISION_ADMIN_USER', () => {}); return; }
  const base ={ DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_USER: process.env.TEST_DB_USER ?? '', DB_PASS: process.env.TEST_DB_PASS ?? '' };
  const env = loadEnv({ NODE_ENV: 'test', ...base, DB_NAME: T!, CONTROL_DB_NAME: C!, CONTROL_MASTER_KEY: 'master-key-for-tests', APP_SECRET_KEY: 'unused', UPLOAD_DIR: '/tmp/udc-mt-uploads', TENANT_UPLOAD_ROOT: '/tmp/udc-mt-uploads',
    PROVISION_DB_USER: AU, PROVISION_DB_PASS: process.env.TEST_PROVISION_ADMIN_PASS ?? '' } as NodeJS.ProcessEnv);
  const tmpl = createPool({ ...env, DB_NAME: T! }), ctl = createPool({ ...env, DB_NAME: C! }), adm = createPool({ ...env, DB_NAME: 'information_schema', DB_USER: AU!, DB_PASS: process.env.TEST_PROVISION_ADMIN_PASS ?? '' });
  let mt: MultiTenant; let app: Awaited<ReturnType<typeof buildApp>>;
  const names = ['udc_t_prov1', 'udc_t_prov2'];
  const dropAll = async () => { for (const n of names) { await adm.db.execute(`DROP DATABASE IF EXISTS ${n}`); for (const h of ['%', 'localhost', '127.0.0.1']) await adm.db.execute(`DROP USER IF EXISTS '${n.replace('udc_t_', 'udc_')}'@'${h}'`); } };

  beforeAll(async () => {
    await dropAll();
    await resetAndSeed(tmpl.db);
    await tmpl.db.execute("INSERT INTO roles (id, role_name) VALUES (3, 'Super Admin')");
    await tmpl.db.execute("INSERT INTO permissions (id, permission_key, module) VALUES (1,'dashboard.view','x')");
    await tmpl.db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (3,1)');
    await tmpl.db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('business_name','TEMPLATE CO') ON DUPLICATE KEY UPDATE setting_value='TEMPLATE CO'");
    await tmpl.db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('invoice_prefix_counter','99'), ('currency_symbol','Rs.') ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)");
    await tmpl.db.execute("INSERT INTO customers (customer_code, full_name, mobile) VALUES ('TC1', 'Template Customer', '1')"); // transactional data must NOT be cloned
    await ctl.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const t of ['tenant_domains', 'tenants', 'tenant_events']) await ctl.db.execute(`DROP TABLE IF EXISTS ${t}`);
    await initControlSchema(ctl.db);
    mt = createMultiTenant(env);
    app = await buildApp(mt.services, mt); await app.ready();
  });
  afterAll(async () => { await app?.close(); await mt?.close(); await dropAll(); await Promise.all([tmpl.close(), ctl.close(), adm.close()]); });

  const input = (slug: string, extra = {}) => ({ slug, name: 'Gamma <Press>', host: `${slug}.test`, templateDb: T!, admin: { username: 'owner', password: 'owner-pass-1', fullName: 'Gamma Owner', mobile: '9999900000' }, ...extra });

  it('creates the database, clones schema + reference data (not customers), resets counters, creates admin', async () => {
    const r = await provisionTenant(env, mt.registry, input('prov1'));
    expect(r.dbName).toBe('udc_t_prov1');
    const row = (await mt.registry.list()).find((t) => t.slug === 'prov1')!;
    const { db, close } = createPool(mt.registry.tenantEnv(row)); // connects as the business's OWN db user
    try {
      const v = async (k: string) => (await db.query<{ v: string }>('SELECT setting_value AS v FROM settings WHERE setting_key = ?', [k]))[0]?.v;
      expect(await v('business_name')).toBe('Gamma <Press>');
      expect(await v('invoice_prefix_counter')).toBe('0');
      expect(await v('currency_symbol')).toBe('Rs.');
      expect((await db.query('SELECT 1 FROM customers')).length).toBe(0);
      expect((await db.query('SELECT 1 FROM roles WHERE role_name = "Super Admin"')).length).toBe(1);
      expect((await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM role_permissions'))[0]!.n).toBe(1);
      expect((await db.query<{ store_name: string }>('SELECT store_name FROM stores'))[0]!.store_name).toBe('Main');
      expect((await db.query<{ password_hash: string }>('SELECT password_hash FROM users'))[0]!.password_hash).toMatch(/^\$2[aby]\$/);
      // the business's DB user cannot see another business's data
      await expect(db.query(`SELECT 1 FROM ${T}.customers`)).rejects.toThrow();
    } finally { await close(); }
  });

  it('the new business works end-to-end on its host (login → page), template business untouched', async () => {
    const g = await app.inject({ method: 'GET', url: '/modules/auth/login.php', headers: { host: 'prov1.test' } });
    const csrf = /name="csrf_token" value="([0-9a-f]{64})"/.exec(g.body)?.[1] ?? '';
    const sc = ([] as string[]).concat(g.headers['set-cookie'] as string[] | string).map((c) => c.split(';')[0]).join('; ');
    const p = await app.inject({ method: 'POST', url: '/modules/auth/login.php', headers: { host: 'prov1.test', cookie: sc, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ csrf_token: csrf, username: 'owner', password: 'owner-pass-1' }).toString() });
    expect(p.statusCode).toBe(302);
    const jar = new Map<string, string>();
    for (const c of [sc, ([] as string[]).concat(p.headers['set-cookie'] as string[] | string).map((x) => x.split(';')[0]).join('; ')].join('; ').split('; ').filter(Boolean)) jar.set(c.split('=')[0]!, c);
    const page = await app.inject({ method: 'GET', url: '/modules/dashboard/landing.php', headers: { host: 'prov1.test', cookie: [...jar.values()].join('; ') } });
    expect(page.statusCode).toBe(200); expect(page.body).toContain('Gamma &lt;Press&gt;'); expect(page.body).not.toContain('TEMPLATE CO');
    expect((await tmpl.db.query<{ v: string }>("SELECT setting_value AS v FROM settings WHERE setting_key='invoice_prefix_counter'"))[0]!.v).toBe('99');
  });

  it('rejects duplicates / bad input and leaves nothing behind on failure', async () => {
    await expect(provisionTenant(env, mt.registry, input('prov1'))).rejects.toThrow(/already exists/);
    await expect(provisionTenant(env, mt.registry, input('p', {}))).rejects.toThrow(/slug/);
    await expect(provisionTenant(env, mt.registry, input('prov2', { admin: { username: 'o', password: 'short', fullName: 'x' } }))).rejects.toThrow(/password/);
    await tmpl.db.execute("DELETE FROM role_permissions"); await tmpl.db.execute("DELETE FROM roles WHERE role_name = 'Super Admin'");
    await expect(provisionTenant(env, mt.registry, input('prov2'))).rejects.toThrow(/Super Admin/);
    expect((await adm.db.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = "udc_t_prov2"')).length).toBe(0);
    expect((await mt.registry.list()).some((t) => t.slug === 'prov2')).toBe(false);
  });
});
