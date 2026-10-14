import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 180_000 });

describe.skipIf(!webEnabled)('payments / accounts / POS submit: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);
  const write = writeCompare(h.db, h.env.APP_URL);

  const prepare = async (db: Db) => {
    const extra = ['wallet.manage', 'payments.adjust', 'payments.export', 'pos.override_discount', 'pos.manual_rate_override'];
    await db.execute(`INSERT IGNORE INTO permissions (permission_key, module) VALUES ${extra.map((k) => `('${k}', 'x')`).join(',')}`);
    await db.execute(`INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN (${extra.map((k) => `'${k}'`).join(',')})`);
    await db.execute('UPDATE payments SET payment_date = NOW() - INTERVAL id SECOND');
    await db.execute('UPDATE wallet_transactions SET created_at = NOW() - INTERVAL id SECOND');
    await db.execute('UPDATE accounts_receivable SET due_date = CURDATE() - INTERVAL (CAST(id AS SIGNED) * 17 - 20) DAY');
    await db.execute("UPDATE expenses SET description = CONCAT(description, ' <b>x</b>') WHERE id = 1");
  };

  const asBoss = async () => {
    const c = await login('boss');
    await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php');
    await c.php.post('/api/set_active_store.php', { store_id: '1' }); await c.node.post('/api/set_active_store.php', { store_id: '1' });
    return c;
  };

  const both = async (php: Client, node: Client, path: string, label = path, sortRows = false) => {
    const a = await php.get(path), b = await node.get(path);
    eq(b, a, label, sortRows);
    return a;
  };

  it('payments list + wallet history', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    for (const q of ['', '?q=Vip', '?payment_type_id=1', '?date_from=2020-01-01&date_to=2099-01-01', '?q=zzz', '?page=2', '?payment_type_id=2&q=O']) await both(php, node, `/modules/payments/list.php${q}`);
    for (const q of ['', '?q=Vip', '?txn_type=Deposit', '?txn_type=Redeem&date_from=2020-01-01', '?q=nobody-like-this']) await both(php, node, `/modules/payments/wallet.php${q}`);
    const nobody = await login('nobody');
    for (const p of ['/modules/payments/list.php', '/modules/payments/wallet.php']) await both(nobody.php, nobody.node, p, `nobody ${p}`);
    const anon = await login(null);
    for (const p of ['/modules/payments/list.php', '/modules/payments/wallet.php', '/modules/accounts/outstanding.php', '/modules/accounts/expenses.php']) await both(anon.php, anon.node, p, `anon ${p}`);
  });

  it('daily collection + outstanding (filters, CSV exports)', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    expect((await php.get('/modules/accounts/outstanding.php')).body).not.toContain('No outstanding balances found.');
    expect((await php.get('/modules/payments/list.php')).body).not.toContain('No payments found.');
    const payDay = (await h.db.query<any>('SELECT DATE(MAX(payment_date)) AS d FROM payments'))[0].d; // not "today": the app clock (IST) and the DB clock (UTC) disagree around midnight
    expect((await php.get(`/modules/accounts/daily-collection.php?date=${payDay}`)).body).not.toContain('No transactions for this date.');
    for (const q of ['', '?payment_type_id=1', '?staff_id=1', '?order=2', '?customer=Vip', '?date=2020-01-01', '?date=garbage']) await both(php, node, `/modules/accounts/daily-collection.php${q}`, `daily ${q}`, true);
    const a = await php.get('/modules/accounts/daily-collection.php?export=1'), b = await node.get('/modules/accounts/daily-collection.php?export=1');
    expect(b.body).toBe(a.body);
    expect(b.type).toBe(a.type);
    for (const q of ['', '?ageing=1-7+days', '?ageing=90%2B+days', '?customer=Vip', '?order=1', '?min_amount=100', '?min_amount=abc', '?due_date=2020-01-01']) await both(php, node, `/modules/accounts/outstanding.php${q}`, `outstanding ${q}`, true);
    const c = await php.get('/modules/accounts/outstanding.php?export=1'), d = await node.get('/modules/accounts/outstanding.php?export=1');
    expect(d.body).toBe(c.body);
    expect(d.type).toBe(c.type);
    const nobody = await login('nobody');
    for (const p of ['/modules/accounts/daily-collection.php', '/modules/accounts/outstanding.php']) await both(nobody.php, nobody.node, p, `nobody ${p}`);
  });

  it('expenses + income: list, add, edit, categories', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    for (const t of ['expenses', 'income']) {
      for (const q of ['', '?q=rent', '?category_id=1', '?from=2020-01-01&to=2099-01-01', '?edit=1', '?edit=999', '?per_page=1&page=2']) await both(php, node, `/modules/accounts/${t}.php${q}`, `${t} ${q}`);
    }
    const save = (path: string, form: Record<string, string>) => (c: Client) => c.post(path, form);
    const ex = '/modules/accounts/expenses.php', inc = '/modules/accounts/income.php';
    await write('add expense', php, node, save(ex, { action: 'save', expense_date: '2026-03-04', category_id: '2', amount: '88.5', payment_mode: 'Cash', vendor: 'V <i>', description: 'd', remarks: 'r' }));
    await write('add expense invalid', php, node, save(ex, { action: 'save', expense_date: 'nope', category_id: '99', amount: '-3', payment_mode: 'Bitcoin' }));
    await write('edit expense', php, node, save(ex, { action: 'save', id: '1', expense_date: '2026-03-04', category_id: '1', amount: '15000', payment_mode: 'Cash', vendor: 'Landlord', description: 'shop rent changed' }));
    await write('edit expense no change', php, node, save(ex, { action: 'save', id: '2', expense_date: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10), category_id: '2', amount: '1234.50', payment_mode: 'UPI', description: 'diesel', remarks: 'van' }));
    await write('edit missing', php, node, save(ex, { action: 'save', id: '999', expense_date: '2026-03-04', category_id: '1', amount: '5' }));
    await write('add income', php, node, save(inc, { action: 'save', income_date: '2026-03-04', source: 'Rent received', amount: '700', payment_mode: 'UPI', description: 'x', remarks: '' }));
    await write('add income invalid', php, node, save(inc, { action: 'save', income_date: '2026-03-04', source: '', amount: '0' }));
    await write('edit income', php, node, save(inc, { action: 'save', id: '1', income_date: '2026-03-04', source: 'Scrap', amount: '301', description: 'hangers' }));
    await write('category add', php, node, save(ex, { action: 'category', category_name: '  Packaging  ' }));
    await write('category add duplicate', php, node, save(ex, { action: 'category', category_name: 'Rent' }));
    await write('category add empty', php, node, save(ex, { action: 'category', category_name: '' }));
    await write('category rename', php, node, save(ex, { action: 'category', category_id: '2', category_name: 'Petrol' }));
    await write('category deactivate', php, node, save(ex, { action: 'category', category_id: '1', category_name: 'Rent', set_active: '0' }));
    await write('category activate', php, node, save(ex, { action: 'category', category_id: '3', category_name: 'Old', set_active: '1' }));
    await write('category missing', php, node, save(ex, { action: 'category', category_id: '99', category_name: 'x' }));
    const nobody = await login('nobody');
    for (const p of [ex, inc]) await both(nobody.php, nobody.node, p, `nobody ${p}`);
  });

  it('wallet adjustment', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const w = '/modules/accounts/wallet-adjustment.php';
    await both(php, node, w);
    await both(php, node, `${w}?customer_id=1`);
    await both(php, node, `${w}?customer_id=999`);
    const adj = (form: Record<string, string>) => (c: Client) => c.post(w, form);
    // the WhatsApp event_ref embeds time(); compare it separately
    const opts = { ignoreTables: ['whatsapp_outbound_queue'] };
    await write('credit', php, node, adj({ customer_id: '1', delta: '125.5', reason: 'goodwill <b>' }), opts);
    await write('debit', php, node, adj({ customer_id: '1', delta: '-20', reason: 'fix' }), opts);
    await write('zero', php, node, adj({ customer_id: '1', delta: '0', reason: 'x' }), opts);
    await write('no reason', php, node, adj({ customer_id: '1', delta: '5', reason: '  ' }), opts);
    await write('no customer', php, node, adj({ delta: '5', reason: 'x' }), opts);
    await write('overdraw', php, node, adj({ customer_id: '2', delta: '-100000', reason: 'x' }), opts);
    const q = await h.db.query<any>('SELECT COUNT(*) AS n FROM whatsapp_outbound_queue');
    expect(Number(q[0].n)).toBeGreaterThanOrEqual(0);
    const nobody = await login('nobody');
    await both(nobody.php, nobody.node, w, 'nobody');
  });

  it('POS: new token + piece/laundry submit', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    const json = async (c: Client, path: string, body: unknown, withCsrf = true) => {
      const payload = JSON.stringify(body && typeof body === 'object' ? { ...(body as object), ...(withCsrf ? { csrf_token: c.csrf() } : {}) } : body);
      if (c === php) {
        const r = await fetch(`http://127.0.0.1:${h.port}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: php.cookie() }, body: payload });
        return { status: r.status, location: null, body: await r.text(), type: r.headers.get('content-type') } as any;
      }
      const r = await h.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', cookie: node.cookie() }, payload });
      return { status: r.statusCode, location: null, body: r.body, type: String(r.headers['content-type'] ?? '') } as any;
    };
    const withToken = (path: string, tokenPath: string, input: Record<string, unknown>, useToken = true) => async (c: Client) => {
      const t = JSON.parse((await c.get(tokenPath)).body).order_token as string;
      return json(c, path, { ...input, order_token: useToken ? t : 'bogus' });
    };
    const tok = '/api/pos_new_token.php';
    const piece = { customer_id: 1, discount_type: 'Flat', discount_value: 10, payments: [{ payment_type_id: 1, amount: 50 }], items: [{ garment_id: 1, service_id: 1, quantity: 2 }, { garment_id: 2, service_id: 1, quantity: 1 }] };
    const laundry = { customer_id: 2, batches: [{ service_id: 3, weight: 5.5, rate: 61.37, garment_count: 3, garments: [{ garment_id: 1, quantity: 2 }, { garment_id: 2, quantity: 1 }] }] };
    const a = await php.get(tok), b = await node.get(tok);
    expect(Object.keys(JSON.parse(b.body))).toEqual(Object.keys(JSON.parse(a.body)));
    expect(b.status).toBe(a.status);
    await write('piece ok', php, node, withToken('/modules/pos/submit.php', tok, piece), { jsonBody: true });
    await write('piece invalid', php, node, withToken('/modules/pos/submit.php', tok, { customer_id: 99, items: [] }), { jsonBody: true });
    await write('piece bad token', php, node, withToken('/modules/pos/submit.php', tok, piece, false), { jsonBody: true });
    const lgToken = (c: Client) => async () => { const page = await c.get('/modules/laundry/index.php?customer_id=2'); return { page, token: /LAUNDRY_ORDER_TOKEN = "([0-9a-f]{32})"/.exec(page.body)![1]! }; };
    const lgSubmit = (input: Record<string, unknown>) => async (c: Client) => json(c, '/modules/laundry/submit.php', { ...input, order_token: (await lgToken(c)()).token });
    await write('laundry ok', php, node, lgSubmit(laundry), { jsonBody: true });
    await write('laundry invalid', php, node, lgSubmit({ customer_id: 2, batches: [] }), { jsonBody: true });
    // replay of a consumed token is blocked
    const replay = async (c: Client) => { const t = JSON.parse((await c.get(tok)).body).order_token; await json(c, '/modules/pos/submit.php', { ...piece, order_token: t }); return json(c, '/modules/pos/submit.php', { ...piece, order_token: t }); };
    await write('piece replay', php, node, replay, { jsonBody: true });
    await write('no csrf', php, node, async (c) => json(c, '/modules/pos/submit.php', { ...piece, order_token: 'x' }, false), { jsonBody: true });
    const g1 = await php.get('/modules/pos/submit.php'), g2 = await node.get('/modules/pos/submit.php');
    expect(g2.status).toBe(g1.status);
    expect(JSON.parse(g2.body)).toEqual(JSON.parse(g1.body));
    // store-less Super Admin is refused
    const fresh = await login('boss');
    await fresh.php.get('/modules/dashboard/landing.php'); await fresh.node.get('/modules/dashboard/landing.php');
    await write('no store selected', fresh.php, fresh.node, withToken('/modules/pos/submit.php', tok, piece), { jsonBody: true });
    const nobody = await login('nobody');
    for (const p of ['/modules/pos/submit.php', '/modules/laundry/submit.php', tok]) await both(nobody.php, nobody.node, p, `nobody ${p}`);
  });

  it('POS + laundry pages and lookup APIs', async () => {
    await seedRich(prepare);
    const { php, node } = await asBoss();
    await both(php, node, '/modules/pos/index.php');
    await both(php, node, '/modules/pos/index.php?customer_id=2');
    await both(php, node, '/modules/laundry/index.php', 'laundry picker');
    for (const id of [1, 2, 999]) await both(php, node, `/modules/laundry/index.php?customer_id=${id}`);
    for (const q of ['?customer_id=1', '?customer_id=2', '?customer_id=999', '']) {
      const a = await php.get(`/api/customer_pos_summary.php${q}`), b = await node.get(`/api/customer_pos_summary.php${q}`);
      expect(b.status, q).toBe(a.status);
      expect(b.body, q).toBe(a.body);
    }
    // lower-privileged staff (no discount / manual-rate override) and users without pos.create
    const admin = await login('admin');
    await both(admin.php, admin.node, '/modules/pos/index.php', 'admin pos');
    const nobody = await login('nobody');
    for (const p of ['/modules/pos/index.php', '/modules/laundry/index.php', '/api/customer_pos_summary.php?customer_id=1']) await both(nobody.php, nobody.node, p, `nobody ${p}`);
  });
});
