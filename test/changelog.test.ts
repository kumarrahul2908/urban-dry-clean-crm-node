import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { resetAndSeed } from './helpers.js';

/**
 * Node-only checks for the 2026-10-20..22 changelog items that cannot (or should not) be compared with PHP row by row:
 * counters that heal themselves (MAX+1), tag numbers after removing an item in the middle, and workshop invoice photos.
 */
const enabled = !!process.env.TEST_DB_NAME;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]), randomBytes(2000)]);
function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----t${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe.skipIf(!enabled)('changelog 2026-10-20..22 (Node-only checks)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'udc-changelog-'));
  const env = loadEnv({
    NODE_ENV: 'test', DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k', APP_URL: 'https://crm.example', UPLOAD_DIR: dir,
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let auth: { authorization: string };
  let wsAuth: { authorization: string };
  let otherWsAuth: { authorization: string };

  beforeAll(async () => {
    await resetAndSeed(db);
    const perms = ['workshop.billing', 'orders.edit', 'pos.create'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${perms.map((_, i) => `(1, ${i + 1})`).join(',')}`);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (4, 'Workshop Staff')");
    await db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (4, 1)');
    await db.execute("INSERT INTO workshops (id, workshop_name) VALUES (1, 'Alpha'), (2, 'Beta')");
    const pw = await hashPassword('pw12345');
    await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [pw]);
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, workshop_id, is_active) VALUES (2, 4, 'Alpha Staff', 'alpha', ?, 1, 1), (3, 4, 'Beta Staff', 'beta', ?, 2, 1)", [pw, pw]);
    app = await buildApp(buildServices(env, db));
    const login = async (username: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username, password: 'pw12345' } })).json().data.token}` });
    auth = await login('rahul'); wsAuth = await login('alpha'); otherWsAuth = await login('beta');
  });
  afterAll(async () => { await app?.close(); await close(); rmSync(dir, { recursive: true, force: true }); });

  const line = (garment_id: number, service_id: number, quantity: number) => ({ garment_id, service_id, quantity });
  const A = { userId: 1 };

  it('numbers derive from MAX(existing)+1: a counter that fell behind real data heals instead of failing on a duplicate', async () => {
    const o = () => app.services.orders.createOrder({ customer_id: 2, items: [line(1, 1, 1)] }, A, true, 1);
    const a = await o(), b = await o();
    expect([a.order_number, b.order_number]).toEqual(['A0001', 'A0002']);
    // the live CRM's drift: orders exist up to A0002 but every counter says 0
    await db.execute("UPDATE settings SET setting_value = '0' WHERE setting_key IN ('order_number_counter', 'invoice_prefix_counter', 'short_order_seq_counter', 'customer_prefix_counter')");
    const c = await o();
    expect(c.success, JSON.stringify(c)).toBe(true);
    expect(c.order_number).toBe('A0003');
    expect(c.invoice_number).toBe('INV-000003');
    const [row] = await db.query<any>('SELECT order_number FROM orders WHERE id = ?', [c.order_id]);
    expect(row.order_number).toMatch(/^UDC-\d{4}-000003$/);
    expect((await db.query<any>("SELECT setting_value FROM settings WHERE setting_key = 'short_order_seq_counter'"))[0].setting_value).toBe('3');
    // payments/refunds heal the same way
    await db.execute("UPDATE settings SET setting_value = '0' WHERE setting_key = 'payment_prefix_counter'");
    const p = await app.services.orders.recordPayment(c.order_id as number, 2, [{ payment_type_id: 1, amount: 10 }], 0, A);
    expect(p.success, JSON.stringify(p)).toBe(true);
    expect((await db.query<any>('SELECT payment_number FROM payments ORDER BY id DESC LIMIT 1'))[0].payment_number).toMatch(/^PAY-\d{6}$/);
  });

  it('tag numbers never collide after an item in the middle of an order was removed', async () => {
    const o = await app.services.orders.createOrder({ customer_id: 2, items: [line(4, 1, 2), line(1, 1, 1), line(5, 1, 1)] }, A, true, 1); // 4 + 1 + 3 pieces
    expect(o.success).toBe(true);
    const items = (await db.query<any>('SELECT id FROM order_items WHERE order_id = ? ORDER BY id', [o.order_id])).map((r: any) => r.id);
    const rm = await app.services.orders.removeItem(o.order_id as number, items[0], A);
    expect(rm.success).toBe(true);
    const add = await app.services.orders.addItem(o.order_id as number, line(1, 1, 1), A);
    expect(add.success, JSON.stringify(add)).toBe(true);
    const seq = (await db.query<any>('SELECT item_sequence FROM barcodes WHERE order_id = ? ORDER BY item_sequence', [o.order_id])).map((r: any) => r.item_sequence);
    expect(new Set(seq).size).toBe(seq.length);
    expect(Math.max(...seq)).toBe(9); // the new tag continues after the highest tag already printed (8)
  });

  it('workshop invoice photos: upload (bill / garment line), list, delete, scoped to the workshop that owns the bill', async () => {
    const o = await app.services.orders.createOrder({ customer_id: 2, items: [line(1, 1, 1), line(2, 1, 1)] }, A, true, 1);
    const itemIds = (await db.query<any>('SELECT id FROM order_items WHERE order_id = ? ORDER BY id', [o.order_id])).map((r: any) => r.id);
    await db.execute("INSERT INTO workshop_bills (id, bill_number, workshop_id, period_start, period_end) VALUES (1, 'INV-00001', 1, CURDATE(), CURDATE()), (2, 'INV-00002', 2, CURDATE(), CURDATE())");
    await db.execute('INSERT INTO workshop_bill_items (id, bill_id, order_item_id, item_value) VALUES (11, 1, ?, 10), (12, 2, ?, 20)', itemIds);
    const up = (headers: { authorization: string }, fields: Record<string, string>, file?: Parameters<typeof multipart>[1]) => {
      const m = multipart(fields, file);
      return app.inject({ method: 'POST', url: '/api/mobile/workshop_billing_photo_upload.php', headers: { ...headers, ...m.headers }, payload: m.payload });
    };
    const img = { name: 'a.jpg', type: 'image/jpeg', data: JPEG };

    const whole = await up(wsAuth, { bill_id: '1' }, img);
    expect(whole.statusCode).toBe(200);
    expect(whole.json().data).toMatchObject({ bill_id: 1, bill_item_id: null, photo_url: expect.stringMatching(/^https:\/\/crm\.example\/uploads\/workshop_bill_photos\/[0-9a-f]{32}\.jpg$/) });
    const line1 = await up(wsAuth, { bill_id: '1', bill_item_id: '11' }, img);
    expect(line1.json().data).toMatchObject({ bill_id: 1, bill_item_id: 11 });
    expect(readdirSync(join(dir, 'workshop_bill_photos'))).toHaveLength(2);

    expect((await up(wsAuth, { bill_id: '1', bill_item_id: '12' }, img)).json().error).toMatchObject({ code: 'invalid_request', message: 'That garment line does not belong to this invoice.' });
    expect((await up(wsAuth, {}, img)).json().error).toMatchObject({ code: 'invalid_request', message: 'A valid bill_id is required.' });
    expect((await up(wsAuth, { bill_id: '99' }, img)).statusCode).toBe(404);
    expect((await up(otherWsAuth, { bill_id: '1' }, img)).statusCode).toBe(404); // another workshop's bill
    expect((await up(wsAuth, { bill_id: '1' })).json().error.message).toBe('No photo was received.');
    expect((await up(wsAuth, { bill_id: '1' }, { name: 'x.jpg', type: 'image/jpeg', data: Buffer.from('<?php echo 1; ?>') })).json().error.message).toBe('Only JPEG, PNG, or WEBP photos are allowed.');
    expect((await up({ authorization: auth.authorization }, { bill_id: '1' }, img)).statusCode).toBe(200); // Admin sees every workshop
    expect(readdirSync(join(dir, 'workshop_bill_photos'))).toHaveLength(3);

    const list = await app.inject({ method: 'GET', url: '/api/mobile/workshop_billing_photos.php?bill_id=1', headers: wsAuth });
    expect(list.json().data.photos).toHaveLength(3);
    expect(Object.keys(list.json().data.photos[0])).toEqual(['id', 'bill_id', 'bill_item_id', 'photo_url', 'uploaded_at']);
    expect((await app.inject({ method: 'GET', url: '/api/mobile/workshop_billing_photos.php?bill_id=1', headers: otherWsAuth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/mobile/workshop_billing_photos.php', headers: wsAuth })).statusCode).toBe(422);

    const first = list.json().data.photos[0].id;
    const del = (headers: { authorization: string }, photo_id: unknown) => app.inject({ method: 'POST', url: '/api/mobile/workshop_billing_photo_delete.php', headers, payload: { photo_id } });
    expect((await del(otherWsAuth, first)).statusCode).toBe(404);
    expect((await del(wsAuth, 0)).statusCode).toBe(422);
    expect((await del(wsAuth, 9999)).statusCode).toBe(404);
    const gone = await del(wsAuth, first);
    expect(gone.json().data).toEqual({ deleted: true, message: 'Photo removed.' });
    expect(readdirSync(join(dir, 'workshop_bill_photos'))).toHaveLength(2);
    expect(existsSync(join(dir, 'workshop_bill_photos'))).toBe(true);
    // deleting a bill's line cascades to its photos
    await db.execute('DELETE FROM workshop_bills WHERE id = 1');
    expect(Number((await db.query<any>('SELECT COUNT(*) AS n FROM workshop_bill_photos'))[0].n)).toBe(0);
  });
});
