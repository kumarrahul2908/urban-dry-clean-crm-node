import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('master data: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const SLUGS = ['categories', 'stores', 'workshops', 'services', 'taxes', 'discounts', 'urgent_levels', 'payment_types', 'brands', 'colors', 'defects'];

  const prepare = async (db: Db) => {
    // the live schema has these columns (migrations not in db/schema); PHP and Node both need them
    for (const col of ['flat_weight_rate DECIMAL(10,2) NULL', 'flat_weight_tax_id INT NULL']) { try { await db.execute(`ALTER TABLE services ADD COLUMN ${col}`); } catch (ex) { if (!/Duplicate column/.test(String(ex))) console.log('ALTER failed', String(ex)); } }
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('master.manage','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key = 'master.manage'");
    await db.execute("UPDATE services SET description = 'Desc <b>x</b>' WHERE id = 1");
    await db.execute("INSERT IGNORE INTO colors (id, color_name, hex_code, sort_order, is_active) VALUES (50, 'Navy', '#001f3f', 2, 1), (51, 'Plain', NULL, 1, 0)");
    await db.execute("INSERT IGNORE INTO brands (id, brand_name, sort_order, is_active) VALUES (50, 'Brand & Co', 3, 1)");
    await db.execute("INSERT IGNORE INTO defects (id, defect_name, description, sort_order, is_active) VALUES (50, 'Stain', 'ink <i>', 1, 1)");
    await db.execute("INSERT IGNORE INTO taxes (id, tax_name, tax_percent, is_active) VALUES (50, 'GST 5', 5.00, 1)");
    await db.execute("INSERT IGNORE INTO discounts (id, discount_name, discount_type, discount_value, is_active) VALUES (50, 'Festive', 'Percent', 10, 1), (51, 'Flat 50', 'Flat', 50, 0)");
    await db.execute("INSERT IGNORE INTO categories (id, category_name, sort_order, is_active) VALUES (50, 'Cat A', 1, 1)");
    await db.execute("INSERT IGNORE INTO payment_types (id, type_name, sort_order, is_active) VALUES (50, 'Cheque', 9, 1)");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };

  it('list pages, search, pagination, roles', async () => {
    await seedRich(prepare);
    // enough rows to paginate (20/page)
    for (let i = 0; i < 25; i++) await h.db.execute("INSERT INTO brands (brand_name, sort_order, is_active) VALUES (?, ?, 1)", [`Bulk ${i}`, i]);
    const { php, node } = await asBoss();
    await both(php, node, '/modules/master_data/index.php');
    await both(php, node, '/modules/master_data/printers.php');
    for (const s of SLUGS) for (const q of ['', '?q=a', '?q=zzzz', '?page=2', '?q=%3Cb%3E']) await both(php, node, `/modules/master_data/${s}.php${q}`, `${s} ${q}`);
    expect((await php.get('/modules/master_data/brands.php?page=2')).body).toContain('page-link');
    const adm = await login('admin'), nobody = await login('nobody'), anon = await login(null);
    for (const c of [adm, nobody, anon]) for (const p of ['/modules/master_data/index.php', '/modules/master_data/colors.php', '/api/master_data.php']) await both(c.php, c.node, p, `role ${p}`);
  });

  it('api/master_data.php: create / update / toggle / delete / validation', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const call = (body: Record<string, unknown>, withCsrf = true) => async (c: Client) => {
      const payload = JSON.stringify({ ...body, ...(withCsrf ? { csrf_token: c.csrf() } : {}) });
      if (c === php) {
        const r = await fetch(`http://127.0.0.1:${h.port}/api/master_data.php`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: php.cookie() }, body: payload });
        return { status: r.status, location: null, body: await r.text(), type: r.headers.get('content-type') } as any;
      }
      const r = await h.app.inject({ method: 'POST', url: '/api/master_data.php', headers: { 'content-type': 'application/json', cookie: node.cookie() }, payload });
      return { status: r.statusCode, location: null, body: r.body, type: String(r.headers['content-type'] ?? '') } as any;
    };
    const j = { jsonBody: true };
    if (process.env.DBG) { const r1 = await call({ entity: 'services', action: 'create', service_name: 'Rush Wash', description: 'd', sort_order: '3', flat_weight_rate: '25.5', flat_weight_tax_id: '' })(php); console.log('PHP', r1.status, r1.body.slice(0, 400)); const r2 = await call({ entity: 'services', action: 'create', service_name: 'Rush Wash2', description: 'd', sort_order: '3', flat_weight_rate: '25.5', flat_weight_tax_id: '' })(node); console.log('NODE', r2.status, r2.body.slice(0, 400)); }
    const cases: [string, Record<string, unknown>, boolean?][] = [
      ['create brand', { entity: 'brands', action: 'create', brand_name: ' Zeta ', sort_order: 4, junk: 'x' }],
      ['create brand dup', { entity: 'brands', action: 'create', brand_name: 'Brand & Co' }],
      ['create brand empty', { entity: 'brands', action: 'create', brand_name: '  ' }],
      ['create service', { entity: 'services', action: 'create', service_name: 'Rush Wash', description: 'd', sort_order: '3', flat_weight_rate: '25.5', flat_weight_tax_id: '' }],
      ['create service blank numbers', { entity: 'services', action: 'create', service_name: 'S2', description: '', sort_order: '', flat_weight_rate: '', flat_weight_tax_id: '' }],
      ['create service bad rate', { entity: 'services', action: 'create', service_name: 'S3', flat_weight_rate: '-1' }],
      ['create service text rate', { entity: 'services', action: 'create', service_name: 'S4', flat_weight_rate: 'abc' }],
      ['create tax', { entity: 'taxes', action: 'create', tax_name: 'GST 12', tax_percent: '12' }],
      ['create tax missing percent', { entity: 'taxes', action: 'create', tax_name: 'GST 13', tax_percent: '' }],
      ['create discount', { entity: 'discounts', action: 'create', discount_name: 'Promo', discount_type: 'Flat', discount_value: 20 }],
      ['create urgent', { entity: 'urgent_levels', action: 'create', level_name: 'Same Day', surcharge_percent: '50', day_offset: '0', turnaround_hours: '6', sort_order: '1' }],
      ['create store', { entity: 'stores', action: 'create', store_name: 'North', address: 'A', phone: '1' }],
      ['create workshop', { entity: 'workshops', action: 'create', workshop_name: 'Gamma', address: '', phone: '', commission_workshop_percent: '' }],
      ['create color', { entity: 'colors', action: 'create', color_name: 'Teal', hex_code: '#008080', sort_order: 1 }],
      ['create defect', { entity: 'defects', action: 'create', defect_name: 'Tear', description: 'x', sort_order: 2 }],
      ['create category', { entity: 'categories', action: 'create', category_name: 'Cat Z' }],
      ['create payment type', { entity: 'payment_types', action: 'create', type_name: 'Card', sort_order: 5 }],
      ['update brand', { entity: 'brands', action: 'update', id: 50, brand_name: 'Brand Renamed', sort_order: 8 }],
      ['update brand dup', { entity: 'brands', action: 'update', id: 50, brand_name: 'Bulk 0' }],
      ['update missing', { entity: 'brands', action: 'update', id: 9999, brand_name: 'x' }],
      ['update service', { entity: 'services', action: 'update', id: 1, service_name: 'Dry Clean', description: '', sort_order: 1, flat_weight_rate: '', flat_weight_tax_id: '' }],
      ['toggle', { entity: 'colors', action: 'toggle', id: 50 }],
      ['toggle missing', { entity: 'colors', action: 'toggle', id: 9999 }],
      ['delete unused', { entity: 'colors', action: 'delete', id: 51 }],
      ['delete used', { entity: 'services', action: 'delete', id: 1 }],
      ['delete missing', { entity: 'colors', action: 'delete', id: 9999 }],
      ['unknown entity', { entity: 'nope', action: 'create' }],
      ['unknown action', { entity: 'brands', action: 'zzz' }],
      ['no csrf', { entity: 'brands', action: 'toggle', id: 50 }, false],
    ];
    for (const [label, body, csrf] of cases) { try { await write(label, php, node, call(body, csrf ?? true), j); } catch (ex) { throw new Error(`[${label}] ${(ex as Error).message}`); } }
    // a logged-in user without master.manage gets the 403 page (own csrf token / session)
    const nobody = await login('nobody');
    await nobody.php.get('/modules/dashboard/landing.php'); await nobody.node.get('/modules/dashboard/landing.php');
    const raw = async (c: Client, isPhp: boolean) => {
      const payload = JSON.stringify({ entity: 'brands', action: 'create', brand_name: 'N', csrf_token: c.csrf() });
      if (isPhp) { const r = await fetch(`http://127.0.0.1:${h.port}/api/master_data.php`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: c.cookie() }, body: payload }); return { status: r.status, body: await r.text() }; }
      const r = await h.app.inject({ method: 'POST', url: '/api/master_data.php', headers: { 'content-type': 'application/json', cookie: c.cookie() }, payload }); return { status: r.statusCode, body: r.body };
    };
    const a = await raw(nobody.php, true), b = await raw(nobody.node, false);
    expect(b.status).toBe(a.status);
    expect(b.body.replace(/\s+/g, ' ')).toBe(a.body.replace(/\s+/g, ' '));
  });
});
