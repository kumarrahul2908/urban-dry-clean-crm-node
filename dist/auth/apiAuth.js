import { createHash, randomBytes } from 'node:crypto';
import { parseUtcDatetime, utcDatetime } from '../lib/time.js';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/**
 * Port of includes/ApiAuth.php. Same api_tokens table: opaque 64-hex bearer token, only its
 * SHA-256 stored, expires_at in UTC. Tokens issued by the PHP app keep working after cutover.
 */
export class ApiAuth {
    db;
    auth;
    tokenLifetimeDays;
    now;
    constructor(db, auth, tokenLifetimeDays, now = Date.now) {
        this.db = db;
        this.auth = auth;
        this.tokenLifetimeDays = tokenLifetimeDays;
        this.now = now;
    }
    async userContext(user) {
        return {
            id: Number(user.id),
            username: user.username,
            full_name: user.full_name,
            email: user.email ?? null,
            role_id: Number(user.role_id),
            role_name: user.role_name,
            store_id: user.store_id !== null && user.store_id !== undefined ? Number(user.store_id) : null,
            permissions: await this.auth.permissionsForRole(Number(user.role_id)),
        };
    }
    async issueToken(userId, deviceName, deviceId, ip) {
        const raw = randomBytes(32).toString('hex');
        const expiresAt = utcDatetime(this.now() + this.tokenLifetimeDays * 86400_000);
        await this.db.execute('INSERT INTO api_tokens (user_id, token_hash, device_name, device_id, ip_address, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, sha256(raw), deviceName || null, deviceId || null, ip, expiresAt]);
        return { token: raw, expires_at: expiresAt };
    }
    async validateToken(rawToken) {
        if (!rawToken)
            return null;
        const rows = await this.db.query(`SELECT t.id AS token_id, t.expires_at, t.revoked_at, u.*, r.role_name
       FROM api_tokens t JOIN users u ON u.id = t.user_id JOIN roles r ON r.id = u.role_id
       WHERE t.token_hash = ? LIMIT 1`, [sha256(rawToken)]);
        const row = rows[0];
        if (!row)
            return null;
        if (row.revoked_at !== null)
            return null;
        if (parseUtcDatetime(row.expires_at) <= this.now())
            return null;
        if (!row.is_active)
            return null;
        if (row.locked_until && parseUtcDatetime(row.locked_until) > this.now())
            return null;
        try {
            await this.db.execute('UPDATE api_tokens SET last_used_at = NOW() WHERE id = ?', [row.token_id]);
        }
        catch (e) {
            console.error('[mobile-api] failed to stamp api_tokens.last_used_at:', e.message);
        }
        return { ...(await this.userContext(row)), token_id: Number(row.token_id) };
    }
    async revokeToken(rawToken) {
        const r = await this.db.execute('UPDATE api_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL', [sha256(rawToken)]);
        return r.affectedRows > 0;
    }
    async revokeAllForUser(userId) {
        const r = await this.db.execute('UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
        return r.affectedRows;
    }
}
