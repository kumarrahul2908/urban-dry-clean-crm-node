import { describe, expect, it, vi } from 'vitest';
import { buildServices } from '../src/app.js';
import type { Db } from '../src/db/pool.js';
import { noopOrderHooks } from '../src/services/hooks.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('workshop pages: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);

  const prepare = async (db: Db) => {
    const svc = buildServices(h.env, db, { hooks: noopOrderHooks });
    const A = { userId: 1 };
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('workshop.manage','x'),('workshop.billing','x'),('billing.view','x'),('master.manage','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN ('workshop.manage','workshop.billing','billing.view','master.manage')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 1, id FROM permissions WHERE permission_key IN ('workshop.manage')");
    await db.execute("UPDATE order_items SET item_status = 'Pending' WHERE order_id IN (1, 5)");
    await db.execute("UPDATE orders SET due_date = CURDATE() + INTERVAL (CAST(id AS SIGNED) - 3) DAY");
    const items = await db.query<any>('SELECT id, order_id FROM order_items WHERE order_id IN (1, 5) ORDER BY id');
    const c1 = await svc.workshop.createChallan(1, [items[0].id, items[1].id], 'no <b>bleach</b>', A) as any;
    if (!c1.success) throw new Error(JSON.stringify(c1));
    const c2 = await svc.workshop.createChallan(2, [items[2].id], '', A) as any;
    if (!c2.success) throw new Error(JSON.stringify(c2));
    await db.execute("UPDATE orders SET store_id = 2 WHERE id = 5");
    const wi = await db.query<any>('SELECT id, order_item_id FROM workshop_items ORDER BY id');
    await svc.workshop.startProcessing(wi[1].id, A);
    await svc.workshop.completeProcessing(wi[1].id, A, 'done');
    await svc.workshop.returnToStore(wi[1].id, A, '');
    await db.execute("UPDATE workshop_items SET status = 'Received' WHERE id = ?", [wi[0].id]);
    // laundry garments: back to Pending, challan to workshop 1
    const lgs = await db.query<any>('SELECT id FROM laundry_garments ORDER BY id');
    for (const g of lgs) await db.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, module) VALUES (?, 'QC', 'Pending', 1, NOW() + INTERVAL 1 SECOND, 'workshop')", [g.id]);
    const lc = await svc.workshop.createLaundryChallan(1, [lgs[0].id], 'laundry', A) as any;
    if (!lc.success) throw new Error(JSON.stringify(lc));
    const lwi = (await db.query<any>('SELECT id FROM workshop_items WHERE laundry_garment_id = ?', [lgs[0].id]))[0];
    await svc.workshop.startProcessing(lwi.id, A);
    await svc.workshop.markUnprocessed(wi[2].id, A, 'torn beyond repair');
    await db.execute("UPDATE workshops SET email = 'ws@example.com', gstin = '07AAMCC6729K1Z1', address = 'Line 1\nLine <2>' WHERE id = 1");
  };

  const asBoss = async () => {
    const c = await login('boss');
    await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php');
    await c.php.post('/api/set_active_store.php', { store_id: '1' }); await c.node.post('/api/set_active_store.php', { store_id: '1' });
    return c;
  };
  const both = async (php: Client, node: Client, path: string, label = path, sortRows = false) => {
    const a = await php.get(path), b = await node.get(path);
    eq(b, a, label, sortRows);
    return a;
  };
  const opts = { sortRows: true, ignoreTables: [] as string[] };

  it('dashboard, index, receiving, challans (pages + roles)', async () => {
    await seedRich(prepare);
    for (const who of ['boss', 'admin', 'ws', 'orphan'] as const) {
      const c = who === 'boss' ? await asBoss() : await login(who);
      const { php, node } = c;
      for (const p of ['/modules/workshop/dashboard.php', '/modules/workshop/dashboard.php?store_id=1', '/modules/workshop/dashboard.php?store_id=2', '/modules/workshop/index.php', '/modules/workshop/index.php?status=Pending', '/modules/workshop/index.php?status=Workshop&urgent_only=1',
        '/modules/workshop/index.php?order=1&customer=Vip&garment=Shirt', '/modules/workshop/receiving.php', '/modules/workshop/challan_view.php?id=1', '/modules/workshop/challan_view.php?id=2', '/modules/workshop/challan_view.php?id=3', '/modules/workshop/challan_view.php?id=99',
        '/modules/workshop/challan_print.php?id=1', '/modules/workshop/challan_print.php?id=3', '/modules/workshop/challan_print.php?id=99']) await both(php, node, p, `${who} ${p}`, true);
    }
    expect((await (await asBoss()).php.get('/modules/workshop/index.php')).body).toContain('Awaiting Accept');
    const nobody = await login('nobody');
    for (const p of ['/modules/workshop/dashboard.php', '/modules/workshop/index.php', '/modules/workshop/receiving.php']) await both(nobody.php, nobody.node, p, `nobody ${p}`);
  });

  it('workshop actions (send challan, start/complete, accept, return, unprocessed, receive)', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const post = (path: string, form: Record<string, string>) => (c: Client) => c.post(path, form);
    const ix = '/modules/workshop/index.php';
    const pend = await h.db.query<any>("SELECT id FROM order_items WHERE item_status = 'Pending' ORDER BY id");
    const wi = await h.db.query<any>('SELECT id, status, laundry_garment_id FROM workshop_items ORDER BY id');
    const lgs = await h.db.query<any>('SELECT id FROM laundry_garments ORDER BY id');
    await write('challan none', php, node, post(ix, { action: 'create_challan', workshop_id: '1' }), opts);
    await write('challan', php, node, post(ix, { action: 'create_challan', workshop_id: '1', 'item_ids[]': String(pend[0]?.id ?? 4), remarks: 'r' }), opts);
    await write('laundry challan', php, node, post(ix, { action: 'create_laundry_challan', workshop_id: '2', 'laundry_garment_ids[]': String(lgs[1].id), remarks: 'x' }), opts);
    await write('laundry challan none', php, node, post(ix, { action: 'create_laundry_challan', workshop_id: '2' }), opts);
    await write('accept', php, node, post(ix, { action: 'accept', workshop_item_id: String(wi[0].id), redirect_qs: 'status=Workshop' }), opts);
    await write('accept again', php, node, post(ix, { action: 'accept', workshop_item_id: String(wi[0].id) }), opts);
    await write('start', php, node, post(ix, { action: 'start_processing', workshop_item_id: String(wi[0].id) }), opts);
    await write('complete', php, node, post(ix, { action: 'complete_processing', workshop_item_id: String(wi[0].id), remarks: 'ok' }), opts);
    await write('return', php, node, post(ix, { action: 'return_to_store', workshop_item_id: String(wi[0].id) }), opts);
    await write('laundry complete', php, node, post(ix, { action: 'complete_processing_laundry', workshop_item_id: String(wi.find((x: any) => x.laundry_garment_id).id) }), opts);
    await write('unprocessed', php, node, post(ix, { action: 'mark_unprocessed', workshop_item_id: String(wi[1].id), reason: 'stain' }), opts);
    await write('unprocessed short', php, node, post(ix, { action: 'mark_unprocessed', workshop_item_id: String(wi[1].id), reason: 'x' }), opts);
    await write('resolve', php, node, post(ix, { action: 'resolve_unprocessed', workshop_item_id: String(wi[2].id) }), opts);
    await write('missing item', php, node, post(ix, { action: 'start_processing', workshop_item_id: '999' }), opts);
    await write('receive', php, node, post('/modules/workshop/receiving.php', { workshop_item_id: String(wi[1].id) }), opts);
    await write('receive not returned', php, node, post('/modules/workshop/receiving.php', { workshop_item_id: String(wi[0].id) }), opts);
    // linked workshop login: foreign items hidden, store-side send refused
    const ws = await login('ws');
    await write('ws send refused', ws.php, ws.node, post(ix, { action: 'create_challan', workshop_id: '1', 'item_ids[]': '1' }), opts);
    await write('ws foreign item', ws.php, ws.node, post(ix, { action: 'start_processing', workshop_item_id: String(wi[2].id) }), opts);
    await write('ws own item', ws.php, ws.node, post(ix, { action: 'accept', workshop_item_id: String(wi[0].id) }), opts);
  });

  it('workshop settings: view, validation, save', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const s = '/modules/workshop/settings.php';
    for (const q of ['', '?workshop_id=2', '?workshop_id=99', '?saved=1']) await both(php, node, `${s}${q}`);
    const ws = await login('ws'), orphan = await login('orphan'), adm = await login('admin');
    for (const c of [ws, orphan, adm]) await both(c.php, c.node, s, 'settings other role');
    const base = { workshop_id: '1', company_name: 'Alpha Co', address: 'A\r\nB', phone: '123', email: 'a@b.co', gstin: '07AAMCC6729K1Z1', state_code: '07', invoice_prefix: 'alp', invoice_next_number: '5', payment_terms_days: '30', item_description: 'Dry Clean charges', invoice_notes: 'n', bank_details: 'b' };
    const post = (form: Record<string, string>) => (c: Client) => c.post(s, form);
    const cases: Record<string, Record<string, string>> = {
      ok: {}, 'no company': { company_name: '' }, 'bad email': { email: 'nope' }, 'email edge': { email: 'a..b@x.com' }, 'email unicode': { email: 'é@x.com' }, 'bad gstin': { gstin: '123' }, 'bad gstin state': { gstin: '99AAMCC6729K1Z1' }, 'no gstin bad state': { gstin: '', state_code: '99' },
      'bad prefix': { invoice_prefix: 'a' }, 'dup prefix': { invoice_prefix: 'BET' }, 'next zero': { invoice_next_number: '0' }, 'bad terms': { payment_terms_days: '5' }, 'no desc': { item_description: '' }, 'gstin lower': { gstin: '07aamcc6729k1z1' },
    };
    await h.db.execute("UPDATE workshops SET invoice_prefix = 'BET' WHERE id = 2");
    for (const [name, over] of Object.entries(cases)) await write(`settings ${name}`, php, node, post({ ...base, ...over }), { sortRows: true });
    await write('settings other workshop', php, node, post({ ...base, workshop_id: '2', invoice_prefix: 'BETX' }), { sortRows: true });
    await write('settings csrf', php, node, (c) => c.post(s, base, { csrf: false }), { sortRows: true });
    await write('settings ws login', ws.php, ws.node, post({ ...base, workshop_id: '2' }), { sortRows: true });
  });

  it('workshop report', async () => {
    await seedRich(prepare);
    await h.db.execute("UPDATE workshop_items SET sent_at = NOW() - INTERVAL id DAY");
    const { php, node } = await asBoss();
    for (const q of ['', '?period=15days', '?period=30days', '?period=custom', '?period=custom&from=2020-01-01&to=2099-01-01', '?period=custom&from=bad&to=bad', '?period=zzz', '?store_id=1', '?store_id=2', '?store_id=9', '?period=30days&store_id=2']) await both(php, node, `/modules/workshop/report.php${q}`, `report ${q}`, true);
    expect((await php.get('/modules/workshop/report.php?period=30days')).body).toContain('Combined total');
    for (const who of ['ws', 'orphan', 'admin'] as const) { const c = await login(who); await both(c.php, c.node, '/modules/workshop/report.php?period=30days', `report ${who}`, true); }
  });

  const prepareBills = async (db: Db) => {
    await prepare(db);
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 5, id FROM permissions WHERE permission_key = 'billing.view'");
    const svc = buildServices(h.env, db, { hooks: noopOrderHooks });
    const wi = await db.query<any>('SELECT id, laundry_garment_id FROM workshop_items ORDER BY id');
    await db.execute('UPDATE workshop_items SET sent_at = NOW() - INTERVAL 20 DAY WHERE id = ?', [wi[1].id]);
    await db.execute('UPDATE workshop_items SET sent_at = NOW() - INTERVAL 40 DAY WHERE laundry_garment_id IS NOT NULL');
    await db.execute("INSERT IGNORE INTO workshop_items (id, challan_id, order_item_id, status, sent_at) SELECT 99, challan_id, order_item_id, 'Sent', NOW() FROM workshop_items WHERE id = 0");
    const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const a = await svc.workshopInvoice.createInvoice(null, 1, day(25), day(15), day(0), null, 1, null, null, 'inclusive', 18, null, 'sent_only') as any;
    if (!a.ok) throw new Error(JSON.stringify(a));
    await svc.workshopInvoice.recordPayment(a.bill_id, 5, 1, 'ref <1>', day(0), 'part', 1, null);
    const b = await svc.workshopInvoice.createInvoice(null, 1, day(45), day(35), day(1), 'Laundry period', 1, null, null, 'exclusive', 18, null, 'sent_only') as any;
    if (!b.ok) throw new Error(JSON.stringify(b));
    await h.db.execute("UPDATE workshop_bills SET due_date = CURDATE() - INTERVAL 3 DAY WHERE id = ?", [b.bill_id]);
  };

  it('workshop billing: list, new, review, detail, invoice print', async () => {
    await seedRich(prepareBills);
    for (const who of ['boss', 'admin', 'ws', 'orphan'] as const) {
      const c = who === 'boss' ? await asBoss() : await login(who);
      const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
      for (const p of ['', '?status=Unpaid', '?status=Partially%20Paid', '?status=Overdue', '?status=Paid', '?status=Void', '?status=bogus', '?id=1', '?id=2', '?id=99', '?new=1', '?new=1&store_id=all&workshop_id=1&period=custom&custom_from=2026-01-01',
        '?preview=1', '?preview=1&store_id=all&workshop_id=1', '?preview=1&store_id=all&workshop_id=1&basis=sent_only', '?preview=1&store_id=all&workshop_id=1&period=30days&basis=whole', '?preview=1&store_id=1&workshop_id=1&period=30days&basis=sent_only', '?preview=1&store_id=all&workshop_id=1&basis=bogus', '?new=1&basis=sent_only', '?id=2', '?preview=1&store_id=1&workshop_id=1&period=30days', '?preview=1&store_id=2&workshop_id=2&period=week', '?preview=1&store_id=all&workshop_id=1&period=custom&custom_from=bad&custom_to=bad',
        `?preview=1&store_id=all&workshop_id=1&period=custom&custom_from=${day(60)}&custom_to=${day(0)}&changed=1`, '?created=1', '?preview=1&store_id=9&workshop_id=1',
        '/../bill_print.php?id=1', '/../bill_print.php?id=2', '/../bill_print.php?id=99']) {
        const path = p.startsWith('/') ? `/modules/workshop${p.slice(3)}` : `/modules/workshop/billing.php${p}`;
        await both(c.php, c.node, path, `${who} ${path}`, true);
      }
    }
    expect((await (await asBoss()).php.get('/modules/workshop/billing.php?id=1')).body).toContain('Payments received');
    const nobody = await login('nobody');
    for (const p of ['/modules/workshop/billing.php', '/modules/workshop/bill_print.php?id=1']) await both(nobody.php, nobody.node, p, `nobody ${p}`);
    const anon = await login(null);
    await both(anon.php, anon.node, '/modules/workshop/billing.php', 'anon billing');
  });

  it('workshop billing: generate, pay, void, unprocessed', async () => {
    await seedRich(prepareBills);
    const { php, node } = await asBoss();
    const b = '/modules/workshop/billing.php';
    const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    const post = (form: Record<string, string>) => (c: Client) => c.post(b, form);
    const o = { sortRows: true };
    const items = await h.db.query<any>("SELECT wi.id FROM workshop_items wi ORDER BY wi.id");
    await write('generate all stores', php, node, post({ action: 'generate', store_id: 'all', workshop_id: '1', from: day(6), to: day(0), invoice_date: day(0), subject: 'Charges X', expected_total: '-1', expected_count: '-1', gst_mode: 'none' }), o);
    const bills = await h.db.query<any>('SELECT id FROM workshop_bills ORDER BY id');
    await write('generate sent-only basis', php, node, post({ action: 'generate', store_id: 'all', workshop_id: '1', from: day(6), to: day(0), invoice_date: day(0), subject: 'Sent only', expected_total: '-1', expected_count: '-1', gst_mode: 'exclusive', basis: 'sent_only' }), o);
    await write('generate bogus basis', php, node, post({ action: 'generate', store_id: '1', workshop_id: '1', from: day(60), to: day(0), invoice_date: day(0), subject: '', expected_total: '-1', expected_count: '-1', gst_mode: 'none', basis: 'bogus' }), o);
    await write('generate changed', php, node, post({ action: 'generate', store_id: 'all', workshop_id: '1', from: day(6), to: day(0), invoice_date: day(0), subject: 's', expected_total: '12345', expected_count: '9', gst_mode: 'inclusive' }), o);
    await write('generate no items', php, node, post({ action: 'generate', store_id: '1', workshop_id: '1', from: day(100), to: day(90), invoice_date: day(0), subject: '', expected_total: '0', expected_count: '0', gst_mode: 'exclusive' }), o);
    await write('generate bad dates', php, node, post({ action: 'generate', store_id: 'all', workshop_id: '1', from: 'x', to: 'y', invoice_date: 'z', expected_total: '0', expected_count: '0' }), o);
    await write('generate bad store', php, node, post({ action: 'generate', store_id: '99', workshop_id: '1', from: day(6), to: day(0) }), o);
    await write('pay partial', php, node, post({ action: 'record_payment', bill_id: String(bills[0].id), amount: '10', payment_type_id: '1', reference_no: 'UPI-1', paid_on: day(0), notes: 'n <b>' }), o);
    await write('pay too much', php, node, post({ action: 'record_payment', bill_id: String(bills[0].id), amount: '999999', payment_type_id: '1', paid_on: day(0) }), o);
    await write('pay bad type', php, node, post({ action: 'record_payment', bill_id: String(bills[0].id), amount: '1', payment_type_id: '99', paid_on: day(0) }), o);
    await write('pay future', php, node, post({ action: 'record_payment', bill_id: String(bills[0].id), amount: '1', payment_type_id: '1', paid_on: '2099-01-01' }), o);
    await write('pay zero', php, node, post({ action: 'record_payment', bill_id: String(bills[0].id), amount: '0', payment_type_id: '1', paid_on: day(0) }), o);
    await write('pay void/missing', php, node, post({ action: 'record_payment', bill_id: '99', amount: '1', payment_type_id: '1', paid_on: day(0) }), o);
    await write('void', php, node, post({ action: 'void', bill_id: String(bills[1].id), reason: 'wrong period' }), o);
    await write('void paid', php, node, post({ action: 'void', bill_id: String(bills[0].id), reason: 'oops' }), o);
    await write('void short reason', php, node, post({ action: 'void', bill_id: String(bills[1].id), reason: 'x' }), o);
    await write('unprocessed', php, node, post({ action: 'mark_unprocessed', workshop_item_id: String(items[0].id), reason: 'torn badly', redirect_to: `${h.env.APP_URL}/modules/workshop/billing.php?preview=1` }), o);
    await write('unprocessed no redirect', php, node, post({ action: 'mark_unprocessed', workshop_item_id: String(items[0].id), reason: 'torn badly' }), o);
    await write('unprocessed foreign redirect', php, node, post({ action: 'mark_unprocessed', workshop_item_id: String(items[0].id), reason: 'torn badly', redirect_to: 'https://evil.example/' }), o);
    await write('resolve', php, node, post({ action: 'resolve_unprocessed', workshop_item_id: String(items[2].id) }), o);
    await write('csrf', php, node, (c) => c.post(b, { action: 'void', bill_id: '1', reason: 'abc' }, { csrf: false }), o);
    // workshop login (workshop 1): own bills only; orphan: blocked
    const ws = await login('ws'), orphan = await login('orphan');
    await write('ws pay', ws.php, ws.node, post({ action: 'record_payment', bill_id: String(bills[0].id), amount: '1', payment_type_id: '1', paid_on: day(0) }), o);
    await write('ws generate other workshop', ws.php, ws.node, post({ action: 'generate', store_id: 'all', workshop_id: '2', from: day(6), to: day(0), invoice_date: day(0), subject: '', expected_total: '-1', expected_count: '-1' }), o);
    await write('orphan generate', orphan.php, orphan.node, post({ action: 'generate', store_id: 'all', workshop_id: '1', from: day(6), to: day(0), invoice_date: day(0) }), o);
    const viewer = await login('nobody');
    await write('viewer cannot manage', viewer.php, viewer.node, post({ action: 'void', bill_id: String(bills[0].id), reason: 'abc' }), o);
  });
});
