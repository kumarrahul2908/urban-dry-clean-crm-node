import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { buildDataset as buildDatasetShared, TOKENS } from './web/dataset.js';

/**
 * Endpoint-level PHP ↔ Node parity: the REAL api/mobile/<name>.php (run through test/parity/endpoint.php)
 * and the Node route are called with the same token + query on the SAME seeded database; status code
 * and JSON body must match. See docs/PARITY.md.
 */
vi.setConfig({ testTimeout: 120_000 });

const PHP_APP = process.env.PARITY_PHP_APP;
const enabled = !!PHP_APP && !!process.env.TEST_DB_NAME;

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

  const buildDataset = () => buildDatasetShared(db, env);
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
  const TIME_KEYS = new Set(['created_at', 'updated_at', 'read_at', 'checked_at', 'paid_at', 'order_date']);
  const strip = (v: any): any => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !TIME_KEYS.has(k)).map(([k, x]) => [k, strip(x)])) : v);
  async function state() {
    const q = (sql: string) => db.query<any>(sql).then((r) => r.map(strip));
    return norm({
      feedback: await q('SELECT id, customer_id, order_id, rating, comments, status FROM feedback ORDER BY id'),
      garments: await q('SELECT * FROM garments ORDER BY id'),
      items: await q('SELECT id, order_id, item_status, quantity, unit, pieces_per_unit, piece_names, unit_price, weight, weight_rate, is_manual_override, subtotal, discount, tax_percent, tax, total, brand_id, color_id, remarks FROM order_items ORDER BY id'),
      orderTotals: await q('SELECT id, order_number, short_order_code, subtotal, discount_amount, urgent_charge, tax_amount, grand_total, total_paid, current_due FROM orders ORDER BY id'),
      itemDefects: await q('SELECT order_item_id, defect_id, recorded_by FROM order_item_defects ORDER BY order_item_id, defect_id'),
      barcodes: await q('SELECT id, barcode_value, short_qr_payload, order_id, order_item_id, laundry_garment_id, item_sequence, piece_index FROM barcodes ORDER BY id'),
      qc: await q('SELECT id, order_item_id, laundry_garment_id, checked_by, result, reason, remarks FROM qc_records ORDER BY id'),
      rework: await q('SELECT id, order_item_id, laundry_garment_id, qc_record_id, reason, rework_date, status FROM rework_records ORDER BY id'),
      pickups: await q('SELECT id, pickup_number, customer_id, order_id, address, area, pincode, pickup_date, pickup_time, garment_count, notes, driver_id, status, created_by FROM pickup_orders ORDER BY id'),
      deliveries: await q('SELECT id, delivery_number, order_id, customer_id, phone, address, amount_due, delivery_date, time_slot, driver_id, status, payment_collected, remarks, created_by FROM delivery_orders ORDER BY id'),
      orderStatus: await q('SELECT id, status_id FROM orders ORDER BY id'),
      wchallans: await q('SELECT id, challan_number, workshop_id, remarks, created_by FROM workshop_challans ORDER BY id'),
      witems: await q('SELECT id, challan_id, order_item_id, laundry_garment_id, status, remarks FROM workshop_items ORDER BY id'),
      bills: await q('SELECT id, bill_number, store_id, is_combined, workshop_id, period_start, period_end, invoice_date, due_date, terms_label, subject, item_count, total_value, share_percent, gst_mode, gst_rate, gst_amount, workshop_share, store_share, grand_total, amount_paid, status, payment_type_id, reference_no, paid_by, created_by, snapshot_json FROM workshop_bills ORDER BY id'),
      billItems: await q('SELECT bill_id, order_item_id, item_value FROM workshop_bill_items ORDER BY bill_id, order_item_id'),
      billPayments: await q('SELECT id, bill_id, amount, payment_type_id, reference_no, paid_on, notes, received_by FROM workshop_bill_payments ORDER BY id'),
      workshopsCounter: await q('SELECT id, invoice_next_number FROM workshops ORDER BY id'),
      history: await q('SELECT id, order_item_id, laundry_garment_id, previous_status, new_status, changed_by, remarks, module FROM garment_status_history ORDER BY id'),
      expenses: await q('SELECT * FROM expenses ORDER BY id'),
      income: await q('SELECT * FROM income ORDER BY id'),
      notifications: await q('SELECT id, user_id, template_key, channel, message, is_read FROM notification_logs ORDER BY id'),
      waQueue: (await q('SELECT id, account_id, customer_id, order_id, to_number, message_type, template_key, payload_json, event_ref, campaign_id, status, retry_count FROM whatsapp_outbound_queue ORDER BY id'))
        .map((r: any) => ({ ...r, payload_json: JSON.parse(r.payload_json) })),
      resetTokens: (await q('SELECT id, reset_token IS NOT NULL AS has_token, reset_token_expires IS NOT NULL AS has_expiry FROM users ORDER BY id')),
      audit: (await q('SELECT user_id, action, module, record_id, old_value, new_value FROM audit_logs WHERE module IN ("feedback","expenses","income","garments","qc_records","rework_records","order_items","pickup_orders","delivery_orders","workshop_challans","workshop_items","workshop_bills")  ORDER BY id'))
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
      if (process.env.DEBUG_SCENARIO) calls.forEach((c, i) => { if (nodeOut[i]!.status !== phpOut[i]!.status) console.log(`[${name.slice(0, 12)}] STATUS DIFF #${i} ${c.endpoint} ${JSON.stringify(c.body ?? c.query)} php=${phpOut[i]!.status} node=${nodeOut[i]!.status} ${JSON.stringify(nodeOut[i]!.body).slice(0, 120)}`); });
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

  const prepWorkshop = async () => {
    // pending items (order 1), items already at the workshop in various states (orders 3-4), laundry garment 1 sent, 2 pending
    await db.execute("UPDATE order_items SET item_status = 'Pending' WHERE id IN (1, 2, 3)");
    await db.execute("UPDATE order_items SET item_status = 'Workshop' WHERE id = 4");
    await db.execute("UPDATE order_items SET item_status = 'Processing' WHERE id = 5");
    await db.execute("UPDATE order_items SET item_status = 'Workshop' WHERE id = 6");
    await db.execute("DELETE FROM garment_status_history");
    await db.execute("INSERT INTO workshop_challans (id, challan_number, workshop_id, challan_date, created_by) VALUES (1, 'CH-000001', 1, NOW(), 1), (2, 'CH-000002', 2, NOW(), 1)");
    await db.execute("INSERT INTO workshop_items (id, challan_id, order_item_id, laundry_garment_id, status, sent_at) VALUES (1, 1, 4, NULL, 'Sent', NOW()), (2, 1, 5, NULL, 'Processing', NOW()), (3, 2, 6, NULL, 'Received', NOW()), (4, 1, NULL, 1, 'Sent', NOW())");
    await db.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, module) VALUES (4, 'Pending', 'Workshop', 1, NOW() - INTERVAL 1 HOUR, 'workshop'), (5, 'Workshop', 'Processing', 1, NOW() - INTERVAL 1 HOUR, 'workshop')");
    await db.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, module) VALUES (1, 'Pending', 'Workshop', 1, NOW() - INTERVAL 1 HOUR, 'workshop')");
    await db.execute("UPDATE settings SET setting_value = setting_value WHERE 1=0");
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('challan_prefix', 'CH-') ON DUPLICATE KEY UPDATE setting_value = 'CH-'");
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('challan_prefix_counter', '2') ON DUPLICATE KEY UPDATE setting_value = '2'");
  };
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const WA_ = (action: string, extra: Record<string, unknown> = {}, who: Who = 'admin') => P('workshop_action', { action, ...extra }, who);
  const waSeed = async () => {
    await db.execute("INSERT INTO whatsapp_accounts (id, store_id, account_name, waba_id, phone_number_id, access_token_encrypted, api_version, is_active) VALUES (1, NULL, 'Main', 'w1', 'p1', 'AAAA', 'v21.0', 1)");
    await db.execute(
      `INSERT INTO notification_templates (template_key, channel, body, provider_template_name, language, template_param_order, is_active) VALUES
       ('order_confirmation', 'WhatsApp', 'Hi {customer_name}, order {order_number} Rs.{grand_total} - {business_name} {nope}', 'order_confirmation_v1', 'en', '["customer_name","order_number","grand_total","business_name"]', 1),
       ('order_ready', 'WhatsApp', 'Hi {customer_name}, order {order_number} is ready', NULL, NULL, NULL, 1),
       ('pickup_scheduled', 'WhatsApp', 'Pickup for {order_number} on {pickup_date}', 'pickup_v1', 'hi', '["order_number","pickup_date"]', 1),
       ('workshop_completed', 'WhatsApp', 'Workshop done for {order_number}', NULL, '', '', 1)`);
    await db.execute("UPDATE customers SET address = '5 Market Road' WHERE id = 2");
    await db.execute("UPDATE order_items SET item_status = 'Packed' WHERE order_id = 4");                       // pickup needs a fully packed order
    await db.execute("UPDATE order_items SET item_status = 'Ready' WHERE order_id = 3 AND id NOT IN (4, 5)");   // QC-passing items 4+5 completes order 3
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('business_name', 'Urban Test') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
  };
  scenario('whatsapp: order_confirmation, pickup_scheduled, order_ready and inactive-template hooks enqueue identical rows', [
    P('pos_orders_create', { client_request_id: 'wa-1', customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 2 }], payments: [{ payment_type_id: 1, amount: 50 }] }),
    P('pos_orders_create', { client_request_id: 'wa-1', customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 2 }], payments: [{ payment_type_id: 1, amount: 50 }] }),
    P('pickup_action', { action: 'create', order_id: 4, pickup_date: today, pickup_time: '10:30' }),
    P('pickup_action', { action: 'create', order_id: 4, pickup_date: today }),
    P('qc_action', { action: 'pass', order_item_id: 4 }),
    P('qc_action', { action: 'pass', order_item_id: 5 }),
    P('laundry_orders_create', { client_request_id: 'wa-2', customer_id: 2, batches: [{ service_id: 3, weight: 3, rate: 60, garment_count: 1, garments: [{ garment_id: 1, quantity: 1 }] }] }),
    WA_('create_challan', { workshop_id: 1, item_ids: [1] }),
    WA_('start_processing', { workshop_item_id: 1 }),
    WA_('complete_processing', { workshop_item_id: 1 }),
  ], waSeed);

  scenario('whatsapp: without any account nothing is queued; password reset not set up / set up', [
    P('pos_orders_create', { client_request_id: 'wa-3', customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }),
    P('pickup_action', { action: 'create', order_id: 1, pickup_date: today }),
  ]);

  const resetCases = async () => {
    await db.execute("UPDATE users SET mobile = '+91 98765-43210', email = 'admin@example.com' WHERE id = 1");
    await db.execute("UPDATE users SET mobile = '9876543210' WHERE id = 3");
    await db.execute("UPDATE users SET mobile = '' WHERE id = 4");
    await db.execute("UPDATE users SET reset_token = 'old', reset_token_expires = NOW() + INTERVAL 59 MINUTE WHERE id = 5"); await db.execute("UPDATE users SET mobile = '9000000001', reset_token = 'old2', reset_token_expires = NOW() + INTERVAL 53 MINUTE WHERE id = 6");
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('password_reset_wa_template', 'reset_tpl') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
  };
  const PR = (identifier: unknown): Case => ({ name: 'password_reset_request', endpoint: 'password_reset_request', method: 'POST', body: { identifier } });
  scenario('password_reset_request: not configured', [PR('rahul'), PR(''), PR(5)]);
  scenario('password_reset_request: configured — unknown, success, no mobile, recently sent, ambiguous (shared mobile)', [
    PR('nobody-here'), PR('rahul'), PR('ws'), PR('nobody'), PR('admin@example.com'), PR('9876543210'), PR('boss'), PR('driver'), PR('x'.repeat(151)), PR('  '), PR({ a: 1 }),
  ], resetCases);

  const WA = (action: string, extra: Record<string, unknown> = {}, who: Who = 'admin') => P('workshop_action', { action, ...extra }, who);
  scenario('workshop: queue, challans, item lifecycle, schedule, report, billing + permissions', [
    G('workshop_queue'),
    G('workshop_queue', { status: 'Workshop', garment: 'Suit', customer: 'Vip', urgent_only: '1', due_date: today }),
    G('workshop_queue', { status: 'Bogus' }),
    G('workshop_queue', { due_date: 'x' }),
    G('workshop_queue', {}, 'wstaff'),
    G('workshop_queue', { customer: 'Plain' }, 'wstaff'),
    G('workshop_schedule'),
    G('workshop_schedule', {}, 'wstaff'),
    G('workshop_report'),
    G('workshop_report', { period: '15days', store_id: '1' }),
    G('workshop_report', { period: 'custom', from: yday, to: today }, 'wstaff'),
    G('workshop_report', { period: 'zzz' }),
    // challans
    WA('create_challan', { workshop_id: 1, item_ids: [1, 2], remarks: ' <b>urgent</b> ' }),
    WA('create_challan', { workshop_id: 1, item_ids: [1] }),
    WA('create_challan', { workshop_id: 3, item_ids: [3] }),
    WA('create_challan', { workshop_id: 2, item_ids: [999] }),
    WA('create_challan', { workshop_id: 2, item_ids: [] }),
    WA('create_challan', { workshop_id: 2, item_ids: [3], remarks: 'x'.repeat(501) }),
    WA('create_challan', { workshop_id: 2, item_ids: [3] }, 'wstaff'),
    WA('create_laundry_challan', { workshop_id: 2, laundry_garment_ids: [2], remarks: 'wash' }),
    WA('create_laundry_challan', { workshop_id: 2, laundry_garment_ids: [999] }),
    // item lifecycle (workshop items: 1 Sent, 2 Processing, 3 Received, 4 laundry Sent, then new ones)
    WA('start_processing', { workshop_item_id: 1 }),
    WA('start_processing', { workshop_item_id: 1 }),
    WA('complete_processing', { workshop_item_id: 1, remarks: 'all done' }),
    WA('complete_processing', { workshop_item_id: 2 }),
    WA('return_to_store', { workshop_item_id: 1 }),
    WA('return_to_store', { workshop_item_id: 3 }),
    WA('accept', { workshop_item_id: 3, remarks: 'ok' }),
    WA('accept', { workshop_item_id: 3 }),
    WA('mark_unprocessed', { workshop_item_id: 4 }),
    WA('mark_unprocessed', { workshop_item_id: 4, remarks: 'ab' }),
    WA('mark_unprocessed', { workshop_item_id: 4, remarks: 'torn beyond repair' }),
    WA('mark_unprocessed', { workshop_item_id: 4, remarks: 'again' }),
    WA('resolve_unprocessed', { workshop_item_id: 4 }),
    WA('resolve_unprocessed', { workshop_item_id: 4 }),
    WA('start_processing', { workshop_item_id: 4 }, 'wstaff'),
    WA('start_processing', { workshop_item_id: 3 }, 'wstaff'),
    WA('store_receive', { workshop_item_id: 1 }),
    WA('store_receive', { workshop_item_id: 2 }),
    WA('store_receive', { workshop_item_id: 999 }),
    WA('start_processing', { workshop_item_id: 0 }),
    WA('explode', { workshop_item_id: 1 }),
    G('workshop_queue'),
    G('workshop_schedule'),
    // billing
    G('workshop_billing_list'),
    G('workshop_billing_list', {}, 'wstaff'),
    G('workshop_billing_list', {}, 'viewer'),
    P('workshop_billing_generate', { store_id: 1, workshop_id: 1, from: yday, to: today }),
    P('workshop_billing_generate', { store_id: 1, workshop_id: 1, from: yday, to: today }),
    P('workshop_billing_generate', { store_id: 1, workshop_id: 2, from: yday, to: today }),
    P('workshop_billing_generate', { store_id: 1, workshop_id: 1, from: today, to: yday }),
    P('workshop_billing_generate', { store_id: 99, workshop_id: 1, from: yday, to: today }),
    P('workshop_billing_generate', { store_id: 1, workshop_id: 9, from: yday, to: today }),
    P('workshop_billing_generate', { workshop_id: 1 }),
    P('workshop_billing_generate', { store_id: 'all', workshop_id: 1, from: yday, to: today, gst_mode: 'exclusive', basis: 'sent_only' }),
    P('workshop_billing_generate', { store_id: 'all', workshop_id: 1, from: yday, to: today, gst_mode: 'inclusive' }),
    P('workshop_billing_generate', { store_id: 'all', workshop_id: 2, from: yday, to: today, gst_mode: 'bogus', basis: 'bogus' }),
    P('workshop_billing_generate', { store_id: 2, workshop_id: 1, from: yday, to: today, basis: 'whole' }),
    P('workshop_billing_generate', { store_id: 0, workshop_id: 1, from: yday, to: today }),
    P('workshop_billing_generate', { store_id: '', workshop_id: 1, from: yday, to: today }),
    G('workshop_billing_list'),
    G('workshop_billing_detail', { id: '2' }),
    G('workshop_billing_detail', { id: '3' }),
    P('workshop_billing_generate', { store_id: 1, workshop_id: 2, from: yday, to: today }, 'wstaff'),
    P('workshop_billing_generate', { store_id: 1, workshop_id: 2, from: yday, to: today }, 'viewer'),
    G('workshop_billing_list'),
    G('workshop_billing_list', { status: 'Unpaid' }),
    G('workshop_billing_detail', { id: '1' }),
    G('workshop_billing_detail', { id: '1' }, 'wstaff'),
    G('workshop_billing_detail', { id: '99' }),
    G('workshop_billing_detail', {}),
    P('workshop_billing_mark_paid', { bill_id: 1, payment_type_id: 1, amount: 10, reference_no: 'R1' }),
    P('workshop_billing_mark_paid', { bill_id: 1, payment_type_id: 9, amount: 10 }),
    P('workshop_billing_mark_paid', { bill_id: 1, payment_type_id: 1, amount: 1000000 }),
    P('workshop_billing_mark_paid', { bill_id: 1, payment_type_id: 2 }),
    P('workshop_billing_mark_paid', { bill_id: 1, payment_type_id: 2 }),
    P('workshop_billing_mark_paid', { bill_id: 2, payment_type_id: 2 }),
    P('workshop_billing_mark_paid', { bill_id: 3, payment_type_id: 1, amount: 5 }),
    P('workshop_billing_mark_paid', { bill_id: 99, payment_type_id: 2 }),
    P('workshop_billing_mark_paid', { bill_id: 0, payment_type_id: 2 }),
    P('workshop_billing_mark_paid', { bill_id: 1, payment_type_id: 2 }, 'viewer'),
    G('workshop_billing_detail', { id: '1' }),
    G('workshop_billing_list', { status: 'Paid' }),
  ], prepWorkshop);

  // ---- short codes + Set garments + editing an item on a submitted order (PHP changelog 2026-10-20..22) ----------------
  // dataset: orders 1-6, order items 1-8; the order created first below becomes order 7 with items 9..
  const UPD = (body: Record<string, unknown>, who: Who = 'boss') => P('order_item_update', { order_id: 7, ...body }, who);
  scenario('Set garments + order_item_update + short code everywhere', [
    P('pos_orders_create', { client_request_id: 'sc-1', customer_id: 2, items: [{ garment_id: 4, service_id: 1, quantity: 2 }, { garment_id: 1, service_id: 1, quantity: 1, brand_id: 1, color_id: 1, defect_ids: [1], remarks: 'old' }, { garment_id: 5, service_id: 1, quantity: 1.5 }] }),
    P('pos_orders_create', { client_request_id: 'sc-1', customer_id: 2, items: [{ garment_id: 4, service_id: 1, quantity: 2 }] }),
    G('orders_detail', { id: '7' }),
    G('orders_list', { q: 'A0007' }),
    G('orders_search', { q: 'A0007' }),
    G('orders_search', { q: 'UDC-' }),
    G('orders_list'),
    G('barcode_lookup', { barcode: 'A0007-03' }),
    G('barcode_lookup', { barcode: 'A0007-04' }),
    G('pos_garments', { category_id: '1' }),
    P('order_item_add', { order_id: 7, client_request_id: 'sc-add', garment_id: 4, service_id: 1, quantity: 1 }, 'boss'),
    UPD({ item_id: 10, quantity: 4 }),
    UPD({ item_id: 10, remarks: ' fresh ', brand_id: 1, color_id: null, defect_ids: [1, 2] }),
    UPD({ item_id: 10, rate_override: '77.5' }),
    UPD({ item_id: 10, rate_override: 'x' }),
    UPD({ item_id: 10, quantity: 0 }),
    UPD({ item_id: 10, manual_override: true, rate_override: 5 }, 'admin'),
    UPD({ item_id: 10, manual_override: true, rate_override: 5 }),
    UPD({ item_id: 10, defect_ids: 'nope' }),
    UPD({ item_id: 999, quantity: 1 }),
    UPD({ item_id: 0 }),
    UPD({ item_id: 10, order_id: 999 }),
    P('order_item_update', { item_id: 10 }, 'boss'),
    UPD({ item_id: 10, quantity: 2 }, 'viewer'),
    G('orders_detail', { id: '7' }),
    P('order_item_remove', { order_id: 7, item_id: 11 }, 'boss'),
    // an order that already moved on cannot be edited
    P('order_item_update', { order_id: 1, item_id: 1, quantity: 9 }, 'boss'),
    G('daily_dashboard'),
    G('notifications_list'),
    G('feedback_list'),
    G('feedback_list', { order: 'A000' }),
    G('qc_queue'),
    G('packing_queue'),
    G('rework_list'),
    G('workshop_queue'),
    G('pickup_list'),
    G('delivery_manage_list'),
    G('my_deliveries_list', {}, 'admin'),
    G('wallet_transactions'),
  ]);

  scenario('laundry order returns the short code too', [
    P('laundry_orders_create', { client_request_id: 'lc-1', customer_id: 1, batches: [{ service_id: 3, weight: 2, rate: 60, garment_count: 2, garments: [{ garment_id: 4, quantity: 1 }, { garment_id: 1, quantity: 1 }] }] }),
    P('laundry_orders_create', { client_request_id: 'lc-1', customer_id: 1, batches: [{ service_id: 3, weight: 2, rate: 60, garment_count: 2, garments: [{ garment_id: 4, quantity: 1 }, { garment_id: 1, quantity: 1 }] }] }),
    G('orders_detail', { id: '7' }),
    G('barcode_lookup', { barcode: 'A0007-01' }),
  ]);

  it('workshop staff not linked to a workshop sees nothing (deliberate: PHP showed every workshop)', async () => {
    await buildDataset();
    await prepWorkshop();
    const r = await runNode({ name: 'q', endpoint: 'workshop_queue', who: 'orphan' });
    expect(r.status).toBe(403);
    expect((await runNode({ name: 's', endpoint: 'workshop_schedule', who: 'orphan' })).status).toBe(403);
    expect((await runNode({ name: 'b', endpoint: 'workshop_billing_list', who: 'orphan' })).body.data.bills).toEqual([]);
  });
});
