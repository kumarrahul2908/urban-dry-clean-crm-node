import type { Db } from '../src/db/pool.js';

export type Handler = (sql: string, params: unknown[]) => unknown[] | { affectedRows: number; insertId: number } | undefined;

/** Fake Db: handlers are matched by regex against the SQL; every call is recorded. */
export function fakeDb(handlers: [RegExp, Handler][]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const find = (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    const h = handlers.find(([re]) => re.test(sql));
    return h ? h[1](sql, params) : undefined;
  };
  const db: Db = {
    async query(sql, params = []) {
      return (find(sql, params) as never[]) ?? [];
    },
    async execute(sql, params = []) {
      const r = find(sql, params);
      return r && !Array.isArray(r) ? r : { affectedRows: 1, insertId: 1 };
    },
    async tx(fn) {
      return fn(db);
    },
  };
  return { db, calls };
}

/** Empties tables on ONE connection with FK checks off (pool.query alone may hop connections). */
export async function resetTables(db: Db, tables: string[]): Promise<void> {
  await db.tx(async (t) => {
    await t.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const tbl of tables) await t.execute(`DELETE FROM ${tbl}`);
    await t.execute('SET FOREIGN_KEY_CHECKS = 1');
  });
}

import { readFileSync } from 'node:fs';

/** Truncates every table and loads test/parity/seed.sql (a small, realistic dataset). */
export async function resetAndSeed(db: Db): Promise<void> {
  const seedSql = readFileSync(new URL('./parity/seed.sql', import.meta.url), 'utf8');
  const tables = (await db.query<{ t: string }>('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = "BASE TABLE"')).map((r) => r.t);
  await db.tx(async (t) => {
    await t.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const tb of tables) await t.execute(`TRUNCATE TABLE \`${tb}\``);
    for (const stmt of seedSql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await t.execute(stmt);
    await t.execute('SET FOREIGN_KEY_CHECKS = 1');
  });
}
