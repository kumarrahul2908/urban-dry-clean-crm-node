import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, open } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export interface StoredTemp { tmpPath: string; bytes: number; head: Buffer }

/**
 * Local-disk storage for uploads: <root>/<subdir>/<random-32-hex>.<ext>, the same layout the PHP app used
 * (uploads/order_photos, uploads/garments), so existing files keep working after being copied over.
 * Files are written verbatim — nothing is resized or re-encoded.
 */
export class LocalDiskStorage {
  readonly root: string;
  constructor(root: string, private readonly publicBase: string) {
    this.root = resolve(root);
  }

  private dir(subdir: string): string {
    if (!/^[a-z0-9_]+$/.test(subdir)) throw new Error('Invalid storage folder.');
    return join(this.root, subdir);
  }

  /** Absolute path of a stored file; throws if `filename` tries to escape the folder. */
  pathOf(subdir: string, filename: string): string {
    const safe = basename(filename);
    if (safe !== filename || safe === '' || safe.startsWith('.')) throw new Error('Invalid file name.');
    const p = join(this.dir(subdir), safe);
    if (!p.startsWith(this.dir(subdir) + sep)) throw new Error('Invalid file name.');
    return p;
  }

  url(subdir: string, filename: string): string {
    return `${this.publicBase.replace(/\/+$/, '')}/uploads/${subdir}/${filename}`;
  }

  /** Streams an upload to a temp file (so memory stays flat for big photos) and reports size + first bytes. */
  async receive(stream: Readable): Promise<StoredTemp> {
    const tmpDir = this.dir('tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `up_${randomBytes(12).toString('hex')}.part`);
    try {
      await pipeline(stream, createWriteStream(tmpPath, { mode: 0o644 }));
    } catch (e) {
      await unlink(tmpPath).catch(() => {});
      throw e;
    }
    const { size } = await stat(tmpPath);
    const fh = await open(tmpPath, 'r');
    try {
      const head = Buffer.alloc(Math.min(16, size));
      await fh.read(head, 0, head.length, 0);
      return { tmpPath, bytes: size, head };
    } finally {
      await fh.close();
    }
  }

  async discard(tmpPath: string): Promise<void> {
    await unlink(tmpPath).catch(() => {});
  }

  /** Moves a received temp file into <subdir>/ under a fresh random name. */
  async commit(tmpPath: string, subdir: string, ext: string): Promise<string> {
    const dir = this.dir(subdir);
    await mkdir(dir, { recursive: true });
    const filename = `${randomBytes(16).toString('hex')}.${ext}`;
    await rename(tmpPath, join(dir, filename));
    return filename;
  }

  async remove(subdir: string, filename: string | null | undefined): Promise<boolean> {
    if (!filename) return false;
    try {
      await unlink(this.pathOf(subdir, filename));
      return true;
    } catch {
      return false;
    }
  }

  async sizeOf(subdir: string, filename: string): Promise<number | null> {
    try {
      return (await stat(this.pathOf(subdir, filename))).size;
    } catch {
      return null;
    }
  }

  async read(subdir: string, filename: string): Promise<Buffer> {
    return readFile(this.pathOf(subdir, filename));
  }
}
