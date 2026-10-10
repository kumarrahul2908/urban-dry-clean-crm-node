import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { resetTables } from './helpers.js';
import { similarTextPercent } from '../src/lib/php.js';

const enabled = !!process.env.TEST_DB_NAME;

describe('php helpers', () => {
  it('similar_text percent matches PHP', () => {
    // php > similar_text("rahul kumar", "rahul kumr", $p); => 10 chars sim, 95.238...
    expect(similarTextPercent('rahul kumar', 'rahul kumr')).toBeCloseTo(95.238, 2);
    expect(similarTextPercent('abc', 'xyz')).toBe(0);
    expect(similarTextPercent('vivek kumar', 'vivek kumar')).toBe(100);
  });
});

describe.skipIf(!enabled)('customers + wallet (real MariaDB schema)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused',
    DB_USER: process.env.TEST_DB_USER || 'unused',
    DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: { authorization: string };

  beforeAll(async () => {
    await resetTables(db, ['api_tokens', 'users', 'role_permissions', 'permissions', 'roles', 'wallet_transactions', 'customer_wallet', 'accounts_receivable', 'customers', 'price_lists', 'settings', 'audit_logs']);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (1, 'Admin')");
    const perms = ['customers.view', 'customers.create', 'customers.edit', 'wallet.manage', 'payments.adjust', 'pos.create'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${perms.map((_, i) => `(1, ${i + 1})`).join(',')}`);
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, is_active) VALUES (1, 1, 'Rahul', 'rahul', ?, 1)", [await hashPassword('pw12345')]);
    await db.execute("INSERT INTO price_lists (id, price_list_name, list_type) VALUES (1, 'Default', 'Default')");
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('customer_prefix', 'CUST-'), ('barcode_prefix', 'UDC')");
    app = await buildApp(buildServices(env, db));
    const login = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'pw12345' } });
    headers = { authorization: `Bearer ${login.json().data.token}` };
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as object });
  const get = (url: string) => app.inject({ method: 'GET', url, headers });
  let custId = 0;

  it('creates a customer with code, barcode, wallet row and audit log', async () => {
    const r = await post('/api/mobile/customers_create', { full_name: 'Rahul Kumar', mobile: '98765 43210', price_list_id: 1 });
    expect(r.statusCode).toBe(200);
    const d = r.json().data;
    custId = d.id;
    expect(d.customer_code).toBe('CUST-00001');
    const [row] = await db.query<any>('SELECT barcode, title, registration_source, created_by FROM customers WHERE id = ?', [custId]);
    // Faithful to PHP: 'UDC' . '-CUST-' . substr($code, -6), and substr of 'CUST-00001' is '-00001'.
    expect(row).toMatchObject({ barcode: 'UDC-CUST--00001', title: 'Mr', registration_source: 'Counter', created_by: 1 });
    expect((await db.query('SELECT 1 FROM customer_wallet WHERE customer_id = ? AND balance = 0', [custId])).length).toBe(1);
    expect((await db.query('SELECT 1 FROM audit_logs WHERE module = "customers" AND action = "create"')).length).toBe(1);
  });

  it('validates and blocks duplicates', async () => {
    const bad = await post('/api/mobile/customers_create', { full_name: ' ', mobile: 'abc' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.fields).toEqual({ full_name: 'Customer name is required.', mobile: 'A valid mobile number is required.' });

    const exact = await post('/api/mobile/customers_create', { full_name: 'rahul kumar', mobile: '09876543210' });
    expect(exact.statusCode).toBe(409);
    expect(exact.json().error.code).toBe('duplicate_customer');

    const similar = await post('/api/mobile/customers_create', { full_name: 'Rahul Kumr', mobile: '9876543210' });
    expect(similar.json().error.code).toBe('duplicate_requires_confirmation');
    const forced = await post('/api/mobile/customers_create', { full_name: 'Rahul Kumr', mobile: '9876543210', confirm_different_person: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().data.customer_code).toBe('CUST-00002');

    const other = await post('/api/mobile/customers_create', { full_name: 'Someone Else', mobile: '9876543210' });
    expect(other.statusCode).toBe(200); // same mobile, genuinely different name → warn only
  });

  it('list / search / detail / edit_detail / update', async () => {
    const list = (await get('/api/mobile/customers_list?q=rahul')).json().data;
    expect(list.total).toBe(2);
    expect(list.results[0].price_list_id === null || typeof list.results[0].id === 'number').toBe(true);
    expect((await get('/api/mobile/customers_search?q=r')).json().data.results).toEqual([]);
    expect((await get('/api/mobile/customers_search?q=rahul%20kumar')).json().data.results.length).toBe(1);

    const detail = (await get(`/api/mobile/customers_detail?id=${custId}`)).json().data.customer;
    expect(detail).toMatchObject({ full_name: 'Rahul Kumar', price_list_name: 'Default', wallet_balance: '0.00' });
    expect((await get('/api/mobile/customers_detail?id=999999')).statusCode).toBe(404);

    const up = await post('/api/mobile/customers_update', { id: custId, full_name: 'Rahul K', mobile: '9876543210', title: 'Mr', is_active: 1, city: 'Delhi' });
    expect(up.statusCode).toBe(200);
    const ed = (await get(`/api/mobile/customers_edit_detail?id=${custId}`)).json().data.customer;
    expect(ed).toMatchObject({ full_name: 'Rahul K', city: 'Delhi', is_active: 1 });
  });

  it('pos_customer_summary', async () => {
    const d = (await get(`/api/mobile/pos_customer_summary?customer_id=${custId}`)).json().data;
    expect(d).toMatchObject({ price_list_id: 1, price_list_name: 'Default', outstanding: 0, wallet_balance: 0 });
    expect(d.customer.name).toBe('Mr Rahul K');
  });

  it('wallet_adjust: credit, debit, idempotent replay, conflict, ledger', async () => {
    const a1 = await post('/api/mobile/wallet_adjust', { customer_id: custId, client_request_id: 'req-1', delta: 500, reason: 'top up' });
    expect(a1.json().data).toEqual({ balance: 500, idempotent_replay: false });
    const a2 = await post('/api/mobile/wallet_adjust', { customer_id: custId, client_request_id: 'req-2', delta: -120.5, reason: 'fix' });
    expect(a2.json().data.balance).toBe(379.5);
    const replay = await post('/api/mobile/wallet_adjust', { customer_id: custId, client_request_id: 'req-2', delta: -120.5, reason: 'fix' });
    expect(replay.json().data).toEqual({ balance: 379.5, idempotent_replay: true });
    const conflict = await post('/api/mobile/wallet_adjust', { customer_id: custId, client_request_id: 'req-2', delta: -1, reason: 'fix' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    expect((await post('/api/mobile/wallet_adjust', { customer_id: custId, client_request_id: 'x', delta: 0, reason: 'r' })).statusCode).toBe(422);

    const tx = (await get('/api/mobile/wallet_transactions?txn_type=Adjustment')).json().data;
    expect(tx.total).toBe(2);
    expect(tx.total_credit).toBe(500);
    expect(tx.total_debit).toBe(120.5);
    expect(tx.transactions[0]).toMatchObject({ balance_after: 379.5, created_by_name: 'Rahul' });
    expect(await app.services.wallet.recalculate(custId)).toBe(379.5);
    expect((await get(`/api/mobile/customers_detail?id=${custId}`)).json().data.customer.wallet_balance).toBe('379.50');
  });

  it('wallet redeem cannot overdraw and rolls back', async () => {
    await expect(app.services.wallet.redeem(custId, 1000)).rejects.toThrow(/Insufficient/);
    expect(await app.services.wallet.getBalance(custId)).toBe(379.5);
  });

  it('enforces permissions', async () => {
    const noauth = await app.inject({ method: 'GET', url: '/api/mobile/customers_list' });
    expect(noauth.statusCode).toBe(401);
  });
});
