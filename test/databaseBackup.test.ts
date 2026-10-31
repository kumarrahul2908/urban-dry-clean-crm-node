import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { DatabaseBackupService } from '../src/services/databaseBackupService.js';

/**
 * Node-only checks for the DB backup feature (changelog 2026-10-23..30, section 7). The real PHP
 * app hand-rolled a pure-PHP dump (no exec()/shell_exec() on its hosting); this port uses
 * `mysqldump | gzip` instead, so there is no PHP output to byte-compare against -- these checks
 * instead verify the actual, observable contract: a real .sql.gz file lands on disk, it's a valid
 * gzip archive containing real SQL for this database, filenames/pruning/list/delete all behave as
 * documented, and it never writes under the web-servable UPLOAD_DIR.
 */
const enabled = !!process.env.TEST_DB_NAME;
vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)('DatabaseBackupService (Node-only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'udc-backup-'));
  const uploadDir = join(dir, 'uploads');
  const env = loadEnv({
    NODE_ENV: 'test', DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306',
    DB_NAME: process.env.TEST_DB_NAME || 'unused', DB_USER: process.env.TEST_DB_USER || 'unused', DB_PASS: process.env.TEST_DB_PASS ?? '',
    APP_SECRET_KEY: 'k', UPLOAD_DIR: uploadDir,
  } as NodeJS.ProcessEnv);
  const svc = new DatabaseBackupService(env);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('backup directory is a sibling of UPLOAD_DIR, never nested inside it (never web-servable)', () => {
    const backupDir = svc.dir();
    expect(backupDir.startsWith(uploadDir + '/')).toBe(false);
    expect(backupDir).not.toBe(uploadDir);
  });

  it('run() produces a real, valid gzip SQL dump; list() finds it; delete() removes it', async () => {
    const before = await svc.list();
    const result = await svc.run();
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.file).toMatch(/^backup_\d{4}-\d{2}-\d{2}_\d{6}\.sql\.gz$/);
    expect(result.size_bytes).toBeGreaterThan(0);

    const path = svc.pathFor(result.file!);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(existsSync(path! + '.partial')).toBe(false); // never left behind on success

    const sql = gunzipSync(readFileSync(path!)).toString('utf8');
    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('orders');

    const after = await svc.list();
    expect(after.length).toBe(before.length + 1);
    expect(after[0]!.filename).toBe(result.file); // newest first

    expect(await svc.delete(result.file!)).toBe(true);
    expect(existsSync(path!)).toBe(false);
    expect(await svc.delete(result.file!)).toBe(false); // already gone
  });

  it('pathFor()/delete() reject anything not matching the exact filename shape (never trust a request for a filesystem path)', async () => {
    expect(svc.pathFor('../../etc/passwd')).toBeNull();
    expect(svc.pathFor('backup_2026-01-01_120000.sql')).toBeNull(); // missing .gz
    expect(svc.pathFor('backup_2026-01-01_120000.sql.gz')).not.toBeNull();
    expect(await svc.delete('../../etc/passwd')).toBe(false);
  });
});
