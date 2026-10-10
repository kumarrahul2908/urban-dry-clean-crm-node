import { describe, expect, it } from 'vitest';
import { expectSameHtml, webEnabled, webHarness } from './web/harness.js';

describe.skipIf(!webEnabled)('customers pages: PHP ↔ Node HTML parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string, sortRows = false) => expectSameHtml(got, want, h.env.APP_URL, label, sortRows);

  const prepare = async (db: import('../src/db/pool.js').Db) => {
    await db.execute("INSERT INTO permissions (permission_key, module) VALUES ('customers.create', 'x'), ('customers.edit', 'x')");
    await db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN ('customers.create','customers.edit')");
    await db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 1, id FROM permissions WHERE permission_key IN ('customers.create')"); // admin: create but not edit
    await db.execute("UPDATE customers SET title = 'Mr', address = '5 <b>Rose</b> Lane', area = 'Saket', city = 'Delhi', state = 'DL', pincode = '110017', alt_mobile = '9000000009', barcode = 'UDC-CUST-0001', home_delivery = 1, discount_percent = 12.50, price_list_id = 2 WHERE id = 1");
    await db.execute("UPDATE customers SET title = '', is_active = 0 WHERE id = 2");
    // many customers for pagination (distinct ids → deterministic ORDER BY id DESC)
    const rows: string[] = [];
    for (let i = 0; i < 47; i++) rows.push(`('CX${i}', 'Bulk Person ${i}', '70000${String(i).padStart(5, '0')}', 'Area ${i % 5}')`);
    await db.execute(`INSERT INTO customers (customer_code, full_name, mobile, area) VALUES ${rows.join(',')}`);
    await db.execute('UPDATE orders SET order_date = NOW() - INTERVAL id DAY'); // distinct sort keys (ties are unordered in MariaDB, PHP as much as Node)
    await db.execute("INSERT INTO wallet_transactions (customer_id, txn_type, debit, credit, balance_after, remarks, created_at) VALUES (1, 'Deposit', 0, 500, 500, 'adv <1>', '2026-10-01 05:00:00'), (1, 'Redeem', 120.5, 0, 379.5, NULL, '2026-10-02 08:30:00')");
    await db.execute("INSERT INTO customer_wallet (customer_id, balance) VALUES (1, 379.5) ON DUPLICATE KEY UPDATE balance = 379.5");
  };

  it('list: search, pagination, empty, roles', async () => {
    await seedRich(prepare);
    for (const who of ['admin', 'boss', 'nobody'] as const) {
      const { php, node } = await login(who);
      for (const q of ['', '?q=Vip', '?q=plain&page=1', '?q=zzzzzz', '?page=2', '?page=3', '?page=99', '?page=0', '?page=abc', '?q=Bulk', '?q=Bulk&page=2', '?q=a%26b+c', '?q=%3Cb%3E']) {
        eq(await node.get('/modules/customers/list.php' + q), await php.get('/modules/customers/list.php' + q), `${who}${q}`);
      }
    }
  });

  it('view: full profile, inactive customer, missing id, roles', async () => {
    await seedRich(prepare);
    for (const who of ['admin', 'boss', 'nobody'] as const) {
      const { php, node } = await login(who);
      for (const q of ['?id=1', '?id=2', '?id=3', '?id=999', '?id=0', '']) {
        // rows that tie on every ORDER BY key (two garments of one order) come back in unspecified order: compare rows as sets
        eq(await node.get('/modules/customers/view.php' + q), await php.get('/modules/customers/view.php' + q), `${who}${q}`, true);
      }
    }
  });

  it('add / edit: forms, validation, duplicates, success + resulting rows', async () => {
    await seedRich(prepare);
    const { php, node } = await login('boss');
    for (const p of ['/modules/customers/add.php', '/modules/customers/edit.php?id=1', '/modules/customers/edit.php?id=999']) eq(await node.get(p), await php.get(p), p);
    const nobody = await login('nobody');
    eq(await nobody.node.get('/modules/customers/add.php'), await nobody.php.get('/modules/customers/add.php'), 'add 403');
    const admin = await login('admin');
    eq(await admin.node.get('/modules/customers/edit.php?id=1'), await admin.php.get('/modules/customers/edit.php?id=1'), 'edit 403 for admin');

    const base = { title: 'Mrs', full_name: 'New <Person>', mobile: '9811122233', alt_mobile: '', email: 'n@example.com', membership_id: '', address: 'Addr', area: 'Ar', city: 'Ct', state: 'St', pincode: '110001', birthday: '1990-05-06', anniversary: '', price_list_id: '2', discount_percent: '7.5', communication_preference: 'WhatsApp', registration_source: 'Website', marketing_source: 'fb', referral_code: 'R1', gstin: '', remarks: 'rem', home_delivery: 'on' };
    // Writes: run PHP, roll the database back to the snapshot, run Node — so ids/codes/counters are identical and responses comparable.
    const snap = async () => ({
      maxCustomer: Number((await h.db.query<any>('SELECT COALESCE(MAX(id),0) AS m FROM customers'))[0].m),
      maxAudit: Number((await h.db.query<any>('SELECT COALESCE(MAX(id),0) AS m FROM audit_logs'))[0].m),
      settings: await h.db.query<any>('SELECT * FROM settings'),
      customers: await h.db.query<any>('SELECT * FROM customers'),
    });
    const restore = async (s: Awaited<ReturnType<typeof snap>>) => {
      await h.db.tx(async (t) => {
        await t.execute('SET FOREIGN_KEY_CHECKS = 0');
        await t.execute('DELETE FROM customer_wallet WHERE customer_id > ?', [s.maxCustomer]);
        await t.execute('DELETE FROM customers WHERE id > ?', [s.maxCustomer]);
        await t.execute(`ALTER TABLE customers AUTO_INCREMENT = ${s.maxCustomer + 1}`);
        await t.execute('DELETE FROM audit_logs WHERE id > ?', [s.maxAudit]);
        const keys = s.settings.map((r: any) => r.setting_key);
        await t.execute(`DELETE FROM settings WHERE setting_key NOT IN (${keys.map(() => '?').join(',')})`, keys); // counters created by the write
        for (const r of s.settings) await t.execute('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [r.setting_value, r.setting_key]);
        for (const c of s.customers) {
          const cols = Object.keys(c).filter((k) => k !== 'id' && k !== 'created_at' && k !== 'updated_at');
          await t.execute(`UPDATE customers SET ${cols.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((k) => c[k]), c.id]);
        }
        await t.execute('SET FOREIGN_KEY_CHECKS = 1');
      });
    };
    const write = async (path: string, form: Record<string, string>, label: string, who: 'boss' | 'admin' = 'boss') => {
      const c = await login(who);
      await c.php.get(path); await c.node.get(path);
      const s0 = await snap();
      const a = await c.php.post(path, form);
      const stateA = await h.db.query<any>('SELECT * FROM customers ORDER BY id');
      const auditA = await h.db.query<any>('SELECT user_id, action, module, record_id, old_value, new_value FROM audit_logs WHERE id > ? AND module = "customers" ORDER BY id', [s0.maxAudit]);
      await restore(s0);
      const b = await c.node.post(path, form);
      const stateB = await h.db.query<any>('SELECT * FROM customers ORDER BY id');
      const auditB = await h.db.query<any>('SELECT user_id, action, module, record_id, old_value, new_value FROM audit_logs WHERE id > ? AND module = "customers" ORDER BY id', [s0.maxAudit]);
      eq(b, a, label);
      const strip = (rows: any[]) => rows.map(({ created_at, updated_at, ...r }: any) => r);
      const sa = strip(stateA), sb = strip(stateB);
      const bad = sa.length !== sb.length ? [`row count ${sb.length} vs ${sa.length}`] : sa.flatMap((r: any, i: number) => Object.keys(r).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(sb[i][k])).map((k) => `id ${r.id}.${k}: node=${JSON.stringify(sb[i][k])} php=${JSON.stringify(r[k])}`));
      expect(bad, label).toEqual([]);
      const parseNoTs = (v: string | null) => { if (v === null) return null; try { const o = JSON.parse(v); delete o.updated_at; return o; } catch { return v; } };
      const noTs = (rows: any[]) => rows.map((r) => ({ ...r, old_value: parseNoTs(r.old_value), new_value: parseNoTs(r.new_value) })); // PHP escapes "/" in stored JSON; compare parsed
      const jb = JSON.stringify(noTs(auditB)), ja = JSON.stringify(noTs(auditA));
      if (jb !== ja) { let i = 0; while (jb[i] === ja[i]) i++; throw new Error(`${label}: audit differs\n node ${jb.slice(Math.max(0, i - 150), i + 250)}\n php  ${ja.slice(Math.max(0, i - 150), i + 250)}`); }
      if (a.status === 302) {
        // follow the redirect on both sides (flash shown), then restore again so later steps start from the snapshot
        const loc = a.location!.replace(h.env.APP_URL, '');
        eq(await c.node.get(loc), await c.php.get(loc), `${label} → ${loc}`, true);
      }
      await restore(s0);
      return a;
    };
    await write('/modules/customers/add.php', { ...base, full_name: '', mobile: 'abc' }, 'add: invalid');
    await write('/modules/customers/add.php', { ...base, full_name: 'Vip Cust', mobile: '9999999999' }, 'add: exact duplicate');
    await write('/modules/customers/add.php', { ...base, full_name: 'Vip Custo', mobile: '9999999999' }, 'add: similar name');
    await write('/modules/customers/add.php', { ...base, full_name: 'Vip Custo', mobile: '9999999999', confirm_different_person: 'on' }, 'add: similar name confirmed');
    const ok = await write('/modules/customers/add.php', { ...base, full_name: 'Totally Different', mobile: '9999999999' }, 'add: same mobile other name → warn + save');
    expect(ok.status).toBe(302);
    const ok2 = await write('/modules/customers/add.php', base, 'add: success');
    expect(ok2.status).toBe(302);
    await write('/modules/customers/add.php', { ...base, home_delivery: '' , price_list_id: '', discount_percent: '', birthday: '' }, 'add: blanks → NULL/0');
    await write('/modules/customers/edit.php?id=3', { ...base, full_name: '', mobile: '1' }, 'edit: invalid');
    const e1 = await write('/modules/customers/edit.php?id=3', { ...base, full_name: 'Edited Name', mobile: '9822233344', is_active: 'on' }, 'edit: success');
    expect(e1.status).toBe(302);
    await write('/modules/customers/edit.php?id=3', { ...base, full_name: 'Plain', mobile: '8888888888' }, 'edit: duplicate of customer 2');
    await write('/modules/customers/edit.php?id=1', { ...base, full_name: 'Vip Cust', mobile: '9999999999' }, 'edit: self is excluded from the duplicate check');
  });

  it('customers_check_mobile API + csrf failure', async () => {
    await seedRich(prepare);
    const { php, node } = await login('nobody');
    for (const q of ['', '?mobile=abc', '?mobile=9999999999', '?mobile=9999999999&name=Vip%20Cust', '?mobile=9999999999&name=Other', '?mobile=9999999999&name=Vip%20Cust&exclude_id=1', '?mobile=%2B91%209999-999999&name=x']) {
      eq(await node.get('/api/customers_check_mobile.php' + q), await php.get('/api/customers_check_mobile.php' + q), q);
    }
    const boss = await login('boss');
    eq(await boss.node.post('/modules/customers/add.php', { full_name: 'x' }, { csrf: false }), await boss.php.post('/modules/customers/add.php', { full_name: 'x' }, { csrf: false }), 'csrf');
  });
});

describe.skipIf(!webEnabled)('customers export/import: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string) => expectSameHtml(got, want, h.env.APP_URL, label);
  const prepare = async (db: import('../src/db/pool.js').Db) => {
    await db.execute("INSERT INTO permissions (permission_key, module) VALUES ('customer.export', 'x'), ('customer.import', 'x')");
    await db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 3, id FROM permissions WHERE permission_key IN ('customer.export','customer.import')");
    await db.execute("UPDATE customers SET alt_mobile = '9000000009', email = 'vip@example.com', address = 'A, \"B\"', birthday = '1990-01-02' WHERE id = 1");
    await db.execute("INSERT INTO customer_wallet (customer_id, balance) VALUES (1, 150.25) ON DUPLICATE KEY UPDATE balance = 150.25");
  };

  it('export page + CSV download are byte-identical (filters, audit row)', async () => {
    await seedRich(prepare);
    const { php, node } = await login('boss');
    for (const q of ['', '?status=active', '?status=inactive&price_list_id=2', '?q=vip&date_from=2020-01-01&date_to=2099-01-01', '?status=weird']) {
      eq(await node.get('/modules/customers/export.php' + q), await php.get('/modules/customers/export.php' + q), q);
    }
    const nobody = await login('nobody');
    eq(await nobody.node.get('/modules/customers/export.php'), await nobody.php.get('/modules/customers/export.php'), '403');
    for (const q of ['?export=1', '?export=1&status=active', '?export=1&q=plain', '?export=1&price_list_id=2&date_from=2020-01-01']) {
      const a = await php.get('/modules/customers/export.php' + q), b = await node.get('/modules/customers/export.php' + q);
      expect(b.status).toBe(a.status);
      expect(b.type).toBe('text/csv');
      expect(b.body).toBe(a.body);
    }
    const audits = await h.db.query<any>("SELECT user_id, action, module, record_id, new_value FROM audit_logs WHERE action = 'export' ORDER BY id");
    expect(audits).toHaveLength(8);
    const parse = (r: any) => JSON.parse(r.new_value);
    for (let i = 0; i < 4; i++) expect({ ...audits[2 * i + 1], new_value: parse(audits[2 * i + 1]) }).toEqual({ ...audits[2 * i], new_value: parse(audits[2 * i]) }); // PHP row, then Node row, per request
  });

  it('import: template, upload → mapping → preview → confirm (skip/update/cancel) match PHP', async () => {
    await seedRich(prepare);
    const { php, node } = await login('boss');
    const t1 = await php.get('/modules/customers/import.php?template=1'), t2 = await node.get('/modules/customers/import.php?template=1');
    expect(t2.body).toBe(t1.body);
    eq(await node.get('/modules/customers/import.php'), await php.get('/modules/customers/import.php'), 'upload page');

    const csv = [
      'Customer Code,Name,Mobile,Email,Notes,Company,Price List,Opening Balance,DOB',
      'C1,Vip Cust Renamed,9999999999,,vip note,Acme,,50,1990-05-12',      // code match → duplicate
      'ZZ9,Plain,8888888888,plain2@example.com,,,,,',                       // same mobile+name → duplicate by mobile
      ',,12345,,,,,,',                                                      // name missing + bad mobile
      ',Ghost,9000011111,,,,No Such List,,',                                // unknown price list → error
      ',Quote "Q",91,,"multi, line",,,,',                                   // bad mobile → error (quoting / multi-column parse)
    ].join('\n');
    const base = async (c: typeof php) => {
      await c.get('/modules/customers/import.php');
      const up = await c.upload('/modules/customers/import.php', { step: 'upload' }, { field: 'file', filename: 'c.csv', content: csv });
      const token = /name="import_token" value="([0-9a-f]{32})"/.exec(up.body)?.[1];
      return { up, token: token! };
    };
    const a = await base(php), b = await base(node);
    eq(b.up, a.up, 'mapping page');
    const mapping = (extra: Record<string, string> = {}) => ({ step: 'mapping', 'map[Customer Code]': 'customer_code', 'map[Name]': 'full_name', 'map[Mobile]': 'mobile', 'map[Email]': 'email', 'map[Notes]': 'notes', 'map[Company]': 'company', 'map[Price List]': 'price_list', 'map[Opening Balance]': 'opening_wallet', 'map[DOB]': 'birthday', ...extra });
    const pa = await php.post('/modules/customers/import.php', { ...mapping(), import_token: a.token });
    const pb = await node.post('/modules/customers/import.php', { ...mapping(), import_token: b.token });
    eq(pb, pa, 'preview page');
    expect(pa.body).toContain('Preview Import');

    // cancel on both, then bad token handling
    const ca = await php.post('/modules/customers/import.php', { step: 'cancel', import_token: a.token });
    const cb = await node.post('/modules/customers/import.php', { step: 'cancel', import_token: b.token });
    eq(cb, ca, 'cancel');
    const bad = { step: 'mapping', import_token: 'nope', 'map[Name]': 'full_name' };
    eq(await node.post('/modules/customers/import.php', bad), await php.post('/modules/customers/import.php', bad), 'bad token');
    // not a csv / empty csv
    for (const [name, content] of [['x.txt', 'a,b'], ['e.csv', ''], ['h.csv', 'Name,Mobile\n']] as const) {
      eq(await node.upload('/modules/customers/import.php', { step: 'upload' }, { field: 'file', filename: name, content }), await php.upload('/modules/customers/import.php', { step: 'upload' }, { field: 'file', filename: name, content }), name);
    }
    eq(await node.post('/modules/customers/import.php', { step: 'upload' }), await php.post('/modules/customers/import.php', { step: 'upload' }), 'no file');

    // confirm with skip and with update: identical report + identical rows
    for (const policy of ['skip', 'update']) {
      const snap = { customers: await h.db.query<any>('SELECT * FROM customers ORDER BY id'), wallet: await h.db.query<any>('SELECT * FROM customer_wallet ORDER BY customer_id') };
      const run = async (c: typeof php) => {
        const { token } = await base(c);
        await c.post('/modules/customers/import.php', { ...mapping(), import_token: token });
        const done = await c.post('/modules/customers/import.php', { step: 'confirm', duplicate_policy: policy, import_token: token });
        return done;
      };
      const da = await run(php);
      const stateA = await h.db.query<any>('SELECT id, customer_code, title, full_name, mobile, alt_mobile, email, address, birthday, remarks, price_list_id FROM customers ORDER BY id');
      const auditA = await h.db.query<any>("SELECT action, module, record_id, new_value FROM audit_logs WHERE module = 'customers' AND new_value LIKE '%import%' ORDER BY id");
      await h.db.tx(async (t) => {
        await t.execute('SET FOREIGN_KEY_CHECKS = 0');
        for (const c of snap.customers) { const cols = Object.keys(c).filter((k) => !['id', 'created_at', 'updated_at'].includes(k)); await t.execute(`UPDATE customers SET ${cols.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...cols.map((k) => c[k]), c.id]); }
        await t.execute("DELETE FROM audit_logs WHERE module = 'customers' AND new_value LIKE '%import%'");
        await t.execute('SET FOREIGN_KEY_CHECKS = 1');
      });
      const db_ = await run(node);
      const stateB = await h.db.query<any>('SELECT id, customer_code, title, full_name, mobile, alt_mobile, email, address, birthday, remarks, price_list_id FROM customers ORDER BY id');
      const auditB = await h.db.query<any>("SELECT action, module, record_id, new_value FROM audit_logs WHERE module = 'customers' AND new_value LIKE '%import%' ORDER BY id");
      eq(db_, da, `confirm ${policy}`);
      expect(stateB, policy).toEqual(stateA);
      expect(auditB.map((r: any) => ({ ...r, new_value: JSON.parse(r.new_value) })), policy).toEqual(auditA.map((r: any) => ({ ...r, new_value: JSON.parse(r.new_value) })));
      expect(da.body).toContain(policy === 'update' ? '2 updated' : '2 duplicate(s) skipped');
    }
  });

  it('import that creates customers: Node completes it (PHP 8 aborts — see docs/PARITY.md)', async () => {
    await seedRich(prepare);
    const { php, node } = await login('boss');
    const csv = 'Name,Mobile,Opening Balance,DOB\nBrand New,9123456780,200,1991-02-03\nAnother,9123456781,,\n';
    const flow = async (c: typeof php, policy = 'skip') => {
      const up = await c.upload('/modules/customers/import.php', { step: 'upload' }, { field: 'file', filename: 'n.csv', content: csv });
      const token = /name="import_token" value="([0-9a-f]{32})"/.exec(up.body)![1]!;
      await c.post('/modules/customers/import.php', { step: 'mapping', 'map[Name]': 'full_name', 'map[Mobile]': 'mobile', 'map[Opening Balance]': 'opening_wallet', 'map[DOB]': 'birthday', import_token: token });
      return c.post('/modules/customers/import.php', { step: 'confirm', duplicate_policy: policy, import_token: token });
    };
    const a = await flow(php);
    expect(a.body).toMatch(/Import failed, no changes were made: .*already an active transaction/);   // existing PHP defect
    expect(await h.db.query("SELECT 1 FROM customers WHERE full_name IN ('Brand New','Another')")).toHaveLength(0);
    const b = await flow(node);
    expect(b.body).toContain('2 customer(s) created');
    const rows = await h.db.query<any>("SELECT customer_code, full_name, registration_source, birthday, barcode FROM customers WHERE full_name IN ('Brand New','Another') ORDER BY id");
    expect(rows.map((r: any) => [r.full_name, r.registration_source, r.birthday])).toEqual([['Brand New', 'Import', '1991-02-03'], ['Another', 'Import', null]]);
    expect(rows[0].barcode).toMatch(/^UDC-CUST-/);
    const w = await h.db.query<any>("SELECT cw.balance, wt.txn_type, wt.credit, wt.remarks, wt.payment_mode, wt.created_by FROM customer_wallet cw JOIN customers c ON c.id = cw.customer_id JOIN wallet_transactions wt ON wt.customer_id = c.id WHERE c.full_name = 'Brand New'");
    expect(w).toEqual([{ balance: '200.00', txn_type: 'Deposit', credit: '200.00', remarks: 'Imported opening balance', payment_mode: 'Opening Balance', created_by: 3 }]);
  });
});
