import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { ChallanPdfService } from '../src/services/challanPdf.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';
import { pdfFonts, pdfStreams } from './web/pdfStreams.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('challans: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);
  const o = { sortRows: true };
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('billing.view','x'),('reports.view','x'),('admin.settings','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key IN ('billing.view','reports.view','admin.settings') WHERE r.id IN (1,3)");
    await db.execute("UPDATE order_items SET packaging_style = 'HANGER' WHERE id = 1");
    await db.execute("INSERT IGNORE INTO order_item_defects (order_item_id, defect_id) SELECT 1, id FROM defects LIMIT 2");
  };
  const asBoss = async () => { const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php'); return c; };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label, true); return a; };

  it('pages: select redirect, combine (+edit), list, reports, numbers', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    await both(php, node, '/modules/orders/challan_select.php');
    for (const q of ['', '?q=A000', '?q=zzz']) await both(php, node, `/modules/orders/challan_combine.php${q}`, `combine ${q}`);
    await both(php, node, '/modules/orders/challan_list.php', 'empty list');
    await both(php, node, '/modules/orders/challan_combine.php?challan_id=99', 'edit missing');
    for (const q of ['', '?date_from=2020-01-01&date_to=2099-12-31', '?date_from=bad']) await both(php, node, `/modules/orders/challan_reports.php${q}`, `reports ${q}`);
    await both(php, node, '/modules/orders/challan_whatsapp_settings.php', 'numbers');
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const c = await login(who as any);
      for (const p of ['/modules/orders/challan_list.php', '/modules/orders/challan_combine.php', '/modules/orders/challan_reports.php', '/modules/orders/challan_whatsapp_settings.php']) await both(c.php, c.node, p, `${who} ${p}`);
    }
  });

  it('single-order challan page (creates the record on first open), combine/edit/delete/send, list + pdf viewer', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const g = (p: string) => (c: Client) => c.get(p);
    await write('challan with amount', php, node, g('/modules/orders/challan.php?id=1&with_amount=1'), o);
    await write('challan without amount', php, node, g('/modules/orders/challan.php?id=2'), o);
    await write('challan laundry/odd id', php, node, g('/modules/orders/challan.php?id=3&with_amount=1'), o);
    await write('challan missing order', php, node, g('/modules/orders/challan.php?id=999'), o);
    await write('challan view (reuse number)', php, node, async (c) => { await c.get('/modules/orders/challan.php?id=1&with_amount=1'); return c.get('/modules/orders/challan.php?id=1&with_amount=1&view=1'); }, o);

    const cp = (f: Record<string, string | string[]>, csrf = true) => (c: Client) => c.post('/modules/orders/challan_combine.php', f, { csrf });
    await write('combine summary with amount', php, node, cp({ 'order_ids[]': ['1', '2'], with_amount: '1', combine_format: 'aggregated' }), o);
    await write('combine order-wise without', php, node, cp({ 'order_ids[]': ['2', '1'], with_amount: '0', combine_format: 'order_wise' }), o);
    await write('combine delivery', php, node, cp({ 'order_ids[]': ['1', '2', '3'], delivery: '1' }), o);
    await write('combine single', php, node, cp({ 'order_ids[]': ['1'], with_amount: '1' }), o);
    await write('combine none', php, node, cp({ with_amount: '1', 'order_ids[]': [] }), o);
    await write('combine missing order', php, node, cp({ 'order_ids[]': ['1', '999'], with_amount: '1' }), o);
    await write('combine csrf', php, node, cp({ 'order_ids[]': ['1'], with_amount: '1' }, false), o);
    await write('combine reuse', php, node, async (c) => { await c.post('/modules/orders/challan_combine.php', { 'order_ids[]': ['1', '2'], with_amount: '1', combine_format: 'aggregated' }); return c.post('/modules/orders/challan_combine.php', { 'order_ids[]': ['2', '1'], with_amount: '1', combine_format: 'aggregated' }); }, o);

    // edit + list + viewer + APIs against a real challan
    const edited = await write('edit flow', php, node, async (c) => {
      await c.post('/modules/orders/challan_combine.php', { 'order_ids[]': ['1', '2'], with_amount: '1', combine_format: 'aggregated' });
      const id = (await h.db.query<any>('SELECT MAX(id) AS id FROM challans'))[0].id;
      await c.get(`/modules/orders/challan_combine.php?challan_id=${id}`);
      await c.post('/modules/orders/challan_combine.php', { challan_id: String(id), 'order_ids[]': ['3'], with_amount: '0', combine_format: 'order_wise' });
      await c.get('/modules/orders/challan_list.php');
      await c.get('/modules/orders/challan_list.php?q=A000');
      await c.get(`/modules/orders/challan_pdf.php?challan_id=${id}`);
      await c.get(`/modules/orders/challan_pdf.php?challan_id=999`);
      await c.get(`/modules/orders/challan_pdf.php`);
      await c.get('/modules/orders/challan_reports.php?date_from=2020-01-01&date_to=2099-12-31');
      return c.get('/modules/orders/challan_list.php');
    }, o);
    expect(edited.body).toContain('Without Amount');
    await write('api delete', php, node, async (c) => {
      await c.post('/modules/orders/challan_combine.php', { 'order_ids[]': ['1'], with_amount: '1' });
      const id = (await h.db.query<any>('SELECT MAX(id) AS id FROM challans'))[0].id;
      return c.post('/api/challan_delete.php', { challan_id: String(id) });
    }, { ...o, jsonBody: true });
    await write('api delete missing', php, node, (c) => c.post('/api/challan_delete.php', { challan_id: '999' }), { ...o, jsonBody: true });
    await write('api delete none', php, node, (c) => c.post('/api/challan_delete.php', {}), { ...o, jsonBody: true });
    await write('api send (no account)', php, node, async (c) => {
      await c.post('/modules/orders/challan_combine.php', { 'order_ids[]': ['1'], with_amount: '1' });
      const id = (await h.db.query<any>('SELECT MAX(id) AS id FROM challans'))[0].id;
      return c.post('/api/challan_send_whatsapp.php', { challan_id: String(id), number: '9876543210' });
    }, { ...o, jsonBody: true });
    await write('api send missing', php, node, (c) => c.post('/api/challan_send_whatsapp.php', { challan_id: '999', number: '9876543210' }), { ...o, jsonBody: true });
    await write('api send bad', php, node, (c) => c.post('/api/challan_send_whatsapp.php', { challan_id: '1' }), { ...o, jsonBody: true });

    const nr = (f: Record<string, string>, csrf = true) => (c: Client) => c.post('/modules/orders/challan_whatsapp_settings.php', f, { csrf });
    await write('numbers save', php, node, nr({ number_0: '98765-43210', number_1: '', number_2: '+91 99999 11111' }), o);
    await write('numbers invalid', php, node, nr({ number_0: '123', number_1: '9876543210' }), o);
    await write('numbers csrf', php, node, nr({ number_0: '9876543210' }, false), o);
    await write('numbers then list', php, node, async (c) => { await c.post('/modules/orders/challan_whatsapp_settings.php', { number_0: '9876543210', number_3: '9123456780' }); await c.post('/modules/orders/challan_combine.php', { 'order_ids[]': ['1'], with_amount: '1' }); return c.get('/modules/orders/challan_list.php'); }, o);
  });

  it('challan PDF: real PHP ChallanPdfService ↔ Node port (page content streams) in every format', async () => {
    await seedRich(prepare);
    const gen = new ChallanPdfService(h.db, h.env.APP_NAME, h.env.APP_TIMEZONE);
    const cases: [number[], boolean, string][] = [
      [[1], true, 'aggregated'], [[1], false, 'aggregated'], [[2], true, 'order_wise'], [[1, 2], true, 'aggregated'], [[1, 2], false, 'aggregated'],
      [[1, 2], true, 'order_wise'], [[1, 2], false, 'order_wise'], [[1, 2, 3], true, 'delivery'], [[3], true, 'delivery'], [[2, 3], false, 'aggregated'],
    ];
    for (const [ids, withAmount, format] of cases) {
      const label = `${ids.join(',')} amount=${withAmount} ${format}`;
      const dir = mkdtempSync(join(tmpdir(), 'chl-'));
      const phpFile = join(dir, 'php.pdf');
      execFileSync('php', [`${process.env.PARITY_PHP_APP}/challan.php`, phpFile, ids.join(','), withAmount ? '1' : '0', 'CUS-000001', format], {
        env: { ...process.env, UDC_DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', UDC_DB_PORT: process.env.TEST_DB_PORT ?? '3306', UDC_DB_NAME: process.env.TEST_DB_NAME ?? '', UDC_DB_USER: process.env.TEST_DB_USER ?? '', UDC_DB_PASS: process.env.TEST_DB_PASS ?? '' },
      });
      const r = await gen.generate(ids, withAmount, 'CUS-000001', format);
      expect(r.success, label).toBe(true);
      const node = readFileSync(r.file_path!), php = readFileSync(phpFile);
      const a = pdfStreams(node), b = pdfStreams(php);
      expect(a.length, `${label} pages`).toBe(b.length);
      expect(a.join('').length, `${label} has real content`).toBeGreaterThan(900);
      a.forEach((st, i) => expect(st, `${label} page ${i + 1}`).toBe(b[i]));
      expect(pdfFonts(node), label).toEqual(pdfFonts(php));
    }
  });
});
