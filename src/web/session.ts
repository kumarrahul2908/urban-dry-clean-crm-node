import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.js';

export interface SessionUser { id: number; full_name: string; username: string; role_id: number; role_name: string; store_id: number | null }
export interface SessionData {
  user_id?: number;
  user?: SessionUser;
  permissions?: string[];
  last_activity?: number;
  csrf_token?: string;
  flash?: { type: string; message: string }[];
  active_store_id?: number;
  [k: string]: unknown;
}

const hash = (id: string) => createHash('sha256').update(id).digest('hex');

/** DB-backed sessions: the cookie holds a random id, the table holds its SHA-256 and the JSON session data. */
export class WebSessionStore {
  constructor(private readonly db: Db) {}

  newId(): string { return randomBytes(32).toString('hex'); }

  async load(rawId: string): Promise<SessionData | null> {
    if (!/^[0-9a-f]{64}$/.test(rawId)) return null;
    const rows = await this.db.query<{ data: string }>('SELECT data FROM web_sessions WHERE id = ?', [hash(rawId)]);
    if (!rows[0]) return null;
    try { return JSON.parse(rows[0].data) as SessionData; } catch { return null; }
  }

  async save(rawId: string, data: SessionData): Promise<void> {
    await this.db.execute(
      'INSERT INTO web_sessions (id, user_id, data, last_activity) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), data = VALUES(data), last_activity = VALUES(last_activity)',
      [hash(rawId), data.user_id ?? null, JSON.stringify(data), data.last_activity ?? Math.floor(Date.now() / 1000)],
    );
  }

  async destroy(rawId: string): Promise<void> {
    await this.db.execute('DELETE FROM web_sessions WHERE id = ?', [hash(rawId)]);
  }

  /** Housekeeping for a cron: sessions idle for longer than `maxIdleSeconds`. */
  async purge(maxIdleSeconds: number): Promise<number> {
    return (await this.db.execute('DELETE FROM web_sessions WHERE last_activity < ?', [Math.floor(Date.now() / 1000) - maxIdleSeconds])).affectedRows;
  }
}
