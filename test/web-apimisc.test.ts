import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!webEnabled)('remaining web api/*.php: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const write = writeCompare(h.db, h.env.APP_URL);
  const j = { jsonBody: true, sortRows: true };
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('whatsapp.settings','x'),('billing.view','x'),('orders.edit','x'),('accounts.view','x'),('garment_tags.view','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN ('whatsapp.settings','billing.view','orders.edit','accounts.view','garment_tags.view') WHERE r.id IN (1,3,4)");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const get = (path: string) => (c: Client) => c.get(path);
  const postForm = (path: string, f: Record<string, string>, csrf = true) => (c: Client) => c.post(path, f, { csrf });

  it('lookups, stub, roles', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const bcs = await h.db.query<any>('SELECT barcode_value, qr_token, short_qr_payload, laundry_garment_id FROM barcodes ORDER BY id');
    const piece = bcs.find((b: any) => !b.laundry_garment_id), lw = bcs.find((b: any) => b.laundry_garment_id);
    const paths = ['/api/barcode_lookup.php', '/api/barcode_lookup.php?barcode=NOPE'];
    for (const b of [piece, lw]) if (b) paths.push(`/api/barcode_lookup.php?barcode=${encodeURIComponent(b.barcode_value)}`, `/api/qr_lookup.php?token=${b.qr_token}`, ...(b.short_qr_payload ? [`/api/qr_lookup.php?token=${encodeURIComponent(b.short_qr_payload)}`] : []));
    paths.push('/api/qr_lookup.php', '/api/qr_lookup.php?token=zzz', `/api/qr_lookup.php?token=${'a'.repeat(32)}`, '/api/qr_lookup.php?token=A1-1');
    for (const p of paths) await write('lookup ' + p, php, node, get(p), j);
    const r = await php.get('/api/voice_pos_parse.php'); const n = await node.get('/api/voice_pos_parse.php');
    expect([n.status, n.body]).toEqual([r.status, r.body]);
    for (const who of ['ws', 'nobody', null] as const) { const c = await login(who as any); for (const p of ['/api/barcode_lookup.php?barcode=x', '/api/qr_lookup.php?token=x', '/api/order_photo_list.php?order_id=1']) expectSameHtml(await c.node.get(p), await c.php.get(p), h.env.APP_URL, `${who} ${p}`); }
  });

  it('order photos', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const oi = (await h.db.query<any>('SELECT id, order_id FROM order_items ORDER BY id LIMIT 1'))[0];
    const other = (await h.db.query<any>('SELECT id FROM order_items WHERE order_id <> ? LIMIT 1', [oi.order_id]))[0];
    const up = (f: Record<string, string>, file?: { name: string; data: Buffer | string }, csrf = true) => (c: Client) => file
      ? c.upload('/api/order_photo_upload.php', f, { field: 'image', filename: file.name, content: file.data })
      : c.post('/api/order_photo_upload.php', f, { csrf });
    const base = { order_id: String(oi.order_id), order_item_id: '', caption: ' hi ' };
    await write('photo ok order-level', php, node, up(base, { name: 'a.png', data: PNG }), j);
    await write('photo ok item-level', php, node, up({ ...base, order_item_id: String(oi.id) }, { name: 'a.png', data: PNG }), j);
    await write('photo wrong item', php, node, up({ ...base, order_item_id: String(other?.id ?? 99999) }, { name: 'a.png', data: PNG }), j);
    await write('photo no order', php, node, up({ ...base, order_id: '' }, { name: 'a.png', data: PNG }), j);
    await write('photo missing order', php, node, up({ ...base, order_id: '99999' }, { name: 'a.png', data: PNG }), j);
    await write('photo long caption', php, node, up({ ...base, caption: 'x'.repeat(256) }, { name: 'a.png', data: PNG }), j);
    await write('photo no file', php, node, up(base), j);
    await write('photo bad type', php, node, up(base, { name: 'a.png', data: 'text file' }), j);
    await write('photo gif', php, node, up(base, { name: 'a.gif', data: Buffer.from('GIF89a' + 'x'.repeat(20)) }), j);
    await write('photo csrf', php, node, up(base, undefined, false), { sortRows: true });
    await write('photo GET', php, node, get('/api/order_photo_upload.php'), j);
    await h.db.execute("INSERT INTO order_photos (order_id, order_item_id, file_path, caption, uploaded_by) VALUES (?, NULL, 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1.png', 'c', 1), (?, ?, 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2.png', NULL, 1)", [oi.order_id, oi.order_id, oi.id]);
    await write('list', php, node, get(`/api/order_photo_list.php?order_id=${oi.order_id}`), j);
    await write('list no id', php, node, get('/api/order_photo_list.php'), j);
    const pid = (await h.db.query<any>('SELECT id FROM order_photos ORDER BY id LIMIT 1'))[0].id;
    await write('delete', php, node, postForm('/api/order_photo_delete.php', { photo_id: String(pid) }), j);
    await write('delete missing', php, node, postForm('/api/order_photo_delete.php', { photo_id: '99999' }), j);
    await write('delete no id', php, node, postForm('/api/order_photo_delete.php', {}), j);
    await write('delete csrf', php, node, postForm('/api/order_photo_delete.php', { photo_id: String(pid) }, false), { sortRows: true });
    await write('delete GET', php, node, get('/api/order_photo_delete.php'), j);
  });

  it('whatsapp senders (validation + enqueue paths)', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    await h.db.execute("INSERT INTO notification_templates (template_key, channel, body, provider_template_name, language, template_param_order, is_active) VALUES ('payment_reminder','WhatsApp','Due {due_amount} for {order_number}','payment_reminder','en','[\"due_amount\",\"order_number\"]',1), ('t2','WhatsApp','Hi {x}',NULL,NULL,'[\"x\"]',1)");
    await h.db.execute("INSERT INTO whatsapp_accounts (store_id, account_name, waba_id, phone_number_id, access_token_encrypted, api_version, is_active) VALUES (NULL,'M','w','p','enc','v21.0',1)");
    const cust = (await h.db.query<any>('SELECT customer_id FROM accounts_receivable WHERE due_amount > 0 AND status = \'Open\' LIMIT 1'))[0]?.customer_id ?? 1;
    const clean0 = (await h.db.query<any>('SELECT id FROM customers WHERE id <> ? LIMIT 1', [cust]))[0].id;
    const P = (n: string) => `/api/${n}.php`;
    const f = postForm;
    await write('due ok', php, node, f(P('whatsapp_send_due_reminder'), { customer_id: String(cust) }), j);
    await write('due none', php, node, f(P('whatsapp_send_due_reminder'), { customer_id: String(clean0) }), j);
    await write('due missing', php, node, f(P('whatsapp_send_due_reminder'), { customer_id: '9999' }), j);
    await write('due no id', php, node, f(P('whatsapp_send_due_reminder'), {}), j);
    await write('due csrf', php, node, f(P('whatsapp_send_due_reminder'), { customer_id: '1' }, false), { sortRows: true });
    await write('due GET', php, node, get(P('whatsapp_send_due_reminder')), j);
    await write('tpl ok', php, node, f(P('whatsapp_send_template'), { customer_id: String(cust), template_key: 't2', 'variables[x]': ' v ' }), j);
    await write('tpl unknown', php, node, f(P('whatsapp_send_template'), { customer_id: String(cust), template_key: 'nope' }), j);
    await write('tpl no cust', php, node, f(P('whatsapp_send_template'), { customer_id: '9999', template_key: 't2' }), j);
    await write('tpl missing', php, node, f(P('whatsapp_send_template'), {}), j);
    await write('reply missing', php, node, f(P('whatsapp_send_reply'), {}), j);
    await write('reply no cust', php, node, f(P('whatsapp_send_reply'), { customer_id: '9999', text: 'x' }), j);
    await write('invoice missing', php, node, f(P('whatsapp_send_invoice'), {}), j);
    await write('invoice no order', php, node, f(P('whatsapp_send_invoice'), { order_id: '9999' }), j);
    await write('test no account', php, node, f(P('whatsapp_send_test_message'), {}), j);
    await write('test bad number', php, node, f(P('whatsapp_send_test_message'), { account_id: '1', to_number: 'abc' }), j);
    await write('conn no account', php, node, f(P('whatsapp_test_connection'), {}), j);
    await write('media none', php, node, (c) => c.post(P('whatsapp_send_media'), { customer_id: String(cust) }), j);
    const media = (name: string, data: Buffer | string) => (c: Client) => c.upload(P('whatsapp_send_media'), { customer_id: String(cust), caption: '' }, { field: 'media', filename: name, content: data });
    await write('media bad type', php, node, media('a.txt', 'plain text'), j);
    await write('media no cust', php, node, (c) => c.upload(P('whatsapp_send_media'), { customer_id: '9999' }, { field: 'media', filename: 'a.png', content: PNG }), j);
    expect(true).toBe(true);
  });
});
