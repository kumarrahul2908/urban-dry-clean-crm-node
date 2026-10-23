import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { resetAndSeed } from './helpers.js';

const enabled = !!process.env.TEST_DB_NAME;

describe.skipIf(!enabled)('orders + payments HTTP API (real MariaDB schema)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let h: { authorization: string };
  let viewer: { authorization: string };

  beforeAll(async () => {
    await resetAndSeed(db);
    const perms = ['pos.create', 'orders.view', 'orders.edit', 'orders.cancel', 'payments.collect', 'payments.refund', 'payments.view', 'pos.override_discount', 'pos.manual_rate_override', 'packing.manage'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${perms.map((_, i) => `(1, ${i + 1})`).join(',')}`);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (2, 'Viewer')");
    await db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (2, 2)');
    const hash = await hashPassword('pw12345');
    await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [hash]);
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (2, 2, 'View Only', 'viewer', ?, 1, 1)", [hash]);
    app = await buildApp(buildServices(env, db));
    const login = async (u: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: u, password: 'pw12345' } })).json().data.token}` });
    h = await login('rahul');
    viewer = await login('viewer');
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  const post = (url: string, payload: unknown, headers = h) => app.inject({ method: 'POST', url: `/api/mobile/${url}`, headers, payload: payload as object });
  const get = (url: string, headers = h) => app.inject({ method: 'GET', url: `/api/mobile/${url}`, headers });
  let orderId = 0;

  it('creates an order, idempotently', async () => {
    const body = { client_request_id: 'c-1', customer_id: 2, discount_type: 'Percent', discount_value: 0, items: [{ garment_id: 1, service_id: 1, quantity: 2 }], payments: [{ payment_type_id: 1, amount: 50 }] };
    const r = await post('pos_orders_create', body);
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    orderId = d.order_id;
    // 2 x 99.99 = 199.98, GST 5% = 10.00 (9.999 rounds up)
    expect(d).toMatchObject({ order_number: 'A0001', invoice_number: 'INV-000001', grand_total: 209.98, idempotent_replay: false });

    // the user-facing identifier is the Short Order Code; the long order number is kept internally
    expect((await db.query<any>('SELECT order_number, short_order_code FROM orders WHERE id = ?', [orderId]))[0]).toMatchObject({ short_order_code: 'A0001', order_number: expect.stringMatching(/^UDC-\d{4}-000001$/) });
    const again = (await post('pos_orders_create', body)).json().data;
    expect(again).toMatchObject({ order_id: orderId, order_number: 'A0001', idempotent_replay: true, grand_total: 209.98 });
    expect(Number((await db.query<any>('SELECT COUNT(*) AS n FROM orders'))[0].n)).toBe(1);
  });

  it('rejects bad requests with the usual envelope', async () => {
    expect((await post('pos_orders_create', { customer_id: 2 })).json().error).toMatchObject({ code: 'invalid_request', message: 'A valid client_request_id is required.' });
    const bad = await post('pos_orders_create', { client_request_id: 'c-2', customer_id: 2, items: [{ garment_id: 1, service_id: 3, weight: 1 }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'validation_failed', message: 'Could not create the order.', field_errors: [expect.stringContaining('No price configured for Shirt / Wash N Fold')] });
    expect((await app.inject({ method: 'POST', url: '/api/mobile/pos_orders_create', headers: { ...h, 'content-type': 'application/json' }, payload: '{bad' })).json().error.code).toBe('invalid_request');
    expect((await post('pos_orders_create', { client_request_id: 'c-3', customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, viewer)).statusCode).toBe(403);
  });

  it('detail, list, search', async () => {
    const d = (await get(`orders_detail?id=${orderId}`)).json().data;
    expect(d.order).toMatchObject({ id: orderId, status_key: 'order_created', grand_total: '209.98', total_paid: '50.00', current_due: '159.98', customer_name: 'Plain' });
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ garment_name: 'Shirt', service_name: 'Dry Clean', defects: [] });
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0].breakdown).toBe('Cash: 50.00');
    expect(d.receivable_status).toBe('Open');
    expect(d.order_actions).toMatchObject({ can_edit: true, can_add_item: true, can_remove_item: false, can_cancel: true, max_discount_percent: 10 });
    expect(d.wallet_balance).toBe(0);

    const l = (await get('orders_list?q=Plain')).json().data;
    expect(l).toMatchObject({ total: 1, per_page: 20, total_pages: 1 });
    expect(l.results[0]).toMatchObject({ id: orderId, status_label: 'Created' });
    expect((await get('orders_search?q=Pla')).json().data.results[0].order_number).toBeTruthy();
    expect((await get('orders_search?q=P')).json().data.results).toEqual([]);
    expect((await get(`orders_detail?id=${orderId}`, viewer)).statusCode).toBe(200);
    expect((await get('orders_detail?id=0')).statusCode).toBe(422);
    expect((await get('orders_detail?id=999')).statusCode).toBe(404);
  });

  it('record payment: updated_due, replay, conflict, overpay', async () => {
    const body = { order_id: orderId, client_request_id: 'p-1', payment_lines: [{ payment_type_id: 2, amount: 100 }] };
    const r = (await post('orders_record_payment', body)).json().data;
    expect(r).toMatchObject({ updated_due: 59.98, idempotent_replay: false, payment_number: 'PAY-000002' });
    expect((await post('orders_record_payment', body)).json().data).toMatchObject({ idempotent_replay: true, payment_id: r.payment_id });
    const conflict = await post('orders_record_payment', { ...body, payment_lines: [{ payment_type_id: 2, amount: 101 }] });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    const over = await post('orders_record_payment', { order_id: orderId, client_request_id: 'p-2', payment_lines: [{ payment_type_id: 1, amount: 9999 }] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.field_errors[0]).toMatch(/exceeds the current outstanding balance of Rs\. 59\.98/);
    expect((await post('orders_record_payment', { order_id: orderId, client_request_id: 'p-3' })).statusCode).toBe(422);
    expect((await post('orders_record_payment', { order_id: orderId, client_request_id: 'p-4', payment_lines: [{ payment_type_id: 1, amount: 1 }] }, viewer)).statusCode).toBe(403);

    const list = (await get('payments_list')).json().data;
    expect(list.total).toBe(2);
    expect(list.payments[0]).toMatchObject({ payment_number: 'PAY-000002', total_amount: 100, lines: [{ type_name: 'UPI', amount: 100, reference_no: null }] });
    expect(list.payment_types.map((t: any) => t.type_name)).toEqual(['Cash', 'UPI', 'Wallet']);
  });

  it('refund to wallet then to original method', async () => {
    const w = await post('orders_record_refund', { order_id: orderId, client_request_id: 'rf-1', refund_amount: 20, credit_to_wallet: true, reason: 'goodwill' });
    expect(w.json().data).toMatchObject({ refund_number: 'REF-000001', updated_due: 79.98 });
    expect(Number((await db.query<any>('SELECT balance FROM customer_wallet WHERE customer_id = 2'))[0].balance)).toBe(20);
    const o = await post('orders_record_refund', { order_id: orderId, client_request_id: 'rf-2', refund_amount: 30, reason: 'x', refund_lines: [{ payment_type_id: 1, amount: 30 }] });
    expect(o.json().data.updated_due).toBe(109.98);
    expect((await post('orders_record_refund', { order_id: orderId, client_request_id: 'rf-3', refund_amount: 30, reason: '' })).statusCode).toBe(422);
    expect((await post('orders_record_refund', { order_id: orderId, client_request_id: 'rf-4', refund_amount: 5000, reason: 'big', refund_lines: [{ payment_type_id: 1, amount: 5000 }] })).json().error.field_errors[0]).toMatch(/exceeds the net amount actually paid/);
  });

  it('edit: no-op, change, add and remove item', async () => {
    const same = await post('order_edit', { order_id: orderId, due_date: (await db.query<any>('SELECT due_date FROM orders WHERE id = ?', [orderId]))[0].due_date, notes: '' });
    expect(same.json().data).toMatchObject({ changed: false });
    const bad = await post('order_edit', { order_id: orderId, due_date: 'nope' });
    expect(bad.json().error).toMatchObject({ code: 'validation_failed', message: 'A valid due date (YYYY-MM-DD) is required.' });
    const changed = await post('order_edit', { order_id: orderId, due_date: '2030-01-05', notes: 'rush', home_delivery: 1, delivery_charge: 25 });
    expect(changed.json().data).toMatchObject({ changed: true, grand_total: 234.98 });

    const add = await post('order_item_add', { order_id: orderId, client_request_id: 'it-1', garment_id: 2, service_id: 2, quantity: 1 });
    expect(add.json().data).toMatchObject({ idempotent_replay: false });
    const itemId = add.json().data.item_id;
    expect((await post('order_item_add', { order_id: orderId, client_request_id: 'it-1', garment_id: 2, service_id: 2, quantity: 1 })).json().data).toMatchObject({ item_id: itemId, idempotent_replay: true });
    expect((await post('order_item_remove', { order_id: orderId, item_id: 99999 })).json().error.code).toBe('item_not_found');
    expect((await post('order_item_remove', { order_id: orderId, item_id: itemId })).json().data).toMatchObject({ removed: true });
    const [{ g }] = await db.query<any>('SELECT grand_total AS g FROM orders WHERE id = ?', [orderId]);
    expect(Number(g)).toBe(234.98);
  });

  it('cancel marks the receivable Refund Due and blocks further changes', async () => {
    const c = await post('order_cancel', { order_id: orderId, reason: 'customer left' });
    expect(c.json().data).toMatchObject({ cancelled: true, receivable_status: 'Refund Due', warning: expect.stringContaining('net effective payment') });
    expect((await post('order_cancel', { order_id: orderId, reason: 'again' })).json().error).toMatchObject({ code: 'already_cancelled', receivable_status: 'Refund Due' });
    expect((await post('order_edit', { order_id: orderId, due_date: '2030-01-06' })).json().error.code).toBe('order_not_editable');
    expect((await post('orders_record_payment', { order_id: orderId, client_request_id: 'late', payment_lines: [{ payment_type_id: 1, amount: 1 }] })).json().error.field_errors[0]).toMatch(/cancelled/);
  });

  it('laundry order over HTTP', async () => {
    const r = await post('laundry_orders_create', { client_request_id: 'l-1', customer_id: 1, batches: [{ service_id: 3, weight: 2, rate: 60, garment_count: 2, garments: [{ garment_id: 1, quantity: 2 }] }] });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ grand_total: 120, idempotent_replay: false });
    const d = (await get(`orders_detail?id=${r.json().data.order_id}`)).json().data;
    expect(d.order.order_mode).toBe('weight');
    expect(d.laundry_garments).toHaveLength(2);
    expect(d.order_actions.can_add_item).toBe(false);
  });
});
