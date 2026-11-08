import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { resetAndSeed } from './helpers.js';

const enabled = !!process.env.TEST_DB_NAME;

describe.skipIf(!enabled)('challan_* mobile API (real MariaDB schema)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let h: { authorization: string };
  let o1 = 0, o2 = 0, o3 = 0;

  beforeAll(async () => {
    await resetAndSeed(db);
    const perms = ['pos.create', 'challans.manage'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${perms.map((_, i) => `(1, ${i + 1})`).join(',')}`);
    const hash = await hashPassword('pw12345');
    await db.execute('UPDATE users SET password_hash = ? WHERE id = 1', [hash]);
    app = await buildApp(buildServices(env, db));
    h = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'pw12345' } })).json().data.token}` };

    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/mobile/${url}`, headers: h, payload: payload as object });
    o1 = (await post('pos_orders_create', { client_request_id: 'ch-o1', customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 2 }] })).json().data.order_id;
    o2 = (await post('pos_orders_create', { client_request_id: 'ch-o2', customer_id: 1, items: [{ garment_id: 2, service_id: 1, quantity: 1 }] })).json().data.order_id;
    o3 = (await post('pos_orders_create', { client_request_id: 'ch-o3', customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] })).json().data.order_id;
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/mobile/${url}`, headers: h, payload: payload as object });
  const get = (url: string) => app.inject({ method: 'GET', url: `/api/mobile/${url}`, headers: h });

  let challanId = 0, challanNumber = '';

  it('challan_generate: creates a challan, is idempotent on the exact order set + with_amount', async () => {
    const r1 = await post('challan_generate', { order_ids: [o1], with_amount: true });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data).toMatchObject({ reused: false });
    challanId = r1.json().data.challan_id;
    challanNumber = r1.json().data.challan_number;

    const r2 = await post('challan_generate', { order_ids: [o1], with_amount: true });
    expect(r2.json().data).toMatchObject({ reused: true, challan_id: challanId });
  });

  it('challan_generate: rejects an empty order list and an unknown order', async () => {
    expect((await post('challan_generate', { order_ids: [], with_amount: true })).statusCode).toBe(422);
    expect((await post('challan_generate', { order_ids: [999999], with_amount: true })).statusCode).toBe(422);
  });

  it('challans_list: returns real rows with created_by_name populated (the LEFT JOIN users must survive a populated list, not just an empty one)', async () => {
    const combined = await post('challan_generate', { order_ids: [o2, o3], with_amount: false });
    expect(combined.statusCode).toBe(200);

    const list = await get('challans_list');
    expect(list.statusCode).toBe(200);
    const results = list.json().data.results;
    expect(results.length).toBeGreaterThanOrEqual(2);
    const single = results.find((r: any) => r.id === challanId);
    expect(single).toMatchObject({ challan_number: challanNumber, with_amount: true, order_count: 1, created_by_name: 'Rahul' });
    const combinedRow = results.find((r: any) => r.id === combined.json().data.challan_id);
    expect(combinedRow).toMatchObject({ with_amount: false, order_count: 2, created_by_name: 'Rahul' });
    expect(combinedRow.order_numbers.split(', ')).toHaveLength(2);
  });

  it('challan_detail: single-order challan shows its items; combined shows both orders', async () => {
    const d = await get(`challan_detail?id=${challanId}`);
    expect(d.statusCode).toBe(200);
    expect(d.json().data).toMatchObject({ combined: false, challan: { challan_number: challanNumber, with_amount: true } });
    expect(d.json().data.orders).toHaveLength(1);
    expect(d.json().data.items.length).toBeGreaterThan(0);

    expect((await get('challan_detail?id=999999')).statusCode).toBe(404);
  });

  it('challan_edit: replaces the order set, challan_delete removes it', async () => {
    const edited = await post('challan_edit', { challan_id: challanId, order_ids: [o1, o2], with_amount: false });
    expect(edited.statusCode).toBe(200);
    const detail = await get(`challan_detail?id=${challanId}`);
    expect(detail.json().data.combined).toBe(true);
    expect(detail.json().data.orders).toHaveLength(2);
    expect(detail.json().data.challan.with_amount).toBe(false);

    const del = await post('challan_delete', { challan_id: challanId });
    expect(del.statusCode).toBe(200);
    expect((await get(`challan_detail?id=${challanId}`)).statusCode).toBe(404);
  });

  it('challan_pdf: returns a PDF for a valid challan, 404/422 otherwise', async () => {
    const created = await post('challan_generate', { order_ids: [o1], with_amount: true });
    const id = created.json().data.challan_id;
    const pdf = await get(`challan_pdf?id=${id}`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 8).toString()).toBe('%PDF-1.3');

    expect((await get('challan_pdf?id=999999')).statusCode).toBe(404);
  });

  it('challan_report_date_wise and challan_report_garments_wise return aggregated data', async () => {
    const dateWise = await get('challan_report_date_wise?period=30days');
    expect(dateWise.statusCode).toBe(200);
    expect(dateWise.json().data.report.length).toBeGreaterThan(0);
    const today = dateWise.json().data.report[0];
    expect(today.challan_count).toBeGreaterThan(0);

    const garmentsWise = await get('challan_report_garments_wise?period=30days');
    expect(garmentsWise.statusCode).toBe(200);
    expect(garmentsWise.json().data.report.length).toBeGreaterThan(0);
    expect(garmentsWise.json().data.report[0]).toHaveProperty('garment_name');
    expect(garmentsWise.json().data.report[0]).toHaveProperty('quantity');
  });

  it('challan_whatsapp_numbers: standalone list/save, independent of sending one, capped at 5', async () => {
    expect((await get('challan_whatsapp_numbers')).json().data).toEqual({ numbers: [] });

    const saved = await post('challan_whatsapp_numbers', { numbers: ['9876543210', '9876543211', '9876543210', ''] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.numbers).toEqual(['9876543210', '9876543211']);
    expect((await get('challan_whatsapp_numbers')).json().data.numbers).toEqual(['9876543210', '9876543211']);

    const tooMany = await post('challan_whatsapp_numbers', { numbers: ['1', '2', '3', '4', '5', '6'] });
    expect(tooMany.json().data.numbers).toHaveLength(5);
  });
});
