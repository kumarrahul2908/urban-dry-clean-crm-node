import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!webEnabled)('admin pages: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('users.manage','x'),('admin.settings','x'),('branding.manage','x'),('master.manage','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN ('users.manage','admin.settings','branding.manage','master.manage')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 1, id FROM permissions WHERE permission_key IN ('admin.settings','master.manage')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 4, id FROM permissions WHERE permission_key = 'master.manage'");
    await db.execute("UPDATE users SET store_id = (SELECT MIN(id) FROM stores WHERE is_active = 1) WHERE username = 'wstaff'"); // a fixed-store login
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };
  const o = { sortRows: true };

  it('users: list + create/update/toggle', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    await both(php, node, '/modules/admin/users.php', 'list');
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); await both(c.php, c.node, '/modules/admin/users.php', `${who}`); }
    const roles = await h.db.query<any>('SELECT id, role_name FROM roles ORDER BY id');
    const staff = roles.find((r: any) => r.role_name === 'Workshop Staff') ?? roles[0];
    const wk = (await h.db.query<any>('SELECT id FROM workshops WHERE is_active=1 ORDER BY id LIMIT 1'))[0];
    const st = (await h.db.query<any>('SELECT id FROM stores WHERE is_active=1 ORDER BY id LIMIT 1'))[0];
    const me = (await h.db.query<any>("SELECT id FROM users WHERE username='boss'"))[0];
    const other = (await h.db.query<any>("SELECT id FROM users WHERE username='nobody'"))[0];
    const post = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/admin/users.php', f, { csrf });
    const base = { action: 'create', user_id: '', full_name: 'New Person', username: 'newp', email: 'n@x.com', mobile: '99999', employee_code: 'E1', password: 'longenough1', role_id: String(staff.id), store_id: String(st.id), workshop_id: String(wk?.id ?? ''), is_active: 'on' };
    await write('create ok', php, node, post(base), o);
    await write('create non-staff drops workshop', php, node, post({ ...base, role_id: String(roles[0].id) }), o);
    await write('create no store/optional empty', php, node, post({ ...base, email: '', mobile: '', employee_code: '', store_id: '', workshop_id: '', is_active: '' } as any), o);
    await write('create empty', php, node, post({ action: 'create' }), o);
    await write('create short pw', php, node, post({ ...base, password: 'short' }), o);
    await write('create bad role', php, node, post({ ...base, role_id: '9999' }), o);
    await write('create bad store', php, node, post({ ...base, store_id: '9999' }), o);
    await write('create bad workshop', php, node, post({ ...base, workshop_id: '9999' }), o);
    await write('create dup username', php, node, post({ ...base, username: 'boss' }), o);
    await write('create csrf', php, node, post(base, false), o);
    const upd = { ...base, action: 'update', user_id: String(other.id), username: 'nobody2', password: '' };
    await write('update ok', php, node, post(upd), o);
    await write('update pw', php, node, post({ ...upd, password: 'newpassword9' }), o);
    await write('update short pw', php, node, post({ ...upd, password: 'x' }), o);
    await write('update self deactivate', php, node, post({ ...upd, user_id: String(me.id), username: 'boss', is_active: '' }), o);
    await write('update missing', php, node, post({ ...upd, user_id: '9999' }), o);
    await write('update no id', php, node, post({ ...upd, user_id: '' }), o);
    await write('update dup username', php, node, post({ ...upd, username: 'boss' }), o);
    await write('toggle other', php, node, post({ action: 'toggle_active', user_id: String(other.id) }), o);
    await write('toggle self', php, node, post({ action: 'toggle_active', user_id: String(me.id) }), o);
    await write('toggle missing', php, node, post({ action: 'toggle_active', user_id: '9999' }), o);
    await write('unknown action', php, node, post({ action: 'zzz' }), o);
    expect(true).toBe(true);
  });

  it('settings + logo', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    await both(php, node, '/modules/admin/settings.php', 'page');
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); await both(c.php, c.node, '/modules/admin/settings.php', `${who}`); }
    const post = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/admin/settings.php', f, { csrf });
    const all = { save_settings: '1', business_name: ' Urban <Dry> ', address: 'Addr', phone: '1', whatsapp: '2', email: 'e@x.com', gstin: 'G', opening_time: '09:00', closing_time: '21:00', invoice_prefix: 'INV', currency_symbol: 'Rs.', delivery_charge_default: '10', max_counter_discount_percent: '5', default_due_days: '3', allow_overpayment: 'on', short_order_code_enabled: 'on', short_order_code_prefix: 'b', short_order_code_digits: '5', password_reset_wa_template: 'tmpl', password_reset_wa_language: 'en' };
    await write('save ok', php, node, post(all), o);
    await write('save unchecked', php, node, post({ ...all, allow_overpayment: undefined, short_order_code_enabled: undefined } as any), o);
    await write('save bad prefix', php, node, post({ ...all, short_order_code_prefix: 'AB' }), o);
    await write('save bad prefix digit', php, node, post({ ...all, short_order_code_prefix: '1' }), o);
    await write('save bad digits', php, node, post({ ...all, short_order_code_digits: '11' }), o);
    await write('save partial', php, node, post({ save_settings: '1', phone: '777' }), o);
    await write('save csrf', php, node, post(all, false), o);
    // per-store Order Code prefix (changelog 2026-10-23..30, section 8): optional override of the shared prefix
    const stores = await h.db.query<any>('SELECT id FROM stores WHERE is_active=1 ORDER BY id');
    await write('save store prefixes', php, node, post({ ...all, [`store_prefix_${stores[0].id}`]: 'e', [`store_prefix_${stores[1]?.id ?? stores[0].id}`]: '' }), o);
    await write('save bad store prefix', php, node, post({ ...all, [`store_prefix_${stores[0].id}`]: 'EE' }), o);
    await both(php, node, '/modules/admin/settings.php', 'page with a store prefix set');
    const up = (name: string, content: Buffer | string) => (c: Client) => c.upload('/modules/admin/settings.php', { logo_action: 'upload' }, { field: 'logo', filename: name, content, type: 'image/png' });
    await write('logo upload', php, node, up('l.png', PNG), o);
    await write('logo bad ext', php, node, up('l.gif', PNG), o);
    await write('logo fake', php, node, up('l.png', 'not an image'), o);
    await write('logo none', php, node, (c) => c.post('/modules/admin/settings.php', { logo_action: 'upload' }), o);
    await h.db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('logo_path','old.png') ON DUPLICATE KEY UPDATE setting_value='old.png'");
    await both(php, node, '/modules/admin/settings.php', 'page with logo');
    await write('logo replace', php, node, up('l.png', PNG), o);
    await write('logo delete', php, node, post({ logo_action: 'delete' }), o);
    // admin role has admin.settings but not branding.manage → 403 text
    const adm = await login('admin');
    await write('logo no permission', adm.php, adm.node, (c) => c.post('/modules/admin/settings.php', { logo_action: 'delete' }), o);
    await write('save as admin', adm.php, adm.node, (c) => c.post('/modules/admin/settings.php', all), o);
  });

  it('print settings', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const stores = await h.db.query<any>('SELECT id FROM stores WHERE is_active=1 ORDER BY id');
    for (const q of ['', `?store_id=${stores[0].id}`, `?store_id=${stores[stores.length - 1].id}`, '?store_id=9999']) await both(php, node, `/modules/admin/print_settings.php${q}`, `ps ${q}`);
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); await both(c.php, c.node, '/modules/admin/print_settings.php', `${who}`); }
    const post = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/admin/print_settings.php', f, { csrf });
    const sid = String(stores[0].id);
    await write('tag ok', php, node, post({ form: 'tag', store_id: sid, tag_width: '1.5', tag_height: '3', tag_unit: 'in', tag_printer_name: ' Zebra ' }), o);
    await write('tag mm', php, node, post({ form: 'tag', store_id: sid, tag_width: '40', tag_height: '80', tag_unit: 'mm', tag_printer_name: '' }), o);
    await write('tag bad', php, node, post({ form: 'tag', store_id: sid, tag_width: '0', tag_height: 'x', tag_unit: 'in' }), o);
    await write('invoice thermal', php, node, post({ form: 'invoice', store_id: sid, invoice_printer_type: 'thermal', invoice_paper_size: '80mm', invoice_width: '80', invoice_height: '', invoice_unit: 'mm', invoice_printer_name: 'P' }), o);
    await write('invoice laser', php, node, post({ form: 'invoice', store_id: sid, invoice_printer_type: 'laser', invoice_paper_size: 'a4', invoice_width: '8.27', invoice_height: '11.69', invoice_unit: 'in', invoice_printer_name: '' }), o);
    await write('invoice laser no height', php, node, post({ form: 'invoice', store_id: sid, invoice_printer_type: 'laser', invoice_paper_size: 'a4', invoice_width: '210', invoice_height: '', invoice_unit: 'mm' }), o);
    await write('delivery ok', php, node, post({ form: 'delivery', store_id: sid, delivery_printer_type: 'thermal', delivery_paper_size: '58mm', delivery_width: '58', delivery_unit: 'mm', delivery_printer_name: '' }), o);
    await write('delivery bad', php, node, post({ form: 'delivery', store_id: sid, delivery_printer_type: 'laser', delivery_width: '-1', delivery_unit: 'mm' }), o);
    await write('unknown form', php, node, post({ form: 'zzz', store_id: sid }), o);
    await write('bad store', php, node, post({ form: 'tag', store_id: '9999', tag_width: '1', tag_height: '1' }), o);
    await write('csrf', php, node, post({ form: 'tag', store_id: sid }, false), o);
    const fx = await login('ws');
    const fxStore = String((await h.db.query<any>("SELECT store_id FROM users WHERE username='wstaff'"))[0].store_id);
    await write('fixed own store', fx.php, fx.node, (c) => c.post('/modules/admin/print_settings.php', { form: 'tag', store_id: fxStore, tag_width: '2', tag_height: '4', tag_unit: 'in' }), o);
    await write('fixed other store', fx.php, fx.node, (c) => c.post('/modules/admin/print_settings.php', { form: 'tag', store_id: String(stores.find((s: any) => String(s.id) !== fxStore)?.id ?? 2), tag_width: '2', tag_height: '4', tag_unit: 'in' }), o);
  });
});
