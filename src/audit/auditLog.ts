import type { Db } from '../db/pool.js';

/** Port of includes/audit.php. Never throws: audit failure must not break the main flow. */
export class AuditLog {
  constructor(private readonly db: Db, private readonly log: (msg: string) => void = console.error) {}

  async record(p: {
    action: string;
    module: string;
    recordId?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    userId?: number | null;
    ip?: string | null;
  }): Promise<void> {
    const enc = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : (v ?? null));
    try {
      await this.db.execute(
        'INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [p.userId ?? null, p.action, p.module, p.recordId ?? null, enc(p.oldValue), enc(p.newValue), p.ip ?? null],
      );
    } catch (e) {
      this.log(`AuditLog failed: ${(e as Error).message}`);
    }
  }
}
