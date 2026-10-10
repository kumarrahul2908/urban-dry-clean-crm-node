import { describe, expect, it } from 'vitest';
import { expectSameHtml, webEnabled, webHarness } from './web/harness.js';

/** The shared fixture has equal counts for two services (a tie PHP and Node may legitimately order differently): add one more Steam Press line. */
async function breakTies(db: import('../src/db/pool.js').Db) {
  await db.tx(async (t) => { // temp tables are per connection
    await t.execute('DROP TEMPORARY TABLE IF EXISTS tmp_oi');
    await t.execute('CREATE TEMPORARY TABLE tmp_oi AS SELECT * FROM order_items WHERE service_id = 2 LIMIT 1');
    await t.execute('UPDATE tmp_oi SET id = 0');
    await t.execute('INSERT INTO order_items SELECT * FROM tmp_oi');
    await t.execute('DROP TEMPORARY TABLE tmp_oi');
  });
}

describe.skipIf(!webEnabled)('dashboard: PHP ↔ Node HTML parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string) => expectSameHtml(got, want, h.env.APP_URL, label);

  it('business dashboard for each role (fixed store, all stores, workshop staff, no permission)', async () => {
    await seedRich(breakTies);
    for (const who of ['admin', 'boss', 'ws', 'orphan', 'nobody'] as const) {
      const { php, node } = await login(who);
      const a = await php.get('/modules/dashboard/index.php');
      const b = await node.get('/modules/dashboard/index.php');
      eq(b, a, who);
      expect(a.status).toBe(who === 'nobody' ? 403 : 200);
    }
  });

  it('with overdue + due-today + due-tomorrow data and an empty database', async () => {
    await seedRich(async (db) => {
      await breakTies(db);
      await db.execute("UPDATE orders SET due_date = CURDATE() WHERE id IN (2, 3)");
      await db.execute("UPDATE orders SET due_date = CURDATE() + INTERVAL 1 DAY, due_time = '10:15:00' WHERE id IN (4, 5)");
      await db.execute("UPDATE orders SET due_date = CURDATE() - INTERVAL 3 DAY WHERE id = 1");
      await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (9, 1, 'Zed <Store>', 'branch', 1) ON DUPLICATE KEY UPDATE store_name = VALUES(store_name)");
      await db.execute("UPDATE orders SET store_id = 9 WHERE id = 3");
    });
    for (const who of ['admin', 'boss', 'ws'] as const) {
      const { php, node } = await login(who);
      eq(await node.get('/modules/dashboard/index.php'), await php.get('/modules/dashboard/index.php'), who);
    }
    await h.db.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['order_items', 'orders', 'laundry_garments', 'payments', 'accounts_receivable', 'workshop_items']) await h.db.execute(`DELETE FROM ${t}`);
    await h.db.execute('SET FOREIGN_KEY_CHECKS = 1');
    const { php, node } = await login('boss');
    eq(await node.get('/modules/dashboard/index.php'), await php.get('/modules/dashboard/index.php'), 'empty db');
  });
});

describe.skipIf(!webEnabled)('daily dashboard: PHP ↔ Node HTML parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string) => expectSameHtml(got, want, h.env.APP_URL, label);

  it('every role, several dates, bad dates, workshop staff redirect', async () => {
    await seedRich(async (db) => {
      // distinct sort keys everywhere: MariaDB returns rows that tie on every ORDER BY key in unspecified order, PHP as much as Node
      await db.execute("UPDATE orders SET due_date = CURDATE() WHERE id IN (1, 2)");
      await db.execute("UPDATE orders SET due_date = CURDATE() - INTERVAL 1 DAY WHERE id = 3");
      await db.execute("UPDATE orders SET due_date = CURDATE() + INTERVAL 2 DAY WHERE id = 4");
      await db.execute("UPDATE orders SET due_date = CURDATE() + INTERVAL 3 DAY WHERE id = 5");
      await db.execute("UPDATE order_items SET item_status = 'Ready' WHERE order_id = 2");
      await db.execute("UPDATE orders SET urgent_level_id = 1, due_time = '14:30:00' WHERE id = 1");
      await db.execute("UPDATE orders SET urgent_level_id = 1, due_time = '15:45:00' WHERE id = 2");
      await db.execute("INSERT INTO pickup_orders (pickup_number, customer_id, address, pickup_date, pickup_time, garment_count, status) VALUES ('PX1', 2, 'Addr <1>', CURDATE(), '09:30:00', NULL, 'Scheduled'), ('PX2', 1, 'Addr 2', CURDATE(), '08:15:00', 4, 'Requested')");
      await db.execute("UPDATE customers SET birthday = DATE_FORMAT(CURDATE() + INTERVAL 3 DAY, '1990-%m-%d'), anniversary = DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '2015-%m-%d') WHERE id = 2");
    });
    const d = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    for (const who of ['admin', 'boss', 'ws', 'nobody'] as const) {
      const { php, node } = await login(who);
      for (const q of ['', `?date=${d(0)}`, `?date=${d(1)}`, `?date=${d(-2)}`, '?date=garbage', '?date=2026-02-31', '?date=2000-01-01']) {
        eq(await node.get('/modules/daily_dashboard/index.php' + q), await php.get('/modules/daily_dashboard/index.php' + q), `${who}${q}`);
      }
    }
  });
});
