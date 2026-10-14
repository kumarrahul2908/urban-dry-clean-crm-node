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
});
