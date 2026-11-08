/**
 * Port of includes/LoginRateLimiter.php (Master A4). Same table (login_ip_attempts), same
 * atomic upsert. Fail-open: a broken limiter must never lock every user out.
 */
export class LoginRateLimiter {
    db;
    lockoutMinutes;
    log;
    static FAILED_THRESHOLD = 20;
    static WINDOW_MINUTES = 15;
    constructor(db, lockoutMinutes, log = console.error) {
        this.db = db;
        this.lockoutMinutes = lockoutMinutes;
        this.log = log;
    }
    normalize(ip) {
        return ip ? ip.slice(0, 45) : null;
    }
    async blockedMinutesRemaining(rawIp) {
        const ip = this.normalize(rawIp);
        if (!ip)
            return null;
        try {
            const rows = await this.db.query('SELECT TIMESTAMPDIFF(SECOND, NOW(), blocked_until) AS s FROM login_ip_attempts WHERE ip_address = ? AND blocked_until IS NOT NULL AND blocked_until > NOW()', [ip]);
            const row = rows[0];
            return row ? Math.max(1, Math.ceil(Number(row.s) / 60)) : null;
        }
        catch (e) {
            this.log(`[login-rate-limit] check failed (allowing login): ${e.message}`);
            return null;
        }
    }
    async recordFailure(rawIp) {
        const ip = this.normalize(rawIp);
        if (!ip)
            return;
        const w = LoginRateLimiter.WINDOW_MINUTES;
        const t = LoginRateLimiter.FAILED_THRESHOLD;
        const b = Math.max(1, this.lockoutMinutes);
        try {
            // Assignments run left to right in ON DUPLICATE KEY UPDATE; see the PHP original.
            await this.db.execute(`INSERT INTO login_ip_attempts (ip_address, window_start, failed_count, blocked_until)
         VALUES (?, NOW(), 1, NULL)
         ON DUPLICATE KEY UPDATE
           failed_count  = IF(window_start < NOW() - INTERVAL ${w} MINUTE, 1, failed_count + 1),
           window_start  = IF(window_start < NOW() - INTERVAL ${w} MINUTE, NOW(), window_start),
           blocked_until = IF(failed_count >= ${t}, NOW() + INTERVAL ${b} MINUTE, blocked_until)`, [ip]);
        }
        catch (e) {
            this.log(`[login-rate-limit] record failed: ${e.message}`);
        }
    }
}
