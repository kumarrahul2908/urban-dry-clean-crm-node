import { describe, expect, it, vi } from 'vitest';
import { buildServices } from '../src/app.js';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness } from './web/harness.js';

vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!webEnabled)('orders pages: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);

  const prepare = async (db: Db) => {
    const extra = ['orders.edit', 'orders.cancel', 'payments.refund', 'payments.create', 'billing.view', 'garment_tags.view', 'garment_tags.print', 'pos.override_discount'];
    await db.execute(`INSERT IGNORE INTO permissions (permission_key, module) VALUES ${extra.map((k) => `('${k}', 'x')`).join(',')}`);
    await db.execute(`INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN (${extra.map((k) => `'${k}'`).join(',')})`);
    // admin (role 1): everything except cancel/refund/override
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 1, id FROM permissions WHERE permission_key IN ('orders.edit','billing.view','garment_tags.view','payments.create')");
    await db.execute('UPDATE orders SET order_date = NOW() - INTERVAL id HOUR, due_time = NULL'); // distinct sort keys
    await db.execute("UPDATE orders SET due_time = '16:45:00', notes = 'handle <i>with</i> care' WHERE id = 1");
    await db.execute("UPDATE customers SET address = '5 Market Road' WHERE id IN (1, 2)");
  };

  const asBoss = async () => {
    const c = await login('boss');
    await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php');
    const a = await c.php.post('/api/set_active_store.php', { store_id: '1' }), b = await c.node.post('/api/set_active_store.php', { store_id: '1' });
    expect(JSON.parse(a.body).success && JSON.parse(b.body).success).toBe(true);
    return c;
  };

  it('list: filters, pagination, roles', async () => {
    await seedRich(prepare);
    const svc = buildServices(h.env, h.db);
    for (let i = 0; i < 24; i++) await svc.orders.createOrder({ customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);
    await h.db.execute('UPDATE orders SET order_date = NOW() - INTERVAL id MINUTE');
    for (const who of ['admin', 'boss', 'nobody'] as const) {
      const { php, node } = await login(who);
      for (const q of ['', '?q=UDC-2026-000003', '?q=vip', '?status_id=1', '?status_id=999', '?from=2020-01-01&to=2099-01-01', '?from=2099-01-01', '?q=zzz', '?page=2', '?page=3', '?page=99', '?q=Plain&page=2', '?status_id=abc&page=-1']) {
        eq(await node.get('/modules/orders/list.php' + q), await php.get('/modules/orders/list.php' + q), `${who}${q}`);
      }
    }
  });

  it('view: piece, laundry, cancelled, missing, permissions', async () => {
    await seedRich(prepare);
    const ids = (await h.db.query<any>('SELECT id, order_mode FROM orders ORDER BY id')).map((r: any) => r.id);
    expect((await h.db.query<any>("SELECT 1 FROM orders WHERE order_mode = 'weight'")).length).toBeGreaterThan(0);
    await h.db.execute("UPDATE orders SET status_id = 2, cancelled_at = NOW(), cancelled_by = 1, cancelled_reason = 'Customer <left>' WHERE id = 5");
    await h.db.execute("UPDATE accounts_receivable SET status = 'Refund Due' WHERE order_id = 5");
    for (const who of ['admin', 'boss', 'nobody'] as const) {
      const { php, node } = await login(who);
      for (const id of [...ids, 9999, 0]) eq(await node.get(`/modules/orders/view.php?id=${id}`), await php.get(`/modules/orders/view.php?id=${id}`), `${who} #${id}`, true);
    }
  });

  it('invoice + receipt (default A4, thermal, custom laser; refunds)', async () => {
    await seedRich(prepare);
    await h.db.execute("UPDATE settings SET setting_value = 'Rs.' WHERE setting_key = 'currency_symbol'");
    await h.db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('address', '12 <Main> Road'), ('phone', '98765'), ('whatsapp', '98765'), ('gstin', '07ABC'), ('logo_path', 'logo.png') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
    const payments = (await h.db.query<any>('SELECT id FROM payments ORDER BY id')).map((r: any) => r.id);
    expect(payments.length).toBeGreaterThan(1);
    const { php, node } = await login('boss');
    const orderIds = (await h.db.query<any>('SELECT id FROM orders ORDER BY id')).map((r: any) => r.id);
    for (const cfg of [null, "invoice_printer_type = 'thermal', invoice_width_mm = 80, invoice_height_mm = NULL, invoice_paper_size = '80mm'", "invoice_printer_type = 'laser', invoice_width_mm = 215.9, invoice_height_mm = 279.4, invoice_paper_size = 'letter'"]) {
      if (cfg) await h.db.execute(`INSERT INTO store_print_settings (store_id) VALUES (1) ON DUPLICATE KEY UPDATE store_id = store_id`).then(() => h.db.execute(`UPDATE store_print_settings SET ${cfg} WHERE store_id = 1`));
      for (const id of [...orderIds, 999]) eq(await node.get(`/modules/orders/invoice.php?id=${id}`), await php.get(`/modules/orders/invoice.php?id=${id}`), `invoice #${id} ${cfg ?? 'default'}`);
    }
    for (const id of [...payments, 999]) eq(await node.get(`/modules/orders/receipt.php?payment_id=${id}`), await php.get(`/modules/orders/receipt.php?payment_id=${id}`), `receipt #${id}`);
    const nobody = await login('nobody');
    eq(await nobody.node.get('/modules/orders/invoice.php?id=1'), await nobody.php.get('/modules/orders/invoice.php?id=1'), 'invoice 403');
    eq(await nobody.node.get('/modules/orders/receipt.php?payment_id=1'), await nobody.php.get('/modules/orders/receipt.php?payment_id=1'), 'receipt 403');
  });

  it('edit: form, validation, discount ceiling, success (DB state identical)', async () => {
    await seedRich(prepare);
    await h.db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('max_counter_discount_percent', '10') ON DUPLICATE KEY UPDATE setting_value = '10'");
    const { php, node } = await asBoss();
    const admin = await login('admin');
    for (const [c, label] of [[{ php, node }, 'boss'], [admin, 'admin']] as const) {
      for (const p of ['/modules/orders/edit.php?id=1', '/modules/orders/edit.php?id=4', '/modules/orders/edit.php?id=999']) eq(await c.node.get(p), await c.php.get(p), `${label} ${p}`);
    }
    const form = { due_date: '2026-12-31', due_time: '10:30', urgent_level_id: '1', discount_type: 'Percent', discount_value: '5', notes: 'n <b>', workshop_notes: 'w', home_delivery: 'on', delivery_charge: '40', reason: 'customer asked' };
    await write('edit success (boss)', php, node, (c) => c.post('/modules/orders/edit.php?id=1', form));
    await write('edit no reason', php, node, (c) => c.post('/modules/orders/edit.php?id=1', { ...form, reason: '' }));
    await write('edit bad date', php, node, (c) => c.post('/modules/orders/edit.php?id=1', { ...form, due_date: '' }));
    await write('edit flat discount > total', php, node, (c) => c.post('/modules/orders/edit.php?id=1', { ...form, discount_type: 'Flat', discount_value: '999999' }));
    await write('edit admin over ceiling', admin.php, admin.node, (c) => c.post('/modules/orders/edit.php?id=1', { ...form, discount_value: '50' }));
    await write('edit admin within ceiling', admin.php, admin.node, (c) => c.post('/modules/orders/edit.php?id=1', { ...form, discount_value: '8', urgent_level_id: '' }));
    await write('edit csrf', php, node, (c) => c.post('/modules/orders/edit.php?id=1', form, { csrf: false }));
    await write('edit not editable', php, node, (c) => c.post('/modules/orders/edit.php?id=3', form));
  });

  it('payment + refund + receipt flow: pages, validation, DB state identical', async () => {
    await seedRich(prepare);
    await h.db.execute("INSERT INTO customer_wallet (customer_id, balance) VALUES (2, 80) ON DUPLICATE KEY UPDATE balance = 80");
    await h.db.execute("INSERT INTO wallet_transactions (customer_id, txn_type, debit, credit, balance_after, remarks) VALUES (2, 'Deposit', 0, 80, 80, 'adv')");
    await h.db.execute("INSERT INTO whatsapp_accounts (id, store_id, account_name, waba_id, phone_number_id, access_token_encrypted, api_version, is_active) VALUES (1, NULL, 'M', 'w', 'p', 'AAAA', 'v21.0', 1)");
    await h.db.execute("INSERT INTO notification_templates (template_key, channel, body, is_active) VALUES ('payment_received', 'WhatsApp', 'Paid {paid_amount} for {order_number} - {customer_name}', 1)");
    const { php, node } = await asBoss();
    const fixed = await login('admin');
    // pages
    for (const p of ['/modules/orders/payment.php?id=1', '/modules/orders/payment.php?id=2', '/modules/orders/payment.php?id=999', '/modules/orders/refund.php?id=1', '/modules/orders/refund.php?id=4', '/modules/orders/refund.php?id=999']) {
      eq(await node.get(p), await php.get(p), p);
    }
    const nobody = await login('nobody');
    for (const p of ['/modules/orders/payment.php?id=1', '/modules/orders/refund.php?id=1']) eq(await nobody.node.get(p), await nobody.php.get(p), `nobody ${p}`);
    // boss with no active store → 403 store boundary
    const fresh = await login('boss');
    for (const p of ['/modules/orders/payment.php?id=1', '/modules/orders/refund.php?id=1']) eq(await fresh.node.get(p), await fresh.php.get(p), `no active store ${p}`);

    const due = (await h.db.query<any>('SELECT id, current_due FROM orders WHERE id IN (2, 3, 4) ORDER BY id')).map((r: any) => `${r.id}:${r.current_due}`);
    expect(due.length).toBe(3);
    const pay = (id: number, over: Record<string, string | string[]> = {}) => (c: any) => c.post(`/modules/orders/payment.php?id=${id}`, { 'payment_type_id[]': '1', 'amount[]': '10', wallet_amount: '0', ...over });
    await write('payment cash partial', php, node, pay(2, { 'amount[]': '25.5' }));
    await write('payment with wallet', php, node, pay(2, { 'amount[]': '5', wallet_amount: '20' }));
    await write('payment wallet over balance', php, node, pay(2, { wallet_amount: '9999', 'amount[]': '' }));
    await write('payment nothing', php, node, pay(2, { 'amount[]': '', wallet_amount: '0' }));
    await write('payment over due', php, node, pay(2, { 'amount[]': '999999' }));
    await write('payment csrf', php, node, (c) => c.post('/modules/orders/payment.php?id=2', { 'amount[]': '5' }, { csrf: false }));
    await write('payment other store (admin fixed store)', fixed.php, fixed.node, pay(2, { 'amount[]': '1' }));

    const ref = (id: number, over: Record<string, string> = {}) => (c: any) => c.post(`/modules/orders/refund.php?id=${id}`, { refund_amount: '10', 'payment_type_id[]': '1', 'amount[]': '10', reason: 'damaged', remarks: 'r', ...over });
    await write('refund partial cash', php, node, ref(1));
    await write('refund to wallet', php, node, ref(1, { credit_to_wallet: 'on', 'amount[]': '' }));
    await write('refund > net paid', php, node, ref(1, { refund_amount: '99999' }));
    await write('refund without reason', php, node, ref(1, { reason: '' }));
    await write('refund lines mismatch', php, node, ref(1, { 'amount[]': '3' }));
    await write('refund nothing paid', php, node, ref(4));

    // receipts for the new payments
    for (const id of [1, 2]) {
      const r = await write(`receipt ${id}`, php, node, (c) => c.get(`/modules/orders/receipt.php?payment_id=${id}`));
      expect(r.status).toBe(200);
    }
  });

  it('JSON actions: add_item / remove_item / cancel', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const post = (path: string, body: Record<string, unknown>, withCsrf = true) => async (c: any) => {
      // JSON body with csrf_token inside, as udcPost() sends it
      const url = path;
      const csrf = c.csrf();
      if (c === php) {
        const r = await fetch(`http://127.0.0.1:${h.port}${url}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: php.cookie() }, body: JSON.stringify({ ...body, ...(withCsrf ? { csrf_token: csrf } : {}) }) });
        return { status: r.status, location: null, body: await r.text(), type: r.headers.get('content-type') };
      }
      const r = await h.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', cookie: node.cookie() }, payload: JSON.stringify({ ...body, ...(withCsrf ? { csrf_token: csrf } : {}) }) });
      return { status: r.statusCode, location: null, body: r.body, type: String(r.headers['content-type'] ?? '') };
    };
    const items = (await h.db.query<any>('SELECT id, order_id FROM order_items ORDER BY id LIMIT 6'));
    const o1Item = items.find((i: any) => Number(i.order_id) === 1).id;
    await write('remove item', php, node, post('/modules/orders/remove_item.php', { order_id: 1, item_id: o1Item }), { jsonBody: true });
    await write('remove item (missing)', php, node, post('/modules/orders/remove_item.php', { order_id: 1, item_id: 99999 }), { jsonBody: true });
    await write('remove item csrf', php, node, post('/modules/orders/remove_item.php', { order_id: 1, item_id: o1Item }, false), { jsonBody: true });
    await write('add item', php, node, post('/modules/orders/add_item.php', { order_id: 1, garment_id: 2, service_id: 1, quantity: 2 }), { jsonBody: true });
    await write('add item (bad garment)', php, node, post('/modules/orders/add_item.php', { order_id: 1, garment_id: 999, service_id: 1, quantity: 1 }), { jsonBody: true });
    await write('add item (non-editable order)', php, node, post('/modules/orders/add_item.php', { order_id: 3, garment_id: 2, service_id: 1, quantity: 1 }), { jsonBody: true });
    await write('cancel', php, node, post('/modules/orders/cancel.php', { order_id: 1, reason: 'test <x>' }), { jsonBody: true });
    await write('cancel no reason', php, node, post('/modules/orders/cancel.php', { order_id: 1, reason: '' }), { jsonBody: true });
    await write('cancel not found', php, node, post('/modules/orders/cancel.php', { order_id: 999, reason: 'x' }), { jsonBody: true });
    // permission / auth
    const nobody = await login('nobody');
    for (const p of ['add_item', 'remove_item', 'cancel']) {
      const a = await nobody.php.post(`/modules/orders/${p}.php`, { order_id: '1' }), b = await nobody.node.post(`/modules/orders/${p}.php`, { order_id: '1' });
      eq(b, a, `nobody ${p}`);
      const anon = await login(null);
      const x = await anon.php.get(`/modules/orders/${p}.php`), y = await anon.node.get(`/modules/orders/${p}.php`);
      eq(y, x, `anonymous ${p}`);
    }
    const g1 = await node.get('/modules/orders/cancel.php'), g2 = await php.get('/modules/orders/cancel.php');
    expect(JSON.parse(g1.body)).toEqual(JSON.parse(g2.body));
    expect(g2.status).toBe(400);
  });
});
