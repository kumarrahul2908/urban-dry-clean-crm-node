import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll } from 'vitest';
import { buildApp, buildServices } from '../../src/app.js';
import { loadEnv } from '../../src/config/env.js';
import { createPool, type Db } from '../../src/db/pool.js';
import { hashPassword } from '../../src/lib/password.js';
import { resetAndSeed } from '../helpers.js';
import { buildDataset, TOKENS } from './dataset.js';

export const PHP_APP = process.env.PARITY_PHP_APP;
export const webEnabled = !!PHP_APP && !!process.env.TEST_DB_NAME;

export interface Resp { status: number; location: string | null; body: string; type: string | null }
export interface Client { get(path: string): Promise<Resp>; post(path: string, form: Record<string, string>, opts?: { csrf?: boolean }): Promise<Resp>; csrf(): string | null; cookie(): string }

const free = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

export const USERS = { admin: 'rahul', boss: 'boss', ws: 'wstaff', viewer: 'viewer', fixed: 'fixed', nobody: 'nobody', orphan: 'orphan', driver: 'driver' } as const;
export const PASSWORD = 'pw-12345-ok';

/** Real PHP (php -S) and the Node app on the SAME database; each `login()` gives an independent cookie jar per side. */
export function webHarness() {
  const dbEnv = {
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
  };
  const env = loadEnv({ NODE_ENV: 'test', ...dbEnv, APP_SECRET_KEY: 'k', APP_TIMEZONE: 'Asia/Kolkata', APP_URL: 'https://example.test', SESSION_LIFETIME_MINUTES: '120' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  const h = { db, env, app: null as unknown as Awaited<ReturnType<typeof buildApp>>, port: 0, php: null as ChildProcess | null };

  beforeAll(async () => {
    h.port = await free();
    h.php = spawn('php', ['-S', `127.0.0.1:${h.port}`, '-t', PHP_APP!], {
      env: { ...process.env, UDC_DB_HOST: dbEnv.DB_HOST, UDC_DB_PORT: dbEnv.DB_PORT, UDC_DB_NAME: dbEnv.DB_NAME, UDC_DB_USER: dbEnv.DB_USER, UDC_DB_PASS: dbEnv.DB_PASS },
      stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${h.port}/assets/css/app.css`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    h.app = await buildApp(buildServices(env, db, { navShowAll: true }));
    await h.app.ready();
  });
  afterAll(async () => { h.php?.kill(); await h.app?.close(); await close(); });

  const cookieJar = () => {
    const jar: Record<string, string> = {};
    return {
      absorb(setCookie: string[]) { for (const c of setCookie) { const [kv] = c.split(';'); const i = kv!.indexOf('='); const k = kv!.slice(0, i); const v = kv!.slice(i + 1); if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(c) || v === '' || v === 'deleted') delete jar[k]; else jar[k] = v; } },
      header: () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
    };
  };
  const csrfOf = (html: string) => /name="csrf-token" content="([0-9a-f]{64})"/.exec(html)?.[1] ?? /name="csrf_token" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? null;

  const mk = (send: (method: string, path: string, headers: Record<string, string>, form?: Record<string, string>) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>): Client => {
    const jar = cookieJar();
    let token: string | null = null;
    const call = async (method: string, path: string, form?: Record<string, string>): Promise<Resp> => {
      const r = await send(method, path, jar.header() ? { cookie: jar.header() } : {}, form);
      const sc = r.headers['set-cookie']; jar.absorb(Array.isArray(sc) ? sc : sc ? [sc] : []);
      const t = csrfOf(r.body); if (t) token = t;
      let loc = (r.headers.location as string | undefined) ?? null;
      return { status: r.status, location: loc, body: r.body, type: (r.headers['content-type'] as string | undefined)?.split(';')[0] ?? null };
    };
    return {
      get: (p) => call('GET', p),
      post: (p, form, o) => call('POST', p, o?.csrf === false ? form : { csrf_token: token ?? '', ...form }),
      csrf: () => token,
      cookie: () => jar.header(),
    };
  };

  const phpClient = () => mk(async (method, path, headers, form) => {
    const r = await fetch(`http://127.0.0.1:${h.port}${path}`, {
      method, redirect: 'manual', headers: { ...headers, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const headersObj: Record<string, string | string[] | undefined> = {};
    r.headers.forEach((v, k) => { headersObj[k] = v; });
    headersObj['set-cookie'] = r.headers.getSetCookie();
    return { status: r.status, headers: headersObj, body: await r.text() };
  });
  const nodeClient = () => mk(async (method, path, headers, form) => {
    const r = await h.app.inject({
      method: method as 'GET' | 'POST', url: path, headers: { ...headers, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      payload: form ? new URLSearchParams(form).toString() : undefined,
    });
    return { status: r.statusCode, headers: r.headers as Record<string, string | string[] | undefined>, body: r.body };
  });

  async function seed(extra?: (db: Db) => Promise<void>) {
    await resetAndSeed(db);
    const perms = ['dashboard.view', 'customers.view', 'packing.manage', 'pos.create', 'orders.view', 'payments.collect', 'workshop.manage', 'audit.view', 'admin.settings', 'users.manage'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (3, 'Super Admin'), (4, 'Workshop Staff'), (5, 'Cashier')");
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${perms.map((_, i) => `(3, ${i + 1})`).join(',')}, (1, 1), (1, 2), (1, 3), (1, 4), (1, 5), (1, 8), (4, 7), (5, 1)`);
    const hash = await hashPassword(PASSWORD);
    await db.execute('UPDATE users SET password_hash = ?, full_name = \'Rahul <Admin>\' WHERE id = 1', [hash]);
    await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (2, 1, 'Branch & Co', 'branch', 1), (3, 1, 'Closed', 'branch', 0)");
    await db.execute("INSERT INTO users (id, role_id, full_name, username, email, password_hash, store_id, is_active) VALUES (3, 3, 'Boss', 'boss', 'boss@example.com', ?, NULL, 1), (4, 4, 'Ws', 'wstaff', NULL, ?, NULL, 1), (5, 5, 'View', 'viewer', NULL, ?, 1, 1), (6, 1, 'Fixed', 'fixed', NULL, ?, 2, 1)", [hash, hash, hash, hash]);
    await extra?.(db);
  }

  /** The big shared fixture (orders in every state, payments, pickups, workshop …); users: rahul(store 1) boss(no store) wstaff nobody orphan driver. */
  async function seedRich(extra?: (db: Db) => Promise<void>) {
    await buildDataset(db, env, TOKENS, PASSWORD);
    await extra?.(db);
  }

  async function login(who: keyof typeof USERS | null) {
    const php = phpClient(), node = nodeClient();
    if (who) for (const c of [php, node]) {
      await c.get('/modules/auth/login.php');
      const r = await c.post('/modules/auth/login.php', { username: USERS[who], password: PASSWORD });
      if (r.status !== 302) throw new Error(`login failed for ${who}: ${r.status} ${r.body.slice(0, 200)}`);
    }
    return { php, node };
  }
  return { h, seed, seedRich, login, phpClient, nodeClient };
}

/** Makes two pages comparable: random tokens, comments and insignificant whitespace are removed. */
export function normalizeHtml(s: string, appUrl: string): string {
  return s
    .replace(/[0-9a-f]{64}/g, 'TOKEN')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/\s+\/>/g, '/>')
    .trim()
    .replaceAll(appUrl, 'BASE');
}

/** Fails with the first differing region (±160 chars) instead of dumping two whole pages. */
export function expectSameHtml(got: { status: number; location: string | null; body: string }, want: { status: number; location: string | null; body: string }, appUrl: string, label = '') {
  const g = normalizeHtml(got.body, appUrl), w = normalizeHtml(want.body, appUrl);
  if (got.status !== want.status) throw new Error(`${label} status ${got.status} ≠ PHP ${want.status}`);
  if ((got.location ?? null) !== (want.location ?? null)) throw new Error(`${label} location ${got.location} ≠ PHP ${want.location}`);
  if (g === w) return;
  let i = 0;
  while (i < g.length && i < w.length && g[i] === w[i]) i++;
  throw new Error(`${label} HTML differs at char ${i}:\n  node: …${g.slice(Math.max(0, i - 120), i + 160)}\n  php : …${w.slice(Math.max(0, i - 120), i + 160)}`);
}
