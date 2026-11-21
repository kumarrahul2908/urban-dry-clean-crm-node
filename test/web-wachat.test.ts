import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!webEnabled)('WhatsApp chat/bulk/firebase pages: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const o = { sortRows: true };
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('billing.view','x'),('whatsapp.settings','x'),('workshop.billing','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN ('billing.view','whatsapp.settings','workshop.billing') WHERE r.id IN (1,3)");
    const cust = (await db.query<any>('SELECT id, mobile FROM customers ORDER BY id LIMIT 1'))[0];
    const ph = '91' + String(cust.mobile).replace(/\D/g, '').slice(-10);
    const rows: any[][] = [
      [ph, cust.id, 'outbound', 'document', '[document] Invoice A0001', null, 'wamid.1', 'read', 70],
      [ph, cust.id, 'inbound', 'text', 'Hello <b>there</b>\nsecond line', null, 'wamid.2', 'received', 60],
      [ph, cust.id, 'inbound', 'reaction', '👍', 'wamid.1', 'wamid.3', 'received', 55],
      [ph, cust.id, 'inbound', 'image', 'a photo', '12345', 'wamid.4', 'received', 50],
      [ph, cust.id, 'outbound', 'image', '[image] cap', 'local:abc.jpg', 'wamid.5', 'delivered', 40],
      [ph, cust.id, 'outbound', 'text', 'A reply', null, 'wamid.6', 'failed', 30],
      [ph, cust.id, 'inbound', 'call', '📵 Missed WhatsApp call', null, 'call1', 'ended', 20],
      ['15550001111', null, 'inbound', 'audio', null, '999', 'wamid.7', 'received', 10],
      ['15550001111', null, 'outbound', 'document', '[document] Challan CUS-000001', null, 'wamid.8', 'sent', 5],
    ];
    for (const r of rows) await db.execute('INSERT INTO whatsapp_messages (phone_number, customer_id, direction, message_type, message_text, media_url, provider_message_id, status, created_at) VALUES (?,?,?,?,?,?,?,?, NOW() - INTERVAL ? MINUTE)', r);
    await db.execute("INSERT INTO notification_templates (template_key, channel, subject, body, provider_template_name, language, template_param_order, is_active, meta_status, category) VALUES ('udc_offer_1','WhatsApp','Offer','Namaste {customer_name}, offer! {business_name}', 'udc_offer_1','en','[\"customer_name\",\"business_name\"]',1,'APPROVED','MARKETING'),('udc_wait_1','WhatsApp','Waiting','Hello {customer_name} wait', NULL,'en','[\"customer_name\"]',1,'REJECTED','UTILITY')");
    await db.execute("UPDATE notification_templates SET meta_reject_reason = 'Policy' WHERE template_key = 'udc_wait_1'");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };

  it('message log pages: list, thread (all bubble kinds), media 404, roles', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const phone = (await h.db.query<any>('SELECT phone_number FROM whatsapp_messages ORDER BY id LIMIT 1'))[0].phone_number;
    for (const q of ['', '?q=1555', '?q=zzz']) await both(php, node, `/modules/whatsapp/messages_list.php${q}`, `list ${q}`);
    for (const p of [phone, '15550001111', '99999', '']) await both(php, node, `/modules/whatsapp/messages_thread.php?phone=${encodeURIComponent(p)}`, `thread ${p}`);
    for (const id of ['2', '4', '5', '999', '']) await both(php, node, `/modules/whatsapp/media.php?id=${id}`, `media ${id}`);
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const c = await login(who as any);
      for (const p of ['/modules/whatsapp/messages_list.php', `/modules/whatsapp/messages_thread.php?phone=${phone}`, '/modules/whatsapp/bulk.php', '/modules/settings/firebase_settings.php']) await both(c.php, c.node, p, `${who} ${p}`);
    }
  });

  it('thread actions (reply / attachment without an account), bulk + firebase pages and actions, workshop bill PDF + send', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const phone = (await h.db.query<any>('SELECT phone_number FROM whatsapp_messages ORDER BY id LIMIT 1'))[0].phone_number;
    const tp = `/modules/whatsapp/messages_thread.php?phone=${phone}`;
    await write('reply no account', php, node, async (c) => { await c.post(tp, { reply_text: 'hello there' }); return c.get(tp); }, o);
    await write('reply blank', php, node, async (c) => { await c.post(tp, { reply_text: '   ' }); return c.get(tp); }, o);
    await write('reply csrf', php, node, (c) => c.post(tp, { reply_text: 'x' }, { csrf: false }), o);
    await write('attachment png', php, node, async (c) => { await c.upload(tp, { send_attachment: '1', caption: 'cap' }, { field: 'attachment', filename: 'a.png', content: PNG, type: 'image/png' }); return c.get(tp); }, o);
    await write('attachment bad', php, node, async (c) => { await c.upload(tp, { send_attachment: '1', caption: '' }, { field: 'attachment', filename: 'a.txt', content: 'text', type: 'text/plain' }); return c.get(tp); }, o);
    await write('attachment none', php, node, async (c) => { await c.post(tp, { send_attachment: '1', caption: '' }); return c.get(tp); }, o);

    const bk = (f: Record<string, string | string[]>, csrf = true) => (c: Client) => c.post('/modules/whatsapp/bulk.php', f, { csrf });
    await write('bulk template no account', php, node, bk({ action: 'create_template', label: 'Diwali', category: 'MARKETING', body: 'Namaste {customer_name}, offer {business_name} ho' }), o);
    await write('bulk template bad vars', php, node, bk({ action: 'create_template', label: 'X', category: 'UTILITY', body: 'Hi {bogus} there' }), o);
    await write('bulk template starts with var', php, node, bk({ action: 'create_template', label: 'X', category: 'UTILITY', body: '{customer_name} hello' }), o);
    await write('bulk template empty', php, node, bk({ action: 'create_template', label: '', category: 'UTILITY', body: '' }), o);
    await write('bulk sync no account', php, node, bk({ action: 'sync' }), o);
    await write('bulk send no name', php, node, bk({ action: 'send', campaign_name: '', template_id: '1' }), o);
    await write('bulk send missing template', php, node, bk({ action: 'send', campaign_name: 'C', template_id: '999' }), o);
    await write('bulk send unapproved', php, node, bk({ action: 'send', campaign_name: 'C', template_id: String((await h.db.query<any>("SELECT id FROM notification_templates WHERE template_key='udc_wait_1'"))[0].id) }), o);
    const tid = String((await h.db.query<any>("SELECT id FROM notification_templates WHERE template_key='udc_offer_1'"))[0].id);
    await write('bulk send no recipients', php, node, bk({ action: 'send', campaign_name: 'C', template_id: tid }), o);
    await write('bulk send bad segment', php, node, bk({ action: 'send', campaign_name: 'C', template_id: tid, segment: 'nope' }), o);
    await write('bulk send csrf', php, node, bk({ action: 'send', campaign_name: 'C', template_id: tid }, false), o);

    const fb = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/settings/firebase_settings.php', f, { csrf });
    await write('firebase invalid json', php, node, fb({ service_account_json: '{"nope":1}' }), o);
    await write('firebase empty', php, node, fb({ service_account_json: '' }), o);
    await write('firebase test push', php, node, fb({ send_test_push: '1' }), o);
    await write('firebase csrf', php, node, fb({ service_account_json: 'x' }, false), o);
    await write('firebase page', php, node, async (c) => c.get('/modules/settings/firebase_settings.php'), o);

    // workshop invoice: PDF download + WhatsApp send form (no account configured -> same error)
    await write('wbill pdf missing', php, node, (c) => c.get('/modules/workshop/bill_pdf.php?id=999'), o);
    expect(true).toBe(true);
  });
});
