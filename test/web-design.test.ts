import { describe, expect, it, vi } from 'vitest';
import { buildServices } from '../src/app.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

/** Tag Design / Invoice Design / Dormant Customers / multi-piece Set garments (PHP changelog 2026-10-20..22). */
describe.skipIf(!webEnabled)('design + dormant + multi-piece: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };
  const opts = { sortRows: true };

  it('tag design: page, roles, saves', async () => {
    await seedRich();
    const { php, node } = await asBoss();
    await both(php, node, '/modules/admin/tag_design.php');
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const c = await login(who as any);
      await both(c.php, c.node, '/modules/admin/tag_design.php', `tag design ${who}`);
    }
    const keys = (await h.db.query<any>('SELECT field_key FROM tag_design_fields ORDER BY sort_order')).map((r: any) => r.field_key as string);
    const full = (over: Record<string, string> = {}) => {
      const f: Record<string, string> = {};
      keys.forEach((k, i) => {
        if (i % 3 !== 1) f[`show_${k}`] = 'on';
        f[`font_${k}`] = ['Arial', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New', 'Arial Black'][i % 6]!;
        f[`size_${k}`] = String(8 + i);
        f[`align_${k}`] = ['left', 'center', 'right'][i % 3]!;
        if (i % 2) f[`bold_${k}`] = 'on';
        if (i % 4 === 0) f[`italic_${k}`] = 'on';
        if (i % 5 === 0) f[`underline_${k}`] = 'on';
        if (i % 3 === 0) f[`box_${k}`] = 'on';
      });
      return { ...f, ...over };
    };
    await write('save', php, node, (c) => c.post('/modules/admin/tag_design.php', full()), opts);
    await write('save sanitised', php, node, (c) => c.post('/modules/admin/tag_design.php', full({ [`font_${keys[0]}`]: 'Comic Sans', [`size_${keys[0]}`]: '3', [`size_${keys[1]}`]: '500', [`size_${keys[2]}`]: 'abc', [`align_${keys[0]}`]: 'justify' })), opts);
    await write('save nothing ticked', php, node, (c) => c.post('/modules/admin/tag_design.php', {}), opts);
    await write('save csrf', php, node, (c) => c.post('/modules/admin/tag_design.php', full(), { csrf: false }), opts);
    await both(php, node, '/modules/admin/tag_design.php', 'tag design after saves');
  });

  it('invoice design: page, roles, saves, and the invoice itself', async () => {
    await seedRich();
    const { php, node } = await asBoss();
    await both(php, node, '/modules/admin/invoice_design.php');
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const c = await login(who as any);
      await both(c.php, c.node, '/modules/admin/invoice_design.php', `invoice design ${who}`);
    }
    const fkeys = (await h.db.query<any>('SELECT field_key FROM invoice_design_fields ORDER BY sort_order')).map((r: any) => r.field_key as string);
    const tkeys = (await h.db.query<any>('SELECT toggle_key FROM invoice_design_toggles ORDER BY sort_order')).map((r: any) => r.toggle_key as string);
    const body = (on: (k: string) => boolean, over: Record<string, string> = {}) => {
      const f: Record<string, string> = { section: 'fields_toggles' };
      fkeys.forEach((k, i) => { if (on(k)) f[`show_${k}`] = 'on'; f[`font_${k}`] = ['Verdana', 'Georgia', 'Courier New'][i % 3]!; f[`size_${k}`] = String(10 + i * 4); f[`align_${k}`] = ['center', 'right', 'left'][i % 3]!; if (i % 2 === 0) f[`bold_${k}`] = 'on'; if (i === 1) f[`italic_${k}`] = 'on'; if (i === 2) f[`underline_${k}`] = 'on'; });
      for (const t of tkeys) if (on(t)) f[`toggle_${t}`] = 'on';
      return { ...f, ...over };
    };
    const invoices = async (label: string) => {
      for (const id of [1, 2, 5]) await both(php, node, `/modules/orders/invoice.php?id=${id}`, `${label} invoice ${id}`);
    };
    await invoices('default');
    await write('save everything on', php, node, (c) => c.post('/modules/admin/invoice_design.php', body(() => true)), opts);
    await invoices('everything on (terms still empty)');
    await write('terms single line', php, node, (c) => c.post('/modules/admin/invoice_design.php', { section: 'terms', 'term_line[]': 'Goods once delivered are final.' }), opts);
    await write('terms none', php, node, (c) => c.post('/modules/admin/invoice_design.php', { section: 'terms' }), opts);
    await write('terms blank line', php, node, (c) => c.post('/modules/admin/invoice_design.php', { section: 'terms', 'term_line[]': '   ' }), opts);
    await write('terms one', php, node, (c) => c.post('/modules/admin/invoice_design.php', { section: 'terms', 'term_line[]': 'Delivery within 48 hours <b>&</b>' }), opts);
    await invoices('terms on');
    await write('save everything off', php, node, (c) => c.post('/modules/admin/invoice_design.php', body(() => false)), opts);
    await invoices('everything off');
    await write('save mixed', php, node, (c) => c.post('/modules/admin/invoice_design.php', body((k) => !['show_logo', 'show_barcode', 'store_address', 'show_tax_breakdown'].includes(k), { [`font_${fkeys[0]}`]: 'Nope', [`size_${fkeys[0]}`]: '2', [`align_${fkeys[1]}`]: 'x' })), opts);
    await invoices('mixed');
    await write('unknown section', php, node, (c) => c.post('/modules/admin/invoice_design.php', { section: 'zzz' }), opts);
    await write('csrf', php, node, (c) => c.post('/modules/admin/invoice_design.php', body(() => true), { csrf: false }), opts);
    await both(php, node, '/modules/admin/invoice_design.php', 'invoice design after saves');
    expect(true).toBe(true);
  });

  it('dormant customers report + customer "days since last order"', async () => {
    await seedRich();
    // spread of last-order ages (and opt-in / opt-out) so every bucket has someone
    const base = Number((await h.db.query<any>('SELECT MAX(id) AS m FROM customers'))[0].m);
    const ages = [35, 61, 95, 125, 200, 400];
    for (let i = 0; i < ages.length; i++) {
      const r = await h.db.execute('INSERT INTO customers (customer_code, full_name, mobile, communication_preference, is_active, created_by) VALUES (?,?,?,?,1,1)', [`D${base}${i}`, `Dormant ${ages[i]}`, `70000000${i}${i}`, i % 2 ? 'WhatsApp' : 'SMS']);
      await h.db.execute("INSERT INTO orders (order_number, short_order_code, invoice_number, customer_id, store_id, price_list_id, order_date, due_date, status_id, created_by) VALUES (?,?,?,?,1,1, NOW() - INTERVAL ? DAY, CURDATE(), 1, 1)", [`UDC-D-${i}`, `Z${i}`, `INV-D${i}`, r.insertId, ages[i]]);
    }
    const { php, node } = await asBoss();
    for (const q of ['', '?bucket=30', '?bucket=60', '?bucket=90', '?bucket=120', '?bucket=180', '?bucket=zzz', '?bucket=60&store_id=1', '?store_id=999', '?store_id=abc']) await both(php, node, `/modules/reports/dormant_customers.php${q}`, `dormant ${q}`);
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const c = await login(who as any);
      await both(c.php, c.node, '/modules/reports/dormant_customers.php?bucket=30', `dormant ${who}`);
    }
    for (const q of ['?bucket=30&export=1', '?bucket=180&export=1']) {
      const a = await php.get(`/modules/reports/dormant_customers.php${q}`), b = await node.get(`/modules/reports/dormant_customers.php${q}`);
      expect(b.status).toBe(a.status);
      expect(b.body).toBe(a.body);
    }
    // customer detail stat card (never-ordered, ordered today, ordered long ago)
    const never = await h.db.execute("INSERT INTO customers (customer_code, full_name, mobile, communication_preference, is_active, created_by) VALUES ('NEVER1','Never Ordered','7111111111','WhatsApp',1,1)");
    for (const id of [1, 2, base + 1, base + 5, never.insertId]) await both(php, node, `/modules/customers/view.php?id=${id}`, `customer view ${id}`);
    await both(php, node, '/modules/reports/whatsapp/campaigns.php?segment=120_day_inactive', 'campaign 120');
    await both(php, node, '/modules/reports/whatsapp/campaigns.php?segment=180plus_day_inactive', 'campaign 180+');
    await both(php, node, '/modules/reports/whatsapp/campaigns.php?segment=60_day_inactive', 'campaign 60');
  });

  it('garments: Pieces per Unit on add / edit', async () => {
    await seedRich();
    const { php, node } = await asBoss();
    await both(php, node, '/modules/garments/add.php', 'add form');
    await both(php, node, '/modules/garments/edit.php?id=1', 'edit form');
    const base = { garment_name: 'Safari Suit', sku: 'SS-1', category_id: '1', default_service_id: '1', unit: 'Set', description: 'd' };
    const add = (form: Record<string, string>) => (c: Client) => c.post('/modules/garments/add.php', form);
    await write('add 2 pieces', php, node, add({ ...base, pieces_per_unit: '2' }), opts);
    await write('add 3 pieces', php, node, add({ ...base, garment_name: 'Salwar Set', sku: 'SS-2', pieces_per_unit: '3' }), opts);
    await write('add zero', php, node, add({ ...base, garment_name: 'Zero', sku: 'SS-3', pieces_per_unit: '0' }), opts);
    await write('add text', php, node, add({ ...base, garment_name: 'Text', sku: 'SS-4', pieces_per_unit: 'abc' }), opts);
    await write('add blank', php, node, add({ ...base, garment_name: 'Blank', sku: 'SS-5', pieces_per_unit: '' }), opts);
    await write('add missing field', php, node, add({ ...base, garment_name: 'Missing', sku: 'SS-6' }), opts);
    await write('add fractional', php, node, add({ ...base, garment_name: 'Frac', sku: 'SS-7', pieces_per_unit: '2.9' }), opts);
    const eb = { garment_name: 'Renamed', sku: 'REN-1', category_id: '1', default_service_id: '', unit: 'Pcs', description: 'x', is_active: '1' };
    const edit = (id: number, form: Record<string, string>) => (c: Client) => c.post(`/modules/garments/edit.php?id=${id}`, form);
    await write('edit 4 pieces', php, node, edit(1, { ...eb, pieces_per_unit: '4' }), opts);
    await write('edit zero', php, node, edit(1, { ...eb, pieces_per_unit: '0' }), opts);
    await write('edit negative', php, node, edit(1, { ...eb, pieces_per_unit: '-3' }), opts);
    await write('edit no field', php, node, edit(2, eb), opts);
    await both(php, node, '/modules/garments/edit.php?id=1', 'edit form after');
    await both(php, node, '/modules/garments/list.php', 'list');
    // POS garment feed carries pieces_per_unit
    for (const q of ['', '?category_id=1', '?q=Safari']) await both(php, node, `/api/garments_for_pos.php${q}`, `garments_for_pos ${q}`);
  });

  it('tags: multi-piece Set items print one tag per piece, driven by Tag Design', async () => {
    await seedRich();
    const svc = buildServices(h.env, h.db);
    // a Set garment (names), a Set garment (no names) and an ordinary one on the same order
    await h.db.execute("UPDATE garments SET pieces_per_unit = 2, piece_names = 'Left, Right' WHERE id = 1");
    await h.db.execute("UPDATE garments SET pieces_per_unit = 3, piece_names = NULL WHERE id = 2");
    await h.db.execute("UPDATE garments SET pieces_per_unit = 1, piece_names = NULL WHERE id = 6");
    const line = (garment_id: number, service_id: number, quantity: number) => ({ garment_id, service_id, quantity });
    const r = await svc.orders.createOrder({ customer_id: 1, items: [line(1, 1, 2), line(6, 1, 1), line(2, 1, 1)] }, { userId: 1 }, true, 1, true);
    expect(r.success, JSON.stringify(r)).toBe(true);
    const bc = await h.db.query<any>('SELECT b.item_sequence, b.piece_index, b.barcode_value, b.order_item_id FROM barcodes b WHERE b.order_id = ? ORDER BY b.id', [r.order_id]);
    expect(bc.map((b: any) => b.item_sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bc.map((b: any) => b.piece_index)).toEqual([1, 2, 3, 4, 1, 1, 2, 3]);
    const { php, node } = await asBoss();
    await write('tags order (default design)', php, node, (c) => c.get(`/modules/barcode/tags_print.php?order_id=${r.order_id}`), opts);
    await h.db.execute("UPDATE tag_design_fields SET show_field = 0 WHERE field_key IN ('qr_code','sequence','barcode_linear')");
    await h.db.execute("UPDATE tag_design_fields SET font_family = 'Georgia', font_size = 19, is_bold = 1, is_italic = 1, is_underline = 1, text_align = 'right', has_box = 1 WHERE field_key IN ('customer_name','garment_name','piece_of_set')");
    await write('tags order (custom design)', php, node, (c) => c.get(`/modules/barcode/tags_print.php?order_id=${r.order_id}&auto_print=1`), opts);
    const ids = bc.map((b: any) => b.order_item_id);
    expect(ids.length).toBe(8);
    await h.db.execute("UPDATE tag_design_fields SET show_field = 0 WHERE field_key = 'piece_of_set'");
    await write('tags order (piece line hidden)', php, node, (c) => c.get(`/modules/barcode/tags_print.php?order_id=${r.order_id}&format=a4`), opts);
    await h.db.execute('DELETE FROM tag_design_fields');
    await write('tags order (design table empty)', php, node, (c) => c.get(`/modules/barcode/tags_print.php?order_id=${r.order_id}`), opts);
    await both(php, node, `/modules/orders/view.php?id=${r.order_id}`, 'order view');
    await both(php, node, `/modules/orders/invoice.php?id=${r.order_id}`, 'invoice');
    await both(php, node, '/modules/barcode/tags.php', 'tags list');
  });
});
