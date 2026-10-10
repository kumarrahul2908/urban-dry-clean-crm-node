import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
export interface UploadFile { field: string; filename: string; content: string | Buffer; type?: string }
export interface Client { get(path: string): Promise<Resp>; post(path: string, form: Record<string, string>, opts?: { csrf?: boolean }): Promise<Resp>; upload(path: string, form: Record<string, string>, file: UploadFile): Promise<Resp>; csrf(): string | null; cookie(): string }

const free = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

export const USERS = { admin: 'rahul', boss: 'boss', ws: 'wstaff', viewer: 'viewer', fixed: 'fixed', nobody: 'nobody', orphan: 'orphan', driver: 'driver' } as const;
export const PASSWORD = 'pw-12345-ok';

/** Real PHP (php -S) and the Node app on the SAME database; each `login()` gives an independent cookie jar per side. */
export function webHarness() {
  const dbEnv = {
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
  };
  const env = loadEnv({ NODE_ENV: 'test', ...dbEnv, APP_SECRET_KEY: 'k', APP_TIMEZONE: 'Asia/Kolkata', APP_URL: 'https://example.test', SESSION_LIFETIME_MINUTES: '120', UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'udc-web-uploads-')) } as NodeJS.ProcessEnv);
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

  type Send = (method: string, path: string, headers: Record<string, string>, form?: Record<string, string>, file?: UploadFile) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>;
  const mk = (send: Send): Client => {
    const jar = cookieJar();
    let token: string | null = null;
    const call = async (method: string, path: string, form?: Record<string, string>, file?: UploadFile): Promise<Resp> => {
      const r = await send(method, path, jar.header() ? { cookie: jar.header() } : {}, form, file);
      const sc = r.headers['set-cookie']; jar.absorb(Array.isArray(sc) ? sc : sc ? [sc] : []);
      const t = csrfOf(r.body); if (t) token = t;
      let loc = (r.headers.location as string | undefined) ?? null;
      return { status: r.status, location: loc, body: r.body, type: (r.headers['content-type'] as string | undefined)?.split(';')[0] ?? null };
    };
    return {
      get: (p) => call('GET', p),
      post: (p, form, o) => call('POST', p, o?.csrf === false ? form : { csrf_token: token ?? '', ...form }),
      upload: (p, form, file) => call('POST', p, { csrf_token: token ?? '', ...form }, file),
      csrf: () => token,
      cookie: () => jar.header(),
    };
  };

  const phpClient = () => mk(async (method, path, headers, form, file) => {
    let body: BodyInit | undefined;
    let ct: Record<string, string> = {};
    if (file) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form ?? {})) fd.set(k, v);
      fd.set(file.field, new Blob([new Uint8Array(Buffer.from(file.content))], { type: file.type ?? 'text/csv' }), file.filename);
      body = fd;
    } else if (form) { body = new URLSearchParams(form).toString(); ct = { 'content-type': 'application/x-www-form-urlencoded' }; }
    const r = await fetch(`http://127.0.0.1:${h.port}${path}`, { method, redirect: 'manual', headers: { ...headers, ...ct }, body });
    const headersObj: Record<string, string | string[] | undefined> = {};
    r.headers.forEach((v, k) => { headersObj[k] = v; });
    headersObj['set-cookie'] = r.headers.getSetCookie();
    return { status: r.status, headers: headersObj, body: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()) }; // keep a CSV's BOM
  });
  const nodeClient = () => mk(async (method, path, headers, form, file) => {
    let payload: string | Buffer | undefined;
    let ct: Record<string, string> = {};
    if (file) {
      const boundary = `----t${Math.random().toString(16).slice(2)}`;
      const parts: Buffer[] = [];
      for (const [k, v] of Object.entries(form ?? {})) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type ?? 'text/csv'}\r\n\r\n`), Buffer.from(file.content), Buffer.from(`\r\n--${boundary}--\r\n`));
      payload = Buffer.concat(parts);
      ct = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    } else if (form) { payload = new URLSearchParams(form).toString(); ct = { 'content-type': 'application/x-www-form-urlencoded' }; }
    const r = await h.app.inject({ method: method as 'GET' | 'POST', url: path, headers: { ...headers, ...ct }, payload });
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
export function normalizeHtml(s: string, appUrl: string, sortRows = false): string {
  const out = s
    .replace(/[0-9a-f]{64}/g, 'TOKEN')
    .replace(/\b[0-9a-f]{32}\b/g, 'TOKEN32')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/\s+\/>/g, '/>')
    .trim()
    .replaceAll(appUrl, 'BASE');
  return sortRows ? out.replace(/<tbody>([\s\S]*?)<\/tbody>/g, (_m, inner: string) => `<tbody>${(inner.match(/<tr[\s\S]*?<\/tr>/g) ?? [inner]).sort().join('')}</tbody>`) : out;
}

/** Fails with the first differing region (±160 chars) instead of dumping two whole pages. */
export function expectSameHtml(got: { status: number; location: string | null; body: string }, want: { status: number; location: string | null; body: string }, appUrl: string, label = '', sortRows = false) {
  const g = normalizeHtml(got.body, appUrl, sortRows), w = normalizeHtml(want.body, appUrl, sortRows);
  if (got.status !== want.status) throw new Error(`${label} status ${got.status} ≠ PHP ${want.status}`);
  if ((got.location ?? null) !== (want.location ?? null)) throw new Error(`${label} location ${got.location} ≠ PHP ${want.location}`);
  if (g === w) return;
  let i = 0;
  while (i < g.length && i < w.length && g[i] === w[i]) i++;
  throw new Error(`${label} HTML differs at char ${i}:\n  node: …${g.slice(Math.max(0, i - 120), i + 160)}\n  php : …${w.slice(Math.max(0, i - 120), i + 160)}`);
}
