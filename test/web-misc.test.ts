import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('audit / notifications / feedback: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const o = { sortRows: true };
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('audit.view','x'),('notifications.manage','x'),('feedback.manage','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN ('audit.view','notifications.manage','feedback.manage') WHERE r.id IN (1,3,4)");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };

  it('audit log page', async () => {
    await seedRich(prepare);
    const uids = (await h.db.query<any>('SELECT id FROM users ORDER BY id')).map((u: any) => u.id);
    for (let i = 0; i < 60; i++) await h.db.execute("INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, '1.2.3.4', NOW() - INTERVAL ? MINUTE)", [i % 3 === 0 ? null : uids[i % uids.length], ['create', 'edit', 'delete'][i % 3], ['orders', 'users', 'settings'][i % 3], String(i), i % 5 ? null : '{"password_hash":"x","a":1}', i % 4 ? '{"mobile":"9876543210","email":"abc@example.com","token":"zzz"}' : 'plain <b>text</b>', i]);
    const { php, node } = await asBoss();
    for (const q of ['', '?module=orders', '?action=edit', '?user_id=1', '?record_id=5', '?date_from=2020-01-01', '?date_to=2099-01-01', '?module=Bad!', '?user_id=abc', '?date_from=nope', '?page=2', '?page=99', '?module=orders&action=create&page=1']) await both(php, node, `/modules/audit/index.php${q}`, `audit ${q}`);
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); await both(c.php, c.node, '/modules/audit/index.php', `${who}`); }
  });

  it('notifications', async () => {
    await seedRich(prepare);
    const boss = (await h.db.query<any>("SELECT id FROM users WHERE username='boss'"))[0].id;
    for (let i = 0; i < 8; i++) await h.db.execute("INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, message, is_read, created_at) VALUES (?,?,?,?,?,?,?, NOW() - INTERVAL ? MINUTE)", [i % 2 ? 1 : null, i % 3 ? 1 : null, i % 4 === 0 ? null : (i % 4 === 1 ? boss : (await h.db.query<any>('SELECT id FROM users ORDER BY id LIMIT 1 OFFSET 1'))[0].id), 'tpl_' + i, i === 7 ? 'WhatsApp' : 'In-App', `Msg <${i}>`, i % 2, i * 3 + 1]);
    const { php, node } = await asBoss();
    for (const q of ['', '?filter=unread', '?filter=zzz']) await both(php, node, `/modules/notifications/index.php${q}`, `notif ${q}`);
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); await both(c.php, c.node, '/modules/notifications/index.php', `${who}`); }
    const ids = await h.db.query<any>("SELECT id FROM notification_logs WHERE channel='In-App' AND is_read=0 ORDER BY id");
    const post = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/notifications/index.php', f, { csrf });
    await write('mark read', php, node, post({ action: 'mark_read', notification_id: String(ids[0].id) }), o);
    await write('mark read missing', php, node, post({ action: 'mark_read', notification_id: '9999' }), o);
    await write('mark all', php, node, post({ action: 'mark_all_read' }), o);
    await write('unknown', php, node, post({ action: 'x' }), o);
    await write('csrf', php, node, post({ action: 'mark_all_read' }, false), o);
    expect(true).toBe(true);
  });

  it('feedback', async () => {
    await seedRich(prepare);
    const cust = await h.db.query<any>('SELECT id FROM customers ORDER BY id LIMIT 3');
    const ord = (await h.db.query<any>('SELECT id, customer_id FROM orders ORDER BY id LIMIT 1'))[0];
    for (let i = 0; i < 12; i++) await h.db.execute('INSERT INTO feedback (customer_id, order_id, rating, comments, status, created_at) VALUES (?,?,?,?,?, NOW() - INTERVAL ? DAY)', [cust[i % cust.length].id, i % 2 ? ord.id : null, 1 + (i % 5), i % 3 ? `Comment <${i}>` : null, ['New', 'Reviewed', 'Resolved'][i % 3], i]);
    const { php, node } = await asBoss();
    for (const q of ['', '?rating=5', '?rating=2', '?status=New', '?status=Resolved', '?customer=a', '?customer=zzz', '?order=UDC', '?rating=3&status=Reviewed']) await both(php, node, `/modules/feedback/index.php${q}`, `fb ${q}`);
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); await both(c.php, c.node, '/modules/feedback/index.php', `${who}`); }
    const post = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/feedback/index.php', f, { csrf });
    const fid = (await h.db.query<any>("SELECT id FROM feedback WHERE status='New' LIMIT 1"))[0].id;
    await write('status change', php, node, post({ action: 'set_status', feedback_id: String(fid), status: 'Resolved' }), o);
    await write('status same', php, node, post({ action: 'set_status', feedback_id: String(fid), status: 'New' }), o);
    await write('status missing', php, node, post({ action: 'set_status', feedback_id: '9999', status: 'Resolved' }), o);
    await write('status invalid', php, node, post({ action: 'set_status', feedback_id: String(fid), status: 'Bogus' }), o);
    await write('add ok', php, node, post({ action: 'add', customer_id: String(cust[0].id), order_id: '', rating: '4', comments: ' nice <b> ' }), o);
    await write('add with order', php, node, post({ action: 'add', customer_id: String(ord.customer_id), order_id: String(ord.id), rating: '9', comments: '' }), o);
    await write('add wrong order', php, node, post({ action: 'add', customer_id: String(cust.find((c: any) => c.id !== ord.customer_id).id), order_id: String(ord.id), rating: '3' }), o);
    await write('add missing order', php, node, post({ action: 'add', customer_id: String(cust[0].id), order_id: '9999', rating: '3' }), o);
    await write('add bad customer', php, node, post({ action: 'add', customer_id: '9999', rating: '3' }), o);
    await write('add rating 0', php, node, post({ action: 'add', customer_id: String(cust[0].id), rating: '0' }), o);
    await write('csrf', php, node, post({ action: 'add', customer_id: '1', rating: '3' }, false), o);
    expect(true).toBe(true);
  });
});
