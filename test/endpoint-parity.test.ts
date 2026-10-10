import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { resetAndSeed } from './helpers.js';

/**
 * Endpoint-level PHP ↔ Node parity: the REAL api/mobile/<name>.php (run through test/parity/endpoint.php)
 * and the Node route are called with the same token + query on the SAME seeded database; status code
 * and JSON body must match. See docs/PARITY.md.
 */
const PHP_APP = process.env.PARITY_PHP_APP;
const enabled = !!PHP_APP && !!process.env.TEST_DB_NAME;

const TOKENS = { admin: 'a'.repeat(64), boss: 'b'.repeat(64), ws: 'c'.repeat(64), viewer: 'd'.repeat(64) } as const;
type Who = keyof typeof TOKENS;
interface Case { name: string; endpoint: string; who?: Who; method?: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown }

describe.skipIf(!enabled)('endpoint parity (real api/mobile/*.php vs Node)', () => {
  const dbEnv = {
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
  };
  const env = loadEnv({ NODE_ENV: 'test', ...dbEnv, APP_SECRET_KEY: 'k', APP_TIMEZONE: 'Asia/Kolkata', APP_URL: 'https://example.test' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;

  const runPhp = (c: Case) => {
    const out = execFileSync('php', [`${PHP_APP}/endpoint.php`], {
      input: JSON.stringify({ name: c.endpoint, method: c.method ?? 'GET', query: c.query ?? {}, body: c.body !== undefined ? JSON.stringify(c.body) : null, token: TOKENS[c.who ?? 'admin'] }),
      env: { ...process.env, UDC_DB_HOST: dbEnv.DB_HOST, UDC_DB_PORT: dbEnv.DB_PORT, UDC_DB_NAME: dbEnv.DB_NAME, UDC_DB_USER: dbEnv.DB_USER, UDC_DB_PASS: dbEnv.DB_PASS },
    }).toString();
    const m = /^([\s\S]*)\n@@STATUS:(\d+)$/.exec(out);
    if (!m) throw new Error(`PHP gave no status: ${out.slice(0, 400)}`);
    let body: unknown;
    try { body = JSON.parse(m[1]!); } catch { throw new Error(`PHP gave non-JSON for ${c.name}: ${m[1]!.slice(0, 400)}`); }
    return { status: Number(m[2]), body };
  };
  const runNode = async (c: Case) => {
    const qs = c.query ? `?${new URLSearchParams(c.query)}` : '';
    const r = await app.inject({
      method: c.method ?? 'GET', url: `/api/mobile/${c.endpoint}.php${qs}`,
      headers: { authorization: `Bearer ${TOKENS[c.who ?? 'admin']}` }, ...(c.body !== undefined ? { payload: c.body as object } : {}),
    });
    return { status: r.statusCode, body: r.json() };
  };
  /** Numbers and numeric strings compare equal (PHP's PDO returned strings for many columns). */
  const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) && x.trim() === x && !/^0\d/.test(x) ? Number(x) : x)));

  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon).map((x) => JSON.stringify(x)).sort() : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)])) : v);
  const sameMultiset = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const check = async (c: Case, tweak: (b: any) => any = (b) => b) => {
    const php = runPhp(c);
    const node = await runNode(c);
    const got = { status: node.status, body: norm(tweak(node.body)) };
    const want = { status: php.status, body: norm(tweak(php.body)) };
    try {
      expect(got, c.name).toEqual(want);
    } catch (e) {
      // SQL ORDER BY ties (same second / same NULL key) come back in unspecified order from MariaDB on every
      // execution, for PHP as much as for Node. Accept a difference ONLY in the order of tied rows: same multiset.
      if (!sameMultiset(got, want)) throw e;
    }
    return php;
  };

  beforeAll(async () => {
    await resetAndSeed(db);
    const perms = ['dashboard.view', 'reports.view', 'payments.view', 'payments.collect', 'accounts.view', 'customers.view', 'audit.view', 'pos.create', 'orders.view'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (3, 'Super Admin'), (4, 'Workshop Staff'), (5, 'Nobody')");
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${[1, 3].flatMap((r) => perms.map((_, i) => `(${r}, ${i + 1})`)).join(',')}, (4, 1)`);
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (3, 3, 'Boss', 'boss', 'x', NULL, 1), (4, 4, 'Ws', 'ws', 'x', 1, 1), (5, 5, 'Nobody', 'nobody', 'x', 1, 1)");
    await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (2, 1, 'Branch', 'branch', 1)");
    const tok = (id: number, t: string) => db.execute("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL 1 DAY)", [id, createHash('sha256').update(t).digest('hex')]);
    await tok(1, TOKENS.admin); await tok(3, TOKENS.boss); await tok(4, TOKENS.ws); await tok(5, TOKENS.viewer);
    await db.execute('UPDATE users SET password_hash = ?', [await hashPassword('x')]);

    const svc = buildServices(env, db);
    app = await buildApp(svc);
    const A = { userId: 1 };
    const line = (g: number, s: number, q = 1) => ({ garment_id: g, service_id: s, quantity: q });
    const mk = async (customer: number, items: object[], extra: object = {}, store = 1) => {
      const r = await svc.orders.createOrder({ customer_id: customer, items, ...extra }, A, true, store, true);
      if (!r.success) throw new Error(JSON.stringify(r.errors));
      return r.order_id as number;
    };
    const o1 = await mk(1, [line(1, 1, 3), line(2, 1)], { urgent_level_id: 1, payments: [{ payment_type_id: 1, amount: 300 }] });
    const o2 = await mk(2, [line(1, 2, 4)], { payments: [{ payment_type_id: 2, amount: 100 }] });
    const o3 = await mk(1, [line(2, 2, 2), line(1, 1)]);
    const o4 = await mk(2, [line(2, 1, 2)], { discount_type: 'Percent', discount_value: 5 });
    const o5 = await mk(1, [line(1, 1, 2)], {}, 2);
    const lo = await svc.orders.createLaundryOrder({ customer_id: 2, batches: [{ service_id: 3, weight: 4.2, rate: 61.37, garment_count: 2, garments: [{ garment_id: 1, quantity: 2 }] }] }, A, true, 1);
    await svc.orders.recordPayment(o3, 1, [{ payment_type_id: 1, amount: 50 }], 0, A);
    await svc.orders.processRefund(o1, 20, [{ payment_type_id: 1, amount: 20 }], false, 'damaged', '', A);
    // spread dates / statuses
    await db.execute("UPDATE orders SET status_id = 4, order_date = NOW() - INTERVAL 1 DAY, due_date = CURDATE() WHERE id = ?", [o1]);
    await db.execute("UPDATE orders SET status_id = 12, due_date = CURDATE() - INTERVAL 1 DAY WHERE id = ?", [o2]);
    await db.execute("UPDATE orders SET status_id = 5, order_date = NOW() - INTERVAL 10 DAY, due_date = CURDATE() - INTERVAL 3 DAY WHERE id = ?", [o3]);
    await db.execute("UPDATE order_items SET item_status = 'Workshop' WHERE order_id = ?", [o3]);
    await db.execute("UPDATE orders SET status_id = 9, order_date = NOW() - INTERVAL 40 DAY, due_date = CURDATE() + INTERVAL 2 DAY WHERE id = ?", [o4]);
    await db.execute("UPDATE order_items SET item_status = 'Ready' WHERE order_id = ?", [o4]);
    await db.execute("UPDATE orders SET status_id = 6, due_date = CURDATE() WHERE id = ?", [o5]);
    await db.execute("UPDATE orders SET due_time = '09:00:00' WHERE id = ?", [o1]);
    await db.execute("UPDATE orders SET due_time = '11:30:00' WHERE id = ?", [o5]);
    await db.execute("UPDATE order_items SET item_status = 'Processing' WHERE order_id = ?", [o5]);
    await db.execute("UPDATE orders SET due_date = CURDATE() - INTERVAL 60 DAY WHERE id = ?", [lo.order_id]);
    await db.execute("UPDATE customers SET birthday = DATE_FORMAT(CURDATE() + INTERVAL 2 DAY, '1990-%m-%d'), anniversary = DATE_FORMAT(CURDATE() + INTERVAL 5 DAY, '2015-%m-%d') WHERE id = 1");
    await db.execute("INSERT INTO pickup_orders (pickup_number, customer_id, address, pickup_date, pickup_time, garment_count, status) VALUES ('P1', 1, 'Somewhere', CURDATE(), '10:00', 3, 'Scheduled'), ('P2', 2, 'Elsewhere', CURDATE(), NULL, NULL, 'Requested')");
    await db.execute("INSERT INTO delivery_orders (delivery_number, order_id, customer_id, delivery_date, status, amount_due) VALUES ('D1', ?, 1, CURDATE(), 'Pending', 10), ('D2', ?, 1, CURDATE(), 'Delivered', 0)", [o1, o5]);
    await db.execute("INSERT INTO feedback (customer_id, order_id, rating, comments) VALUES (1, ?, 5, 'great'), (2, NULL, 2, 'slow')", [o1]);
    await db.execute("INSERT INTO qc_records (order_item_id, result, checked_at) VALUES (1, 'Passed', NOW()), (2, 'Failed', NOW()), (3, 'Rework', NOW())");
    await db.execute("INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value, ip_address) VALUES (1, 'edit', 'customers', '1', '{\"mobile\":\"9876543210\",\"email\":\"rahul@example.com\",\"address\":\"12 Street\",\"password_hash\":\"$2y$10$abc\",\"nested\":{\"api_key\":\"zzz\",\"note\":\"ok\"},\"list\":[1,{\"token\":\"t\"}],\"empty\":{}}', 'plain text with 9876543210 inside', '10.0.0.1'), (NULL, 'login', 'auth', NULL, NULL, 'Bearer abcdef', NULL), (3, 'delete', 'orders', '99', 'my password is x', '\"just a string\"', '')");
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  const cases: Case[] = [
    ...(['admin', 'boss'] as Who[]).flatMap((who): Case[] => [
      { name: `dashboard_summary/${who}`, endpoint: 'dashboard_summary', who },
      { name: `daily_dashboard/${who}`, endpoint: 'daily_dashboard', who },
      { name: `daily_dashboard/${who}/date`, endpoint: 'daily_dashboard', who, query: { date: new Date(Date.now() - 86400000).toISOString().slice(0, 10) } },
      { name: `reports_summary/${who}`, endpoint: 'reports_summary', who },
      { name: `reports_summary/${who}/range`, endpoint: 'reports_summary', who, query: { date_from: '2020-01-01', date_to: '2099-12-31' } },
    ]),
    { name: 'daily_dashboard bad date', endpoint: 'daily_dashboard', query: { date: 'garbage' } },
    { name: 'reports bad dates', endpoint: 'reports_summary', query: { date_from: 'x', date_to: 'y' } },
    { name: 'daily_collection', endpoint: 'daily_collection' },
    { name: 'daily_collection filters', endpoint: 'daily_collection', query: { payment_type_id: '1', staff_id: '1', customer: 'Vip', order: 'UDC' } },
    { name: 'daily_collection other date', endpoint: 'daily_collection', query: { date: '2020-01-01' } },
    { name: 'outstanding_list', endpoint: 'outstanding_list' },
    { name: 'outstanding_list filtered', endpoint: 'outstanding_list', query: { customer: 'Plain', min_amount: '10' } },
    { name: 'outstanding_list ageing', endpoint: 'outstanding_list', query: { ageing: '1-7 days' } },
    { name: 'outstanding_list ageing 90', endpoint: 'outstanding_list', query: { ageing: '90+ days', min_amount: 'abc' } },
    { name: 'customer_history 1', endpoint: 'customer_history', query: { id: '1' } },
    { name: 'customer_history 2', endpoint: 'customer_history', query: { id: '2' } },
    { name: 'customer_history missing', endpoint: 'customer_history', query: { id: '999' } },
    { name: 'customer_history bad id', endpoint: 'customer_history', query: { id: '0' } },
    { name: 'audit_logs', endpoint: 'audit_logs', who: 'boss' },
    { name: 'audit_logs options', endpoint: 'audit_logs', who: 'boss', query: { options: '1', per_page: '5', page: '2' } },
    { name: 'audit_logs filters', endpoint: 'audit_logs', who: 'boss', query: { module: 'customers', action: 'edit', user_id: '1', record_id: '1', date_from: '2020-01-01', date_to: '2099-01-01' } },
    { name: 'audit_logs invalid', endpoint: 'audit_logs', who: 'boss', query: { module: 'BAD!', user_id: '0', date_from: '2026-02-30', per_page: '1000', page: '0' } },
    { name: 'audit_logs date order', endpoint: 'audit_logs', who: 'boss', query: { date_from: '2026-12-01', date_to: '2026-01-01' } },
    { name: 'audit_logs admin role (allowed)', endpoint: 'audit_logs', who: 'admin' },
    { name: 'audit_logs viewer (forbidden)', endpoint: 'audit_logs', who: 'viewer' },
    { name: 'workshop staff blocked', endpoint: 'dashboard_summary', who: 'ws' },
    { name: 'workshop staff blocked 2', endpoint: 'daily_dashboard', who: 'ws' },
    { name: 'no permission', endpoint: 'reports_summary', who: 'viewer' },
    { name: 'no permission 2', endpoint: 'outstanding_list', who: 'viewer' },
  ];
  for (const c of cases) it(c.name, async () => { await check(c); });
});
