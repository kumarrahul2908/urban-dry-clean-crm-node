import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { buildDataset as buildDatasetShared, TOKENS } from './web/dataset.js';
import { dbDiff, dbRestore, dbSnapshot } from './web/dbstate.js';

/**
 * Endpoint parity for the mobile APIs added in Nov 2026 (customer returns, challans, WhatsApp chat/bulk, caller lookup,
 * FCM registration, workshop invoice PDF/send): real api/mobile/<name>.php vs the Node route, same token, same seeded DB.
 * Writes: PHP runs, the DB rolls back, Node runs, the resulting rows must match (see test/web/dbstate.ts).
 */
vi.setConfig({ testTimeout: 120_000 });
const PHP_APP = process.env.PARITY_PHP_APP;
const enabled = !!PHP_APP && !!process.env.TEST_DB_NAME;
type Who = keyof typeof TOKENS;
interface Case { name: string; endpoint: string; who?: Who; method?: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown; post?: Record<string, string> }

describe.skipIf(!enabled)('mobile endpoint parity: returns / challans / WhatsApp chat / caller / fcm', () => {
  const dbEnv = {
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
  };
  const env = loadEnv({ NODE_ENV: 'test', ...dbEnv, APP_SECRET_KEY: 'k', APP_TIMEZONE: 'Asia/Kolkata', APP_URL: 'https://example.test' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;

  const runPhp = (c: Case) => {
    const out = execFileSync('php', [`${PHP_APP}/endpoint.php`], {
      input: JSON.stringify({ name: c.endpoint, method: c.method ?? 'GET', query: c.query ?? {}, body: c.body !== undefined ? JSON.stringify(c.body) : null, post: c.post ?? {}, token: TOKENS[c.who ?? 'admin'] }),
      env: { ...process.env, UDC_DB_HOST: dbEnv.DB_HOST, UDC_DB_PORT: dbEnv.DB_PORT, UDC_DB_NAME: dbEnv.DB_NAME, UDC_DB_USER: dbEnv.DB_USER, UDC_DB_PASS: dbEnv.DB_PASS },
    }).toString();
    const m = /^([\s\S]*)\n@@STATUS:(\d+)$/.exec(out);
    if (!m) throw new Error(`PHP gave no status: ${out.slice(0, 400)}`);
    let body: unknown;
    try { body = JSON.parse(m[1]!); } catch { body = m[1]!.slice(0, 8); } // binary (PDF) responses compare by status + magic
    return { status: Number(m[2]), body };
  };
  const runNode = async (c: Case) => {
    const qs = c.query ? `?${new URLSearchParams(c.query)}` : '';
    const r = await app.inject({
      method: c.method ?? 'GET', url: `/api/mobile/${c.endpoint}.php${qs}`,
      headers: { authorization: `Bearer ${TOKENS[c.who ?? 'admin']}`, ...(c.post ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(c.post ? { payload: new URLSearchParams(c.post).toString() } : c.body !== undefined ? { payload: c.body as object } : {}),
    });
    let body: unknown;
    try { body = r.json(); } catch { body = r.body.slice(0, 8); }
    return { status: r.statusCode, body };
  };
  const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) && x.trim() === x && !/^0\d/.test(x) ? Number(x) : x)));
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon).map((x) => JSON.stringify(x)).sort() : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)])) : v);
  const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
  const mask = (v: any): any => (Array.isArray(v) ? v.map(mask) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)])) : typeof v === 'string' && TIME.test(v) ? 'TS' : v);

  const read = async (c: Case) => {
    const php = runPhp(c); const node = await runNode(c);
    const got = { status: node.status, body: mask(norm(node.body)) }, want = { status: php.status, body: mask(norm(php.body)) };
    try { expect(got, c.name).toEqual(want); } catch (e) { if (!same(got, want)) throw e; }
    return php;
  };
  const write = async (c: Case) => {
    const before = await dbSnapshot(db);
    const php = runPhp(c); const stateA = await dbSnapshot(db);
    await dbRestore(db, before);
    const node = await runNode(c); const stateB = await dbSnapshot(db);
    await dbRestore(db, before);
    const got = { status: node.status, body: mask(norm(node.body)) }, want = { status: php.status, body: mask(norm(php.body)) };
    try { expect(got, c.name).toEqual(want); } catch (e) { if (!same(got, want)) throw e; }
    const diff = dbDiff(stateA, stateB);
    if (diff.length) throw new Error(`${c.name}: database state differs\n  ${diff.slice(0, 12).join('\n  ')}`);
    return php;
  };

  beforeAll(async () => {
    await buildDatasetShared(db, env);
    // extra permissions + data for these endpoints
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('billing.view','x'),('whatsapp.settings','x'),('admin.settings','x'),('orders.edit','x'),('workshop.billing','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN ('billing.view','whatsapp.settings','admin.settings','orders.edit','workshop.billing') WHERE r.id IN (1,3)");
    await db.execute('DELETE FROM return_reasons');
    await db.execute("INSERT INTO return_reasons (id, reason_name, sort_order, is_active) VALUES (1,'Not clean',1,1),(2,'Smell',2,1),(3,'Off',3,0)");
    await db.execute("UPDATE orders SET status_id = (SELECT id FROM order_statuses WHERE status_key = 'delivered') WHERE id IN (1, 2)");
    await db.execute("UPDATE order_items SET item_status = 'Delivered' WHERE order_id = 1");
    const cust = (await db.query<any>('SELECT id, mobile FROM customers ORDER BY id LIMIT 1'))[0];
    const ph = '91' + String(cust.mobile).replace(/\D/g, '').slice(-10);
    for (const r of [[ph, cust.id, 'outbound', 'text', 'hi', null, 'w1', 'read', 30], [ph, cust.id, 'inbound', 'text', 'reply', null, 'w2', 'received', 20], [ph, cust.id, 'inbound', 'reaction', '👍', 'w1', 'w3', 'received', 10], [ph, cust.id, 'outbound', 'image', '[image] x', 'local:zzz.jpg', 'w4', 'sent', 5], ['15550001111', null, 'inbound', 'text', 'who', null, 'w5', 'received', 3]]) {
      await db.execute('INSERT INTO whatsapp_messages (phone_number, customer_id, direction, message_type, message_text, media_url, provider_message_id, status, created_at) VALUES (?,?,?,?,?,?,?,?, NOW() - INTERVAL ? MINUTE)', r);
    }
    await db.execute("INSERT INTO notification_templates (template_key, channel, subject, body, provider_template_name, language, template_param_order, is_active, meta_status, category) VALUES ('udc_t1','WhatsApp','T1','Hello {customer_name} x', 'udc_t1','en','[\"customer_name\"]',1,'APPROVED','MARKETING')");
    const ins = await db.execute("INSERT INTO challans (challan_number, order_id, with_amount, combine_format, created_by) VALUES ('CUS-000001', 1, 1, 'aggregated', 1)");
    await db.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?, 1), (?, 2)', [ins.insertId, ins.insertId]);
    app = await buildApp(buildServices(env, db));
  });
  afterAll(async () => { await app?.close(); await close(); });

  const reads: Case[] = [
    { name: 'returns_list', endpoint: 'returns_list' },
    { name: 'returns_list days', endpoint: 'returns_list', query: { days: '5' } },
    { name: 'returns_list perms', endpoint: 'returns_list', who: 'viewer' },
    { name: 'order_return GET delivered', endpoint: 'order_return', query: { order_id: '1' } },
    { name: 'order_return GET not delivered', endpoint: 'order_return', query: { order_id: '3' } },
    { name: 'order_return GET missing', endpoint: 'order_return', query: { order_id: '999' } },
    { name: 'order_return GET no id', endpoint: 'order_return' },
    { name: 'challan_list', endpoint: 'challan_list' },
    { name: 'challan_list q', endpoint: 'challan_list', query: { q: 'CUS' } },
    { name: 'challan_list page', endpoint: 'challan_list', query: { page: '3' } },
    { name: 'challan_detail', endpoint: 'challan_detail', query: { challan_id: '1' } },
    { name: 'challan_detail missing', endpoint: 'challan_detail', query: { challan_id: '99' } },
    { name: 'challan_detail none', endpoint: 'challan_detail' },
    { name: 'challan_detail POST', endpoint: 'challan_detail', method: 'POST', body: {} },
    { name: 'challan_list perms', endpoint: 'challan_list', who: 'viewer' },
    { name: 'challan_pdf', endpoint: 'challan_pdf', query: { challan_id: '1' } },
    { name: 'challan_pdf missing', endpoint: 'challan_pdf', query: { challan_id: '99' } },
    { name: 'challan_whatsapp_numbers GET', endpoint: 'challan_whatsapp_numbers' },
    { name: 'whatsapp_conversations', endpoint: 'whatsapp_conversations' },
    { name: 'whatsapp_conversations q', endpoint: 'whatsapp_conversations', query: { q: '1555' } },
    { name: 'whatsapp_conversations perms', endpoint: 'whatsapp_conversations', who: 'viewer' },
    { name: 'whatsapp_thread', endpoint: 'whatsapp_thread', query: { phone: '__PH__' } },
    { name: 'whatsapp_thread other', endpoint: 'whatsapp_thread', query: { phone: '15550001111' } },
    { name: 'whatsapp_thread none', endpoint: 'whatsapp_thread' },
    { name: 'whatsapp_media missing', endpoint: 'whatsapp_media', query: { id: '999' } },
    { name: 'whatsapp_media outbound no copy', endpoint: 'whatsapp_media', query: { id: '4' } },
    { name: 'whatsapp_bulk GET', endpoint: 'whatsapp_bulk' },
    { name: 'whatsapp_bulk perms', endpoint: 'whatsapp_bulk', who: 'ws' },
    { name: 'caller_lookup number', endpoint: 'caller_lookup', query: { number: '__MOBILE__' } },
    { name: 'caller_lookup +91', endpoint: 'caller_lookup', query: { number: '+91__MOBILE10__' } },
    { name: 'caller_lookup name', endpoint: 'caller_lookup', query: { number: 'Vip' } },
    { name: 'caller_lookup unknown', endpoint: 'caller_lookup', query: { number: '9000000000' } },
    { name: 'caller_lookup empty', endpoint: 'caller_lookup', query: { number: '' } },
    { name: 'caller_lookup short digits', endpoint: 'caller_lookup', query: { number: '12345' } },
    { name: 'workshop_billing_pdf missing', endpoint: 'workshop_billing_pdf', query: { id: '999' } },
    { name: 'workshop_billing_pdf orphan', endpoint: 'workshop_billing_pdf', who: 'orphan', query: { id: '1' } },
  ];
  for (const c of reads) {
    it(c.name, async () => {
      const cust = (await db.query<any>('SELECT mobile FROM customers ORDER BY id LIMIT 1'))[0];
      const mobile = String(cust.mobile);
      const ph = '91' + mobile.replace(/\D/g, '').slice(-10);
      const sub = (s: string) => s.replace('__PH__', ph).replace('__MOBILE10__', mobile.replace(/\D/g, '').slice(-10)).replace('__MOBILE__', mobile);
      await read({ ...c, query: c.query ? Object.fromEntries(Object.entries(c.query).map(([k, v]) => [k, sub(v)])) : undefined });
    });
  }

  const writes: Case[] = [
    { name: 'order_return POST', endpoint: 'order_return', method: 'POST', post: { order_id: '1', item_ids: '1', reason_id: '1', note: 'x' } },
    { name: 'order_return POST bad reason', endpoint: 'order_return', method: 'POST', post: { order_id: '1', item_ids: '1', reason_id: '3' } },
    { name: 'order_return POST two items', endpoint: 'order_return', method: 'POST', post: { order_id: '1', item_ids: '1,2', reason_id: '2' } },
    { name: 'order_return POST no items', endpoint: 'order_return', method: 'POST', post: { order_id: '1', reason_id: '1' } },
    { name: 'order_return POST not delivered', endpoint: 'order_return', method: 'POST', post: { order_id: '3', item_ids: '5', reason_id: '1' } },
    { name: 'challan_generate', endpoint: 'challan_generate', method: 'POST', body: { order_ids: [1, 2], with_amount: false, combine_format: 'order_wise' } },
    { name: 'challan_generate reuse', endpoint: 'challan_generate', method: 'POST', body: { order_ids: [2, 1], with_amount: true } },
    { name: 'challan_generate single old param', endpoint: 'challan_generate', method: 'POST', body: { order_id: 1, with_amount: 1 } },
    { name: 'challan_generate delivery', endpoint: 'challan_generate', method: 'POST', body: { order_ids: [1], combine_format: 'delivery' } },
    { name: 'challan_generate missing order', endpoint: 'challan_generate', method: 'POST', body: { order_ids: [1, 999] } },
    { name: 'challan_generate not array', endpoint: 'challan_generate', method: 'POST', body: { order_ids: 'x' } },
    { name: 'challan_generate none', endpoint: 'challan_generate', method: 'POST', body: {} },
    { name: 'challan_generate GET', endpoint: 'challan_generate', method: 'GET' },
    { name: 'challan_update', endpoint: 'challan_update', method: 'POST', body: { challan_id: 1, order_ids: [3, 1], with_amount: false, combine_format: 'order_wise' } },
    { name: 'challan_update delivery', endpoint: 'challan_update', method: 'POST', body: { challan_id: 1, order_ids: [1], combine_format: 'delivery' } },
    { name: 'challan_update missing', endpoint: 'challan_update', method: 'POST', body: { challan_id: 99, order_ids: [1] } },
    { name: 'challan_update bad orders', endpoint: 'challan_update', method: 'POST', body: { challan_id: 1, order_ids: [1, 999] } },
    { name: 'challan_update none', endpoint: 'challan_update', method: 'POST', body: {} },
    { name: 'challan_delete', endpoint: 'challan_delete', method: 'POST', body: { challan_id: 1 } },
    { name: 'challan_delete missing', endpoint: 'challan_delete', method: 'POST', body: { challan_id: 99 } },
    { name: 'challan_delete none', endpoint: 'challan_delete', method: 'POST', body: {} },
    { name: 'challan_send_whatsapp no account', endpoint: 'challan_send_whatsapp', method: 'POST', body: { challan_id: 1, number: '9876543210' } },
    { name: 'challan_send_whatsapp missing', endpoint: 'challan_send_whatsapp', method: 'POST', body: { challan_id: 99, number: '9876543210' } },
    { name: 'challan_send_whatsapp invalid', endpoint: 'challan_send_whatsapp', method: 'POST', body: { challan_id: 1 } },
    { name: 'challan_whatsapp_numbers POST', endpoint: 'challan_whatsapp_numbers', method: 'POST', body: { numbers: ['98765-43210', '+91 99999 11111'] } },
    { name: 'challan_whatsapp_numbers POST short', endpoint: 'challan_whatsapp_numbers', method: 'POST', body: { numbers: ['123'] } },
    { name: 'challan_whatsapp_numbers POST too many', endpoint: 'challan_whatsapp_numbers', method: 'POST', body: { numbers: ['9876543210', '9876543211', '9876543212', '9876543213', '9876543214', '9876543215'] } },
    { name: 'challan_whatsapp_numbers POST not array', endpoint: 'challan_whatsapp_numbers', method: 'POST', body: { numbers: 'x' } },
    { name: 'challan_whatsapp_numbers perms', endpoint: 'challan_whatsapp_numbers', who: 'viewer', method: 'POST', body: { numbers: [] } },
    { name: 'whatsapp_thread reply no account', endpoint: 'whatsapp_thread', method: 'POST', body: { phone: '9876543210', text: 'hello' } },
    { name: 'whatsapp_thread reply missing text', endpoint: 'whatsapp_thread', method: 'POST', body: { phone: '9876543210' } },
    { name: 'whatsapp_bulk create no account', endpoint: 'whatsapp_bulk', method: 'POST', body: { action: 'create_template', label: 'L', category: 'MARKETING', body: 'Hi {customer_name} there' } },
    { name: 'whatsapp_bulk create invalid', endpoint: 'whatsapp_bulk', method: 'POST', body: { action: 'create_template', label: '', body: '' } },
    { name: 'whatsapp_bulk sync no account', endpoint: 'whatsapp_bulk', method: 'POST', body: { action: 'sync' } },
    { name: 'whatsapp_bulk send missing tpl', endpoint: 'whatsapp_bulk', method: 'POST', body: { action: 'send', campaign_name: 'C', template_id: 99 } },
    { name: 'whatsapp_bulk send no recipients', endpoint: 'whatsapp_bulk', method: 'POST', body: { action: 'send', campaign_name: 'C', template_id: 1 } },
    { name: 'whatsapp_bulk unknown action', endpoint: 'whatsapp_bulk', method: 'POST', body: { action: 'zzz' } },
    { name: 'fcm_register', endpoint: 'fcm_register', method: 'POST', body: { device_token: 'tok-abc-123' } },
    { name: 'fcm_register empty', endpoint: 'fcm_register', method: 'POST', body: { device_token: ' ' } },
    { name: 'fcm_register GET', endpoint: 'fcm_register', method: 'GET' },
    { name: 'workshop_billing_send_whatsapp missing', endpoint: 'workshop_billing_send_whatsapp', method: 'POST', body: { bill_id: 99, number: '9876543210' } },
    { name: 'workshop_billing_send_whatsapp invalid', endpoint: 'workshop_billing_send_whatsapp', method: 'POST', body: { bill_id: 0 } },
    { name: 'workshop_billing_send_whatsapp GET', endpoint: 'workshop_billing_send_whatsapp', method: 'GET' },
  ];
  for (const c of writes) it(c.name, async () => { await write(c); });
});
