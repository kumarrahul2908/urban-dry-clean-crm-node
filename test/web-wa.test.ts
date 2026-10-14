import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('WhatsApp admin pages: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string) => expectSameHtml(got, want, h.env.APP_URL, label, true);
  const write = writeCompare(h.db, h.env.APP_URL);
  const o = { sortRows: true };
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('whatsapp.settings','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'whatsapp.settings' WHERE r.id IN (1,3,4)");
    await db.execute("UPDATE users SET store_id = (SELECT MIN(id) FROM stores WHERE is_active = 1) WHERE username = 'wstaff'");
    await db.execute("INSERT INTO notification_templates (template_key, channel, subject, body, provider_template_name, language, template_param_order, is_active) VALUES ('promo_a','WhatsApp',NULL,'Hi {customer_name} from {business_name} ☃ long body long body long body long body long body long body long body long body long body long body','promo_a','en','[\"customer_name\",\"business_name\"]',1), ('promo_b','WhatsApp',NULL,'Plain','',NULL,NULL,1), ('mail_a','Email','Subj','Mail body',NULL,NULL,NULL,0)");
    await db.execute("UPDATE customers SET communication_preference = 'WhatsApp'");
    await db.execute("INSERT INTO whatsapp_accounts (store_id, account_name, waba_id, phone_number_id, access_token_encrypted, api_version, is_active) VALUES (NULL, 'Main <acct>', 'w1', 'p1', 'enc', 'v21.0', 1)");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label); return a; };
  const P = '/modules/reports/whatsapp/';

  it('pages render (all roles)', async () => {
    await seedRich(prepare);
    const q = (await h.db.query<any>('SELECT id FROM notification_templates ORDER BY id LIMIT 1'))[0].id;
    await h.db.execute("INSERT INTO whatsapp_campaigns (campaign_name, segment_key, template_id, account_id, status, recipient_count) SELECT 'C <1>', 'new_customers', ?, id, 'Completed', 2 FROM whatsapp_accounts LIMIT 1", [q]);
    await h.db.execute("INSERT INTO whatsapp_marketing_rules (rule_name, segment_key, template_id, is_active) VALUES ('R1','new_customers',?,1)", [q]);
    const { php, node } = await asBoss();
    const range = '?date_from=2020-01-01&date_to=2099-12-31';
    for (const p of [`analytics.php${range}`, 'analytics.php', 'marketing.php', 'rate_list.php', 'templates.php', 'settings.php', 'settings.php?edit=1', 'settings.php?edit=999', 'inbox.php', 'campaigns.php',
      'campaigns.php?segment=new_customers', `campaigns.php?segment=new_customers&template_id=${q}`, 'campaigns.php?segment=bogus', '30_x']) {
      if (p === '30_x') continue;
      await both(php, node, P + p, p);
    }
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); for (const p of ['analytics.php', 'marketing.php', 'settings.php', 'campaigns.php?segment=new_customers', 'inbox.php']) await both(c.php, c.node, P + p, `${who} ${p}`); }
  });

  it('writes: marketing, templates, settings, rate list', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const tid = (await h.db.query<any>("SELECT id FROM notification_templates WHERE template_key='promo_a'"))[0].id;
    const post = (path: string, f: Record<string, string>, csrf = true) => (c: Client) => c.post(P + path, f, { csrf });
    await write('rule save', php, node, post('marketing.php', { action: 'save', rule_name: ' R <x> ', segment_key: 'new_customers', template_id: String(tid), store_id: '' }), o);
    await write('rule bad', php, node, post('marketing.php', { action: 'save', rule_name: '', segment_key: 'zzz', template_id: '0' }), o);
    await write('rule bad template fk', php, node, post('marketing.php', { action: 'save', rule_name: 'X', segment_key: 'new_customers', template_id: '9999' }), o);
    await h.db.execute("INSERT INTO whatsapp_marketing_rules (rule_name, segment_key, template_id, is_active) VALUES ('R1','new_customers',?,0)", [tid]);
    const rid = (await h.db.query<any>('SELECT id FROM whatsapp_marketing_rules ORDER BY id DESC LIMIT 1'))[0].id;
    await write('rule toggle', php, node, post('marketing.php', { action: 'toggle', id: String(rid) }), o);
    await write('rule csrf', php, node, post('marketing.php', { action: 'toggle', id: String(rid) }, false), o);
    const t = { action: 'save', id: '', template_key: 'k1', channel: 'WhatsApp', subject: '', body: ' Hello {customer_name} ', is_active: 'on' };
    await write('tpl create', php, node, post('templates.php', t), o);
    await write('tpl update', php, node, post('templates.php', { ...t, id: String(tid), subject: 'S' }), o);
    await write('tpl invalid', php, node, post('templates.php', { ...t, template_key: '', channel: 'Fax', body: '' }), o);
    await write('tpl dup', php, node, post('templates.php', { ...t, template_key: 'promo_a' }), o);
    await write('tpl delete', php, node, post('templates.php', { action: 'delete', id: String((await h.db.query<any>("SELECT id FROM notification_templates WHERE template_key='promo_b'"))[0].id) }), o);
    const a = { action: 'save', id: '', store_id: '', account_name: 'A2', waba_id: 'w2', phone_number_id: 'p2', sender_display_number: '+91', app_id: '', api_version: 'v21.0', access_token: 'tok', app_secret: 'sec', webhook_verify_token: 'vt', is_active: 'on' };
    await write('acct create', php, node, post('settings.php', a), o);
    await write('acct invalid', php, node, post('settings.php', { ...a, account_name: '', api_version: 'x', access_token: '' }), o);
    await write('acct dup', php, node, post('settings.php', { ...a, waba_id: 'w1', phone_number_id: 'p1' }), o);
    const aid = (await h.db.query<any>('SELECT id FROM whatsapp_accounts ORDER BY id LIMIT 1'))[0].id;
    await write('acct update keep secrets', php, node, post('settings.php?edit=' + aid, { ...a, id: String(aid), access_token: '', app_secret: '', is_active: '' }), o);
    await write('acct update secrets', php, node, post('settings.php', { ...a, id: String(aid), waba_id: 'w9', phone_number_id: 'p9' }), o);
    await write('acct delete', php, node, post('settings.php', { action: 'delete', id: String(aid) }), o);
    await write('acct delete missing', php, node, post('settings.php', { action: 'delete', id: '9999' }), o);
    const cust = (await h.db.query<any>('SELECT id FROM customers ORDER BY id LIMIT 1'))[0].id;
    const pl = (await h.db.query<any>('SELECT id FROM price_lists ORDER BY id LIMIT 1'))[0].id;
    await write('rate no fields', php, node, post('rate_list.php', {}), o);
    await write('rate unknown customer', php, node, post('rate_list.php', { customer_id: '9999', price_list_id: String(pl) }), o);
    await h.db.execute("UPDATE customers SET mobile = '' WHERE id = ?", [cust]);
    await write('rate no mobile', php, node, post('rate_list.php', { customer_id: String(cust), price_list_id: String(pl) }), o);
    await h.db.execute('UPDATE whatsapp_accounts SET is_active = 0');
    await h.db.execute("UPDATE customers SET mobile = '9876543210' WHERE id = ?", [cust]);
    await write('rate no account', php, node, post('rate_list.php', { customer_id: String(cust), price_list_id: String(pl) }), o);
    expect(true).toBe(true);
  });

  it('campaign confirm (text) and media rejections', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const tid = (await h.db.query<any>("SELECT id FROM notification_templates WHERE template_key='promo_a'"))[0].id;
    const f = { action: 'confirm_send', segment: 'new_customers', template_id: String(tid), campaign_name: ' Camp <1> ', store_id: '' };
    const up = (extra: Record<string, string>, file?: { name: string; data: Buffer | string }) => (c: Client) => file
      ? c.upload(P + 'campaigns.php', { ...f, ...extra }, { field: 'media', filename: file.name, content: file.data })
      : c.post(P + 'campaigns.php', { ...f, ...extra });
    const r = await write('campaign text', php, node, up({}), o);
    expect(r.body).toContain('Campaign queued');
    await write('campaign no name', php, node, up({ campaign_name: '' }), o);
    await write('campaign bad segment', php, node, up({ segment: 'zzz' }), o);
    await write('campaign bad template', php, node, up({ template_id: '9999' }), o);
    await write('campaign empty segment', php, node, up({ segment: '30_day_inactive' }), o);
    await write('campaign media wrong type', php, node, up({}, { name: 'a.txt', data: 'hello text' }), o);
    // >10 MB: PHP's own post_max_size (8M) rejects the request before the page runs, so only Node's message is checked
    { const big = await node.upload(P + 'campaigns.php', f, { field: 'media', filename: 'a.pdf', content: Buffer.alloc(10 * 1024 * 1024 + 10, 65) }); expect(big.body).toContain('Media file too large'); }
    await write('campaign csrf', php, node, (c) => c.post(P + 'campaigns.php', f, { csrf: false }), o);
    await h.db.execute('UPDATE whatsapp_accounts SET is_active = 0');
    await write('campaign no account', php, node, up({}), o);
  });
});
