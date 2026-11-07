import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { resetAndSeed } from './helpers.js';

const enabled = !!process.env.TEST_DB_NAME;

describe.skipIf(!enabled)('workshop_queue mobile API (real MariaDB schema)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let h: { authorization: string };

  beforeAll(async () => {
    await resetAndSeed(db);
    const perms = ['pos.create', 'workshop.manage'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${perms.map((_, i) => `(1, ${i + 1})`).join(',')}`);
    await db.execute("INSERT INTO workshops (id, workshop_name) VALUES (1, 'Test Workshop')");
    const hash = await hashPassword('pw12345');
    await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [hash]);
    app = await buildApp(buildServices(env, db));
    h = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'pw12345' } })).json().data.token}` };
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/mobile/${url}`, headers: h, payload: payload as object });
  const get = (url: string) => app.inject({ method: 'GET', url: `/api/mobile/${url}`, headers: h });

  it('exposes workshop_status (raw workshop_items.status) for Laundry in-progress garments, the same way it already does for piece items', async () => {
    const created = await post('laundry_orders_create', {
      client_request_id: 'wq-l-1', customer_id: 1,
      batches: [{ service_id: 3, weight: 1, rate: 61.37, garment_count: 1, garments: [{ garment_id: 1, quantity: 1 }] }],
    });
    expect(created.statusCode).toBe(200);
    const laundryGarmentId = (await db.query<any>('SELECT id FROM laundry_garments WHERE order_item_id = (SELECT id FROM order_items WHERE order_id = ?)', [created.json().data.order_id]))[0].id;

    // nothing sent yet - laundry_pending carries no workshop_status (there's no workshop_items row at all).
    const beforeQueue = (await get('workshop_queue')).json().data;
    const pendingRow = beforeQueue.laundry_pending.find((r: any) => r.laundry_garment_id === laundryGarmentId);
    expect(pendingRow).toMatchObject({ workshop_status: null });

    const sent = await post('workshop_action', { action: 'create_laundry_challan', workshop_id: 1, laundry_garment_ids: [laundryGarmentId], remarks: '' });
    expect(sent.statusCode).toBe(200);

    const afterQueue = (await get('workshop_queue')).json().data;
    const inProgressRow = afterQueue.laundry_in_progress.find((r: any) => r.laundry_garment_id === laundryGarmentId);
    expect(inProgressRow).toMatchObject({ workshop_status: 'Sent', current_status: 'Workshop' });
  });

  it('piece items already exposed workshop_status - unaffected by this change', async () => {
    const created = await post('pos_orders_create', { client_request_id: 'wq-p-1', customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] });
    expect(created.statusCode).toBe(200);
    const orderItemId = (await db.query<any>('SELECT id FROM order_items WHERE order_id = ?', [created.json().data.order_id]))[0].id;

    await post('workshop_action', { action: 'create_challan', workshop_id: 1, item_ids: [orderItemId], remarks: '' });
    const queue = (await get('workshop_queue')).json().data;
    const row = queue.piece.items.find((r: any) => r.order_item_id === orderItemId);
    expect(row).toMatchObject({ workshop_status: 'Sent' });
  });
});
