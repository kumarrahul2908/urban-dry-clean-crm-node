import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('price lists: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const prepare = async (db: Db) => {
    for (const col of ['flat_weight_rate DECIMAL(10,2) NULL', 'flat_weight_tax_id INT NULL']) { try { await db.execute(`ALTER TABLE services ADD COLUMN ${col}`); } catch { /* exists */ } }
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('pricelist.manage','x'),('pricing.view','x'),('pricing.edit','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN ('pricelist.manage','pricing.view','pricing.edit')");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };

  it('list / add / edit pages + roles', async () => {
    await seedRich(prepare);
    for (let i = 0; i < 22; i++) await h.db.execute('INSERT INTO price_lists (price_list_name, list_type, is_active) VALUES (?,?,?)', [`PL ${i}`, ['Default', 'Customer', 'Membership'][i % 3], i % 4 ? 1 : 0]);
    const { php, node } = await asBoss();
    for (const q of ['', '?q=PL', '?q=zzz', '?type=Customer', '?type=Bogus', '?page=2', '?q=%3Cb%3E&type=Default']) await both(php, node, `/modules/pricelist/list.php${q}`, `list ${q}`);
    const lists = await h.db.query<any>('SELECT id FROM price_lists ORDER BY id LIMIT 4');
    for (const l of lists) for (const q of ['', '&q=a', '&category_id=1', '&q=zzz', '&category_id=99']) await both(php, node, `/modules/pricelist/edit.php?id=${l.id}${q}`, `edit ${l.id} ${q}`);
    await both(php, node, '/modules/pricelist/edit.php?id=99999', 'edit missing');
    await both(php, node, '/modules/pricelist/add.php', 'add');
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); for (const p of ['/modules/pricelist/list.php', '/modules/pricelist/edit.php?id=1', '/modules/pricelist/add.php', '/api/pricelist_toggle.php', '/api/price_list_items.php', '/api/price_list_service_rates.php']) await both(c.php, c.node, p, `${who} ${p}`); }
  });

  it('add writes', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const o = { sortRows: true };
    const add = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/pricelist/add.php', f, { csrf });
    await write('add ok', php, node, add({ price_list_name: ' VIP <x> ', list_type: 'Customer' }), o);
    await write('add empty', php, node, add({ price_list_name: '', list_type: 'Default' }), o);
    await write('add bad type', php, node, add({ price_list_name: 'N', list_type: 'Nope' }), o);
    await write('add no type', php, node, add({ price_list_name: 'N2' }), o);
    await write('add csrf', php, node, add({ price_list_name: 'N' }, false), o);
  });

  it('APIs: items / universal rates / toggle', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const call = (path: string, body: unknown, withCsrf = true) => async (c: Client) => {
      const payload = JSON.stringify(withCsrf && body && typeof body === 'object' ? { ...(body as object), csrf_token: c.csrf() } : body);
      if (c === php) { const r = await fetch(`http://127.0.0.1:${h.port}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: php.cookie() }, body: payload }); return { status: r.status, location: null, body: await r.text(), type: r.headers.get('content-type') } as any; }
      const r = await h.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', cookie: node.cookie() }, payload });
      return { status: r.statusCode, location: null, body: r.body, type: String(r.headers['content-type'] ?? '') } as any;
    };
    const j = { jsonBody: true, sortRows: true };
    const items = await h.db.query<any>('SELECT pli.*, s.billing_unit FROM price_list_items pli JOIN services s ON s.id = pli.service_id ORDER BY pli.id');
    const piece = items.find((x: any) => x.billing_unit !== 'weight') ?? items[0];
    const wsvc = (await h.db.query<any>("SELECT id FROM services WHERE billing_unit='weight' AND pricing_scope='garment' LIMIT 1"))[0];
    const usvc = await h.db.query<any>("SELECT id FROM services WHERE pricing_scope='universal' ORDER BY id");
    const gids = (await h.db.query<any>('SELECT id FROM garments ORDER BY id LIMIT 3')).map((g: any) => g.id);
    const PI = '/api/price_list_items.php', SR = '/api/price_list_service_rates.php', PT = '/api/pricelist_toggle.php';
    const cases: [string, string, unknown, boolean?][] = [
      ['toggle list', PT, { id: 1 }], ['toggle missing', PT, { id: 999 }], ['toggle csrf', PT, { id: 1 }, false],
      ['item no payload', PI, null, false], ['item csrf', PI, { action: 'toggle', price_list_id: 1, id: piece.id }, false],
      ['item bad list', PI, { action: 'toggle', price_list_id: 999, id: piece.id }],
      ['item unknown action', PI, { action: 'zzz', price_list_id: 1 }],
      ['item toggle', PI, { action: 'toggle', price_list_id: piece.price_list_id, id: piece.id }],
      ['item toggle missing', PI, { action: 'toggle', price_list_id: piece.price_list_id, id: 99999 }],
      ['item delete used', PI, { action: 'delete', price_list_id: piece.price_list_id, id: piece.id }],
      ['item delete missing', PI, { action: 'delete', price_list_id: 1, id: 99999 }],
      ['item create empty', PI, { action: 'create', price_list_id: 1 }],
      ['item create bad svc', PI, { action: 'create', price_list_id: 1, garment_id: gids[0], service_id: 99999, piece_rate: '5' }],
      ['item create no rate', PI, { action: 'create', price_list_id: 1, garment_id: gids[0], service_id: piece.service_id, piece_rate: '' }],
      ['item create negative', PI, { action: 'create', price_list_id: 1, garment_id: gids[0], service_id: piece.service_id, piece_rate: '-1' }],
      ['item create dup', PI, { action: 'create', price_list_id: piece.price_list_id, garment_id: piece.garment_id, service_id: piece.service_id, piece_rate: '5' }],
      ['item update ok', PI, { action: 'update', price_list_id: piece.price_list_id, id: piece.id, garment_id: piece.garment_id, service_id: piece.service_id, piece_rate: '77.5', tax_id: '' }],
      ['item update missing', PI, { action: 'update', price_list_id: 1, id: 99999 }],
      ['bulk empty', PI, { action: 'bulk_preview', price_list_id: piece.price_list_id }],
      ['bulk preview pct', PI, { action: 'bulk_preview', price_list_id: piece.price_list_id, garment_ids: gids, service_id: piece.service_id, update_type: 'increase', unit: 'percent', value: '12.5' }],
      ['bulk preview amt dec', PI, { action: 'bulk_preview', price_list_id: piece.price_list_id, garment_ids: gids, service_id: piece.service_id, update_type: 'decrease', unit: 'amount', value: '3' }],
      ['bulk apply', PI, { action: 'bulk_apply', price_list_id: piece.price_list_id, garment_ids: gids, service_id: piece.service_id, update_type: 'increase', unit: 'percent', value: '10' }],
      ['bulk svc missing', PI, { action: 'bulk_apply', price_list_id: 1, garment_ids: gids, service_id: 9999, update_type: 'increase', unit: 'percent', value: '10' }],
    ];
    if (wsvc) cases.push(['item create weight', PI, { action: 'create', price_list_id: 1, garment_id: gids[2], service_id: wsvc.id, weight_rate: '31.5', piece_rate: '9' }], ['item create weight no rate', PI, { action: 'create', price_list_id: 1, garment_id: gids[2], service_id: wsvc.id, piece_rate: '9' }]);
    if (usvc.length) {
      cases.push(['uni create', SR, { action: 'create', price_list_id: 1, service_id: usvc[0].id, weight_rate: '25.5', tax_id: '' }],
        ['uni create no rate', SR, { action: 'create', price_list_id: 1, service_id: usvc[0].id, weight_rate: '' }],
        ['uni create garment svc', SR, { action: 'create', price_list_id: 1, service_id: piece.service_id, weight_rate: '5' }],
        ['uni create bad svc', SR, { action: 'create', price_list_id: 1, service_id: 9999, weight_rate: '5' }]);
    }
    cases.push(['uni unknown', SR, { action: 'zzz', price_list_id: 1 }], ['uni missing', SR, { action: 'toggle', price_list_id: 1, id: 999 }], ['uni bad list', SR, { action: 'delete', price_list_id: 999, id: 1 }], ['uni csrf', SR, { action: 'delete', price_list_id: 1, id: 1 }, false]);
    for (const [label, path, body, csrf] of cases) { try { await write(label, php, node, call(path, body, csrf ?? true), j); } catch (ex) { throw new Error(`[${label}] ${(ex as Error).message}`); } }
    // existing universal rows: update / toggle / delete
    if (usvc.length) {
      let u = (await h.db.query<any>('SELECT id, price_list_id, service_id FROM price_list_service_rates ORDER BY id LIMIT 1'))[0];
      if (!u) { await h.db.execute('INSERT INTO price_list_service_rates (price_list_id, service_id, weight_rate, is_active) VALUES (1, ?, 20, 1)', [usvc[0].id]); u = (await h.db.query<any>('SELECT id, price_list_id, service_id FROM price_list_service_rates ORDER BY id LIMIT 1'))[0]; }
      for (const [label, body] of [['uni update', { action: 'update', price_list_id: u.price_list_id, id: u.id, service_id: u.service_id, weight_rate: '33', tax_id: '' }], ['uni toggle', { action: 'toggle', price_list_id: u.price_list_id, id: u.id }], ['uni delete', { action: 'delete', price_list_id: u.price_list_id, id: u.id }], ['uni update missing', { action: 'update', price_list_id: 1, id: 99999 }]] as [string, unknown][]) await write(label, php, node, call(SR, body), j);
      await both(php, node, '/modules/pricelist/edit.php?id=1', 'edit with universal');
    }
    expect(true).toBe(true);
  });
});
