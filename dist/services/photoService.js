import { getSetting } from './settings.js';
export const ORDER_PHOTOS = 'order_photos';
/**
 * Order-photo retention. A photo's age is time since upload (order_photos.created_at). Deleting removes the
 * file from disk and the row from the database; it cannot be undone. The default (daily job) is 30 days.
 */
export class PhotoService {
    db;
    audit;
    storage;
    envRetentionDays;
    log;
    constructor(db, audit, storage, envRetentionDays, log = console.log) {
        this.db = db;
        this.audit = audit;
        this.storage = storage;
        this.envRetentionDays = envRetentionDays;
        this.log = log;
    }
    /** settings.order_photo_retention_days (set from the CRM) wins over the env default; 0 disables. */
    async retentionDays() {
        const v = await getSetting(this.db, 'order_photo_retention_days', null);
        if (v !== null && /^\d+$/.test(v.trim()))
            return parseInt(v, 10);
        return this.envRetentionDays;
    }
    /** Counts (and optionally deletes) photos older than `days`. Processes in batches so a big backlog is safe. */
    async cleanup(days, opts) {
        const res = { retention_days: days, matched: 0, deleted: 0, missing_files: 0, freed_bytes: 0, dry_run: opts.dryRun, oldest: null };
        if (!Number.isInteger(days) || days < 1)
            return res;
        const cutoff = 'created_at < NOW() - INTERVAL ? DAY';
        const [{ n, oldest }] = (await this.db.query(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM order_photos WHERE ${cutoff}`, [days]));
        res.matched = Number(n);
        res.oldest = oldest;
        let lastId = 0;
        for (;;) {
            const batch = await this.db.query(`SELECT id, file_path FROM order_photos WHERE ${cutoff} AND id > ? ORDER BY id LIMIT 200`, [days, lastId]);
            if (batch.length === 0)
                break;
            for (const p of batch) {
                lastId = Number(p.id);
                const size = await this.storage.sizeOf(ORDER_PHOTOS, p.file_path);
                if (size === null)
                    res.missing_files++;
                else
                    res.freed_bytes += size;
                if (opts.dryRun)
                    continue;
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
    async stats(olderThanDays) {
        const [all] = await this.db.query('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM order_photos');
        let old = null;
        if (olderThanDays !== null && olderThanDays >= 1) {
            old = Number((await this.db.query('SELECT COUNT(*) AS n FROM order_photos WHERE created_at < NOW() - INTERVAL ? DAY', [olderThanDays]))[0].n);
        }
        return { total: Number(all.n), oldest: all.oldest, older_than_days: olderThanDays, older_count: old, retention_days: await this.retentionDays() };
    }
}
