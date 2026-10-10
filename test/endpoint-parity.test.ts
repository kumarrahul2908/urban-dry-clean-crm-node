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

const TOKENS = { admin: 'a'.repeat(64), boss: 'b'.repeat(64), ws: 'c'.repeat(64), viewer: 'd'.repeat(64), driver: 'e'.repeat(64) } as const;
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

  async function buildDataset() {
    await resetAndSeed(db);
    const perms = ['dashboard.view', 'reports.view', 'payments.view', 'payments.collect', 'accounts.view', 'customers.view', 'audit.view', 'pos.create', 'orders.view', 'feedback.manage', 'expenses.manage', 'notifications.manage', 'garment.view', 'garment.create', 'garment.edit', 'garment.delete', 'garments.manage', 'garment_tags.view', 'qc.manage', 'rework.manage', 'packing.manage', 'pickup.manage', 'delivery.manage', 'workshop.manage'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (3, 'Super Admin'), (4, 'Workshop Staff'), (5, 'Nobody')");
    const rolePerms = [1, 3].flatMap((r) => perms.map((k, i) => ({ r, i: i + 1, k }))).filter((x) => !(x.r === 1 && ['garment.delete', 'garments.manage'].includes(x.k)));
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${rolePerms.map((x) => `(${x.r}, ${x.i})`).join(',')}, (4, 1)`);
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (3, 3, 'Boss', 'boss', 'x', NULL, 1), (4, 4, 'Ws', 'ws', 'x', 1, 1), (5, 5, 'Nobody', 'nobody', 'x', 1, 1)");
    await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (2, 1, 'Branch', 'branch', 1)");
    const tok = (id: number, t: string) => db.execute("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL 1 DAY)", [id, createHash('sha256').update(t).digest('hex')]);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (6, 'Delivery Driver')");
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (6, 6, 'Driver', 'driver', 'x', 1, 1)");
    await db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 6, id FROM permissions WHERE permission_key IN ('delivery.manage')");
    await tok(6, TOKENS.driver);
    await tok(1, TOKENS.admin); await tok(3, TOKENS.boss); await tok(4, TOKENS.ws); await tok(5, TOKENS.viewer);
    await db.execute('UPDATE users SET password_hash = ?', [await hashPassword('x')]);

    const svc = buildServices(env, db);
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
    await db.execute("INSERT INTO expense_categories (id, category_name, is_active) VALUES (1, 'Rent', 1), (2, 'Fuel', 1), (3, 'Old', 0)");
    await db.execute("INSERT INTO expenses (expense_date, category_id, description, amount, payment_mode, vendor, remarks, created_by) VALUES (CURDATE(), 1, 'shop rent', 15000, 'Cash', 'Landlord', NULL, 1), (CURDATE() - INTERVAL 2 DAY, 2, 'diesel', 1234.5, 'UPI', NULL, 'van', 3), (DATE_FORMAT(CURDATE(), '%Y-%m-01'), 1, 'rent adv', 500, NULL, NULL, NULL, 1)");
    await db.execute("INSERT INTO income (income_date, source, description, amount, payment_mode, created_by) VALUES (CURDATE(), 'Scrap', 'hangers', 300, 'Cash', 1), (CURDATE(), 'Scrap', 'boxes', 120.25, NULL, 3)");
    await db.execute("INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, message, status, is_read) VALUES (1, NULL, NULL, 'a', 'In-App', 'shared unread', 'Sent', 0), (1, NULL, 1, 'b', 'In-App', 'mine unread', 'Sent', 0), (2, NULL, 3, 'c', 'In-App', 'boss only', 'Sent', 0), (2, NULL, 1, 'd', 'In-App', 'mine read', 'Sent', 1), (NULL, NULL, NULL, 'e', 'WhatsApp', 'not in-app', 'Sent', 0)");
    await db.execute("INSERT INTO feedback (customer_id, order_id, rating, comments, status) VALUES (2, NULL, 4, 'ok', 'Reviewed'), (1, NULL, 1, 'bad', 'Resolved')");
    // ---- operations data: items waiting at QC / in rework / ready; laundry garments at QC
    await db.execute("UPDATE order_items SET item_status = 'QC' WHERE order_id = ? ", [o3]);          // o3: 2 items at QC
    await db.execute("UPDATE order_items SET item_status = 'Rework' WHERE id = ?", [(await db.query<any>('SELECT MIN(id) AS i FROM order_items WHERE order_id = ?', [o2]))[0].i]);
    await db.execute("UPDATE order_items SET item_status = 'Ready' WHERE order_id = ?", [o4]);
    const rwItem = (await db.query<any>("SELECT id FROM order_items WHERE item_status = 'Rework' LIMIT 1"))[0].id;
    await db.execute("INSERT INTO rework_records (order_item_id, reason, rework_date, status) VALUES (?, 'stain', CURDATE(), 'Pending')", [rwItem]);
    const lgs = await db.query<any>('SELECT id FROM laundry_garments ORDER BY id');
    for (const g of lgs) await db.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, module) VALUES (?, 'Pending', 'QC', 1, NOW() - INTERVAL 1 HOUR, 'workshop')", [g.id]);
    await db.execute("INSERT INTO rework_records (laundry_garment_id, reason, rework_date, status) VALUES (?, 'crease', CURDATE(), 'In Progress')", [lgs[0].id]);
    await db.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, module) VALUES (?, 'QC', 'Rework', 1, NOW(), 'qc')", [lgs[0].id]);
  }
  beforeAll(async () => {
    await buildDataset();
    app = await buildApp(buildServices(env, db));
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
    { name: 'feedback_list', endpoint: 'feedback_list' },
    { name: 'feedback_list filters', endpoint: 'feedback_list', query: { rating: '4', status: 'Reviewed', customer: 'Plain' } },
    { name: 'feedback_list orders_for_customer', endpoint: 'feedback_list', query: { orders_for_customer: '1' } },
    { name: 'expenses_list', endpoint: 'expenses_list' },
    { name: 'expenses_list filtered', endpoint: 'expenses_list', query: { from: '2020-01-01', to: '2099-01-01', category_id: '1', q: 'rent' } },
    { name: 'expenses_list swapped range', endpoint: 'expenses_list', query: { from: '2099-01-01', to: '2020-01-01' } },
    { name: 'expenses_list income', endpoint: 'expenses_list', query: { type: 'income' } },
    { name: 'expenses_list bad type', endpoint: 'expenses_list', query: { type: 'x' } },
    { name: 'notifications_list', endpoint: 'notifications_list' },
    { name: 'notifications_list unread boss', endpoint: 'notifications_list', who: 'boss', query: { filter: 'unread' } },
    { name: 'feedback no permission', endpoint: 'feedback_list', who: 'viewer' },
  ];
  for (const c of cases) it(c.name, async () => { await check(c); });

  // ---- write endpoints: same dataset, same calls, compare responses AND resulting rows ----------------
  const TIME_KEYS = new Set(['created_at', 'updated_at', 'read_at', 'checked_at']);
  const strip = (v: any): any => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !TIME_KEYS.has(k)).map(([k, x]) => [k, strip(x)])) : v);
  async function state() {
    const q = (sql: string) => db.query<any>(sql).then((r) => r.map(strip));
    return norm({
      feedback: await q('SELECT id, customer_id, order_id, rating, comments, status FROM feedback ORDER BY id'),
      garments: await q('SELECT * FROM garments ORDER BY id'),
      items: await q('SELECT id, order_id, item_status FROM order_items ORDER BY id'),
      qc: await q('SELECT id, order_item_id, laundry_garment_id, checked_by, result, reason, remarks FROM qc_records ORDER BY id'),
      rework: await q('SELECT id, order_item_id, laundry_garment_id, qc_record_id, reason, rework_date, status FROM rework_records ORDER BY id'),
      pickups: await q('SELECT id, pickup_number, customer_id, order_id, address, area, pincode, pickup_date, pickup_time, garment_count, notes, driver_id, status, created_by FROM pickup_orders ORDER BY id'),
      deliveries: await q('SELECT id, delivery_number, order_id, customer_id, phone, address, amount_due, delivery_date, time_slot, driver_id, status, payment_collected, remarks, created_by FROM delivery_orders ORDER BY id'),
      orderStatus: await q('SELECT id, status_id FROM orders ORDER BY id'),
      history: await q('SELECT id, order_item_id, laundry_garment_id, previous_status, new_status, changed_by, remarks, module FROM garment_status_history ORDER BY id'),
      expenses: await q('SELECT * FROM expenses ORDER BY id'),
      income: await q('SELECT * FROM income ORDER BY id'),
      notifications: await q('SELECT id, user_id, template_key, channel, message, is_read FROM notification_logs ORDER BY id'),
      audit: (await q('SELECT user_id, action, module, record_id, old_value, new_value FROM audit_logs WHERE module IN ("feedback","expenses","income","garments","qc_records","rework_records","order_items","pickup_orders","delivery_orders")  ORDER BY id'))
        .map((a: any) => ({ ...a, user_id: a.action === 'lookup' ? null : a.user_id, old_value: a.old_value ? strip(JSON.parse(a.old_value)) : null, new_value: a.new_value ? strip(JSON.parse(a.new_value)) : null })),
    });
  }
  const scenario = (name: string, calls: Case[], prepare?: () => Promise<void>) =>
    it(name, async () => {
      await buildDataset();
      await prepare?.();
      const phpOut = calls.map((c) => runPhp(c));
      if (process.env.DEBUG_SCENARIO) calls.forEach((c, i) => console.log(`[${name.slice(0, 12)}] ${c.endpoint} ${JSON.stringify(c.body ?? c.query)} => ${phpOut[i]!.status} ${JSON.stringify(phpOut[i]!.body).slice(0, 160)}`));
      const phpState = await state();
      await buildDataset();
      await prepare?.();
      const nodeOut: any[] = [];
      for (const c of calls) nodeOut.push(await runNode(c));
      const nodeState = await state();
      const outs = (xs: { status: number; body: unknown }[]) => xs.map((r) => ({ status: r.status, body: norm(strip(r.body)) }));
      try {
        expect(outs(nodeOut)).toEqual(outs(phpOut));
      } catch (e) {
        if (!sameMultiset(outs(nodeOut), outs(phpOut))) throw e; // only tie-ordering of equal sort keys may differ
      }
      expect(nodeState).toEqual(phpState);
    });
  const P = (endpoint: string, body: unknown, who: Who = 'admin'): Case => ({ name: endpoint, endpoint, method: 'POST', body, who });

  scenario('feedback: add, duplicate, validation, status changes', [
    P('feedback_action', { action: 'add', customer_id: 1, order_id: 1, rating: 5, comments: ' lovely ' }),
    P('feedback_action', { action: 'add', customer_id: 1, order_id: 1, rating: 5, comments: 'lovely' }),
    P('feedback_action', { action: 'add', customer_id: 2, rating: '3', comments: '' }),
    P('feedback_action', { action: 'add', customer_id: 1, order_id: 2, rating: 5 }),
    P('feedback_action', { action: 'add', customer_id: 99, rating: 5 }),
    P('feedback_action', { action: 'add', customer_id: 1, rating: 6 }),
    P('feedback_action', { action: 'add', customer_id: 1, rating: 2.5 }),
    P('feedback_action', { action: 'set_status', feedback_id: 1, status: 'Resolved' }),
    P('feedback_action', { action: 'set_status', feedback_id: 1, status: 'Resolved' }),
    P('feedback_action', { action: 'set_status', feedback_id: 999, status: 'New' }),
    P('feedback_action', { action: 'set_status', feedback_id: 1, status: 'Bogus' }),
    P('feedback_action', { action: 'nope' }),
    { name: 'feedback_list after', endpoint: 'feedback_list' },
  ]);

  scenario('expenses + income: create, duplicate, update, validation', [
    P('expense_save', { type: 'expense', entry_date: '2026-10-01', category_id: 1, amount: '250.505', description: ' tea ', payment_mode: 'Cash', vendor: 'Stall' }),
    P('expense_save', { type: 'expense', entry_date: '2026-10-01', category_id: 1, amount: 250.51, description: 'tea', payment_mode: 'Cash', vendor: 'Stall' }),
    P('expense_save', { type: 'expense', id: 1, expense_date: '2026-10-02', category_id: 2, amount: 15000, description: 'shop rent', payment_mode: 'Cash', vendor: 'Landlord' }),
    P('expense_save', { type: 'expense', id: 2, entry_date: '2026-10-05', category_id: 2, amount: 1234.5, description: 'diesel', payment_mode: 'UPI', remarks: 'van' }),
    P('expense_save', { type: 'expense', id: 999, entry_date: '2026-10-05', category_id: 2, amount: 5 }),
    P('expense_save', { type: 'expense', entry_date: '2026-02-30', category_id: 1, amount: 5 }),
    P('expense_save', { type: 'expense', entry_date: '2026-10-05', category_id: 3, amount: 5 }),
    P('expense_save', { type: 'expense', entry_date: '2026-10-05', category_id: 77, amount: -5 }),
    P('expense_save', { type: 'expense', entry_date: '2026-10-05', category_id: 1, amount: 5, payment_mode: 'Wallet' }),
    P('expense_save', { type: 'income', income_date: '2026-10-05', source: 'Scrap', amount: 99.999, payment_mode: 'UPI' }),
    P('expense_save', { type: 'income', entry_date: '2026-10-05', source: '  ', amount: 10 }),
    P('expense_save', { type: 'income', id: 1, income_date: '2026-10-05', source: 'Scrap', amount: 301, description: 'hangers', payment_mode: 'Cash' }),
    P('expense_save', { type: 'other' }),
    { name: 'list after', endpoint: 'expenses_list', query: { from: '2020-01-01', to: '2099-01-01' } },
    { name: 'list income after', endpoint: 'expenses_list', query: { type: 'income', from: '2020-01-01', to: '2099-01-01' } },
  ]);

  scenario('notifications: mark one / again / all / not found', [
    P('notifications_mark_read', { notification_id: 1 }),
    P('notifications_mark_read', { notification_id: 1 }),
    P('notifications_mark_read', { notification_id: 3 }),
    P('notifications_mark_read', { notification_id: 5 }),
    P('notifications_mark_read', {}),
    { name: 'list', endpoint: 'notifications_list', query: { filter: 'unread' } },
    P('notifications_mark_read', { all: 1 }),
    { name: 'list after', endpoint: 'notifications_list' },
  ]);

  scenario('garments: create, edit, duplicates, validation, active flag without permission', [
    P('garment_save', { garment_name: 'Jacket', sku: 'JK1', category_id: 1, default_service_id: 1, unit: 'Pcs', description: 'warm' }),
    P('garment_save', { garment_name: 'jacket', category_id: 1, unit: 'Pcs' }),
    P('garment_save', { garment_name: 'Other', sku: 'JK1', category_id: 1, unit: 'Pcs' }),
    P('garment_save', { garment_name: 'Scarf', category_id: 1, unit: 'Bundle' }),
    P('garment_save', { garment_name: '', category_id: '', unit: '' }),
    P('garment_save', { garment_name: 'Hat', category_id: 'abc', unit: 'Pcs', default_service_id: 99 }),
    P('garment_save', { id: 1, garment_name: 'Shirt Plus', sku: 'SH1', category_id: 1, default_service_id: '', unit: 'Set', is_active: false }),
    P('garment_save', { id: 1, garment_name: 'Shirt Plus', sku: 'SH1', category_id: 1, unit: 'Set', is_active: false }, 'boss'),
    P('garment_save', { id: 1, garment_name: 'Shirt Plus', sku: 'SH1', category_id: 1, unit: 'Set', is_active: 'yes' }, 'boss'),
    P('garment_save', { id: 999, garment_name: 'x', category_id: 1, unit: 'Pcs' }),
    P('garment_save', { garment_name: 'No Perm', category_id: 1, unit: 'Pcs' }, 'viewer'),
    { name: 'manage new', endpoint: 'garment_manage' },
    { name: 'manage 1', endpoint: 'garment_manage', query: { id: '1' }, who: 'boss' },
    { name: 'manage missing', endpoint: 'garment_manage', query: { id: '999' } },
    { name: 'manage forbidden', endpoint: 'garment_manage', who: 'viewer' },
    { name: 'catalog', endpoint: 'garments_catalog_list', who: 'boss' },
  ]);

  it('barcode / qr lookups (piece + laundry + not found + invalid)', async () => {
    await buildDataset();
    const rows = await db.query<any>('SELECT barcode_value, qr_token, short_qr_payload, laundry_garment_id FROM barcodes ORDER BY id');
    const piece = rows.find((r) => !r.laundry_garment_id);
    const laundry = rows.find((r) => r.laundry_garment_id);
    const cs: Case[] = [
      { name: 'barcode piece', endpoint: 'barcode_lookup', query: { barcode: piece.barcode_value } },
      { name: 'barcode laundry', endpoint: 'barcode_lookup', query: { barcode: laundry.barcode_value } },
      { name: 'barcode missing', endpoint: 'barcode_lookup', query: { barcode: 'NOPE-01' } },
      { name: 'barcode empty', endpoint: 'barcode_lookup', query: { barcode: ' ' } },
      { name: 'qr token piece', endpoint: 'qr_lookup', query: { token: piece.qr_token } },
      { name: 'qr token laundry', endpoint: 'qr_lookup', query: { token: laundry.qr_token } },
      { name: 'qr short piece', endpoint: 'qr_lookup', query: { token: piece.short_qr_payload } },
      { name: 'qr unknown token', endpoint: 'qr_lookup', query: { token: 'f'.repeat(32) } },
      { name: 'qr malformed', endpoint: 'qr_lookup', query: { token: 'not a token' } },
      { name: 'barcode forbidden', endpoint: 'barcode_lookup', query: { barcode: piece.barcode_value }, who: 'ws' },
    ];
    for (const c of cs) await check(c);
    expect((await db.query<any>("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'lookup'"))[0].n).toBeGreaterThan(10);
  });

  const G = (endpoint: string, query: Record<string, string> = {}, who: Who = 'admin'): Case => ({ name: endpoint, endpoint, query, who });

  scenario('QC + rework + packing: queue, pass/fail, laundry batch sync, state guards', [
    // fixture: items 4,5 (order 3) at QC; item 3 in Rework (rework #1 Pending); item 6 Ready; laundry garment 1 in Rework (rework #2 In Progress), garment 2 at QC
    G('qc_queue'),
    G('qc_queue', { status: 'QC', customer: 'Vip', urgent_only: '1' }),
    P('qc_action', { action: 'pass', order_item_id: 4 }),
    P('qc_action', { action: 'pass', order_item_id: 4 }),
    P('qc_action', { action: 'fail', order_item_id: 5 }),
    P('qc_action', { action: 'fail', order_item_id: 5, reason: ' <b>colour bleed</b> ', remarks: 'check dye' }),
    P('qc_action', { action: 'pass', order_item_id: 999 }),
    P('qc_action', { action: 'pass', order_item_id: 3 }),
    P('qc_action', { action: 'zap', order_item_id: 4 }),
    P('qc_action', { action: 'pass', garment_type: 'weird', order_item_id: 4 }),
    P('qc_action', { action: 'pass', order_item_id: 0 }),
    P('qc_action', { action: 'fail', order_item_id: 6, reason: 'x'.repeat(501) }),
    P('qc_action', { action: 'pass', garment_type: 'laundry', laundry_garment_id: 2, remarks: 'ok' }),
    P('qc_action', { action: 'pass', garment_type: 'laundry', laundry_garment_id: 1 }),
    P('qc_action', { action: 'fail', garment_type: 'laundry', laundry_garment_id: 2, reason: 'again' }),
    P('qc_action', { action: 'pass', garment_type: 'laundry', laundry_garment_id: 999 }),
    G('qc_queue'),
    G('rework_list'),
    P('rework_action', { action: 'start', rework_id: 1 }),
    P('rework_action', { action: 'start', rework_id: 1 }),
    P('rework_action', { action: 'complete', rework_id: 1 }),
    P('rework_action', { action: 'complete', rework_id: 2 }),
    P('rework_action', { action: 'complete', rework_id: 3 }),
    P('rework_action', { action: 'start', rework_id: 3 }),
    P('rework_action', { action: 'complete', rework_id: 3 }),
    P('rework_action', { action: 'complete', rework_id: 999 }),
    P('rework_action', { action: 'nope', rework_id: 1 }),
    G('rework_list'),
    G('packing_queue'),
    G('packing_queue', { order: 'UDC', customer: 'Plain' }),
    P('packing_action', { order_item_id: 6 }),
    P('packing_action', { order_item_id: 6 }),
    P('packing_action', { order_item_id: 4 }),
    P('packing_action', { order_item_id: 1 }),
    P('packing_action', { order_item_id: 0 }),
    G('packing_queue'),
    G('qc_queue', {}, 'viewer'),
    P('qc_action', { action: 'pass', order_item_id: 3 }, 'viewer'),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const prepFulfillment = async () => {
    await db.tx(async (t) => {
      await t.execute('SET FOREIGN_KEY_CHECKS = 0');
      await t.execute('TRUNCATE TABLE delivery_orders');
      await t.execute('TRUNCATE TABLE pickup_orders');
      await t.execute('TRUNCATE TABLE drivers');
      await t.execute('SET FOREIGN_KEY_CHECKS = 1');
    });
    await db.execute("UPDATE customers SET address = '12 Street', area = 'Sector 5', pincode = '110001' WHERE id = 1");
    await db.execute("UPDATE order_items SET item_status = 'Packed' WHERE order_id IN (1, 4, 5)");
    await db.execute("INSERT INTO drivers (id, driver_name, user_id, is_active) VALUES (1, 'Ravi', 6, 1), (2, 'Gone', NULL, 0)");
  };
  scenario('pickups + deliveries: eligibility, scheduling, drivers, status flow, permissions', [
    G('pickup_list'),
    G('pickup_list', { status: 'weird' }),
    G('delivery_manage_list'),
    P('pickup_action', { action: 'create', order_id: 1, pickup_date: today, pickup_time: '10:30', notes: ' <i>call first</i> ' }),
    P('pickup_action', { action: 'create', order_id: 1, pickup_date: today }),
    P('pickup_action', { action: 'create', order_id: 4, pickup_date: today }),
    P('pickup_action', { action: 'create', order_id: 3, pickup_date: today }),
    P('pickup_action', { action: 'create', order_id: 5, pickup_date: '2026-13-45' }),
    P('pickup_action', { action: 'create', order_id: 5, pickup_date: today, pickup_time: 'ten' }),
    P('pickup_action', { action: 'create', order_id: 5, pickup_date: today, notes: 'n'.repeat(501) }),
    P('pickup_action', { action: 'create', order_id: 0 }),
    P('pickup_action', { action: 'assign_driver', pickup_id: 1, driver_id: 2 }),
    P('pickup_action', { action: 'assign_driver', pickup_id: 1, driver_id: 1 }),
    P('pickup_action', { action: 'assign_driver', pickup_id: 99, driver_id: 1 }),
    G('pickup_list', { status: 'Assigned' }),
    P('pickup_action', { action: 'mark_picked_up', pickup_id: 1 }),
    P('pickup_action', { action: 'mark_picked_up', pickup_id: 1 }),
    P('pickup_action', { action: 'zap' }),
    // deliveries
    P('delivery_manage_action', { action: 'schedule', order_id: 5, delivery_date: today }),
    P('delivery_manage_action', { action: 'schedule', order_id: 5, delivery_date: today }),
    P('delivery_manage_action', { action: 'schedule', order_id: 4, delivery_date: today }),
    P('delivery_manage_action', { action: 'schedule', order_id: 1, delivery_date: today }),
    P('delivery_manage_action', { action: 'schedule', order_id: 3, delivery_date: today }),
    P('delivery_manage_action', { action: 'schedule', order_id: 5, delivery_date: '2026-02-30' }),
    P('delivery_manage_action', { action: 'assign_driver', delivery_id: 1, driver_id: 2 }),
    P('delivery_manage_action', { action: 'assign_driver', delivery_id: 1, driver_id: 1 }),
    P('delivery_manage_action', { action: 'assign_driver', delivery_id: 0, driver_id: 1 }),
    P('delivery_manage_action', { action: 'nope' }),
    G('delivery_manage_list'),
    G('delivery_manage_list', { status: 'Assigned', customer: 'Vip' }),
    G('my_deliveries_list', {}, 'driver'),
    G('my_deliveries_list', {}, 'admin'),
    P('delivery_mark_delivered', { delivery_id: 1 }, 'ws'),
    P('delivery_mark_out', { delivery_id: 1 }, 'driver'),
    P('delivery_mark_out', { delivery_id: 1 }, 'driver'),
    P('delivery_mark_out', { delivery_id: 99 }, 'driver'),
    P('delivery_mark_out', { delivery_id: 0 }, 'driver'),
    P('delivery_mark_delivered', { delivery_id: 1 }, 'driver'),
    P('delivery_mark_delivered', { delivery_id: 1 }, 'driver'),
    G('my_deliveries_list', {}, 'driver'),
    G('delivery_manage_list', {}, 'driver'),
    P('delivery_manage_action', { action: 'schedule', order_id: 5, delivery_date: today }, 'driver'),
    G('pickup_list', {}, 'viewer'),
    G('my_deliveries_list', {}, 'viewer'),
  ], prepFulfillment);
});
