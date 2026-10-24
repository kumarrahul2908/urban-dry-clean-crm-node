import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool, type Db } from '../src/db/pool.js';

/**
 * PHP-vs-Node parity: runs the SAME scenario against the real PHP OrderService and the Node port on
 * identical, freshly seeded databases, then compares results and every money-relevant table.
 *
 *   scripts/make-php-parity-app.sh <backup-repo> /tmp/php-parity
 *   PARITY_PHP_APP=/tmp/php-parity TEST_DB_NAME=... TEST_DB_USER=... TEST_DB_PASS=... TEST_DB_PORT=... npm test
 */
const PHP_APP = process.env.PARITY_PHP_APP;
const enabled = !!PHP_APP && !!process.env.TEST_DB_NAME;

type Step = { op: string; [k: string]: unknown };

describe.skipIf(!enabled)('PHP ↔ Node parity (OrderService)', () => {
  const dbEnv = {
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
  };
  const env = loadEnv({ NODE_ENV: 'test', ...dbEnv, APP_SECRET_KEY: 'k', APP_TIMEZONE: 'Asia/Kolkata' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  const svc = buildServices(env, db);
  afterAll(() => close());

  const seedSql = readFileSync(new URL('./parity/seed.sql', import.meta.url), 'utf8');
  async function reset() {
    const tables = (await db.query<{ t: string }>('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = "BASE TABLE"')).map((r) => r.t);
    await db.tx(async (t) => {
      await t.execute('SET FOREIGN_KEY_CHECKS = 0');
      for (const tb of tables) await t.execute(`TRUNCATE TABLE \`${tb}\``);
      for (const stmt of seedSql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await t.execute(stmt);
      await t.execute('SET FOREIGN_KEY_CHECKS = 1');
    });
  }

  function runPhp(step: Step): any {
    const out = execFileSync('php', [`${PHP_APP}/run.php`], {
      input: JSON.stringify(step),
      env: { ...process.env, UDC_DB_HOST: dbEnv.DB_HOST, UDC_DB_PORT: dbEnv.DB_PORT, UDC_DB_NAME: dbEnv.DB_NAME, UDC_DB_USER: dbEnv.DB_USER, UDC_DB_PASS: dbEnv.DB_PASS },
    }).toString();
    try { return JSON.parse(out); } catch { throw new Error(`PHP did not return JSON: ${out.slice(0, 500)}`); }
  }

  async function runNode(s: Step): Promise<any> {
    const actor = { userId: (s.user_id as number) ?? 1 };
    const o = svc.orders;
    switch (s.op) {
      case 'createOrder': return o.createOrder(s.input as any, actor, !!s.can_override_discount, (s.store_id as number) ?? 1, !!s.can_manual_override);
      case 'createLaundryOrder': return o.createLaundryOrder(s.input as any, actor, !!s.can_override_discount, (s.store_id as number) ?? 1);
      case 'recordPayment': return o.recordPayment(s.order_id as number, s.customer_id as number, s.lines as any, Number(s.wallet ?? 0), actor, { clientRequestId: (s.client_request_id as string) ?? null, requestFingerprint: (s.fingerprint as string) ?? null });
      case 'processRefund': return o.processRefund(s.order_id as number, Number(s.amount), (s.lines as any) ?? [], !!s.to_wallet, s.reason as string, (s.remarks as string) ?? '', actor, (s.client_request_id as string) ?? null, (s.fingerprint as string) ?? null);
      case 'addItem': return o.addItem(s.order_id as number, s.item as any, actor, !!s.can_manual_override, (s.client_request_id as string) ?? null);
      case 'updateItem': return o.updateItem(s.order_id as number, s.item_id as number, s.raw as any, actor, !!s.can_manual_override);
      case 'removeItem': return o.removeItem(s.order_id as number, s.item_id as number, actor);
      case 'editOrder': return o.editOrder(s.order_id as number, s.changes as any, actor, (s.reason as string) ?? '', !!s.can_override_discount);
      case 'cancelOrder': return o.cancelOrder(s.order_id as number, s.reason as string, actor);
    }
    throw new Error(`unknown op ${s.op}`);
  }

  const KEYS = ['success', 'errors', 'order_id', 'order_number', 'invoice_number', 'grand_total', 'payment_number', 'payment_id', 'refund_number', 'item_id', 'warnings', 'warning', 'idempotent_replay', 'error_code'];
  const pick = (r: any) => {
    const o: any = {};
    for (const k of KEYS) if (r[k] !== undefined) o[k] = r[k];
    if (o.warnings && o.warnings.length === 0) delete o.warnings;
    if (o.warning === null) delete o.warning;
    return JSON.parse(JSON.stringify(o));
  };

  const num = (v: unknown) => (v === null || v === undefined ? v : Number(v));
  async function snapshot(d: Db) {
    const q = (sql: string) => d.query<any>(sql);
    const TIME_KEYS = new Set(['created_at', 'updated_at', 'order_date', 'cancelled_at', 'payment_date']);
    const strip = (v: any): any => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !TIME_KEYS.has(k)).map(([k, x]) => [k, strip(x)])) : v);
    const parse = (s: string | null) => { try { return s === null ? null : strip(JSON.parse(s)); } catch { return s; } };
    return {
      orders: await q('SELECT id, order_number, short_order_code, invoice_number, customer_id, store_id, order_mode, price_list_id, due_date, due_time, urgent_level_id, packaging_preference, home_delivery, notes, workshop_notes, subtotal, discount_type, discount_value, discount_amount, urgent_charge, tax_amount, delivery_charge, grand_total, advance_paid, total_paid, current_due, status_id, order_type, created_by, updated_by, cancelled_by, cancelled_reason FROM orders ORDER BY id'),
      items: await q('SELECT * FROM order_items ORDER BY id').then((r) => r.map(({ created_at, ...x }: any) => x)),
      defects: await q('SELECT order_item_id, defect_id, recorded_by FROM order_item_defects ORDER BY order_item_id, defect_id'),
      barcodes: await q('SELECT id, barcode_value, short_qr_payload, order_id, order_item_id, laundry_garment_id, item_sequence, piece_index, CHAR_LENGTH(qr_token) AS tok FROM barcodes ORDER BY id'),
      tags: await q('SELECT id, order_item_id, laundry_garment_id, barcode_id, printed_count FROM garment_tags ORDER BY id'),
      laundry: await q('SELECT id, order_item_id, garment_id, sequence FROM laundry_garments ORDER BY id'),
      payments: await q('SELECT id, payment_number, client_request_id, request_fingerprint, order_id, customer_id, total_amount, payment_kind, remarks, approved_by, created_by FROM payments ORDER BY id'),
      ptx: await q('SELECT id, payment_id, payment_type_id, amount, reference_no FROM payment_transactions ORDER BY id'),
      ar: await q('SELECT id, order_id, customer_id, invoice_number, total_amount, paid_amount, due_amount, status, due_date FROM accounts_receivable ORDER BY id'),
      wallet: await q('SELECT customer_id, balance FROM customer_wallet ORDER BY customer_id'),
      // created_by omitted on purpose: PHP left it NULL for order-driven wallet movements, Node records the actor (asserted separately).
      wtx: await q('SELECT id, customer_id, order_id, txn_type, debit, credit, balance_after, payment_mode, remarks, client_request_id, request_fingerprint FROM wallet_transactions ORDER BY id'),
      counters: await q("SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE '%counter' ORDER BY setting_key"),
      notifications: await q('SELECT customer_id, order_id, template_key, channel, message FROM notification_logs ORDER BY id'),
      audit: await q('SELECT action, module, record_id, old_value, new_value FROM audit_logs ORDER BY id').then((r) =>
        r.map((a: any) => ({ action: a.action, module: a.module, record_id: a.record_id, old: parse(a.old_value), new: parse(a.new_value) }))),
    };
  }
  const normalize = (v: any): any => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x)));

  async function parity(steps: Step[]) {
    const results: Record<'php' | 'node', any[]> = { php: [], node: [] };
    const snaps: any = {};
    await reset();
    for (const s of steps) results.php.push(pick(runPhp(s)));
    snaps.php = normalize(await snapshot(db));
    await reset();
    for (const s of steps) results.node.push(pick(await runNode(s)));
    snaps.node = normalize(await snapshot(db));
    return { results, snaps };
  }
  const expectParity = async (steps: Step[]) => {
    const { results, snaps } = await parity(steps);
    expect(results.node).toEqual(results.php);
    for (const k of Object.keys(snaps.php)) expect({ [k]: snaps.node[k] }).toEqual({ [k]: snaps.php[k] });
    return results.php;
  };

  const line = (g: number, s: number, extra: object = {}) => ({ garment_id: g, service_id: s, quantity: 1, ...extra });

  it('piece order: mixed tax, percent discount, urgent, delivery, split payment', async () => {
    const r = await expectParity([{
      op: 'createOrder', can_override_discount: true,
      input: {
        customer_id: 2, urgent_level_id: 1, discount_type: 'Percent', discount_value: 7.5, home_delivery: 1, delivery_charge: 40, notes: ' hi ',
        packaging_preference: 'HANGER',
        items: [line(1, 1, { quantity: 3, brand_id: 1, color_id: 1, defect_ids: [1, 2], remarks: 'x' }), line(2, 1), line(2, 2, { quantity: 2 }), line(1, 2, { quantity: 7 })],
        payments: [{ payment_type_id: 1, amount: 500 }, { payment_type_id: 2, amount: 300.25 }],
      },
    }]);
    expect(r[0].success).toBe(true);
  });

  it('VIP list + wallet + flat discount + rounding stress', async () => {
    await expectParity([{
      op: 'createOrder', can_override_discount: true,
      input: { customer_id: 1, discount_type: 'Flat', discount_value: 33.33, wallet_amount: 200, items: [line(1, 1, { quantity: 3 }), line(1, 2, { quantity: 3 }), line(2, 1)], payments: [{ payment_type_id: 1, amount: 100 }] },
    }, {
      op: 'createOrder', can_override_discount: true,
      input: { customer_id: 2, discount_type: 'Percent', discount_value: 13.37, urgent_level_id: 2, items: [line(1, 1, { quantity: 1.5 }), line(2, 2, { quantity: 3 }), line(2, 1, { quantity: 7 }), line(1, 2, { quantity: 11 })] },
    }]);
  });

  it('weight lines: min charge, rate override, manual override', async () => {
    await expectParity([
      { op: 'createOrder', can_manual_override: true, input: { customer_id: 2, items: [{ garment_id: 3, service_id: 4, weight: 3.7 }, { garment_id: 3, service_id: 4, weight: 1 }, { garment_id: 1, service_id: 1, quantity: 2, rate_override: '88.8' }] } },
      { op: 'createOrder', can_manual_override: true, input: { customer_id: 2, items: [{ garment_id: 1, service_id: 3, weight: 2, manual_override: true, rate_override: 70 }, { garment_id: 2, service_id: 1, quantity: 1, manual_override: 1, rate_override: '12.345' }] } },
    ]);
  });

  it('validation failures are identical', async () => {
    const r = await expectParity([
      { op: 'createOrder', input: { customer_id: 99, items: [] } },
      { op: 'createOrder', input: { customer_id: 2, urgent_level_id: 77, items: [line(1, 1)] } },
      { op: 'createOrder', input: { customer_id: 2, items: [line(1, 3, { weight: 1 }), line(0, 0), { garment_id: 1, service_id: 1, quantity: 0 }, { garment_id: 1, service_id: 1, quantity: 1, rate_override: 'abc' }, { garment_id: 1, service_id: 1, quantity: 1, manual_override: 1, rate_override: 5 }] } },
      { op: 'createOrder', input: { customer_id: 2, discount_type: 'Percent', discount_value: 25, items: [line(2, 1)] } },
      { op: 'createOrder', input: { customer_id: 2, items: [line(1, 1)], payments: [{ payment_type_id: 1, amount: 9999 }] } },
      { op: 'createOrder', input: { customer_id: 2, items: [line(1, 1)], wallet_amount: 50 } },
      { op: 'createOrder', input: { customer_id: 1, items: [line(1, 1)], wallet_amount: 9999 }, can_override_discount: true },
      { op: 'createOrder', input: { customer_id: 2, items: [line(1, 1)], payments: [{ payment_type_id: 1, amount: -5 }] } },
    ]);
    expect(r.every((x: any) => x.success === false)).toBe(true);
  });

  it('laundry (per-weight) order', async () => {
    const r = await expectParity([
      { op: 'createLaundryOrder', can_override_discount: true, input: { customer_id: 1, discount_type: 'Percent', discount_value: 5, urgent_level_id: 1, payments: [{ payment_type_id: 1, amount: 100 }], batches: [
        { service_id: 3, weight: 5.5, rate: 61.37, garment_count: 3, garments: [{ garment_id: 1, quantity: 2 }, { garment_id: 2, quantity: 1 }] },
        { service_id: 3, weight: 2.25, rate: 58.9, garment_count: 1, garments: [{ garment_id: 1, quantity: 1 }] },
      ] } },
      { op: 'createLaundryOrder', input: { customer_id: 2, batches: [{ service_id: 1, weight: 1, rate: 10, garment_count: 1, garments: [{ garment_id: 1, quantity: 1 }] }, { service_id: 3, weight: 1, rate: 10, garment_count: 5, garments: [{ garment_id: 1, quantity: 1 }] }] } },
    ]);
    expect(r[0].success).toBe(true);
  });

  const order = (payments: object[] = [], extra: object = {}) => ({ op: 'createOrder', can_override_discount: true, input: { customer_id: 2, items: [line(2, 1, { quantity: 2 })], payments, ...extra } });

  it('payments: partial, overpay, idempotent replay/conflict, wallet', async () => {
    await expectParity([
      order(), // order 1, grand total 2*450.5*1.12
      { op: 'recordPayment', order_id: 1, customer_id: 2, lines: [{ payment_type_id: 1, amount: 400 }], client_request_id: 'r1', fingerprint: 'f1' },
      { op: 'recordPayment', order_id: 1, customer_id: 2, lines: [{ payment_type_id: 1, amount: 400 }], client_request_id: 'r1', fingerprint: 'f1' },
      { op: 'recordPayment', order_id: 1, customer_id: 2, lines: [{ payment_type_id: 1, amount: 401 }], client_request_id: 'r1', fingerprint: 'f2' },
      { op: 'recordPayment', order_id: 1, customer_id: 2, lines: [{ payment_type_id: 2, amount: 99999 }], client_request_id: 'r2', fingerprint: 'f3' },
      { op: 'recordPayment', order_id: 1, customer_id: 2, lines: [{ payment_type_id: 9, amount: 5 }] },
      { op: 'recordPayment', order_id: 1, customer_id: 2, lines: [{ payment_type_id: 2, amount: 100.5 }] },
      { op: 'recordPayment', order_id: 99, customer_id: 2, lines: [{ payment_type_id: 2, amount: 1 }] },
      { op: 'createOrder', can_override_discount: true, input: { customer_id: 1, items: [line(1, 1, { quantity: 5 })] } },
      { op: 'recordPayment', order_id: 2, customer_id: 1, lines: [], wallet: 300, client_request_id: 'w1', fingerprint: 'fw' },
      { op: 'recordPayment', order_id: 2, customer_id: 1, lines: [], wallet: 300, client_request_id: 'w2', fingerprint: 'fw2' },
    ]);
  });

  it('refunds: original method, wallet credit, limits, duplicates', async () => {
    await expectParity([
      order([{ payment_type_id: 1, amount: 1000 }]),
      { op: 'processRefund', order_id: 1, amount: 100, lines: [{ payment_type_id: 1, amount: 60 }, { payment_type_id: 2, amount: 40 }], reason: 'damaged', remarks: 'n', client_request_id: 'rf1', fingerprint: 'a' },
      { op: 'processRefund', order_id: 1, amount: 100, lines: [{ payment_type_id: 1, amount: 60 }, { payment_type_id: 2, amount: 40 }], reason: 'damaged', remarks: 'n', client_request_id: 'rf1', fingerprint: 'a' },
      { op: 'processRefund', order_id: 1, amount: 50, lines: [], to_wallet: true, reason: 'goodwill' },
      { op: 'processRefund', order_id: 1, amount: 5000, lines: [{ payment_type_id: 1, amount: 5000 }], reason: 'too much' },
      { op: 'processRefund', order_id: 1, amount: 10, lines: [{ payment_type_id: 1, amount: 5 }, { payment_type_id: 1, amount: 5 }], reason: 'dup' },
      { op: 'processRefund', order_id: 1, amount: 10, lines: [{ payment_type_id: 1, amount: 3 }], reason: 'sum' },
      { op: 'processRefund', order_id: 1, amount: 10, lines: [{ payment_type_id: 99, amount: 10 }], reason: 'x' },
      { op: 'processRefund', order_id: 1, amount: 10, lines: [], reason: '  ' },
    ]);
  });

  it('edit: add/remove item, change discount/urgent (with and without reason), cancel', async () => {
    await expectParity([
      order([{ payment_type_id: 1, amount: 200 }], { items: [line(1, 1, { quantity: 2 }), line(2, 1)] }),
      { op: 'addItem', order_id: 1, item: line(2, 2, { quantity: 3 }), client_request_id: 'i1' },
      { op: 'addItem', order_id: 1, item: line(2, 2, { quantity: 3 }), client_request_id: 'i1' },
      { op: 'addItem', order_id: 1, item: line(1, 3, { weight: 1 }) },
      { op: 'addItem', order_id: 1, item: { garment_id: 3, service_id: 4, weight: 0.5, manual_override: 1, rate_override: 20 }, can_manual_override: true },
      { op: 'removeItem', order_id: 1, item_id: 2 },
      { op: 'removeItem', order_id: 1, item_id: 999 },
      { op: 'editOrder', order_id: 1, changes: { discount_type: 'Percent', discount_value: 5 }, reason: '', can_override_discount: true },
      { op: 'editOrder', order_id: 1, changes: { discount_type: 'Percent', discount_value: 5, urgent_level_id: 1 }, reason: 'loyal', can_override_discount: true },
      { op: 'editOrder', order_id: 1, changes: { discount_type: 'Percent', discount_value: 50 }, reason: 'cap', can_override_discount: false },
      { op: 'editOrder', order_id: 1, changes: { notes: 'later', home_delivery: 1, delivery_charge: 25, due_date: '2030-01-05' } },
      { op: 'editOrder', order_id: 1, changes: {} },
      { op: 'cancelOrder', order_id: 1, reason: 'customer left' },
      { op: 'cancelOrder', order_id: 1, reason: 'again' },
      { op: 'recordPayment', order_id: 1, customer_id: 2, lines: [{ payment_type_id: 1, amount: 1 }] },
    ]);
  });

  it('discount remainder lands on the last line, at creation and after an edit', async () => {
    await expectParity([
      // three equal 99.99 lines, flat 100 discount: 33.33 + 33.33 + 33.34
      { op: 'createOrder', can_override_discount: true, input: { customer_id: 2, discount_type: 'Flat', discount_value: 100, items: [line(1, 1), line(1, 1), line(1, 1)] } },
      { op: 'addItem', order_id: 1, item: line(1, 2, { quantity: 3 }) },
      { op: 'editOrder', order_id: 1, changes: { discount_type: 'Percent', discount_value: 33.33 }, reason: 'r', can_override_discount: true },
      { op: 'removeItem', order_id: 1, item_id: 1 },
      // omitted discount_type: PHP stores NULL and prices the value as FLAT
      { op: 'createOrder', can_override_discount: true, input: { customer_id: 2, discount_value: 10, items: [line(2, 1, { quantity: 3 })] } },
      { op: 'addItem', order_id: 2, item: line(1, 1) },
    ]);
  });

  it('Set garments: tags run over physical pieces (create, add item, remove item); piece data is copied onto the line', async () => {
    const r = await expectParity([
      // Suit x1 (1 piece), Socks x2 (2 pcs each = 4 tags), Shirt x1, Salwar Set x1.5 (3 pcs each = round(4.5) = 5 tags), Odd Names x1, Carpet by weight (never multiplied)
      { op: 'createOrder', can_override_discount: true, can_manual_override: true, input: { customer_id: 1, items: [line(2, 1), line(4, 1, { quantity: 2 }), line(1, 1), line(5, 1, { quantity: 1.5 }), line(6, 1), { garment_id: 3, service_id: 4, weight: 2 }] } },
      { op: 'addItem', order_id: 1, item: line(4, 1, { quantity: 3 }) },
      { op: 'addItem', order_id: 1, item: line(5, 2), client_request_id: 'set-1' },
      { op: 'addItem', order_id: 1, item: line(5, 2), client_request_id: 'set-1' },
      { op: 'removeItem', order_id: 1, item_id: 8 }, // removeItem renumbers EVERY remaining tag to a clean 1..N (2026-10-23..24 changelog) -- removing the last item just happens to leave the lower numbers untouched
      { op: 'addItem', order_id: 1, item: line(1, 1) },
      // garment master changes after the order: the order keeps its own copy of pieces_per_unit / piece_names
      { op: 'createOrder', can_override_discount: true, input: { customer_id: 2, items: [line(4, 1), line(6, 1, { quantity: 2 })], payments: [{ payment_type_id: 1, amount: 50 }] } },
    ]);
    expect(r[0].success).toBe(true);
    // the long order number is internal; callers get the Short Order Code
    expect(r[0].order_number).toMatch(/^A\d{4}$/);
  });

  it('Set garments on the Per-Weight (laundry) flow and the returned short code', async () => {
    const r = await expectParity([
      { op: 'createLaundryOrder', input: { customer_id: 1, batches: [{ service_id: 3, weight: 2, rate: 60, garment_count: 2, garments: [{ garment_id: 4, quantity: 1 }, { garment_id: 1, quantity: 1 }] }] } },
      { op: 'createOrder', input: { customer_id: 2, items: [line(4, 1)] } },
    ]);
    expect(r[0].order_number).toMatch(/^A\d{4}$/);
  });

  it('removing a MIDDLE item renumbers every remaining tag to a clean 1..N, including the printed tag-id text (2026-10-23..24 changelog)', async () => {
    const r = await expectParity([
      // Socks x2 (2pcs each = 4 tags, seq 1-4), Shirt x1 (seq 5), Salwar Set x1 (3pcs, seq 6-8) -- 8 pieces total, 3 order_items
      { op: 'createOrder', can_override_discount: true, input: { customer_id: 1, items: [line(4, 1, { quantity: 2 }), line(1, 1), line(5, 1)] } },
      // remove the MIDDLE item (the single Shirt, seq 5) -- the trailing Salwar Set's 3 tags (previously 6,7,8) must renumber to 5,6,7, not stay at 6-8
      { op: 'removeItem', order_id: 1, item_id: 2 },
      // a further add continues from the new, renumbered total (7), not the old pre-removal total (8)
      { op: 'addItem', order_id: 1, item: line(1, 1) },
    ]);
    expect(r[0].success, JSON.stringify(r[0])).toBe(true);
    expect(r[1].success, JSON.stringify(r[1])).toBe(true);
    expect(r[2].success, JSON.stringify(r[2])).toBe(true);
  });

  it('updateItem: quantity, rate, remarks, brand/colour, defects; the same guards as addItem', async () => {
    const r = await expectParity([
      { op: 'createOrder', can_override_discount: true, can_manual_override: true, input: { customer_id: 1, discount_type: 'Percent', discount_value: 5, urgent_level_id: 1, items: [
        line(1, 1, { quantity: 2, brand_id: 1, color_id: 1, defect_ids: [1], remarks: 'old' }), line(4, 1, { quantity: 2 }), { garment_id: 3, service_id: 4, weight: 2 }, line(2, 1, { quantity: 1 }) ] } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { quantity: 5 } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { remarks: ' new <b> ', brand_id: null, color_id: 1, defect_ids: [1, 2] } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { defect_ids: [] } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { rate_override: '88.8' } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { rate_override: 'abc' } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { rate_override: -4 } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { quantity: 0 } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { manual_override: true, rate_override: 10 } },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { manual_override: true, rate_override: 10 }, can_manual_override: true },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { manual_override: true }, can_manual_override: true },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { manual_override: false, quantity: 3 }, can_manual_override: true },
      { op: 'updateItem', order_id: 1, item_id: 2, raw: { quantity: 4 } },
      { op: 'updateItem', order_id: 1, item_id: 3, raw: { weight: 3.5 } },
      { op: 'updateItem', order_id: 1, item_id: 3, raw: { weight: 0 } },
      { op: 'updateItem', order_id: 1, item_id: 3, raw: { weight: 0.1 } },
      { op: 'updateItem', order_id: 1, item_id: 3, raw: { manual_override: true, rate_override: 99, weight: 1 }, can_manual_override: true },
      { op: 'updateItem', order_id: 1, item_id: 999, raw: { quantity: 1 } },
      { op: 'updateItem', order_id: 99, item_id: 1, raw: { quantity: 1 } },
      { op: 'updateItem', order_id: 1, item_id: 4, raw: {} },
      { op: 'cancelOrder', order_id: 1, reason: 'nope' },
      { op: 'updateItem', order_id: 1, item_id: 1, raw: { quantity: 9 } },
    ]);
    expect(r[1].success).toBe(true);
  });

  it('updateItem is locked once processing has begun', async () => {
    const run = async (impl: 'php' | 'node') => {
      await reset();
      const first = impl === 'php' ? runPhp(order() as any) : await runNode(order() as any);
      await db.execute('UPDATE orders SET status_id = 3 WHERE id = ?', [first.order_id]);
      const s: Step = { op: 'updateItem', order_id: first.order_id, item_id: 1, raw: { quantity: 4 } };
      return pick(impl === 'php' ? runPhp(s) : await runNode(s));
    };
    const a = await run('php'), b = await run('node');
    expect(b).toEqual(a);
    expect(a.success).toBe(false);
  });

  it('cancel without payment; processing-begun orders are locked', async () => {
    await expectParity([
      order(), order(),
      { op: 'cancelOrder', order_id: 1, reason: 'no show' },
      { op: 'cancelOrder', order_id: 2, reason: '' },
    ]);
    // order moved out of order_created cannot be edited/cancelled (same in both)
    const moved = async (impl: 'php' | 'node') => {
      await reset();
      const first = impl === 'php' ? runPhp(order() as any) : await runNode(order() as any);
      await db.execute('UPDATE orders SET status_id = 3 WHERE id = ?', [first.order_id]);
      const steps: Step[] = [
        { op: 'cancelOrder', order_id: first.order_id, reason: 'x' },
        { op: 'addItem', order_id: first.order_id, item: line(1, 1) },
        { op: 'editOrder', order_id: first.order_id, changes: { notes: 'z' } },
      ];
      const out = [];
      for (const s of steps) out.push(pick(impl === 'php' ? runPhp(s) : await runNode(s)));
      return out;
    };
    expect(await moved('node')).toEqual(await moved('php'));
  });
});
