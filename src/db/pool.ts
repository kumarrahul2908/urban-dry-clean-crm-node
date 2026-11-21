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
    // Dates stay strings (no JS-side TZ shifting). The PHP app now pins every connection's MySQL
    // SESSION time zone to IST (config/database.php, 21 Nov 2026), so NOW()/CURRENT_TIMESTAMP
    // store IST -- the 'connection' hook below does the same here.
    timezone: 'Z',
    dateStrings: true,
    connectionLimit: 10,
    // PDO-MySQL semantics: affectedRows = rows actually CHANGED (mysql2 defaults to rows matched).
    flags: ['-FOUND_ROWS'],
    namedPlaceholders: false,
  });

  // Rahul: "Indian time dikhana chahiye" -- the MySQL server runs on the OS's SYSTEM timezone (UTC),
  // so every CURRENT_TIMESTAMP/NOW() default silently stored UTC, ~5:30 behind real IST. PHP now
  // sets the SESSION time zone to IST at its single shared connection point; mirrored here.
  pool.pool.on('connection', (conn) => { conn.query("SET time_zone = '+05:30'"); });

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
