import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebCtx } from './context.js';
import { parseCsv } from './csv.js';

/** import_store_temp_upload(): keeps the uploaded CSV under <uploads>/tmp/<token>.csv for the multi-step import flows. */
export async function importStoreTempUpload(ctx: WebCtx, field: string): Promise<string> {
  const f = ctx.files[field];
  if (!f) throw new Error('Please choose a CSV file to upload.');
  if (!f.filename.toLowerCase().endsWith('.csv')) throw new Error('Only .csv files are supported.');
  const token = randomBytes(16).toString('hex');
  const dir = join(ctx.svc.storage.root, 'tmp');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${token}.csv`), f.buffer);
  return token;
}

export function importTempPath(ctx: WebCtx, token: string): string {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid import session.');
  return join(ctx.svc.storage.root, 'tmp', `${token}.csv`);
}

export async function importCleanupTemp(ctx: WebCtx, token: string): Promise<void> {
  try { await unlink(importTempPath(ctx, token)); } catch { /* best effort */ }
}

export async function parseCsvFile(path: string) {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { throw new Error('Could not read the uploaded file.'); }
  return parseCsv(text);
}
