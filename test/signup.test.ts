import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { approveSignup, validateSignup } from '../src/tenancy/signup.js';
import { initControlSchema } from '../src/tenancy/registry.js';
import { createMultiTenant, type MultiTenant } from '../src/tenancy/runtime.js';
import { resetAndSeed } from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });
const T = process.env.TEST_DB2_NAME, C = process.env.TEST_CONTROL_DB_NAME, AU = process.env.TEST_PROVISION_ADMIN_USER;
const on = !!(T && C && AU);
const KEY = 'master-key-for-tests';

describe.skipIf(!on)('public signup (root host → request → provisioning → login)', () => {
  // loadEnv/createPool below run eagerly (not inside a hook) - guard them so a skipped run never
  // touches an unset DB_NAME/CONTROL_DB_NAME. skipIf still collects this factory to report the
  // suite as skipped, so without this it would throw before the skip ever takes effect.
  if (!on) { it.skip('requires TEST_DB2_NAME / TEST_CONTROL_DB_NAME / TEST_PROVISION_ADMIN_USER', () => {}); return; }
  const base ={ DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_USER: process.env.TEST_DB_USER ?? '', DB_PASS: process.env.TEST_DB_PASS ?? '' };
  const mk = (auto: boolean) => loadEnv({ NODE_ENV: 'test', ...base, DB_NAME: T!, CONTROL_DB_NAME: C!, CONTROL_MASTER_KEY: KEY, APP_SECRET_KEY: 'unused', UPLOAD_DIR: '/tmp/udc-mt-uploads', TENANT_UPLOAD_ROOT: '/tmp/udc-mt-uploads',
    PROVISION_DB_USER: AU, PROVISION_DB_PASS: process.env.TEST_PROVISION_ADMIN_PASS ?? '', CONTROL_ROOT_HOST: 'root.test', TENANT_BASE_DOMAIN: 'apps.test', SIGNUP_TEMPLATE_DB: T!, SIGNUP_AUTO_APPROVE: auto ? 'true' : 'false', SIGNUP_TRIAL_DAYS: '14' } as NodeJS.ProcessEnv);
  const env = mk(false);
  const tmpl = createPool({ ...env, DB_NAME: T! }), ctl = createPool({ ...env, DB_NAME: C! }), adm = createPool({ ...env, DB_NAME: 'information_schema', DB_USER: AU!, DB_PASS: process.env.TEST_PROVISION_ADMIN_PASS ?? '' });
  const dbs = ['udc_t_sg1', 'udc_t_sg2'];
  const dropAll = async () => { for (const n of dbs) { await adm.db.execute(`DROP DATABASE IF EXISTS ${n}`); for (const h of ['%', 'localhost', '127.0.0.1']) await adm.db.execute(`DROP USER IF EXISTS '${n.replace('udc_t_', 'udc_')}'@'${h}'`); } };
  let mtManual: MultiTenant, mtAuto: MultiTenant; let appManual: Awaited<ReturnType<typeof buildApp>>, appAuto: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await dropAll();
    await resetAndSeed(tmpl.db);
    await tmpl.db.execute("INSERT INTO roles (id, role_name) VALUES (3, 'Super Admin')");
    await ctl.db.execute('SET FOREIGN_KEY_CHECKS = 0'); for (const t of ['tenant_domains', 'tenants', 'tenant_events', 'signup_requests']) await ctl.db.execute(`DROP TABLE IF EXISTS ${t}`);
    await initControlSchema(ctl.db);
    mtManual = createMultiTenant(env); appManual = await buildApp(mtManual.services, mtManual); await appManual.ready();
    mtAuto = createMultiTenant(mk(true)); appAuto = await buildApp(mtAuto.services, mtAuto); await appAuto.ready();
  });
  afterAll(async () => { await appManual?.close(); await appAuto?.close(); await mtManual?.close(); await mtAuto?.close(); await dropAll(); await Promise.all([tmpl.close(), ctl.close(), adm.close()]); });

  const token = (ageMs = 5000) => { const ts = String(Date.now() - ageMs); return `${ts}.${createHmac('sha256', KEY).update('signup:' + ts).digest('base64url')}`; };
  const post = (app: typeof appManual, form: Record<string, string>, t = token()) => app.inject({ method: 'POST', url: '/signup', headers: { host: 'root.test', 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ t, website: '', ...form }).toString() });
  const good = (slug: string) => ({ business_name: 'Sparkle Cleaners', owner_name: 'Asha', mobile: '9876543210', email: 'asha@example.com', slug, password: 'asha-pass-1', password2: 'asha-pass-1' });

  it('validation rules', () => {
    const f = { business_name: 'A', owner_name: '', mobile: '12', email: 'x', slug: 'www', password: 'short', password2: 'other' };
    expect(validateSignup(f).length).toBeGreaterThanOrEqual(6);
    expect(validateSignup({ ...f, business_name: 'Ab', owner_name: 'Om', mobile: '9876543210', email: 'a@b.co', slug: 'good-name', password: 'longenough', password2: 'longenough' })).toEqual([]);
  });
  it('root host: signup page works, everything else 404; tenant hosts unaffected', async () => {
    const g = await appManual.inject({ method: 'GET', url: '/signup', headers: { host: 'root.test' } });
    expect(g.statusCode).toBe(200); expect(g.body).toContain('.apps.test');
    expect((await appManual.inject({ method: 'GET', url: '/modules/auth/login.php', headers: { host: 'root.test' } })).statusCode).toBe(404);
    expect((await appManual.inject({ method: 'GET', url: '/signup', headers: { host: 'nobody.apps.test' } })).statusCode).toBe(404);
  });
  it('bot protections: honeypot, forged/expired/too-fast token, invalid input', async () => {
    expect((await post(appManual, { ...good('sg1'), website: 'spam' })).statusCode).toBe(400);
    expect((await post(appManual, good('sg1'), 'forged.token')).statusCode).toBe(400);
    expect((await post(appManual, good('sg1'), token(3 * 3600_000))).statusCode).toBe(400);
    expect((await post(appManual, good('sg1'), token(10))).statusCode).toBe(400);
    const bad = await post(appManual, { ...good('sg1'), email: 'nope', password2: 'x' });
    expect(bad.statusCode).toBe(422); expect(bad.body).toContain('valid email');
  });
  it('manual approval: request is parked, then `approve` provisions and the owner can log in', async () => {
    const r = await post(appManual, good('sg1'));
    expect(r.statusCode).toBe(200); expect(r.body).toContain('We will contact you');
    const req = (await ctl.db.query<any>("SELECT * FROM signup_requests WHERE slug = 'sg1'"))[0];
    expect(req.status).toBe('pending'); expect(req.password_hash).not.toContain('asha-pass-1');
    expect((await post(appManual, good('sg1'))).body).toContain('already taken'); // duplicate slug while pending
    const out = await approveSignup(env, mtManual.registry, req.id);
    expect(out.host).toBe('sg1.apps.test');
    expect((await ctl.db.query<any>('SELECT status, trial_ends_at FROM tenants WHERE slug = "sg1"'))[0].status).toBe('trial');
    const g = await appManual.inject({ method: 'GET', url: '/modules/auth/login.php', headers: { host: 'sg1.apps.test' } });
    const csrf = /name="csrf_token" value="([0-9a-f]{64})"/.exec(g.body)?.[1] ?? '';
    const sc = ([] as string[]).concat(g.headers['set-cookie'] as string[] | string).map((c) => c.split(';')[0]).join('; ');
    const p = await appManual.inject({ method: 'POST', url: '/modules/auth/login.php', headers: { host: 'sg1.apps.test', cookie: sc, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ csrf_token: csrf, username: 'owner', password: 'asha-pass-1' }).toString() });
    expect(p.statusCode).toBe(302);
    await expect(approveSignup(env, mtManual.registry, req.id)).rejects.toThrow(/already approved/);
  });
  it('auto-approve: provisioned instantly and redirected to the new business', async () => {
    const r = await post(appAuto, good('sg2'));
    expect(r.statusCode).toBe(302); expect(String(r.headers.location)).toBe('https://sg2.apps.test/modules/auth/login.php');
    expect((await ctl.db.query<any>("SELECT status FROM signup_requests WHERE slug = 'sg2'"))[0].status).toBe('approved');
  });
});
