/** Port of includes/audit.php. Never throws: audit failure must not break the main flow. */
export class AuditLog {
    db;
    log;
    constructor(db, log = console.error) {
        this.db = db;
        this.log = log;
    }
    /** Audit writes that join an open transaction (rolled back with it, like the single PDO connection in PHP). */
    using(db) {
        return new AuditLog(db, this.log);
    }
    async record(p) {
        const enc = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : (v ?? null));
        try {
            await this.db.execute('INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)', [p.userId ?? null, p.action, p.module, p.recordId ?? null, enc(p.oldValue), enc(p.newValue), p.ip ?? null]);
        }
        catch (e) {
            this.log(`AuditLog failed: ${e.message}`);
        }
    }
}
