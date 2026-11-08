import { loadEnv } from '../config/env.js';
import { AuditLog } from '../audit/auditLog.js';
import { DatabaseBackupService } from '../services/databaseBackupService.js';
import { forEachBusiness } from '../tenancy/runtime.js';
/** Nightly job (cron / systemd timer): produces the same backup_YYYY-MM-DD_HHmmss.sql.gz files the "Take Backup Now" button on Admin > Backup does. Once per active business in SaaS mode. */
await forEachBusiness(loadEnv(), async (env, db, label) => {
    const tag = label === 'single' ? '' : ` [${label}]`;
    const result = await new DatabaseBackupService(env).run();
    if (result.success) {
        await new AuditLog(db).record({ action: 'create', module: 'backup', recordId: result.file, newValue: { size_bytes: result.size_bytes, trigger: 'cron' }, userId: null, ip: null });
        console.log(`[nightly-backup]${tag} OK: ${result.file} (${result.size_bytes} bytes)`);
    }
    else {
        console.error(`[nightly-backup]${tag} FAILED: ${result.errors.join(' ')}`);
    }
});
