import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { WebCtx } from './context.js';
import { parseCsv } from './csv.js';
import { parseXlsx } from './xlsx.js';

/**
 * import_store_temp_upload(): keeps the uploaded file under <uploads>/tmp/<token>.<ext> for the
 * multi-step import flows. Both .csv and .xlsx are accepted here (shared by every import wizard
 * on this page) -- only the customer-import wizard actually parses a real .xlsx (importParseTemp
 * below); the others still only call parseCsvFile() afterward, matching the real app exactly:
 * the upload step there loosened right along with this shared function, parsing did not.
 */
export async function importStoreTempUpload(ctx: WebCtx, field: string): Promise<string> {
  const f = ctx.files[field];
  if (!f) throw new Error('Please choose a CSV or Excel (.xlsx) file to upload.');
  const ext = extname(f.filename).toLowerCase();
  if (ext !== '.csv' && ext !== '.xlsx') throw new Error('Only .csv or .xlsx files are supported.');
  const token = randomBytes(16).toString('hex');
  const dir = join(ctx.svc.storage.root, 'tmp');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${token}${ext}`), f.buffer);
  return token;
}

export function importTempPath(ctx: WebCtx, token: string): string {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid import session.');
  return join(ctx.svc.storage.root, 'tmp', `${token}.csv`);
}

/** import_temp_path(): tries .csv then .xlsx -- whichever actually exists on disk is this token's real extension. */
export async function importTempPathAny(ctx: WebCtx, token: string): Promise<string> {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid import session.');
  const dir = join(ctx.svc.storage.root, 'tmp');
  const csvPath = join(dir, `${token}.csv`);
  try { await readFile(csvPath); return csvPath; } catch { /* try .xlsx next */ }
  return join(dir, `${token}.xlsx`);
}

export async function importCleanupTemp(ctx: WebCtx, token: string): Promise<void> {
  for (const ext of ['.csv', '.xlsx']) await unlink(join(ctx.svc.storage.root, 'tmp', `${token}${ext}`)).catch(() => {});
}

export async function parseCsvFile(path: string) {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { throw new Error('Could not read the uploaded file.'); }
  return parseCsv(text);
}

/** import_parse_temp(): dispatches to the CSV or XLSX parser based on the temp file's own extension -- the one place that needs to know which parser a given import token requires. */
export async function importParseTemp(ctx: WebCtx, token: string) {
  const path = await importTempPathAny(ctx, token);
  if (path.toLowerCase().endsWith('.xlsx')) {
    let buf: Buffer;
    try { buf = await readFile(path); } catch { throw new Error('Could not read the uploaded file.'); }
    return parseXlsx(buf);
  }
  return parseCsvFile(path);
}
