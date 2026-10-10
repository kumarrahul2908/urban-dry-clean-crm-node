import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { Crypto } from '../lib/crypto.js';
import { todayIn } from '../lib/dates.js';
import { CustomerSegments } from '../services/customerSegments.js';
import { getSetting } from '../services/settings.js';
import { WhatsAppService } from '../services/whatsappService.js';
import { MetaCloudProvider } from '../whatsapp/provider.js';

/** Port of cron/whatsapp_marketing_automation.php — run once a day. Idempotent per rule/customer/day via event_ref. */
const env = loadEnv();
const { db, close } = createPool(env);
try {
  const today = todayIn(env.APP_TIMEZONE);
  let rules: Record<string, any>[];
  try {
    rules = await db.query('SELECT * FROM whatsapp_marketing_rules WHERE is_active = 1');
  } catch {
    console.log(`[${today}] Marketing automation: whatsapp_marketing_rules table does not exist yet — nothing to run.`);
    rules = [];
    await close();
    process.exit(0);
  }
  const wa = new WhatsAppService(db, new Crypto(env.APP_SECRET_KEY), new MetaCloudProvider(), { appName: env.APP_NAME, timezone: env.APP_TIMEZONE });
  const segments = new CustomerSegments(db);
  let queued = 0, skipped = 0;
  for (const rule of rules) {
    const tpl = (await db.query<Record<string, any>>("SELECT * FROM notification_templates WHERE id = ? AND channel='WhatsApp' AND is_active=1", [rule.template_id]))[0];
    if (!tpl) continue; // inactive/deleted template — skip silently
    const recipients = await segments.resolve(rule.segment_key, rule.store_id ? Number(rule.store_id) : null);
    for (const r of recipients) {
      const vars = { customer_name: r.full_name, business_name: await getSetting(db, 'business_name', env.APP_NAME) };
      const res = await wa.enqueue(Number(r.id), null, r.mobile, tpl.template_key, vars, `marketing:${rule.id}:${r.id}:${today}`);
      if (res.success && !res.duplicate) queued++; else skipped++;
    }
  }
  console.log(`[${today}] Marketing automation: ${queued} queued, ${skipped} skipped (already sent today or ineligible), ${rules.length} active rule(s).`);
} finally {
  await close();
}
