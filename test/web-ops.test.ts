import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!webEnabled)('QC / packing / pickup / delivery: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);

  const prepare = async (db: Db) => {
    const extra = ['drivers.manage', 'delivery.manage', 'pickup.manage', 'qc.manage', 'rework.manage', 'packing.manage'];
    await db.execute(`INSERT IGNORE INTO permissions (permission_key, module) VALUES ${extra.map((k) => `('${k}', 'x')`).join(',')}`);
    await db.execute(`INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN (${extra.map((k) => `'${k}'`).join(',')})`);
    await db.execute("INSERT IGNORE INTO drivers (id, driver_name, driver_code, mobile, vehicle_number, area_assigned, is_active, user_id) VALUES (1, 'Dev <D>', 'DRV-0001', '9000000001', 'KA01', 'North', 1, NULL), (2, 'Eve', 'DRV-0002', NULL, NULL, NULL, 0, NULL)");
    // o5 fully packed (eligible for pickup/delivery); o1 has a pending delivery, assigned to driver 1 for one row
    await db.execute("UPDATE order_items SET item_status = 'Packed' WHERE order_id = 5");
    await db.execute("UPDATE orders SET due_date = CURDATE() + INTERVAL id DAY, due_time = NULL");
    await db.execute("UPDATE delivery_orders SET driver_id = 1, address = 'A <b>1</b>\nLine 2', phone = '9999999999', amount_due = 12.5 WHERE delivery_number = 'D1'");
    await db.execute("INSERT INTO delivery_orders (delivery_number, order_id, customer_id, delivery_date, status, amount_due, address, phone) VALUES ('D3', 3, 1, CURDATE() + INTERVAL 1 DAY, 'Out for Delivery', 0, 'x', '1')");
    await db.execute("UPDATE pickup_orders SET driver_id = 1 WHERE pickup_number = 'P1'");
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
  const opts = { sortRows: true };

  it('QC dashboard + rework + packing: pages and actions', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    for (const q of ['', '?status=QC', '?status=Rework', '?order=1', '?customer=Vip', '?garment=Shirt', '?urgent_only=1', '?due_date=2020-01-01', '?page=2']) await both(php, node, `/modules/qc/index.php${q}`, `qc ${q}`, true);
    expect((await php.get('/modules/qc/index.php')).body).toContain('Laundry Garments');
    await both(php, node, '/modules/qc/rework.php', 'rework', true);
    for (const q of ['', '?order=1', '?customer=Plain']) await both(php, node, `/modules/packing/index.php${q}`, `packing ${q}`, true);
    expect((await php.get('/modules/packing/index.php')).body).toContain('Mark Packed');

    const items = await h.db.query<any>("SELECT id, item_status FROM order_items ORDER BY id");
    const qcItems = items.filter((i: any) => i.item_status === 'QC').map((i: any) => i.id);
    const readyItem = items.find((i: any) => i.item_status === 'Ready').id;
    const lg = await h.db.query<any>('SELECT id FROM laundry_garments ORDER BY id');
    const post = (path: string, form: Record<string, string>) => (c: Client) => c.post(path, form);
    const qc = '/modules/qc/index.php', rw = '/modules/qc/rework.php', pk = '/modules/packing/index.php';
    await write('qc pass', php, node, post(qc, { action: 'pass', order_item_id: String(qcItems[0]), remarks: 'fine <b>', redirect_qs: 'status=QC' }), opts);
    await write('qc fail', php, node, post(qc, { action: 'fail', order_item_id: String(qcItems[1]), reason: 'stain', remarks: 'r' }), opts);
    await write('qc fail no reason', php, node, post(qc, { action: 'fail', order_item_id: String(qcItems[1]), reason: '' }), opts);
    await write('qc pass wrong status', php, node, post(qc, { action: 'pass', order_item_id: String(readyItem) }), opts);
    await write('qc pass missing', php, node, post(qc, { action: 'pass', order_item_id: '9999' }), opts);
    await write('qc laundry pass', php, node, post(qc, { action: 'pass', garment_type: 'laundry', laundry_garment_id: String(lg[1].id) }), opts);
    await write('qc laundry fail', php, node, post(qc, { action: 'fail', garment_type: 'laundry', laundry_garment_id: String(lg[1].id), reason: 'torn' }), opts);
    await write('qc laundry fail none', php, node, post(qc, { action: 'fail', garment_type: 'laundry', laundry_garment_id: '999', reason: '' }), opts);
    const rework = await h.db.query<any>('SELECT id, status FROM rework_records ORDER BY id');
    await write('rework start', php, node, post(rw, { action: 'start', rework_id: String(rework[0].id) }), opts);
    await write('rework complete (pending)', php, node, post(rw, { action: 'complete', rework_id: String(rework[0].id) }), opts);
    await write('rework complete', php, node, post(rw, { action: 'complete', rework_id: String(rework[1].id) }), opts);
    await write('rework missing', php, node, post(rw, { action: 'start', rework_id: '999' }), opts);
    await write('pack', php, node, post(pk, { order_item_id: String(readyItem), redirect_qs: 'order=1' }), opts);
    await write('pack not ready', php, node, post(pk, { order_item_id: String(qcItems[0]) }), opts);
    await write('csrf', php, node, (c) => c.post(qc, { action: 'pass', order_item_id: '1' }, { csrf: false }), opts);
    const nobody = await login('nobody');
    for (const p of [qc, rw, pk]) await both(nobody.php, nobody.node, p, `nobody ${p}`);
  });

  it('pickup + delivery + drivers + slips', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    for (const q of ['', '?status=eligible', '?status=Scheduled', '?status=Assigned', '?order=5', '?customer=Vip']) await both(php, node, `/modules/pickup/index.php${q}`, `pickup ${q}`, true);
    expect((await php.get('/modules/pickup/index.php')).body).toContain('Eligible for Pickup');
    for (const q of ['', '?status=eligible', '?status=Pending', '?status=Out+for+Delivery', '?order=1', '?customer=Plain']) await both(php, node, `/modules/delivery/index.php${q}`, `delivery ${q}`, true);
    await both(php, node, '/modules/delivery/drivers.php', 'drivers', true);
    await both(php, node, '/modules/delivery/my_deliveries.php', 'my deliveries', true);
    const dl = await h.db.query<any>('SELECT id, delivery_number FROM delivery_orders ORDER BY id');
    for (const d of dl) await both(php, node, `/modules/delivery/slip_print.php?delivery_id=${d.id}`, `slip ${d.id}`);
    await both(php, node, '/modules/delivery/slip_print.php?delivery_id=999', 'slip missing');
    const post = (path: string, form: Record<string, string>) => (c: Client) => c.post(path, form);
    const pk = '/modules/pickup/index.php', dv = '/modules/delivery/index.php', dr = '/modules/delivery/drivers.php', my = '/modules/delivery/my_deliveries.php';
    const wa = { sortRows: true };
    await write('pickup create', php, node, post(pk, { action: 'create', order_id: '5', pickup_date: '2026-12-01', pickup_time: '10:00', notes: 'n' }), wa);
    await write('pickup create ineligible', php, node, post(pk, { action: 'create', order_id: '1', pickup_date: '2026-12-01' }), wa);
    const pu = await h.db.query<any>('SELECT id FROM pickup_orders ORDER BY id');
    await write('pickup assign', php, node, post(pk, { action: 'assign_driver', pickup_id: String(pu[1].id), driver_id: '1' }), wa);
    await write('pickup assign bad driver', php, node, post(pk, { action: 'assign_driver', pickup_id: String(pu[1].id), driver_id: '99' }), wa);
    await write('pickup picked up', php, node, post(pk, { action: 'mark_picked_up', pickup_id: String(pu[0].id) }), wa);
    await write('delivery create', php, node, post(dv, { action: 'create', order_id: '5', delivery_date: '2026-12-01', time_slot: 'AM', remarks: 'r' }), wa);
    await write('delivery assign', php, node, post(dv, { action: 'assign_driver', delivery_id: String(dl[2].id), driver_id: '2' }), wa);
    await write('delivery out', php, node, post(dv, { action: 'out_for_delivery', delivery_id: String(dl[0].id) }), wa);
    await write('delivery delivered', php, node, post(dv, { action: 'delivered', delivery_id: String(dl[2].id) }), wa);
    await write('delivery delivered missing', php, node, post(dv, { action: 'delivered', delivery_id: '999' }), wa);
    await write('driver add', php, node, post(dr, { action: 'save', driver_name: 'New <Guy>', mobile: '1', vehicle_number: 'V', area_assigned: 'A', is_active: 'on' }), wa);
    await write('driver add inactive', php, node, post(dr, { action: 'save', driver_name: 'Zed' }), wa);
    await write('driver edit', php, node, post(dr, { action: 'save', id: '1', driver_name: 'Renamed', mobile: '2', is_active: 'on' }), wa);
    await write('driver no name', php, node, post(dr, { action: 'save', driver_name: '' }), wa);
    await write('my out', php, node, post(my, { action: 'out_for_delivery', delivery_id: String(dl[0].id) }), wa);
    await write('my unknown action', php, node, post(my, { action: 'zzz', delivery_id: String(dl[0].id) }), wa);
    await write('my no delivery', php, node, post(my, { action: 'delivered', delivery_id: '0' }), wa);

    // delivery-driver role (linked drivers row): sees only their own deliveries, cannot schedule/assign
    await h.db.execute("UPDATE drivers SET user_id = (SELECT id FROM users WHERE username = 'driver') WHERE id = 1");
    const driver = await login('driver');
    for (const p of [dv, my, `/modules/delivery/slip_print.php?delivery_id=${dl[0].id}`, `/modules/delivery/slip_print.php?delivery_id=${dl[2].id}`, dr]) await both(driver.php, driver.node, p, `driver ${p}`, true);
    await write('driver cannot assign', driver.php, driver.node, post(dv, { action: 'assign_driver', delivery_id: String(dl[0].id), driver_id: '2' }), wa);
    await write('driver foreign delivery', driver.php, driver.node, post(dv, { action: 'delivered', delivery_id: String(dl[2].id) }), wa);
    await write('driver own delivery', driver.php, driver.node, post(my, { action: 'out_for_delivery', delivery_id: String(dl[0].id) }), wa);
    const nobody = await login('nobody');
    for (const p of [pk, dv, dr, my]) await both(nobody.php, nobody.node, p, `nobody ${p}`);
  });
});
