import type { Db } from '../../src/db/pool.js';

type Snap = Record<string, Record<string, unknown>[]> & { __sums?: never };
const sums = new WeakMap<object, Record<string, string>>();
const autoInc = new WeakMap<object, Record<string, number>>();
const readAutoInc = async (db: Db) => Object.fromEntries((await db.query<{ t: string; a: number | null }>('SELECT table_name AS t, auto_increment AS a FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = "BASE TABLE"')).filter((r) => r.a !== null).map((r) => [r.t, Number(r.a)]));
const SKIP = new Set(['web_sessions', 'api_tokens', 'login_ip_attempts']);

export async function dbSnapshot(db: Db): Promise<Snap> {
  const tables = (await db.query<{ t: string }>('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = "BASE TABLE"')).map((r) => r.t).filter((t) => !SKIP.has(t));
  const out: Snap = {};
  for (const t of tables) out[t] = await db.query(`SELECT * FROM \`${t}\``);
  sums.set(out, await checksums(db, tables));
  autoInc.set(out, await readAutoInc(db));
  return out;
}

async function checksums(db: Db, tables: string[]): Promise<Record<string, string>> {
  const rows = await db.query<Record<string, unknown>>(`CHECKSUM TABLE ${tables.map((t) => `\`${t}\``).join(',')}`);
  return Object.fromEntries(rows.map((r) => [String(r.Table).split('.').pop()!, String(r.Checksum)]));
}

/** Restores only the tables whose checksum changed since the snapshot. */
export async function dbRestore(db: Db, snap: Snap): Promise<void> {
  const before = sums.get(snap) ?? {};
  const now = await checksums(db, Object.keys(snap));
  const changed = Object.keys(snap).filter((t) => before[t] !== now[t]);
  await db.tx(async (t) => {
    await t.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of changed) {
      const rows = snap[table]!;
      await t.execute(`TRUNCATE TABLE \`${table}\``);
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const cols = Object.keys(chunk[0]!);
        await t.execute(`INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ${chunk.map(() => `(${cols.map(() => '?').join(',')})`).join(',')}`, chunk.flatMap((r) => cols.map((c) => r[c])));
      }
    }
    await t.execute('SET FOREIGN_KEY_CHECKS = 1');
  });
  // ids burned by rolled-back statements must not leak into the next run either
  const ai0 = autoInc.get(snap) ?? {}, ai1 = await readAutoInc(db);
  for (const [table, v] of Object.entries(ai0)) if (ai1[table] !== v && snap[table]) await db.execute(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${v}`);
}

const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
function norm(v: unknown): unknown {
  if (typeof v === 'string') {
    if (TS.test(v)) return 'TS';
    if (/^[0-9a-f]{32}$/.test(v) || /^[0-9a-f]{64}$/.test(v)) return 'HEX'; // random tokens (qr_token …)
    if (/^[[{]/.test(v)) { try { return normObj(JSON.parse(v)); } catch { return v; } }
    return v;
  }
  return v;
}
function normObj(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(normObj);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, normObj(x)]));
  return typeof o === 'string' && TS.test(o) ? 'TS' : o;
}

/** Row-by-row differences between two snapshots (timestamps masked, JSON columns compared parsed). */
export function dbDiff(a: Snap, b: Snap, ignoreTables: string[] = []): string[] {
  const out: string[] = [];
  for (const table of Object.keys(a)) {
    if (ignoreTables.includes(table)) continue;
    const ra = a[table]!, rb = b[table] ?? [];
    if (ra.length !== rb.length) { out.push(`${table}: ${ra.length} rows vs ${rb.length}`); continue; }
    ra.forEach((row, i) => {
      for (const k of Object.keys(row)) {
        const x = JSON.stringify(norm(row[k])), y = JSON.stringify(norm(rb[i]![k]));
        if (x !== y) out.push(`${table}[${i}].${k}: ${x} vs ${y}`);
      }
    });
  }
  return out;
}

import { expectSameHtml, type Client, type Resp } from './harness.js';

/**
 * Runs `send` against PHP, rolls the whole database back, runs it against Node, rolls back again and requires the same
 * response and the same resulting database state (timestamps masked). Returns PHP's response.
 */
export function writeCompare(db: Db, appUrl: string) {
  return async (label: string, php: Client, node: Client, send: (c: Client) => Promise<Resp>, opts: { sortRows?: boolean; ignoreTables?: string[]; jsonBody?: boolean } = {}): Promise<Resp> => {
    const before = await dbSnapshot(db);
    const a = await send(php);
    const stateA = await dbSnapshot(db);
    await dbRestore(db, before);
    const b = await send(node);
    const stateB = await dbSnapshot(db);
    await dbRestore(db, before);
    if (opts.jsonBody) {
      const pa = JSON.parse(a.body), pb = JSON.parse(b.body);
      if (JSON.stringify(normObj(pb)) !== JSON.stringify(normObj(pa))) throw new Error(`${label}: JSON differs\n node ${b.body.slice(0, 600)}\n php  ${a.body.slice(0, 600)}`);
      if (a.status !== b.status) throw new Error(`${label}: status ${b.status} ≠ PHP ${a.status}`);
    } else expectSameHtml(b, a, appUrl, label, opts.sortRows);
    const diff = dbDiff(stateA, stateB, opts.ignoreTables);
    if (diff.length) throw new Error(`${label}: database state differs\n  ${diff.slice(0, 12).join('\n  ')}`);
    return a;
  };
}
