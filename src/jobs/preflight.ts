import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';

/** `npm run preflight` — read-only checks to run on the server BEFORE switching traffic. Exit code 1 if anything is wrong. */
const env = loadEnv();
const { db, close } = createPool(env);
let bad = 0;
const ok = (m: string) => console.log('  ok   ' + m);
const fail = (m: string) => { bad++; console.log('  FAIL ' + m); };
const warn = (m: string) => console.log('  warn ' + m);

const REQUIRED_TABLES = ['users', 'roles', 'permissions', 'role_permissions', 'stores', 'customers', 'orders', 'order_items', 'order_statuses', 'payments', 'payment_transactions', 'garments', 'services',
  'price_lists', 'price_list_items', 'price_list_service_rates', 'barcodes', 'laundry_garments', 'audit_logs', 'settings', 'accounts_receivable', 'wallet_transactions', 'notification_logs', 'notification_templates',
  'whatsapp_accounts', 'whatsapp_outbound_queue', 'order_photos', 'api_tokens', 'web_sessions', 'login_ip_attempts', 'store_print_settings', 'workshops', 'workshop_items'];
const REQUIRED_PERMS = ['dashboard.view', 'pos.create', 'orders.view', 'orders.edit', 'payments.view', 'master.manage', 'users.manage', 'admin.settings', 'reports.view', 'garment_tags.view', 'audit.view'];

try {
  console.log('Environment');
  env.APP_SECRET_KEY && env.APP_SECRET_KEY !== 'REPLACE_WITH_64_CHAR_RANDOM_STRING' ? ok('APP_SECRET_KEY set (must equal the PHP config value — decrypts WhatsApp tokens below)') : fail('APP_SECRET_KEY missing / placeholder');
  env.NODE_ENV === 'production' ? ok('NODE_ENV=production') : warn(`NODE_ENV=${env.NODE_ENV}`);
  /^https:\/\//.test(env.APP_URL) ? ok(`APP_URL ${env.APP_URL}`) : warn(`APP_URL is not https: ${env.APP_URL}`);
  env.TRUST_PROXY ? ok('TRUST_PROXY=true') : warn('TRUST_PROXY is false — behind nginx the client IP (login lockout, audit) will be 127.0.0.1');
  try { await mkdir(env.UPLOAD_DIR, { recursive: true }); await access(env.UPLOAD_DIR, constants.W_OK); ok(`UPLOAD_DIR writable ${env.UPLOAD_DIR}`); } catch { fail(`UPLOAD_DIR not writable: ${env.UPLOAD_DIR}`); }
  try { const s = await stat(new URL('../../public/assets', import.meta.url)); s.isDirectory() ? ok('public/assets present') : fail('public/assets is not a directory'); } catch { fail('public/assets missing (CSS/JS would 404)'); }

  console.log('Database');
  try { const [r] = await db.query<{ v: string; tz: string; now: string }>('SELECT VERSION() AS v, @@session.time_zone AS tz, NOW() AS now'); ok(`connected, ${r!.v}, db time ${r!.now} (session tz ${r!.tz})`); } catch (e) { fail('cannot connect: ' + (e as Error).message); throw e; }
  const have = new Set((await db.query<{ t: string }>('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()')).map((r) => r.t));
  const missing = REQUIRED_TABLES.filter((t) => !have.has(t));
  missing.length ? fail(`missing tables: ${missing.join(', ')} — run \`npm run migrate\` (additive tables) or restore the full schema`) : ok(`${REQUIRED_TABLES.length} required tables present`);
  if (have.has('permissions')) {
    const perms = new Set((await db.query<{ k: string }>('SELECT permission_key AS k FROM permissions')).map((r) => r.k));
    const mp = REQUIRED_PERMS.filter((k) => !perms.has(k));
    mp.length ? warn(`permission keys not in DB (those screens will 403 for everyone): ${mp.join(', ')}`) : ok('core permission keys present');
  }
  if (have.has('users')) {
    const [u] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_active = 1");
    Number(u!.n) > 0 ? ok(`${u!.n} active user(s)`) : fail('no active users');
    const [bc] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE password_hash NOT LIKE '$2y$%' AND password_hash NOT LIKE '$2a$%' AND password_hash NOT LIKE '$2b$%'");
    Number(bc!.n) ? warn(`${bc!.n} user(s) have a non-bcrypt password hash and cannot log in`) : ok('all password hashes are bcrypt');
  }
  if (have.has('whatsapp_accounts')) {
    const { Crypto } = await import('../lib/crypto.js');
    const c = new Crypto(env.APP_SECRET_KEY);
    const rows = await db.query<{ id: number; access_token_encrypted: string }>('SELECT id, access_token_encrypted FROM whatsapp_accounts WHERE is_active = 1');
    let bad2 = 0;
    for (const r of rows) { try { c.decrypt(r.access_token_encrypted); } catch { bad2++; } }
    rows.length === 0 ? ok('no active WhatsApp accounts') : bad2 ? fail(`${bad2}/${rows.length} WhatsApp token(s) cannot be decrypted — APP_SECRET_KEY differs from the PHP one`) : ok(`${rows.length} WhatsApp token(s) decrypt fine`);
  }
  if (have.has('udc_migrations')) {
    const [m] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM udc_migrations'); ok(`migrations recorded: ${m!.n}`);
  } else warn('udc_migrations not present — run `npm run migrate` (use --baseline if the DB already has all migration tables)');
} catch { /* reported above */ } finally {
  await close();
  console.log(bad ? `\nPREFLIGHT FAILED (${bad})` : '\nPREFLIGHT OK');
  process.exitCode = bad ? 1 : 0;
}
