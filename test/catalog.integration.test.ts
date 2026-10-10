import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, buildServices } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/password.js';
import { resetTables } from './helpers.js';

const enabled = !!process.env.TEST_DB_NAME;

describe.skipIf(!enabled)('catalog + rates (real MariaDB schema)', () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused',
    DB_USER: process.env.TEST_DB_USER || 'unused',
    DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k',
    APP_URL: 'https://shop.example',
  } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let headers: { authorization: string };

  beforeAll(async () => {
    await resetTables(db, ['api_tokens', 'users', 'role_permissions', 'permissions', 'roles', 'price_list_items', 'price_list_service_rates', 'garments', 'services', 'categories', 'customers', 'price_lists', 'taxes', 'settings', 'urgent_levels']);

    await db.execute("INSERT INTO roles (id, role_name) VALUES (1, 'Admin')");
    await db.execute("INSERT INTO permissions (id, permission_key, module) VALUES (1, 'pos.create', 'pos'), (2, 'garments.manage', 'garments')");
    await db.execute('INSERT INTO role_permissions (role_id, permission_id) VALUES (1, 1), (1, 2)');
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, is_active) VALUES (1, 1, 'Rahul', 'rahul', ?, 1)", [await hashPassword('pw12345')]);

    await db.execute("INSERT INTO taxes (id, tax_name, tax_percent) VALUES (1, 'GST 5%', 5.00)");
    await db.execute("INSERT INTO price_lists (id, price_list_name, list_type) VALUES (1, 'Default', 'Default'), (2, 'VIP', 'Customer'), (3, 'Old', 'Customer')");
    await db.execute('UPDATE price_lists SET is_active = 0 WHERE id = 3');
    await db.execute("INSERT INTO categories (id, category_name, sort_order) VALUES (1, 'Men', 1), (2, 'Women', 2)");
    await db.execute(
      "INSERT INTO services (id, service_name, billing_unit, pricing_scope, sort_order) VALUES (1, 'Dry Clean', 'piece', 'garment', 1), (2, 'Steam Press', 'piece', 'garment', 2), (3, 'Wash N Fold', 'weight', 'universal', 3)",
    );
    await db.execute(
      "INSERT INTO garments (id, garment_name, sku, category_id, default_service_id, image) VALUES (1, 'Shirt', 'SH1', 1, 1, 'shirt.png'), (2, 'Saree', 'SA1', 2, 1, NULL)",
    );
    // Default list prices everything; VIP overrides only Shirt/Dry Clean.
    await db.execute(
      `INSERT INTO price_list_items (price_list_id, garment_id, service_id, piece_rate, tax_id) VALUES
       (1,1,1,100,1),(1,1,2,30,1),(1,2,1,250,1),(2,1,1,80,1)`,
    );
    await db.execute('INSERT INTO price_list_service_rates (price_list_id, service_id, weight_rate, min_weight_charge, tax_id) VALUES (1,3,60,120,1)');
    await db.execute("INSERT INTO customers (id, customer_code, full_name, mobile, price_list_id) VALUES (1, 'C1', 'Vip Cust', '9999999999', 2), (2, 'C2', 'Plain', '8888888888', NULL)");
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('default_price_list_id', '1')");
    await db.execute("INSERT INTO urgent_levels (id, level_name, surcharge_percent, day_offset, sort_order) VALUES (1, 'Express', 25.00, 1, 1)");

    app = await buildApp(buildServices(env, db));
    const login = await app.inject({ method: 'POST', url: '/api/mobile/login', payload: { username: 'rahul', password: 'pw12345' } });
    headers = { authorization: `Bearer ${login.json().data.token}` };
  });
  afterAll(async () => {
    await app?.close();
    await close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers });

  it('requires auth and pos.create', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/mobile/pos_services' })).statusCode).toBe(401);
  });

  it('lookup lists', async () => {
    expect((await get('/api/mobile/pos_categories')).json().data.categories.map((c: any) => c.category_name)).toEqual(['Men', 'Women']);
    expect((await get('/api/mobile/pos_services.php')).json().data.services.map((s: any) => s.service_name)).toEqual(['Dry Clean', 'Steam Press']);
    expect((await get('/api/mobile/laundry_services')).json().data.services.map((s: any) => s.service_name)).toEqual(['Wash N Fold']);
    expect((await get('/api/mobile/urgent_levels')).json().data.urgent_levels).toEqual([{ id: 1, level_name: 'Express', surcharge_percent: 25, day_offset: 1 }]);
  });

  it('pos_rate: own list wins, falls back to Default, 404 when unpriced', async () => {
    const own = (await get('/api/mobile/pos_rate?garment_id=1&service_id=1&price_list_id=2')).json().data;
    expect(own).toMatchObject({ piece_rate: 80, source_list_type: 'Customer', tax_name: 'GST 5%', tax_percent: 5, billing_unit: 'piece' });
    const fb = (await get('/api/mobile/pos_rate?garment_id=2&service_id=1&price_list_id=2')).json().data;
    expect(fb).toMatchObject({ piece_rate: 250, source_list_type: 'Default' });
    const none = await get('/api/mobile/pos_rate?garment_id=2&service_id=2&price_list_id=2');
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toEqual({ code: 'no_price_configured', message: 'No price configured for this garment/service.', billing_unit: 'piece' });
    expect((await get('/api/mobile/pos_rate?garment_id=1')).statusCode).toBe(422);
  });

  it('pos_universal_rate', async () => {
    const r = (await get('/api/mobile/pos_universal_rate?service_id=3&price_list_id=2')).json().data;
    expect(r).toMatchObject({ weight_rate: 60, min_weight_charge: 120, source_list_type: 'Default', billing_unit: 'weight' });
    expect((await get('/api/mobile/pos_universal_rate?service_id=1&price_list_id=2')).statusCode).toBe(422);
  });

  it('pos_garments shows display_rate', async () => {
    const g = (await get('/api/mobile/pos_garments?price_list_id=2')).json().data.garments;
    expect(g.map((x: any) => [x.name, x.display_rate, x.display_has_price])).toEqual([['Saree', 250, true], ['Shirt', 80, true]]);
    expect((await get('/api/mobile/pos_garments?q=sh')).json().data.garments[0]).toMatchObject({ name: 'Shirt', display_rate: null, display_has_price: false });
  });

  it('products: garment list with all rates, customer price list + Default fallback', async () => {
    const d = (await get('/api/mobile/products?customer_id=1')).json().data;
    expect(d.price_list).toEqual({ id: 2, name: 'VIP', type: 'Customer' });
    const shirt = d.garments.find((g: any) => g.name === 'Shirt');
    expect(shirt.rates.map((r: any) => [r.service_name, r.piece_rate, r.source_list_type])).toEqual([['Dry Clean', 80, 'Customer'], ['Steam Press', 30, 'Default']]);
    const saree = d.garments.find((g: any) => g.name === 'Saree');
    expect(saree.rates).toHaveLength(1);
    expect(d.universal_services).toEqual([
      expect.objectContaining({ service_name: 'Wash N Fold', weight_rate: 60, min_weight_charge: 120, tax_percent: 5, source_list_type: 'Default' }),
    ]);
    expect(d.total).toBe(2);

    // customer without own list → Default; inactive/unknown list ignored
    const plain = (await get('/api/mobile/products?customer_id=2')).json().data;
    expect(plain.price_list.id).toBe(1);
    expect(plain.garments.find((g: any) => g.name === 'Shirt').rates[0]).toMatchObject({ piece_rate: 100, source_list_type: 'Default' });

    const filtered = (await get('/api/mobile/products?category_id=2&q=sar')).json().data;
    expect(filtered.garments.map((g: any) => g.name)).toEqual(['Saree']);
  });

  it('garments_catalog_list', async () => {
    const d = (await get('/api/mobile/garments_catalog_list')).json().data;
    expect(d.total).toBe(2);
    expect(d.garments.find((g: any) => g.garment_name === 'Shirt').image_url).toBe('https://shop.example/uploads/garments/shirt.png');
  });
});
