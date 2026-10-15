import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { tenantStorage } from '../src/tenancy/als.js';
import { createMultiTenant, type MultiTenant } from '../src/tenancy/runtime.js';
import { initControlSchema } from '../src/tenancy/registry.js';
import { resetAndSeed } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });
const A = process.env.TEST_DB_NAME, B = process.env.TEST_DB2_NAME, C = process.env.TEST_CONTROL_DB_NAME;
const on = !!(A && B && C);

/** Two businesses (two databases) behind one app + a control DB: no data, session or cookie may cross over. */
describe.skipIf(!on)('multi-tenant isolation (database per business)', () => {
  const base = { DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_USER: process.env.TEST_DB_USER ?? '', DB_PASS: process.env.TEST_DB_PASS ?? '' };
  const env = loadEnv({ NODE_ENV: 'test', ...base, DB_NAME: A!, CONTROL_DB_NAME: C!, CONTROL_MASTER_KEY: 'master-key-for-tests', APP_SECRET_KEY: 'unused', UPLOAD_DIR: '/tmp/udc-mt-uploads' } as NodeJS.ProcessEnv);
  let mt: MultiTenant; let app: Awaited<ReturnType<typeof buildApp>>;
  const pools = [createPool({ ...env, DB_NAME: A! }), createPool({ ...env, DB_NAME: B! }), createPool({ ...env, DB_NAME: C! })];
  const [dbA, dbB, dbC] = pools.map((p) => p.db) as [typeof pools[0]['db'], typeof pools[0]['db'], typeof pools[0]['db']];

  beforeAll(async () => {
    for (const [db, name] of [[dbA, 'Alpha Wash'], [dbB, 'Beta Press']] as const) {
      await resetAndSeed(db);
      await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [await hashPassword('pw-12345-ok')]);
      await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('business_name', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [name]);
    }
    for (const db of [dbA, dbB]) { await db.execute("INSERT INTO permissions (id, permission_key, module) VALUES (1,'dashboard.view','x')"); await db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (1,1)'); }
    await dbB.execute("UPDATE users SET username = 'betaowner' WHERE id = 1"); // user exists only in B under this name
    await dbC.execute('SET FOREIGN_KEY_CHECKS = 0'); await dbC.execute('DROP TABLE IF EXISTS tenant_domains'); await dbC.execute('DROP TABLE IF EXISTS tenants'); await dbC.execute('DROP TABLE IF EXISTS tenant_events');
    await initControlSchema(dbC);
    mt = createMultiTenant(env);
    const reg = mt.registry;
    for (const [slug, name, db, host] of [['alpha', 'Alpha Wash', A!, 'alpha.test'], ['beta', 'Beta Press', B!, 'beta.test']] as const) {
      const r = await dbC.execute('INSERT INTO tenants (slug, name, db_host, db_port, db_name, db_user, db_pass_enc, app_url, app_secret_enc, upload_dir) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [slug, name, base.DB_HOST, Number(base.DB_PORT), db, base.DB_USER, reg.encrypt(base.DB_PASS), `https://${host}`, reg.encrypt('secret-' + slug), `/tmp/udc-mt-uploads/${slug}`]);
      await dbC.execute('INSERT INTO tenant_domains (hostname, tenant_id, is_primary) VALUES (?,?,1)', [host, r.insertId]);
    }
    app = await buildApp(mt.services, mt);
    await app.ready();
  });
  afterAll(async () => { await app?.close(); await mt?.close(); await Promise.all(pools.map((p) => p.close())); });

  const req = (host: string, method: 'GET' | 'POST', url: string, opts: { cookie?: string; form?: Record<string, string> } = {}) =>
    app.inject({ method, url, headers: { host, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, payload: opts.form ? new URLSearchParams(opts.form).toString() : undefined });
  const cookieOf = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat((r.headers['set-cookie'] as string[] | string | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
  const login = async (host: string, username: string) => {
    const g = await req(host, 'GET', '/modules/auth/login.php');
    const csrf = /name="csrf_token" value="([0-9a-f]{64})"/.exec(g.body)?.[1] ?? '';
    const p = await req(host, 'POST', '/modules/auth/login.php', { cookie: cookieOf(g), form: { csrf_token: csrf, username, password: 'pw-12345-ok' } });
    const jar = new Map<string, string>();
    for (const c of [cookieOf(g), cookieOf(p)].join('; ').split('; ').filter(Boolean)) jar.set(c.split('=')[0]!, c); // later Set-Cookie wins (session id is regenerated on login)
    return { status: p.statusCode, location: String(p.headers.location ?? ''), cookie: [...jar.values()].join('; ') };
  };

  it('each host serves its own business', async () => {
    const a = await login('alpha.test', 'rahul');
    expect(a.status).toBe(302);
    const pa = await req('alpha.test', 'GET', '/modules/dashboard/landing.php', { cookie: a.cookie });
    expect(pa.statusCode).toBe(200); expect(pa.body).toContain('Alpha Wash'); expect(pa.body).not.toContain('Beta Press');
    const b = await login('beta.test', 'betaowner');
    const pb = await req('beta.test', 'GET', '/modules/dashboard/landing.php', { cookie: b.cookie });
    expect(pb.statusCode).toBe(200); expect(pb.body).toContain('Beta Press'); expect(pb.body).not.toContain('Alpha Wash');
  });
  it('users do not exist across businesses', async () => {
    const wrong = await login('beta.test', 'rahul'); // rahul only exists in Alpha
    expect(wrong.location).not.toContain('landing');
    const wrong2 = await login('alpha.test', 'betaowner');
    expect(wrong2.location).not.toContain('landing');
  });
  it('a session cookie from one business is useless on the other', async () => {
    const a = await login('alpha.test', 'rahul');
    const cross = await req('beta.test', 'GET', '/modules/dashboard/landing.php', { cookie: a.cookie });
    expect(cross.statusCode).toBe(302); expect(String(cross.headers.location)).toContain('login');
  });
  it('unknown host → 404; suspended → 402; resumed → works again', async () => {
    expect((await req('nobody.test', 'GET', '/modules/auth/login.php')).statusCode).toBe(404);
    await dbC.execute("UPDATE tenants SET status = 'suspended' WHERE slug = 'beta'"); mt.registry.invalidate();
    expect((await req('beta.test', 'GET', '/modules/auth/login.php')).statusCode).toBe(402);
    expect((await req('alpha.test', 'GET', '/modules/auth/login.php')).statusCode).toBe(200);
    await dbC.execute("UPDATE tenants SET status = 'active' WHERE slug = 'beta'"); mt.registry.invalidate();
    expect((await req('beta.test', 'GET', '/modules/auth/login.php')).statusCode).toBe(200);
  });
  it('concurrent requests never mix businesses', async () => {
    const [a, b] = [await login('alpha.test', 'rahul'), await login('beta.test', 'betaowner')];
    const calls = Array.from({ length: 24 }, (_, i) => (i % 2 ? req('beta.test', 'GET', '/modules/dashboard/landing.php', { cookie: b.cookie }) : req('alpha.test', 'GET', '/modules/dashboard/landing.php', { cookie: a.cookie })));
    const res = await Promise.all(calls);
    res.forEach((r, i) => { expect(r.body).toContain(i % 2 ? 'Beta Press' : 'Alpha Wash'); expect(r.body).not.toContain(i % 2 ? 'Alpha Wash' : 'Beta Press'); });
  });
  it('db, upload folder, secret and base URL are per business (also for already-destructured members)', async () => {
    const { db, storage, crypto, env: e } = mt.services; // destructured once, like every page does at registration
    const seen: Record<string, unknown> = {};
    for (const slug of ['alpha', 'beta']) {
      const row = (await mt.registry.list()).find((t) => t.slug === slug)!;
      const rt = await mt.registry.runtimeFor(row);
      await tenantStorage.run({ tenant: rt.info, services: rt.services }, async () => {
        seen[slug] = { name: (await db.query<{ v: string }>("SELECT setting_value AS v FROM settings WHERE setting_key = 'business_name'"))[0]!.v, root: storage.root, url: e.APP_URL, enc: crypto.encrypt('x') };
      });
    }
    const a = seen.alpha as any, b = seen.beta as any;
    expect([a.name, b.name]).toEqual(['Alpha Wash', 'Beta Press']);
    expect(a.root).toContain('/alpha'); expect(b.root).toContain('/beta');
    expect([a.url, b.url]).toEqual(['https://alpha.test', 'https://beta.test']);
    // each business has its own secret: ciphertext of one must not decrypt with the other's key
    const rtA = await mt.registry.runtimeFor((await mt.registry.list()).find((t) => t.slug === 'alpha')!);
    const rtB = await mt.registry.runtimeFor((await mt.registry.list()).find((t) => t.slug === 'beta')!);
    expect(() => rtB.services.crypto.decrypt(a.enc)).toThrow();
    expect(rtA.services.crypto.decrypt(a.enc)).toBe('x');
  });
});
