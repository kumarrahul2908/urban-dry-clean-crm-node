import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';

/**
 * `npm run migrate` — applies db/migrations/*.sql (additive only) in file-name order and records each in `udc_migrations`.
 * A statement that fails only because the object already exists (the PHP era applied some of these by hand) is treated as already applied.
 * `--dry` lists what would run. `--baseline` records every file as applied without running it.
 */
const dry = process.argv.includes('--dry'), baseline = process.argv.includes('--baseline');
const ALREADY = /already exists|Duplicate (column|key|index)|Duplicate foreign key|errno: ?121|errno 121/i;
const env = loadEnv();
const { db, close } = createPool(env);

/** Splits a SQL file into statements (handles `--` comments, quotes and DELIMITER-free scripts; migrations here contain no procedures). */
function statements(sql: string): string[] {
  const out: string[] = []; let cur = ''; let q: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (q) { cur += c; if (c === '\\') cur += sql[++i] ?? ''; else if (c === q) q = null; continue; }
    if (c === '-' && sql[i + 1] === '-' && (sql[i + 2] === ' ' || sql[i + 2] === '\n')) { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

try {
  await db.execute('CREATE TABLE IF NOT EXISTS udc_migrations (name VARCHAR(190) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, note VARCHAR(255) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM udc_migrations')).map((r) => r.name));
  const dir = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    if (dry) { console.log('would apply', f); continue; }
    if (baseline) { await db.execute('INSERT INTO udc_migrations (name, note) VALUES (?, ?)', [f, 'baseline']); console.log('baselined', f); continue; }
    let skipped = 0;
    let tableExists = false; // a plain CREATE TABLE that already exists => the whole file (its follow-up ALTERs) was applied before
    for (const st of statements(await readFile(join(dir, f), 'utf8'))) {
      if (tableExists) { skipped++; continue; }
      try { await db.execute(st); } catch (e) {
        if (ALREADY.test(String((e as Error).message))) { skipped++; if (/^CREATE\s+TABLE/i.test(st)) tableExists = true; continue; }
        throw new Error(`${f}: ${(e as Error).message}\n  in: ${st.slice(0, 160)}`);
      }
    }
    await db.execute('INSERT INTO udc_migrations (name, note) VALUES (?, ?)', [f, skipped ? `${skipped} statement(s) already applied` : null]);
    console.log('applied', f, skipped ? `(${skipped} already present)` : '');
    ran++;
  }
  console.log(dry ? 'dry run done' : `migrations up to date (${ran} applied now, ${files.length} total)`);
} catch (e) {
  console.error('[migrate] FAILED —', (e as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
