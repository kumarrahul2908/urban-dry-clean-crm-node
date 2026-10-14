import { describe, expect, it, vi } from 'vitest';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!webEnabled)('garments: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };

  it('list / view / roles', async () => {
    await seedRich();
    for (let i = 0; i < 22; i++) await h.db.execute('INSERT INTO garments (garment_name, sku, category_id, unit, is_active) VALUES (?,?,1,?,?)', [`Bulk ${i}`, i % 3 ? `SKU${i}` : null, 'Pcs', i % 4 ? 1 : 0]);
    const { php, node } = await asBoss();
    for (const q of ['', '?q=Bulk', '?q=SKU1', '?q=zzz', '?page=2', '?category_id=1', '?service_id=1', '?status=active', '?status=inactive', '?q=%3Cb%3E']) await both(php, node, `/modules/garments/list.php${q}`, `list ${q}`);
    const ids = await h.db.query<any>('SELECT id FROM garments ORDER BY id LIMIT 6');
    for (const g of ids) await both(php, node, `/modules/garments/view.php?id=${g.id}`, `view ${g.id}`);
    await both(php, node, '/modules/garments/view.php?id=99999', 'view missing');
    await both(php, node, '/modules/garments/edit.php?id=1', 'edit form');
    await both(php, node, '/modules/garments/edit.php?id=99999', 'edit missing');
    await both(php, node, '/modules/garments/add.php', 'add form');
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const c = await login(who as any);
      for (const p of ['/modules/garments/list.php', '/modules/garments/view.php?id=1', '/modules/garments/edit.php?id=1', '/modules/garments/add.php']) await both(c.php, c.node, p, `${who} ${p}`);
    }
  });

  it('add / edit writes + uploads', async () => {
    await seedRich();
    const { php, node } = await asBoss();
    const opts = { sortRows: true };
    const add = (form: Record<string, string>) => (c: Client) => c.post('/modules/garments/add.php', form);
    const base = { garment_name: 'Kurta Silk', sku: 'KS-1', category_id: '1', default_service_id: '1', unit: 'Pcs', description: 'd <b>' };
    await write('add ok', php, node, add(base), opts);
    await write('add no sku/service', php, node, add({ ...base, sku: '', default_service_id: '' }), opts);
    await write('add empty', php, node, add({ garment_name: '', sku: '', category_id: '', default_service_id: '', unit: '', description: '' }), opts);
    const ex = (await h.db.query<any>('SELECT garment_name, sku, category_id FROM garments ORDER BY id LIMIT 1'))[0];
    await write('add dup sku', php, node, add({ ...base, sku: ex.sku ?? 'X' }), opts);
    await write('add dup name', php, node, add({ ...base, garment_name: String(ex.garment_name).toUpperCase(), category_id: String(ex.category_id) }), opts);
    await write('add csrf', php, node, (c) => c.post('/modules/garments/add.php', base, { csrf: false }), opts);
    await write('add image', php, node, (c) => c.upload('/modules/garments/add.php', base, { field: 'image', filename: 'a.png', content: PNG, type: 'image/png' }), opts);
    await write('add bad ext', php, node, (c) => c.upload('/modules/garments/add.php', base, { field: 'image', filename: 'a.gif', content: PNG, type: 'image/gif' }), opts);
    await write('add fake image', php, node, (c) => c.upload('/modules/garments/add.php', base, { field: 'image', filename: 'a.png', content: 'not an image at all', type: 'image/png' }), opts);

    const edit = (id: number, form: Record<string, string>) => (c: Client) => c.post(`/modules/garments/edit.php?id=${id}`, form);
    const eb = { garment_name: 'Renamed', sku: 'REN-1', category_id: '1', default_service_id: '', unit: 'Pcs', description: 'x', is_active: '1' };
    await write('edit ok', php, node, edit(1, eb), opts);
    await write('edit deactivate', php, node, edit(1, { garment_name: 'Renamed', sku: 'REN-1', category_id: '1', default_service_id: '', unit: 'Pcs', description: '' }), opts);
    await write('edit empty', php, node, edit(1, { ...eb, garment_name: '', unit: '' }), opts);
    await write('edit dup sku', php, node, edit(2, { ...eb, sku: ex.sku ?? 'Q' }), opts);
    await write('edit missing', php, node, edit(99999, eb), opts);
    await write('edit upload', php, node, (c) => c.upload('/modules/garments/edit.php?id=1', eb, { field: 'image', filename: 'b.png', content: PNG }), opts);
    await write('edit remove image', php, node, edit(1, { ...eb, remove_image: '1' }), opts);
    await write('edit csrf', php, node, (c) => c.post('/modules/garments/edit.php?id=1', eb, { csrf: false }), opts);
    // user without garment.delete / garments.manage: cannot deactivate
    const adm = await login('admin');
    await write('edit deactivate w/o permission', adm.php, adm.node, (c) => c.post('/modules/garments/edit.php?id=1', { ...eb, is_active: '' }), opts);
    expect(true).toBe(true);
  });
});
