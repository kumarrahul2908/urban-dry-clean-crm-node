import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { Crypto } from '../lib/crypto.js';
import { datetimeIn } from '../lib/tzFormat.js';
import { WhatsAppService } from '../services/whatsappService.js';
import { MetaCloudProvider } from '../whatsapp/provider.js';

/** Port of cron/whatsapp_worker.php — run every minute (see docs/DEPLOY.md). */
const env = loadEnv();
const { db, close } = createPool(env);
try {
  const wa = new WhatsAppService(db, new Crypto(env.APP_SECRET_KEY), new MetaCloudProvider(), { appName: env.APP_NAME, timezone: env.APP_TIMEZONE });
  const r = await wa.processQueueBatch(20);
  console.log(`[${datetimeIn(env.APP_TIMEZONE, Date.now())}] WhatsApp queue worker: processed=${r.processed} sent=${r.sent} failed=${r.failed}${r.error ? ` error="${r.error}"` : ''}`);
} finally {
  await close();
}
