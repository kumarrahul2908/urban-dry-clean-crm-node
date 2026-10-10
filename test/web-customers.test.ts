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
