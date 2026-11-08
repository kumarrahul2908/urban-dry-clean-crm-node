import { createHash, randomBytes } from 'node:crypto';
const hash = (id) => createHash('sha256').update(id).digest('hex');
/** DB-backed sessions: the cookie holds a random id, the table holds its SHA-256 and the JSON session data. */
export class WebSessionStore {
    db;
    constructor(db) {
        this.db = db;
    }
    newId() { return randomBytes(32).toString('hex'); }
    async load(rawId) {
        if (!/^[0-9a-f]{64}$/.test(rawId))
            return null;
        const rows = await this.db.query('SELECT data FROM web_sessions WHERE id = ?', [hash(rawId)]);
        if (!rows[0])
            return null;
        try {
            return JSON.parse(rows[0].data);
        }
        catch {
            return null;
        }
    }
    async save(rawId, data) {
        await this.db.execute('INSERT INTO web_sessions (id, user_id, data, last_activity) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), data = VALUES(data), last_activity = VALUES(last_activity)', [hash(rawId), data.user_id ?? null, JSON.stringify(data), data.last_activity ?? Math.floor(Date.now() / 1000)]);
    }
    async destroy(rawId) {
        await this.db.execute('DELETE FROM web_sessions WHERE id = ?', [hash(rawId)]);
    }
    /** Housekeeping for a cron: sessions idle for longer than `maxIdleSeconds`. */
    async purge(maxIdleSeconds) {
        return (await this.db.execute('DELETE FROM web_sessions WHERE last_activity < ?', [Math.floor(Date.now() / 1000) - maxIdleSeconds])).affectedRows;
    }
}
