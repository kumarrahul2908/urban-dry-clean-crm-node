import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { sniffImage } from '../src/storage/imageSniff.js';
import { resetAndSeed } from './helpers.js';

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]);
const fakeImage = (head: Buffer, size: number) => Buffer.concat([head, randomBytes(Math.max(0, size - head.length))]);

function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer; field?: string }) {
  const boundary = `----t${randomBytes(8).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'image'}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('image sniffing', () => {
  it('recognises real formats and rejects the rest', () => {
    expect(sniffImage(JPEG_HEAD)).toBe('jpg');
    expect(sniffImage(PNG_HEAD)).toBe('png');
    expect(sniffImage(WEBP_HEAD)).toBe('webp');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffImage(Buffer.from('<?php echo 1; ?>'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

const enabled = !!process.env.TEST_DB_NAME;
describe.skipIf(!enabled)('uploads: order photos, garment images, retention (real MariaDB schema)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'udc-uploads-'));
  const base = {
    NODE_ENV: 'test', DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k', APP_URL: 'https://crm.example', UPLOAD_DIR: dir,
  };
  const env = loadEnv({ ...base, UPLOAD_MAX_MB: '0' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let h: { authorization: string };
  let orderId = 0, itemId = 0;

  beforeAll(async () => {
    await resetAndSeed(db);
    const perms = ['orders.edit', 'garment.edit', 'admin.settings', 'pos.create'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${perms.map((_, i) => `(1, ${i + 1})`).join(',')}`);
    await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [await hashPassword('pw12345')]);
    app = await buildApp(buildServices(env, db));
    h = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'pw12345' } })).json().data.token}` };
    const o = await app.services.orders.createOrder({ customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1);
    orderId = o.order_id;
    itemId = Number((await db.query<any>('SELECT id FROM order_items WHERE order_id = ?', [orderId]))[0].id);
  });
  afterAll(async () => {
    await app?.close();
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  const upload = (fields: Record<string, string>, file?: Parameters<typeof multipart>[1], url = 'order_photo_upload') => {
    const m = multipart(fields, file);
    return app.inject({ method: 'POST', url: `/api/mobile/${url}`, headers: { ...h, ...m.headers }, payload: m.payload });
  };
  const photoFiles = () => (existsSync(join(dir, 'order_photos')) ? readdirSync(join(dir, 'order_photos')) : []);

  it('stores a 12 MB photo byte-for-byte (no 8 MB limit, no recompression)', async () => {
    const data = fakeImage(JPEG_HEAD, 12 * 1024 * 1024);
    const r = await upload({ order_id: String(orderId), caption: ' front ' }, { name: 'IMG_001.JPG', type: 'image/jpeg', data });
    expect(r.statusCode).toBe(200);
    const photo = r.json().data.photo;
    expect(photo).toMatchObject({ order_id: orderId, order_item_id: null, caption: 'front' });
    expect(photo.url).toMatch(/^https:\/\/crm\.example\/uploads\/order_photos\/[0-9a-f]{32}\.jpg$/);
    const stored = readFileSync(join(dir, 'order_photos', photo.url.split('/').pop()));
    expect(stored.length).toBe(data.length);
    expect(stored.equals(data)).toBe(true);
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]); // no temp leftovers
  });

  it('accepts png/webp, ties a photo to an item, validates everything else', async () => {
    const png = await upload({ order_id: String(orderId), order_item_id: String(itemId) }, { name: 'a.png', type: 'image/png', data: fakeImage(PNG_HEAD, 5000) });
    expect(png.json().data.photo).toMatchObject({ order_item_id: itemId });
    expect(png.json().data.photo.url).toMatch(/\.png$/);
    expect((await upload({ order_id: String(orderId) }, { name: 'a.webp', type: 'image/webp', data: fakeImage(WEBP_HEAD, 5000) })).statusCode).toBe(200);

    const bad = async (fields: Record<string, string>, file: Parameters<typeof multipart>[1] | undefined, code: number, msg: RegExp) => {
      const r = await upload(fields, file);
      expect(r.statusCode).toBe(code);
      expect(r.json().error.message).toMatch(msg);
    };
    const ok = { name: 'x.jpg', type: 'image/jpeg', data: fakeImage(JPEG_HEAD, 100) };
    await bad({}, ok, 422, /valid order_id/);
    await bad({ order_id: '99999' }, ok, 404, /Order not found/);
    await bad({ order_id: String(orderId), order_item_id: '99999' }, ok, 422, /does not belong/);
    await bad({ order_id: String(orderId) }, undefined, 422, /No photo was received/);
    await bad({ order_id: String(orderId) }, { name: 'shell.jpg', type: 'image/jpeg', data: Buffer.from('<?php system($_GET[0]); ?>') }, 422, /Only JPEG, PNG, or WEBP/);
    await bad({ order_id: String(orderId) }, { name: 'a.svg', type: 'image/svg+xml', data: Buffer.from('<svg/>') }, 422, /Only JPEG, PNG, or WEBP/);
    await bad({ order_id: String(orderId), caption: 'x'.repeat(256) }, ok, 422, /Caption is too long/);
    await bad({ order_id: String(orderId) }, { ...ok, field: 'wrong' }, 422, /No photo was received/);
    expect(photoFiles().length).toBe(3); // failures left nothing behind
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/mobile/order_photo_upload', payload: {} })).statusCode).toBe(401);
  });

  it('lists and deletes (file removed too)', async () => {
    const list = (await app.inject({ method: 'GET', url: `/api/mobile/order_photo_list?order_id=${orderId}`, headers: h })).json().data.photos;
    expect(list).toHaveLength(3);
    const victim = list[0];
    const name = victim.url.split('/').pop();
    expect(existsSync(join(dir, 'order_photos', name))).toBe(true);
    const r = await app.inject({ method: 'POST', url: '/api/mobile/order_photo_delete', headers: h, payload: { photo_id: victim.id } });
    expect(r.json().data).toEqual({ deleted: true });
    expect(existsSync(join(dir, 'order_photos', name))).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/mobile/order_photo_delete', headers: h, payload: { photo_id: victim.id } })).statusCode).toBe(404);
  });

  it("cross-store: orders.edit does not let a fixed-store user touch another store's order photos", async () => {
    const hash = await hashPassword('pw12345');
    await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (2, 1, 'Branch', 'branch', 1)");
    await db.execute("INSERT INTO roles (id, role_name) VALUES (2, 'Branch Staff')");
    await db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 2, id FROM permissions WHERE permission_key = 'orders.edit'");
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (2, 2, 'Branch Staff', 'branchstaff', ?, 2, 1)", [hash]);
    const other = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'branchstaff', password: 'pw12345' } })).json().data.token}` };

    // orderId (from beforeAll) belongs to store 1; branchstaff is fixed to store 2 - orders.edit alone must not be enough.
    const before = photoFiles().length;
    const m = multipart({ order_id: String(orderId) }, { name: 'x.jpg', type: 'image/jpeg', data: fakeImage(JPEG_HEAD, 100) });
    const up = await app.inject({ method: 'POST', url: '/api/mobile/order_photo_upload', headers: { ...other, ...m.headers }, payload: m.payload });
    expect(up.statusCode).toBe(403);
    expect(up.json().error.message).toMatch(/your own store/);
    expect(photoFiles().length).toBe(before); // nothing was written

    expect((await app.inject({ method: 'GET', url: `/api/mobile/order_photo_list?order_id=${orderId}`, headers: other })).statusCode).toBe(403);

    const victim = (await db.query<any>('SELECT id FROM order_photos WHERE order_id = ? LIMIT 1', [orderId]))[0];
    const del = await app.inject({ method: 'POST', url: '/api/mobile/order_photo_delete', headers: other, payload: { photo_id: victim.id } });
    expect(del.statusCode).toBe(403);
    expect((await db.query<any>('SELECT id FROM order_photos WHERE id = ?', [victim.id])).length).toBe(1); // not deleted
  });

  it('retention: stats, dry-run by default, confirm required, deletes only old photos', async () => {
    // make 2 of the remaining 2... create 3 more so we have old and new
    for (let i = 0; i < 3; i++) await upload({ order_id: String(orderId) }, { name: 'n.jpg', type: 'image/jpeg', data: fakeImage(JPEG_HEAD, 2048) });
    const all = await db.query<any>('SELECT id, file_path FROM order_photos ORDER BY id');
    expect(all).toHaveLength(5);
    const old = all.slice(0, 3);
    await db.execute(`UPDATE order_photos SET created_at = NOW() - INTERVAL 45 DAY WHERE id IN (${old.map((o: any) => o.id).join(',')})`);
    await db.execute(`UPDATE order_photos SET created_at = NOW() - INTERVAL 10 DAY WHERE id = ${all[3].id}`);

    const stats = (await app.inject({ method: 'GET', url: '/api/mobile/order_photos_stats?older_than_days=30', headers: h })).json().data;
    expect(stats).toMatchObject({ total: 5, older_count: 3, older_than_days: 30, retention_days: 30 });

    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/mobile/order_photos_cleanup', headers: h, payload });
    const dry = (await post({ older_than_days: 30 })).json().data;
    expect(dry).toMatchObject({ dry_run: true, matched: 3, deleted: 0 });
    expect(dry.freed_bytes).toBeGreaterThan(0);
    expect(photoFiles()).toHaveLength(5);

    const noConfirm = await post({ older_than_days: 30, dry_run: false });
    expect(noConfirm.statusCode).toBe(422);
    expect(noConfirm.json().error.code).toBe('confirmation_required');
    expect((await post({ older_than_days: 0 })).statusCode).toBe(422);
    expect(photoFiles()).toHaveLength(5);

    const real = (await post({ older_than_days: 30, dry_run: false, confirm: true })).json().data;
    expect(real).toMatchObject({ dry_run: false, matched: 3, deleted: 3 });
    expect(photoFiles()).toHaveLength(2);
    expect((await db.query<any>('SELECT COUNT(*) AS n FROM order_photos'))[0].n).toBe(2);
    for (const o of old) expect(existsSync(join(dir, 'order_photos', o.file_path))).toBe(false);
    expect((await db.query<any>("SELECT COUNT(*) AS n FROM audit_logs WHERE module = 'order_photos' AND record_id = 'retention:30d'"))[0].n).toBe(1);
  });

  it('daily job honours settings.order_photo_retention_days (and 0 disables)', async () => {
    const [{ id }] = await db.query<any>('SELECT id FROM order_photos ORDER BY id LIMIT 1');
    await db.execute('UPDATE order_photos SET created_at = NOW() - INTERVAL 8 DAY WHERE id = ?', [id]);
    expect(await app.services.photos.retentionDays()).toBe(30); // env default
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('order_photo_retention_days', '7') ON DUPLICATE KEY UPDATE setting_value = '7'");
    expect(await app.services.photos.retentionDays()).toBe(7);
    const r = await app.services.photos.cleanup(await app.services.photos.retentionDays(), { dryRun: false, source: 'job' });
    expect(r.deleted).toBe(1);
    await db.execute("UPDATE settings SET setting_value = '0' WHERE setting_key = 'order_photo_retention_days'");
    expect(await app.services.photos.retentionDays()).toBe(0);
    expect((await app.services.photos.cleanup(0, { dryRun: false, source: 'job' })).matched).toBe(0);
    // permission gate
    const noPerm = await db.execute("DELETE FROM role_permissions WHERE permission_id = 3");
    expect(noPerm.affectedRows).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/mobile/order_photos_cleanup', headers: h, payload: { older_than_days: 1 } })).statusCode).toBe(403);
  });

  it('garment_image: upload, replace (old file removed), remove, validation', async () => {
    const up = async (fields: Record<string, string>, file?: Parameters<typeof multipart>[1]) => upload(fields, file, 'garment_image');
    const a = await up({ garment_id: '1', action: 'upload' }, { name: 'shirt.png', type: 'image/png', data: fakeImage(PNG_HEAD, 3000) });
    expect(a.statusCode).toBe(200);
    const first = a.json().data.image_url.split('/').pop();
    expect(a.json().data.image_url).toMatch(/\/uploads\/garments\/[0-9a-f]{32}\.png$/);
    expect(existsSync(join(dir, 'garments', first))).toBe(true);
    const b = await up({ garment_id: '1', action: 'upload' }, { name: 'shirt.jpg', type: 'image/jpeg', data: fakeImage(JPEG_HEAD, 3000) });
    expect(existsSync(join(dir, 'garments', first))).toBe(false);
    expect(readdirSync(join(dir, 'garments'))).toHaveLength(1);
    expect((await db.query<any>('SELECT image FROM garments WHERE id = 1'))[0].image).toBe(b.json().data.image_url.split('/').pop());
    const rm = await up({ garment_id: '1', action: 'remove' });
    expect(rm.json().data).toEqual({ garment_id: 1, image_url: null });
    expect(readdirSync(join(dir, 'garments'))).toHaveLength(0);

    expect((await up({ garment_id: '0', action: 'upload' })).statusCode).toBe(422);
    expect((await up({ garment_id: '1', action: 'zap' })).json().error.message).toMatch(/upload" or "remove/);
    expect((await up({ garment_id: '999', action: 'upload' }, { name: 'a.png', type: 'image/png', data: fakeImage(PNG_HEAD, 100) })).statusCode).toBe(404);
    expect((await up({ garment_id: '1', action: 'upload' })).json().error.message).toMatch(/No image was received/);
    expect((await up({ garment_id: '1', action: 'upload' }, { name: 'a.png', type: 'image/png', data: Buffer.from('not an image') })).json().error.message).toMatch(/not a valid image/);
    expect((await up({ garment_id: '1', action: 'upload' }, { name: 'a.gif', type: 'image/gif', data: Buffer.concat([Buffer.from('GIF89a'), randomBytes(50)]) })).json().error.message).toMatch(/Invalid image type/);
  });

  it('the safety ceiling still works when set (UPLOAD_MAX_MB=1)', async () => {
    const small = await buildApp(buildServices(loadEnv({ ...base, UPLOAD_MAX_MB: '1' } as NodeJS.ProcessEnv), db));
    const login = await small.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'pw12345' } });
    // role perms were trimmed in the previous test; restore orders.edit check path via direct permission list
    expect(login.statusCode).toBe(200);
    const token = { authorization: `Bearer ${login.json().data.token}` };
    const m = multipart({ order_id: String(orderId) }, { name: 'big.jpg', type: 'image/jpeg', data: fakeImage(JPEG_HEAD, 2 * 1024 * 1024) });
    const r = await small.inject({ method: 'POST', url: '/api/mobile/order_photo_upload', headers: { ...token, ...m.headers }, payload: m.payload });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/too large \(limit 1 MB\)/);
    expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
    await small.close();
  });
});
