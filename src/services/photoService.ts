import type { Db } from '../db/pool.js';
import type { AuditLog } from '../audit/auditLog.js';
import type { LocalDiskStorage } from '../storage/localDisk.js';
import { getSetting } from './settings.js';

export const ORDER_PHOTOS = 'order_photos';

export interface CleanupResult { retention_days: number; matched: number; deleted: number; missing_files: number; freed_bytes: number; dry_run: boolean; oldest: string | null }

/**
 * Order-photo retention. A photo's age is time since upload (order_photos.created_at). Deleting removes the
 * file from disk and the row from the database; it cannot be undone. The default (daily job) is 30 days.
 */
export class PhotoService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly storage: LocalDiskStorage,
    private readonly envRetentionDays: number,
    private readonly log: (m: string) => void = console.log,
  ) {}

  /** settings.order_photo_retention_days (set from the CRM) wins over the env default; 0 disables. */
  async retentionDays(): Promise<number> {
    const v = await getSetting(this.db, 'order_photo_retention_days', null);
    if (v !== null && /^\d+$/.test(v.trim())) return parseInt(v, 10);
    return this.envRetentionDays;
  }

  /** Counts (and optionally deletes) photos older than `days`. Processes in batches so a big backlog is safe. */
  async cleanup(days: number, opts: { dryRun: boolean; userId?: number | null; ip?: string | null; source: 'job' | 'api' }): Promise<CleanupResult> {
    const res: CleanupResult = { retention_days: days, matched: 0, deleted: 0, missing_files: 0, freed_bytes: 0, dry_run: opts.dryRun, oldest: null };
    if (!Number.isInteger(days) || days < 1) return res;
    const cutoff = 'created_at < NOW() - INTERVAL ? DAY';
    const [{ n, oldest }] = (await this.db.query<{ n: number; oldest: string | null }>(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM order_photos WHERE ${cutoff}`, [days])) as [{ n: number; oldest: string | null }];
    res.matched = Number(n);
    res.oldest = oldest;

    let lastId = 0;
    for (;;) {
      const batch = await this.db.query<{ id: number; file_path: string }>(
        `SELECT id, file_path FROM order_photos WHERE ${cutoff} AND id > ? ORDER BY id LIMIT 200`, [days, lastId]);
      if (batch.length === 0) break;
      for (const p of batch) {
        lastId = Number(p.id);
        const size = await this.storage.sizeOf(ORDER_PHOTOS, p.file_path);
        if (size === null) res.missing_files++;
        else res.freed_bytes += size;
        if (opts.dryRun) continue;
        // Row first, file second: a crash in between leaves an orphan file, never a row pointing at nothing.
        await this.db.execute('DELETE FROM order_photos WHERE id = ?', [p.id]);
        await this.storage.remove(ORDER_PHOTOS, p.file_path);
        res.deleted++;
      }
    }
    if (!opts.dryRun && res.deleted > 0) {
      await this.audit.record({
        action: 'delete', module: 'order_photos', recordId: `retention:${days}d`,
        newValue: { source: opts.source, older_than_days: days, deleted: res.deleted, freed_bytes: res.freed_bytes }, userId: opts.userId ?? null, ip: opts.ip ?? null,
      });
    }
    this.log(`[photo-cleanup] ${opts.dryRun ? 'dry-run' : 'deleted'}: matched=${res.matched} deleted=${res.deleted} freed=${res.freed_bytes}B (older than ${days}d)`);
    return res;
  }

  async stats(olderThanDays: number | null) {
    const [all] = await this.db.query<{ n: number; oldest: string | null }>('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM order_photos');
    let old: number | null = null;
    if (olderThanDays !== null && olderThanDays >= 1) {
      old = Number((await this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM order_photos WHERE created_at < NOW() - INTERVAL ? DAY', [olderThanDays]))[0]!.n);
    }
    return { total: Number(all!.n), oldest: all!.oldest, older_than_days: olderThanDays, older_count: old, retention_days: await this.retentionDays() };
  }
}
