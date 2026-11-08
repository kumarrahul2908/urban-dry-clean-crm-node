import { loadEnv } from '../config/env.js';
import { AuditLog } from '../audit/auditLog.js';
import { LocalDiskStorage } from '../storage/localDisk.js';
import { PhotoService } from '../services/photoService.js';
import { forEachBusiness } from '../tenancy/runtime.js';
/** Daily job (cron / systemd timer): deletes order photos older than the retention period. Once per active business in SaaS mode. */
await forEachBusiness(loadEnv(), async (env, db, label) => {
    const photos = new PhotoService(db, new AuditLog(db), new LocalDiskStorage(env.UPLOAD_DIR, env.APP_URL), env.PHOTO_RETENTION_DAYS);
    const days = await photos.retentionDays();
    if (days < 1) {
        console.log(`[photo-cleanup]${label === 'single' ? '' : ` [${label}]`} retention disabled (0) — nothing to do`);
    }
    else {
        await photos.cleanup(days, { dryRun: false, source: 'job' });
    }
});
