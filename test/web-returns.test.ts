import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!webEnabled)('customer returns: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const o = { sortRows: true };
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('orders.edit','x'),('orders.view','x'),('master.manage','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN ('orders.edit','orders.view','master.manage') WHERE r.id IN (1,3)");
    await db.execute("DELETE FROM return_reasons");
    await db.execute("INSERT INTO return_reasons (id, reason_name, sort_order, is_active) VALUES (1,'Saaf nahi hua (not clean)',1,1),(2,'Daag nahi gaya',2,1),(3,'Badbu / smell',3,1),(4,'Inactive one',4,0)");
    await db.execute("UPDATE orders SET status_id = (SELECT id FROM order_statuses WHERE status_key = 'delivered') WHERE id IN (1, 2)");
    await db.execute("UPDATE order_items SET item_status = 'Delivered' WHERE order_id = 1");
    await db.execute("UPDATE order_items SET item_status = 'Packed' WHERE order_id = 2");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };

  it('pages: return form, returns table, reasons, master tile', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    for (const q of ['?order_id=1', '?order_id=2', '?order_id=3', '?order_id=999', '?order_id=0', '']) await both(php, node, `/modules/orders/return.php${q}`, `return ${q}`);
    for (const q of ['', '?date_from=2020-01-01&date_to=2099-12-31', '?reason_id=2', '?date_from=bad', '?export=1&date_from=2020-01-01&date_to=2099-12-31']) await both(php, node, `/modules/orders/returns.php${q}`, `returns ${q}`);
    await both(php, node, '/modules/master_data/return_reasons.php', 'reasons');
    await both(php, node, '/modules/master_data/index.php', 'master index');
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const c = await login(who as any);
      for (const p of ['/modules/orders/return.php?order_id=1', '/modules/orders/returns.php', '/modules/master_data/return_reasons.php']) await both(c.php, c.node, p, `${who} ${p}`);
    }
  });

  it('register returns (items, reason, note, photo) + resulting returns table', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const items = await h.db.query<any>('SELECT id FROM order_items WHERE order_id = 1 ORDER BY id');
    const items2 = await h.db.query<any>('SELECT id FROM order_items WHERE order_id = 2 ORDER BY id');
    const rp = '/modules/orders/return.php?order_id=1';
    const post = (f: Record<string, string | string[]>, csrf = true) => (c: Client) => c.post(rp, f, { csrf });
    await write('return one item', php, node, post({ order_id: '1', 'item_ids[]': [String(items[0].id)], reason_id: '1', note: ' collar <b>daag</b> ' }), o);
    await write('return all items', php, node, post({ order_id: '1', 'item_ids[]': items.map((i: any) => String(i.id)), reason_id: '2', note: '' }), o);
    await write('no items', php, node, post({ order_id: '1', reason_id: '1' }), o);
    await write('bad reason', php, node, post({ order_id: '1', 'item_ids[]': [String(items[0].id)], reason_id: '99' }), o);
    await write('foreign item', php, node, post({ order_id: '1', 'item_ids[]': [String(items2[0].id)], reason_id: '1' }), o);
    await write('not delivered order', php, node, (c) => c.post('/modules/orders/return.php?order_id=3', { order_id: '3', 'item_ids[]': ['1'], reason_id: '1' }), o);
    await write('csrf', php, node, post({ order_id: '1', 'item_ids[]': [String(items[0].id)], reason_id: '1' }, false), o);
    const up = (name: string, content: Buffer | string) => (c: Client) => c.upload(rp, { order_id: '1', 'item_ids[]': String(items[0].id), reason_id: '3', note: 'with photo' }, { field: 'photo', filename: name, content, type: 'image/png' });
    await write('return with photo', php, node, up('a.png', PNG), o);
    await write('return with bad photo', php, node, up('a.png', 'not an image at all'), o);
    // after a real return: pages show it
    const listed = await write('return then list', php, node, async (c) => { await c.post(rp, { order_id: '1', 'item_ids[]': [String(items[0].id)], reason_id: '1', note: 'x' }); return c.get('/modules/orders/returns.php?date_from=2020-01-01&date_to=2099-12-31'); }, o);
    expect(listed.body).toContain('Customer Returns (1)');
    // reasons admin
    const rr = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/master_data/return_reasons.php', f, { csrf });
    await write('reason add', php, node, rr({ action: 'add', reason_name: 'Button toota', sort_order: '9' }), o);
    await write('reason add empty', php, node, rr({ action: 'add', reason_name: '  ', sort_order: '1' }), o);
    await write('reason edit', php, node, rr({ action: 'edit', id: '2', reason_name: 'Renamed', sort_order: '5' }), o);
    await write('reason toggle', php, node, rr({ action: 'toggle', id: '1' }), o);
    await write('reason delete', php, node, rr({ action: 'delete', id: '3' }), o);
    await write('reason csrf', php, node, rr({ action: 'delete', id: '3' }, false), o);
    expect(true).toBe(true);
  });
});
