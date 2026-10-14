import { describe, expect, it, vi } from 'vitest';
import { buildServices } from '../src/app.js';
import type { Db } from '../src/db/pool.js';
import { noopOrderHooks } from '../src/services/hooks.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('barcode / tags / packing stickers: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);

  const prepare = async (db: Db) => {
    const svc = buildServices(h.env, db, { hooks: noopOrderHooks });
    const extra = ['garment_tags.print', 'garment_tags.reprint', 'packing.manage', 'workshop.manage', 'garment_tags.view'];
    await db.execute(`INSERT IGNORE INTO permissions (permission_key, module) VALUES ${extra.map((k) => `('${k}', 'x')`).join(',')}`);
    await db.execute(`INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN (${extra.map((k) => `'${k}'`).join(',')})`);
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 1, id FROM permissions WHERE permission_key IN ('garment_tags.view','garment_tags.print')");
    await db.execute("UPDATE order_items SET remarks = 'lint <b>roller</b>' WHERE id = 1");
    await db.execute("UPDATE garment_tags SET printed_count = 2, last_printed_at = NOW() - INTERVAL 1 DAY, last_printed_by = 1 WHERE barcode_id IN (1, 2)");
    await db.execute("UPDATE stores SET store_name = 'Main <Store>' WHERE id = 1");
    await db.execute("INSERT INTO store_print_settings (store_id, tag_width_mm, tag_height_mm, tag_unit, tag_printer_name) VALUES (2, 50, 70, 'mm', '') ON DUPLICATE KEY UPDATE tag_width_mm = 50");
    const pk = await svc.packing.createPackages(1, 3, 2, 1) as any;
    if (!pk.success) throw new Error(JSON.stringify(pk));
    await svc.packing.recordPrint(1, 1);
    // an item without a barcode (defensive path)
    await db.execute("DELETE FROM garment_tags WHERE order_item_id = 5");
    await db.execute("DELETE FROM barcodes WHERE order_item_id = 5");
    const defect = (await db.query<any>('SELECT id FROM defects LIMIT 1'))[0];
    if (defect) await db.execute('INSERT IGNORE INTO order_item_defects (order_item_id, defect_id) VALUES (1, ?)', [defect.id]);
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
  const o = { sortRows: true };

  it('pages: search, scan, tags list, garment detail, packing, tags print (GET)', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const tok = (await h.db.query<any>('SELECT qr_token FROM packing ORDER BY id LIMIT 1'))[0].qr_token;
    const bc = await h.db.query<any>('SELECT id, barcode_value, order_item_id, laundry_garment_id FROM barcodes ORDER BY id');
    const lgs = await h.db.query<any>('SELECT id FROM laundry_garments ORDER BY id');
    const paths = ['/modules/barcode/search.php', '/modules/barcode/scan.php', '/modules/barcode/scan.php?token=abc%20%22q%22', '/modules/barcode/scan.php?token=0',
      '/modules/barcode/packing_scan.php', '/modules/barcode/packing_scan.php?token=nope', `/modules/barcode/packing_scan.php?token=${tok}`,
      '/modules/barcode/packing.php', '/modules/barcode/packing.php?order_id=1', '/modules/barcode/packing.php?order_id=2', '/modules/barcode/packing.php?order_id=999',
      '/modules/barcode/tags.php', '/modules/barcode/tags.php?printed=printed', '/modules/barcode/tags.php?printed=not_printed', '/modules/barcode/tags.php?order_number=1&service_id=1', '/modules/barcode/tags.php?customer=Vip&garment_id=1&barcode=UDC',
      '/modules/barcode/tags.php?date_from=2020-01-01&date_to=2099-01-01&invoice_number=I', '/modules/barcode/tags.php?page=2',
      '/modules/barcode/garment_detail.php?item_id=1', '/modules/barcode/garment_detail.php?item_id=2', '/modules/barcode/garment_detail.php?item_id=3', '/modules/barcode/garment_detail.php?item_id=999', '/modules/barcode/garment_detail.php',
      `/modules/barcode/garment_detail.php?laundry_garment_id=${lgs[0].id}`, '/modules/barcode/garment_detail.php?laundry_garment_id=999',
      '/modules/barcode/tags_print.php?order_id=1', '/modules/barcode/tags_print.php?order_id=1&auto_print=1', '/modules/barcode/tags_print.php?order_id=5', '/modules/barcode/tags_print.php?order_id=999', '/modules/barcode/tags_print.php'];
    for (const p of paths) { if (p.includes('laundry_garment_id=1')) continue; await both(php, node, p, p, true); }
    // PHP defect: garment_detail.php?laundry_garment_id=… dies with "Column 'id' in ORDER BY is ambiguous" (LaundryGarmentService::getHistory).
    // Node orders by gsh.id, so the page works.
    const lgPath = `/modules/barcode/garment_detail.php?laundry_garment_id=${lgs[0].id}`;
    expect((await php.get(lgPath)).status).toBe(500);
    const lgNode = await node.get(lgPath);
    expect(lgNode.status).toBe(200);
    expect(lgNode.body).toContain('Batch Weight / Rate');
    expect((await php.get('/modules/barcode/tags_print.php?order_id=1')).body).toContain('class="tag"');
    await write('detail without a barcode generates one', php, node, (c) => c.get('/modules/barcode/garment_detail.php?item_id=5'), o);
    void bc;
    const adm = await login('admin'), nobody = await login('nobody'), anon = await login(null);
    for (const p of ['/modules/barcode/tags.php', '/modules/barcode/garment_detail.php?item_id=1', '/modules/barcode/packing.php', '/modules/barcode/tags_print.php?order_id=1', '/modules/barcode/search.php']) {
      await both(adm.php, adm.node, p, `admin ${p}`, true); await both(nobody.php, nobody.node, p, `nobody ${p}`, true); await both(anon.php, anon.node, p, `anon ${p}`, true);
    }
  });

  it('writes: package create, package print, tag print, workshop actions on the detail page', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const post = (path: string, form: Record<string, string>) => (c: Client) => c.post(path, form);
    const pk = '/modules/barcode/packing.php', pp = '/modules/barcode/packing_print.php', tp = '/modules/barcode/tags_print.php', gd = '/modules/barcode/garment_detail.php';
    await write('create packages', php, node, post(pk, { order_id: '2', create_packages: '1', additional_packages: '2', garment_count: '4' }), o);
    await write('create packages more', php, node, post(pk, { order_id: '1', create_packages: '1', additional_packages: '1', garment_count: '0' }), o);
    await write('create packages zero', php, node, post(pk, { order_id: '1', create_packages: '1', additional_packages: '0', garment_count: '1' }), o);
    await write('create packages bad order', php, node, post(pk, { order_id: '999', create_packages: '1', additional_packages: '1', garment_count: '1' }), o);
    const ids = (await h.db.query<any>('SELECT id FROM packing ORDER BY id')).map((r: any) => r.id);
    await write('print packages', php, node, post(pp, { 'package_ids[]': String(ids[0]) }), o);
    await write('print none', php, node, post(pp, {}), o);
    await write('print missing', php, node, post(pp, { 'package_ids[]': '9999' }), o);
    await write('print csrf', php, node, (c) => c.post(pp, { 'package_ids[]': String(ids[0]) }, { csrf: false }), o);
    const bc = await h.db.query<any>('SELECT id FROM barcodes ORDER BY id');
    await write('tags print first-time', php, node, post(tp, { 'barcode_ids[]': String(bc[3].id), format: 'a4' }), o);
    await write('tags print reprint', php, node, post(tp, { 'barcode_ids[]': String(bc[0].id), format: 'label' }), o);
    await write('tags print bad format', php, node, post(tp, { 'barcode_ids[]': String(bc[0].id), format: 'zzz' }), o);
    await write('tags print duplicates', php, node, post(tp, { 'barcode_ids[]': `${bc[0].id}`, format: 'thermal' }), o);
    await write('tags print none', php, node, post(tp, { format: 'thermal' }), o);
    await write('tags print missing', php, node, post(tp, { 'barcode_ids[]': '99999' }), o);
    await write('tags print csrf', php, node, (c) => c.post(tp, { 'barcode_ids[]': String(bc[0].id) }, { csrf: false }), o);
    await write('tags print GET order', php, node, (c) => c.get(`${tp}?order_id=1`), o);
    await write('tags print GET order (store 2, mixed)', php, node, (c) => c.get(`${tp}?order_id=5`), o);
    const adm = await login('admin');
    await write('admin first-time print ok (has print)', adm.php, adm.node, (c) => c.get(`${tp}?order_id=3`), o);
    await write('admin reprint refused', adm.php, adm.node, (c) => c.get(`${tp}?order_id=1`), o);
    // workshop actions from the detail page
    const svc = buildServices(h.env, h.db, { hooks: noopOrderHooks });
    const items = await h.db.query<any>("SELECT id FROM order_items WHERE order_id = 1 ORDER BY id");
    await h.db.execute("UPDATE order_items SET item_status = 'Pending' WHERE order_id = 1");
    const c1 = await svc.workshop.createChallan(1, [items[0].id], '', { userId: 1 }) as any;
    expect(c1.success).toBe(true);
    const wi = (await h.db.query<any>('SELECT id FROM workshop_items ORDER BY id'))[0].id;
    await both(php, node, `${gd}?item_id=${items[0].id}`, 'detail with workshop actions', true);
    await write('detail start', php, node, post(`${gd}?item_id=${items[0].id}`, { workshop_action: 'start_processing', workshop_item_id: String(wi) }), o);
    await write('detail complete', php, node, post(`${gd}?item_id=${items[0].id}`, { workshop_action: 'complete_processing', workshop_item_id: String(wi) }), o);
    await write('detail unknown', php, node, post(`${gd}?item_id=${items[0].id}`, { workshop_action: 'zzz', workshop_item_id: String(wi) }), o);
    await write('detail csrf', php, node, (c) => c.post(`${gd}?item_id=${items[0].id}`, { workshop_action: 'accept', workshop_item_id: String(wi) }, { csrf: false }), o);
    const ws = await login('ws');
    await write('detail ws', ws.php, ws.node, post(`${gd}?item_id=${items[0].id}`, { workshop_action: 'accept', workshop_item_id: String(wi) }), o);
  });
});
