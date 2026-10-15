import { loadEnv } from '../config/env.js';
import { Crypto } from '../lib/crypto.js';
import { datetimeIn } from '../lib/tzFormat.js';
import { WhatsAppService } from '../services/whatsappService.js';
import { forEachBusiness } from '../tenancy/runtime.js';
import { MetaCloudProvider } from '../whatsapp/provider.js';

/** Port of cron/whatsapp_worker.php — run every minute (see docs/DEPLOY.md). In SaaS mode it runs once per active business. */
await forEachBusiness(loadEnv(), async (env, db, label) => {
  const wa = new WhatsAppService(db, new Crypto(env.APP_SECRET_KEY), new MetaCloudProvider(), { appName: env.APP_NAME, timezone: env.APP_TIMEZONE });
  const r = await wa.processQueueBatch(20);
  console.log(`[${datetimeIn(env.APP_TIMEZONE, Date.now())}]${label === 'single' ? '' : ` [${label}]`} WhatsApp queue worker: processed=${r.processed} sent=${r.sent} failed=${r.failed}${r.error ? ` error="${r.error}"` : ''}`);
});
