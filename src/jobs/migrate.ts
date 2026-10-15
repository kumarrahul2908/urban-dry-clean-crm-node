import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { applyMigrations } from '../db/migrations.js';

/** `npm run migrate [-- --dry | --baseline]` — additive db/migrations for the (single) business DB. SaaS: `npm run tenant -- migrate-all`. */
const env = loadEnv();
const { db, close } = createPool(env);
try {
  const r = await applyMigrations(db, { dry: process.argv.includes('--dry'), baseline: process.argv.includes('--baseline'), log: (m) => console.log(m) });
  console.log(process.argv.includes('--dry') ? 'dry run done' : `migrations up to date (${r.applied} applied now, ${r.total} total)`);
} catch (e) {
  console.error('[migrate] FAILED —', (e as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
