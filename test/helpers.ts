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
