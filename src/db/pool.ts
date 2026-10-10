import mysql from 'mysql2/promise';
import type { Env } from '../config/env.js';

/** Minimal DB surface the services depend on (lets tests inject a fake). */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number; insertId: number }>;
  /** Runs fn on one connection inside BEGIN/COMMIT (ROLLBACK if fn throws). */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export function createPool(env: Env): { db: Db; close: () => Promise<void> } {
  const pool = mysql.createPool({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASS,
    charset: 'utf8mb4',
    // The PHP app stores everything in UTC (MySQL NOW()); keep dates as strings, no TZ shifting.
    timezone: 'Z',
    dateStrings: true,
    connectionLimit: 10,
    // PDO-MySQL semantics: affectedRows = rows actually CHANGED (mysql2 defaults to rows matched).
    flags: ['-FOUND_ROWS'],
    namedPlaceholders: false,
  });

  type Runner = Pick<mysql.Pool, 'query'>;
  const wrap = (runner: Runner, inTx: boolean): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const [rows] = await runner.query(sql, params);
      return rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const [res] = await runner.query(sql, params);
      const r = res as mysql.ResultSetHeader;
      return { affectedRows: r.affectedRows, insertId: r.insertId };
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) return fn(this); // already inside a transaction: join it
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(wrap(conn, true));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    },
  });
  const db = wrap(pool, false);
  return { db, close: () => pool.end() };
}
