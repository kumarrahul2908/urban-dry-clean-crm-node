import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { resetAndSeed } from './helpers.js';

const enabled = !!process.env.TEST_DB_NAME;

describe.skipIf(!enabled)('ChallanService: generate/reuse/edit/delete (real MariaDB schema)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  const svc = buildServices(env, db);
  const actor = { userId: 1 };

  let o1 = 0, o2 = 0, o3 = 0;

  beforeAll(async () => {
    await resetAndSeed(db);
    o1 = (await svc.orders.createOrder({ customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, actor, true, 1, true)).order_id as number;
    o2 = (await svc.orders.createOrder({ customer_id: 2, items: [{ garment_id: 2, service_id: 1, quantity: 1 }] }, actor, true, 1, true)).order_id as number;
    o3 = (await svc.orders.createOrder({ customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, actor, true, 1, true)).order_id as number;
  });
  afterAll(async () => { await close(); });

  it('generate: rejects an empty selection', async () => {
    const r = await svc.challans.generate([], true, actor);
    expect(r).toMatchObject({ success: false, errors: ['Select at least one order for this challan.'] });
  });

  it('generate: rejects an unknown order and a cancelled order', async () => {
    const unknown = await svc.challans.generate([999999], true, actor);
    expect(unknown.success).toBe(false);
    expect(unknown.errors![0]).toMatch(/not found/);

    const cancelMe = (await svc.orders.createOrder({ customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, actor, true, 1, true)).order_id as number;
    await svc.orders.cancelOrder(cancelMe, 'test', actor);
    const cancelled = await svc.challans.generate([cancelMe], true, actor);
    expect(cancelled.success).toBe(false);
    expect(cancelled.errors![0]).toMatch(/cancelled/);
  });

  it('generate: enforces store scoping when allowedStoreIds is passed', async () => {
    await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (2, 1, 'Other Store', 'branch', 1)");
    const otherStoreOrder = (await svc.orders.createOrder({ customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, actor, true, 2, true)).order_id as number;
    const denied = await svc.challans.generate([otherStoreOrder], true, actor, [1]);
    expect(denied.success).toBe(false);
    expect(denied.errors![0]).toMatch(/authorized/);
    const allowed = await svc.challans.generate([otherStoreOrder], true, actor, [2]);
    expect(allowed.success).toBe(true);
  });

  let singleChallanId = 0;

  it('generate: creates a challan for a single order', async () => {
    const r = await svc.challans.generate([o1], true, actor);
    expect(r).toMatchObject({ success: true, reused: false });
    expect(r.challan_number).toMatch(/^[A-Z]+-\d{6}$/);
    singleChallanId = r.challan_id as number;
    const rows = await db.query<any>('SELECT order_id FROM challan_orders WHERE challan_id = ?', [singleChallanId]);
    expect(rows.map((x: any) => Number(x.order_id))).toEqual([o1]);
    const [ch] = await db.query<any>('SELECT order_id, with_amount FROM challans WHERE id = ?', [singleChallanId]);
    expect(Number(ch.order_id)).toBe(o1);
    expect(Number(ch.with_amount)).toBe(1);
  });

  it('generate: reuses the SAME challan for the exact same order set + with_amount (no duplicate row)', async () => {
    const before = Number((await db.query<any>('SELECT COUNT(*) AS n FROM challans'))[0].n);
    const r = await svc.challans.generate([o1], true, actor);
    expect(r).toMatchObject({ success: true, reused: true, challan_id: singleChallanId });
    const after = Number((await db.query<any>('SELECT COUNT(*) AS n FROM challans'))[0].n);
    expect(after).toBe(before);
  });

  it('generate: a DIFFERENT with_amount for the same order set is NOT reused (separate challan)', async () => {
    const r = await svc.challans.generate([o1], false, actor);
    expect(r.success).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.challan_id).not.toBe(singleChallanId);
  });

  let combinedChallanId = 0;

  it('generate: combined challan for a superset of orders is NOT reused as the single-order one, and vice versa', async () => {
    const combined = await svc.challans.generate([o1, o2], true, actor);
    expect(combined.success).toBe(true);
    expect(combined.reused).toBe(false);
    combinedChallanId = combined.challan_id as number;
    // asking again for just [o1] still finds the single-order challan, not the combined one
    const single = await svc.challans.generate([o1], true, actor);
    expect(single.challan_id).toBe(singleChallanId);
    // order is irrelevant to the set match: [o2, o1] matches the same combined challan as [o1, o2]
    const reordered = await svc.challans.generate([o2, o1], true, actor);
    expect(reordered).toMatchObject({ reused: true, challan_id: combinedChallanId });
  });

  it('edit: replaces the order set and with_amount on an existing challan, never deduping against another challan', async () => {
    // editing the combined challan down to exactly [o1] would exact-match singleChallanId if generate()'s
    // dedup logic were reused here -- edit() must NOT redirect to it.
    const r = await svc.challans.edit(combinedChallanId, [o1, o3], false, actor);
    expect(r).toMatchObject({ success: true, challan_id: combinedChallanId });
    const rows = (await db.query<any>('SELECT order_id FROM challan_orders WHERE challan_id = ?', [combinedChallanId])).map((x: any) => Number(x.order_id)).sort((a: number, b: number) => a - b);
    expect(rows).toEqual([o1, o3].sort((a, b) => a - b));
    const [ch] = await db.query<any>('SELECT with_amount FROM challans WHERE id = ?', [combinedChallanId]);
    expect(Number(ch.with_amount)).toBe(0);

    // generate() for [o1, o3] now finds THIS edited challan via exact-set match
    const found = await svc.challans.generate([o1, o3], false, actor);
    expect(found).toMatchObject({ reused: true, challan_id: combinedChallanId });
  });

  it('edit: rejects an unknown challan id', async () => {
    const r = await svc.challans.edit(999999, [o1], true, actor);
    expect(r).toMatchObject({ success: false, errors: ['Challan not found.'] });
  });

  it('delete: removes the challan and its challan_orders rows', async () => {
    const r = await svc.challans.delete(singleChallanId, actor);
    expect(r).toMatchObject({ success: true });
    expect(await db.query('SELECT id FROM challans WHERE id = ?', [singleChallanId])).toHaveLength(0);
    expect(await db.query('SELECT id FROM challan_orders WHERE challan_id = ?', [singleChallanId])).toHaveLength(0);
  });

  it('delete: rejects an unknown challan id', async () => {
    const r = await svc.challans.delete(999999, actor);
    expect(r).toMatchObject({ success: false, errors: ['Challan not found.'] });
  });
});
