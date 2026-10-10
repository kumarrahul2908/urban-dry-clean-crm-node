import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, num, ok } from '../../lib/http.js';
import { phpEmpty, toInt } from '../../lib/php.js';
import { qInt } from '../../lib/query.js';
import { ORDER_PHOTOS } from '../../services/photoService.js';
import { sniffImage, type ImageKind } from '../../storage/imageSniff.js';
import type { StoredTemp } from '../../storage/localDisk.js';

type Raw = Record<string, any>;
const PHOTO_TYPES: Record<string, string> = { jpg: 'jpg', png: 'png', webp: 'webp' };

/** Ports of order_photo_upload / order_photo_list / order_photo_delete / garment_image, plus the photo-retention endpoints. */
export async function registerMobileUploadRoutes(app: FastifyInstance) {
  const { db, storage, photos, audit, env } = app.services;
  const route = (method: 'GET' | 'POST', name: string, handler: (req: FastifyRequest) => Promise<unknown>) => {
    app.route({ method, url: `/${name}`, handler });
    app.route({ method, url: `/${name}.php`, handler });
  };
  const auth = async (req: FastifyRequest, ...anyOf: string[]) => {
    const ctx = await app.requireToken(req);
    if (!anyOf.some((p) => ctx.permissions.includes(p))) {
      throw new ApiError('forbidden', 'You do not have permission to perform this action.', 403);
    }
    return ctx;
  };

  /** Reads fields + (at most one) `image` file. The file is streamed to a temp file; the caller must discard/commit it. */
  const readUpload = async (req: FastifyRequest, tooLargeMsg: string): Promise<{ fields: Raw; file: (StoredTemp & { tooLarge: boolean }) | null }> => {
    const fields: Raw = {};
    let file: (StoredTemp & { tooLarge: boolean }) | null = null;
    if (!req.isMultipart()) return { fields: (req.body as Raw) ?? {}, file };
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'image' || file) { part.file.resume(); continue; }
          let tmp: StoredTemp;
          try {
            tmp = await storage.receive(part.file);
          } catch (e) {
            if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') { file = { tmpPath: '', bytes: 0, head: Buffer.alloc(0), tooLarge: true }; continue; }
            throw e;
          }
          file = { ...tmp, tooLarge: part.file.truncated };
        } else {
          fields[part.fieldname] = String((part as { value: unknown }).value ?? '');
        }
      }
    } catch (e) {
      if (file?.tmpPath) await storage.discard(file.tmpPath);
      if ((e as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new ApiError('invalid_request', tooLargeMsg, 422);
      throw e;
    }
    return { fields, file };
  };
  const discard = async (f: { tmpPath: string } | null) => { if (f?.tmpPath) await storage.discard(f.tmpPath); };

  // ---- order photos ---------------------------------------------------------------------------
  route('POST', 'order_photo_upload', async (req) => {
    const ctx = await auth(req, 'orders.edit');
    const { fields, file } = await readUpload(req, `Photo is too large (limit ${env.UPLOAD_MAX_MB} MB).`);
    try {
      const orderId = toInt(fields.order_id);
      const orderItemId = toInt(fields.order_item_id) || null;
      const caption = String(fields.caption ?? '').trim();
      if ([...caption].length > 255) throw new ApiError('invalid_request', 'Caption is too long.', 422);
      if (!orderId) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
      if (!(await db.query('SELECT id FROM orders WHERE id = ?', [orderId])).length) throw new ApiError('not_found', 'Order not found.', 404);
      if (orderItemId && !(await db.query('SELECT id FROM order_items WHERE id = ? AND order_id = ?', [orderItemId, orderId])).length) {
        throw new ApiError('invalid_request', 'That garment does not belong to this order.', 422);
      }
      if (!file || file.bytes === 0 && !file.tooLarge) throw new ApiError('invalid_request', 'No photo was received.', 422);
      if (file.tooLarge) throw new ApiError('invalid_request', `Photo is too large (limit ${env.UPLOAD_MAX_MB} MB).`, 422);
      const kind = sniffImage(file.head);
      const ext = kind ? PHOTO_TYPES[kind] : undefined;
      if (!ext) throw new ApiError('invalid_request', 'Only JPEG, PNG, or WEBP photos are allowed.', 422);

      const filename = await storage.commit(file.tmpPath, ORDER_PHOTOS, ext);
      file.tmpPath = '';
      let photoId: number;
      try {
        const ins = await db.execute('INSERT INTO order_photos (order_id, order_item_id, file_path, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)', [orderId, orderItemId, filename, caption !== '' ? caption : null, ctx.id]);
        photoId = ins.insertId;
      } catch (e) {
        await storage.remove(ORDER_PHOTOS, filename);
        throw e;
      }
      await audit.record({ action: 'create', module: 'order_photos', recordId: String(photoId), newValue: { order_id: orderId, order_item_id: orderItemId, bytes: file.bytes }, userId: ctx.id, ip: req.ip });
      return ok({ photo: { id: photoId, order_id: orderId, order_item_id: orderItemId, url: storage.url(ORDER_PHOTOS, filename), caption: caption !== '' ? caption : null } });
    } finally {
      await discard(file);
    }
  });

  route('GET', 'order_photo_list', async (req) => {
    await auth(req, 'orders.edit');
    const orderId = qInt((req.query as Raw).order_id);
    if (!orderId) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
    const rows = await db.query<Raw>('SELECT id, order_item_id, file_path, caption, created_at FROM order_photos WHERE order_id = ? ORDER BY created_at DESC', [orderId]);
    return ok({ photos: rows.map((r) => ({ id: num(r.id), order_item_id: r.order_item_id !== null ? num(r.order_item_id) : null, url: storage.url(ORDER_PHOTOS, r.file_path), caption: r.caption, created_at: r.created_at })) });
  });

  route('POST', 'order_photo_delete', async (req) => {
    const ctx = await auth(req, 'orders.edit');
    const payload = (req.body && typeof req.body === 'object' ? req.body : {}) as Raw;
    const photoId = toInt(payload.photo_id);
    if (!photoId) throw new ApiError('invalid_request', 'A valid photo_id is required.', 422);
    const [row] = await db.query<Raw>('SELECT order_id, file_path FROM order_photos WHERE id = ?', [photoId]);
    if (!row) throw new ApiError('not_found', 'Photo not found.', 404);
    await db.execute('DELETE FROM order_photos WHERE id = ?', [photoId]);
    await storage.remove(ORDER_PHOTOS, row.file_path);
    await audit.record({ action: 'delete', module: 'order_photos', recordId: String(photoId), oldValue: { order_id: row.order_id }, userId: ctx.id, ip: req.ip });
    return ok({ deleted: true });
  });

  // ---- retention: "delete old images" ------------------------------------------------------------
  // GET  order_photos_stats?older_than_days=30  -> how many photos exist / how many are older than N days
  // POST order_photos_cleanup {older_than_days, dry_run?: true, confirm?: boolean}
  //      dry_run defaults to TRUE; to really delete send {"dry_run": false, "confirm": true}.
  route('GET', 'order_photos_stats', async (req) => {
    await auth(req, 'admin.settings');
    const d = qInt((req.query as Raw).older_than_days);
    return ok(await photos.stats(d >= 1 ? d : null));
  });

  route('POST', 'order_photos_cleanup', async (req) => {
    const ctx = await auth(req, 'admin.settings');
    const p = (req.body && typeof req.body === 'object' ? req.body : {}) as Raw;
    const days = toInt(p.older_than_days);
    if (days < 1) throw new ApiError('invalid_request', 'older_than_days must be 1 or more.', 422);
    const dryRun = p.dry_run === undefined ? true : !!p.dry_run && !phpEmpty(p.dry_run) && String(p.dry_run) !== 'false';
    if (!dryRun && p.confirm !== true) {
      throw new ApiError('confirmation_required', 'Deleting photos cannot be undone. Send "confirm": true together with "dry_run": false.', 422);
    }
    return ok(await photos.cleanup(days, { dryRun, userId: ctx.id, ip: req.ip, source: 'api' }));
  });

  // ---- garment image (garment.edit | garments.manage) ----------------------------------------------
  route('POST', 'garment_image', async (req) => {
    const ctx = await auth(req, 'garment.edit', 'garments.manage');
    const { fields, file } = await readUpload(req, `Image is too large. Maximum size is ${env.UPLOAD_MAX_MB}MB.`);
    try {
      const garmentId = toInt(fields.garment_id);
      const action = String(fields.action ?? '').trim();
      if (garmentId <= 0) throw new ApiError('invalid_request', 'A valid garment_id is required.', 422);
      if (!['upload', 'remove'].includes(action)) throw new ApiError('invalid_request', 'action must be "upload" or "remove".', 422);
      if (!(await db.query('SELECT id FROM garments WHERE id = ?', [garmentId])).length) throw new ApiError('not_found', 'Garment not found.', 404);

      let newFilename: string | null = null;
      if (action === 'upload') {
        if (!file || (file.bytes === 0 && !file.tooLarge)) throw new ApiError('validation_failed', `No image was received. Maximum size is ${env.UPLOAD_MAX_MB}MB.`, 422);
        if (file.tooLarge) throw new ApiError('validation_failed', `Image is too large. Maximum size is ${env.UPLOAD_MAX_MB}MB.`, 422);
        const allowed = env.ALLOWED_IMAGE_TYPES.split(',').map((x) => x.trim().toLowerCase()).map((x) => (x === 'jpeg' ? 'jpg' : x));
        const kind: ImageKind | null = sniffImage(file.head);
        if (!kind) throw new ApiError('validation_failed', 'The uploaded file is not a valid image.', 422);
        if (!allowed.includes(kind)) throw new ApiError('validation_failed', `Invalid image type. Allowed: ${env.ALLOWED_IMAGE_TYPES.split(',').join(', ')}`, 422);
        newFilename = await storage.commit(file.tmpPath, 'garments', kind);
        file.tmpPath = '';
      }
      let oldFilename: string | null = null;
      try {
        oldFilename = await db.tx(async (t) => {
          const [cur] = await t.query<{ image: string | null }>('SELECT image FROM garments WHERE id = ? FOR UPDATE', [garmentId]);
          await t.execute('UPDATE garments SET image = ? WHERE id = ?', [newFilename, garmentId]);
          return cur?.image || null;
        });
      } catch (e) {
        if (newFilename) await storage.remove('garments', newFilename);
        throw e;
      }
      if (oldFilename !== null && oldFilename !== newFilename) await storage.remove('garments', oldFilename);
      if (oldFilename !== null || newFilename !== null) {
        await audit.record({ action: 'edit', module: 'garments', recordId: String(garmentId), oldValue: { image: oldFilename }, newValue: { image: newFilename }, userId: ctx.id, ip: req.ip });
      }
      return ok({ garment_id: garmentId, image_url: newFilename ? storage.url('garments', newFilename) : null });
    } finally {
      await discard(file);
    }
  });
}
