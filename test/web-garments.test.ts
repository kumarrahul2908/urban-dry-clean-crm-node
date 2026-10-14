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

describe.skipIf(!webEnabled)('garments bulk import / bulk image: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const HEAD = 'Garment ID,Garment Code / SKU,Garment Name,Category,Unit,Default Service,Status,Description';
  const tok = (b: string) => /name="(?:import|mapping)_token" value="([0-9a-f]{32})"/.exec(b)?.[1] ?? '';

  it('bulk_import: pages, template, validation, confirm', async () => {
    await seedRich();
    const { php, node } = await asBoss();
    const a = await php.get('/modules/garments/bulk_import.php'), b = await node.get('/modules/garments/bulk_import.php');
    eq(b, a, 'upload page');
    const ta = await php.get('/modules/garments/bulk_import.php?template=1'), tb = await node.get('/modules/garments/bulk_import.php?template=1');
    eq(tb, ta, 'template');
    const cat = (await h.db.query<any>('SELECT category_name FROM categories WHERE is_active=1 ORDER BY id LIMIT 1'))[0].category_name;
    const svc = (await h.db.query<any>('SELECT service_name FROM services WHERE is_active=1 ORDER BY id LIMIT 1'))[0].service_name;
    const g1 = (await h.db.query<any>('SELECT id, garment_name, sku, category_id FROM garments ORDER BY id LIMIT 2'));
    const cases: Record<string, string> = {
      'good new+update': [HEAD, `,NEWSKU1,Brand New Item,${cat},Pcs,${svc},Active,hello`, `${g1[0].id},,Renamed Row,${cat},Kg,,Inactive,upd`].join('\n'),
      'row errors': [HEAD, `999,,X,${cat},Pcs,,Active,`, `,,,Nope Cat,Box,Nope Svc,Maybe,`, `abc,${g1[1].sku ?? 'SKUX'},Y,${cat},Pcs,,,`, `,,Dup,${cat},Pcs,,,`, `,,dup,${cat},Pcs,,,`, `${g1[0].id},,Z,${cat},Pcs,,,`, `${g1[0].id},,Z2,${cat},Pcs,,,`].join('\n'),
      'missing column': 'Garment ID,Garment Name\n1,x',
      'no rows': HEAD,
      'dup existing name': [HEAD, `,,${g1[0].garment_name},${(await h.db.query<any>('SELECT category_name FROM categories WHERE id=?', [g1[0].category_id]))[0].category_name},Pcs,,,`].join('\n'),
    };
    const upload = (csv: string, name = 'g.csv') => async (c: Client) => c.upload('/modules/garments/bulk_import.php', { step: 'upload' }, { field: 'file', filename: name, content: csv });
    for (const [label, csv] of Object.entries(cases)) await write('import ' + label, php, node, upload(csv));
    await write('import bad ext', php, node, upload(cases['good new+update']!, 'g.txt'));
    await write('import csrf', php, node, (c) => c.post('/modules/garments/bulk_import.php', { step: 'upload' }, { csrf: false }));
    await write('import no file', php, node, (c) => c.post('/modules/garments/bulk_import.php', { step: 'upload' }));
    // upload → confirm (own token per side)
    const flow = (csv: string, action: string) => async (c: Client) => { const up = await c.upload('/modules/garments/bulk_import.php', { step: 'upload' }, { field: 'file', filename: 'g.csv', content: csv }); return c.post('/modules/garments/bulk_import.php', { step: action, import_token: tok(up.body) }); };
    await write('import confirm ok', php, node, flow(cases['good new+update']!, 'confirm'));
    await write('import confirm with errors', php, node, flow(cases['row errors']!, 'confirm'));
    await write('import cancel', php, node, flow(cases['good new+update']!, 'cancel'));
    await write('import confirm bad token', php, node, (c) => c.post('/modules/garments/bulk_import.php', { step: 'confirm', import_token: 'zz' }));
    for (const who of ['admin', 'ws', 'nobody', null] as const) { const c = await login(who as any); for (const p of ['/modules/garments/bulk_import.php', '/modules/garments/bulk_import.php?template=1', '/modules/garments/bulk_image.php']) { const x = await c.php.get(p), y = await c.node.get(p); eq(y, x, `${who} ${p}`); } }
  });

  it('bulk_image: preview / confirm / cancel', async () => {
    await seedRich();
    const { php, node } = await asBoss();
    eq(await node.get('/modules/garments/bulk_image.php'), await php.get('/modules/garments/bulk_image.php'), 'page');
    await h.db.execute("UPDATE garments SET image='old.png' WHERE id=2");
    const mk = (files: { name: string; data: Buffer | string }[], mapping?: string) => async (c: Client, action = 'upload', token?: string) => {
      // the shared harness uploads one file; build a multi-file multipart by hand for both sides
      const boundary = `----t${Math.random().toString(16).slice(2)}`;
      const parts: Buffer[] = [];
      const field = (k: string, v: string) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      field('csrf_token', c.csrf() ?? ''); field('step', action); if (token) field('mapping_token', token);
      for (const f of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images[]"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(f.data), Buffer.from('\r\n'));
      if (mapping !== undefined) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mapping_file"; filename="m.csv"\r\nContent-Type: text/csv\r\n\r\n${mapping}\r\n`));
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const payload = Buffer.concat(parts);
      const headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: c.cookie() };
      if (c === php) { const r = await fetch(`http://127.0.0.1:${h.port}/modules/garments/bulk_image.php`, { method: 'POST', redirect: 'manual', headers, body: payload }); return { status: r.status, location: r.headers.get('location'), body: await r.text(), type: r.headers.get('content-type') } as any; }
      const r = await h.app.inject({ method: 'POST', url: '/modules/garments/bulk_image.php', headers, payload });
      return { status: r.statusCode, location: (r.headers.location as string) ?? null, body: r.body, type: String(r.headers['content-type'] ?? '') } as any;
    };
    const send = (files: { name: string; data: Buffer | string }[], mapping?: string) => { const m = mk(files, mapping); return (c: Client) => m(c); };
    const flow = (files: { name: string; data: Buffer | string }[], action: string, mapping?: string) => async (c: Client) => { const m = mk(files, mapping); const up = await m(c); return m(c, action, tok(up.body)); };
    const ok = [{ name: '1.png', data: PNG }, { name: '2.png', data: PNG }];
    await write('img preview ok', php, node, send(ok));
    await write('img preview errors', php, node, send([{ name: 'abc.png', data: PNG }, { name: '99.png', data: PNG }, { name: '1.gif', data: PNG }, { name: '3.png', data: 'nope' }, { name: '4.png', data: PNG }, { name: '4.png', data: PNG }]));
    await write('img mapping csv', php, node, send([{ name: 'front.png', data: PNG }, { name: 'back.png', data: PNG }], 'Garment ID,Image Filename\n1,front.png\n2,BACK.png\n'));
    await write('img none', php, node, send([]));
    await write('img confirm ok', php, node, flow(ok, 'confirm'));
    await write('img confirm errors', php, node, flow([{ name: '99.png', data: PNG }], 'confirm'));
    await write('img cancel', php, node, flow(ok, 'cancel'));
  });
});
