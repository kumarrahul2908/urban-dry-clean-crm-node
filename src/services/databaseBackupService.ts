import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { createGzip } from 'node:zlib';
import type { Env } from '../config/env.js';
import { timeIn, todayIn } from '../lib/dates.js';

export interface BackupResult { success: boolean; file: string | null; size_bytes: number | null; errors: string[] }
export interface BackupListing { filename: string; size_bytes: number; modified_at: number }

const FILENAME_RE = /^backup_\d{4}-\d{2}-\d{2}_\d{6}\.sql\.gz$/;
const KEEP_DAYS = 30; // backups older than this are pruned automatically after each new one

/**
 * Local DB backup (Admin > Backup): "Take Backup Now" / list / download / delete, plus the
 * nightly cron job. The real PHP app hand-rolled a pure-PHP dump because exec()/shell_exec() were
 * both disabled on its Hostinger plan -- that constraint doesn't apply here, so this ports the
 * FEATURE using the standard `mysqldump | gzip` pipeline (same tool the SaaS operator console's
 * own per-tenant export already uses). Files are named backup_YYYY-MM-DD_HHmmss.sql.gz, written
 * under a `.partial` name and renamed only on full success (a half-finished dump never shows up as
 * a real, trustable backup), and stored in a directory deliberately OUTSIDE UPLOAD_DIR (never
 * served by the /uploads static route) -- a sibling of it, unique per tenant since UPLOAD_DIR
 * itself already is.
 */
export class DatabaseBackupService {
  constructor(private readonly env: Env) {}

  dir(): string {
    const uploadDir = resolve(this.env.UPLOAD_DIR);
    return join(dirname(uploadDir), basename(uploadDir) + '-backups');
  }

  async run(): Promise<BackupResult> {
    const dir = this.dir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const now = new Date();
    const filename = `backup_${todayIn(this.env.APP_TIMEZONE, now)}_${timeIn(this.env.APP_TIMEZONE, now).replace(/:/g, '')}.sql.gz`;
    const path = join(dir, filename);
    const tmpPath = path + '.partial';

    const { env } = this;
    const dump = spawn('mysqldump', ['--single-transaction', '--routines', '--hex-blob', '-h', env.DB_HOST, '-P', String(env.DB_PORT), '-u', env.DB_USER, env.DB_NAME], { env: { ...process.env, MYSQL_PWD: env.DB_PASS } });
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += String(d); });

    const result = await new Promise<BackupResult>((resolvePromise) => {
      const out = createWriteStream(tmpPath);
      const gz = createGzip({ level: 9 });
      dump.stdout.pipe(gz).pipe(out);
      let failed = false, exitCode: number | null = null, outFinished = false;
      const fail = (msg: string) => { if (failed) return; failed = true; try { dump.kill(); } catch { /* already exited */ } resolvePromise({ success: false, file: null, size_bytes: null, errors: [msg] }); };
      const maybeDone = () => {
        if (failed || exitCode === null || !outFinished) return;
        if (exitCode !== 0) { fail(`mysqldump exited with code ${exitCode}: ${stderr.trim() || 'unknown error'}`); return; }
        resolvePromise({ success: true, file: filename, size_bytes: null, errors: [] });
      };
      dump.on('error', (e) => fail(`Could not run mysqldump: ${e.message}`));
      dump.on('exit', (code) => { exitCode = code ?? 0; maybeDone(); });
      out.on('error', (e) => fail(`Could not write backup file: ${e.message}`));
      out.on('finish', () => { outFinished = true; maybeDone(); });
    });

    if (!result.success) {
      await unlink(tmpPath).catch(() => {});
      return result;
    }
    try {
      await rename(tmpPath, path);
    } catch (e) {
      await unlink(tmpPath).catch(() => {});
      return { success: false, file: null, size_bytes: null, errors: ['Backup completed but could not be finalized (rename failed): ' + (e as Error).message] };
    }
    const size = (await stat(path)).size;
    await this.pruneOld(dir);
    return { success: true, file: filename, size_bytes: size, errors: [] };
  }

  private async pruneOld(dir: string): Promise<void> {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (!FILENAME_RE.test(f)) continue;
      const path = join(dir, f);
      const st = await stat(path).catch(() => null);
      if (st && st.mtimeMs < cutoff) await unlink(path).catch(() => {});
    }
  }

  /** Lists existing backups, newest first, for the admin UI. */
  async list(): Promise<BackupListing[]> {
    const dir = this.dir();
    const files = await readdir(dir).catch(() => [] as string[]);
    const out: BackupListing[] = [];
    for (const f of files) {
      if (!FILENAME_RE.test(f)) continue;
      const st = await stat(join(dir, f)).catch(() => null);
      if (st) out.push({ filename: f, size_bytes: st.size, modified_at: Math.floor(st.mtimeMs / 1000) });
    }
    return out.sort((a, b) => b.modified_at - a.modified_at);
  }

  /** Full path to a backup file, or null if the filename doesn't match the expected shape (never trust a request body/query for a filesystem path regardless). */
  pathFor(filename: string): string | null {
    return FILENAME_RE.test(filename) ? join(this.dir(), filename) : null;
  }

  async delete(filename: string): Promise<boolean> {
    const path = this.pathFor(filename);
    if (!path) return false;
    try { await unlink(path); return true; } catch { return false; }
  }
}
