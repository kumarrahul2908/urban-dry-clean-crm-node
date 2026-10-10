import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';

// Runs only when a database with db/schema/schema.sql loaded is available:
//   TEST_DB_NAME=... TEST_DB_USER=... TEST_DB_PASS=... TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=3307 npm test
const enabled = !!process.env.TEST_DB_NAME;

describe.skipIf(!enabled)('integration (real MariaDB schema)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME ?? '',
    DB_USER: process.env.TEST_DB_USER ?? '',
    DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k',
    MAX_LOGIN_ATTEMPTS: '3',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    for (const t of ['api_tokens', 'login_ip_attempts', 'audit_logs', 'users', 'role_permissions', 'permissions', 'roles', 'stores', 'organizations'])
      await db.execute(`DELETE FROM ${t}`);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (1, 'Admin')");
    await db.execute("INSERT INTO permissions (id, permission_key, module) VALUES (1, 'orders.view', 'orders')");
    await db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (1, 1)');
    await db.execute("INSERT INTO organizations (id, org_name, org_code) VALUES (1, 'Org', 'ORG')");
    await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (1, 1, 'Main', 'main', 1)");
    const hash = await hashPassword('pw12345');
    await db.execute(
      "INSERT INTO users (id, role_id, full_name, username, email, password_hash, store_id, is_active) VALUES (1, 1, 'Rahul', 'rahul', 'r@x.in', ?, NULL, 1), (2, 1, 'Locky', 'locky', 'l@x.in', ?, NULL, 1)",
      [hash, hash],
    );
    app = await buildApp(buildServices(env, db));
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  it('login → me → logout against the real schema', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'pw12345', device_name: 'Pixel' } });
    expect(login.statusCode).toBe(200);
    const { token, expires_at, user } = login.json().data;
    expect(user.permissions).toEqual(['orders.view']);
    expect(expires_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

    const headers = { authorization: `Bearer ${token}` };
    const me = await app.inject({ method: 'GET', url: '/api/mobile/me.php', headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.store.available_stores).toEqual([{ id: 1, name: 'Main', type: 'main' }]);

    expect((await db.query('SELECT 1 FROM audit_logs WHERE action = "login" AND user_id = 1')).length).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/mobile/logout', headers })).json().data.revoked).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/mobile/me', headers })).statusCode).toBe(401);
  });

  it('locks the account after MAX_LOGIN_ATTEMPTS and counts IP failures', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'locky', password: 'bad' } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'locky', password: 'pw12345' } });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error.message).toMatch(/^Account locked/);
    const [row] = await db.query<{ failed_count: number }>('SELECT failed_count FROM login_ip_attempts');
    expect(Number(row!.failed_count)).toBe(3);
  });
});
