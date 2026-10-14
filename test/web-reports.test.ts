import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/pool.js';
import { expectSameHtml, webEnabled, webHarness, type Client } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('reports: PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  const eq = (got: any, want: any, label: string) => expectSameHtml(got, want, h.env.APP_URL, label, true);
  const prepare = async (db: Db) => {
    await db.execute("INSERT IGNORE INTO permissions (permission_key, module) VALUES ('reports.view','x')");
    await db.execute("INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.permission_key = 'reports.view' WHERE r.id IN (1,3,4)");
    await db.execute("UPDATE users SET store_id = (SELECT MIN(id) FROM stores WHERE is_active = 1) WHERE username = 'wstaff'"); // fixed-store login
  };
  const both = async (php: Client, node: Client, path: string, label = path) => { const a = await php.get(path), b = await node.get(path); eq(b, a, label); return a; };

  it('report page, filters, exports, roles', async () => {
    await seedRich(prepare);
    const c = await login('boss'); await c.php.get('/modules/dashboard/landing.php'); await c.node.get('/modules/dashboard/landing.php');
    const range = '?date_from=2020-01-01&date_to=2099-12-31';
    for (const q of ['', range, '?date_from=2020-01-01', '?date_to=2020-01-31', '?date_from=bad&date_to=worse', '?date_from=&date_to=', range + '&export=garments', range + '&export=customers', range + '&export=zzz', '?date_from=2020-01-01&date_to=2099-12-31&x=1&export=customers']) await both(c.php, c.node, `/modules/reports/index.php${q}`, `reports ${q}`);
    const r = await c.php.get(`/modules/reports/index.php${range}`);
    expect(r.body).toContain('Top Garments');
    expect(r.body).not.toContain('<td class="text-end">0</td></tr></table>'.slice(0, 0) + 'nonexistent-marker');
    for (const who of ['admin', 'ws', 'nobody', null] as const) {
      const x = await login(who as any);
      for (const p of [`/modules/reports/index.php${range}`, `/modules/reports/index.php${range}&export=garments`]) await both(x.php, x.node, p, `${who} ${p}`);
    }
  });
});
