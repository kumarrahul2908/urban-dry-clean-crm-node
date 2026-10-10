import mysql from 'mysql2/promise';
import type { Env } from '../config/env.js';

/** Minimal DB surface the services depend on (lets tests inject a fake). */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number; insertId: number }>;
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
    namedPlaceholders: false,
  });

  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const [rows] = await pool.query(sql, params);
      return rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const [res] = await pool.query(sql, params);
      const r = res as mysql.ResultSetHeader;
      return { affectedRows: r.affectedRows, insertId: r.insertId };
    },
  };
  return { db, close: () => pool.end() };
}
