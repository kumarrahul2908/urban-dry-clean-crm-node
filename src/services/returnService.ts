import type { Db } from '../db/pool.js';
import { sniffImage } from '../storage/imageSniff.js';
import type { LocalDiskStorage } from '../storage/localDisk.js';
import type { AuditLog } from '../audit/auditLog.js';
import type { NotificationService } from './notificationService.js';
import { ORDER_PHOTOS } from './photoService.js';

type Row = Record<string, any>;
const clip = (s: string, n: number) => Array.from(s).slice(0, n).join('');

/** The one optional photo of a return: raw bytes, or a flag that the upload was rejected before reaching us (too big). */
export type ReturnPhoto = { buffer: Buffer } | { tooLarge: true } | null;
export type ReturnResult = { success: true; count: number } | { success: false; errors: string[] };

/**
 * Port of includes/ReturnService.php (Rahul, 21 Nov 2026): garments of an already-delivered order that the customer brings back.
 * Each returned garment gets a customer_returns row (admin-editable reason, optional note, optional photo through order_photos)
 * AND a rework_records row + item_status 'Rework', so it travels Rework -> QC -> Ready -> Packed -> Delivered (a free redo).
 */
export class ReturnService {
  constructor(private readonly db: Db, private readonly audit: AuditLog, private readonly notifications: NotificationService, private readonly storage: LocalDiskStorage) {}

  activeReasons(): Promise<Row[]> {
    return this.db.query<Row>('SELECT id, reason_name FROM return_reasons WHERE is_active = 1 ORDER BY sort_order, id');
  }

  /** Garments of a delivered order that can be returned (not already back in rework). */
  returnableItems(orderId: number): Promise<Row[]> {
    return this.db.query<Row>(
      `SELECT oi.id, oi.quantity, oi.weight, oi.item_status, g.garment_name, s.service_name, s.billing_unit
       FROM order_items oi JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
       WHERE oi.order_id = ? AND oi.item_status != 'Rework' ORDER BY oi.id`, [orderId]);
  }

  async createReturn(orderId: number, itemIdsIn: number[], reasonId: number, noteIn: string, photo: ReturnPhoto, userId: number, ip: string | null = null): Promise<ReturnResult> {
    const itemIds = [...new Set(itemIdsIn.map((x) => Math.trunc(Number(x)) || 0).filter((x) => x !== 0))];
    if (!itemIds.length) return { success: false, errors: ['Kam se kam ek garment select karein.'] };
    const note = clip(noteIn.trim(), 500);

    const reason = (await this.db.query<Row>('SELECT id, reason_name FROM return_reasons WHERE id = ? AND is_active = 1', [reasonId]))[0];
    if (!reason) return { success: false, errors: ['Return reason select karein.'] };

    // Optional photo: validated BEFORE anything is written, saved only after the DB work succeeds.
    let photoExt: string | null = null;
    if (photo) {
      if ('tooLarge' in photo) return { success: false, errors: ['Photo upload nahi ho paya (badi ho sakti hai).'] };
      if (photo.buffer.length > 8 * 1024 * 1024) return { success: false, errors: ['Photo 8 MB se chhoti honi chahiye.'] };
      const kind = sniffImage(photo.buffer.subarray(0, 16));
      if (kind !== 'jpg' && kind !== 'png' && kind !== 'webp') return { success: false, errors: ['Sirf JPEG, PNG ya WEBP photo chalegi.'] };
      photoExt = kind;
    }

    let savedPhotoFile: string | null = null;
    let order: Row | undefined;
    try {
      await this.db.tx(async (t) => {
        order = (await t.query<Row>(
          `SELECT o.id, o.customer_id, o.status_id, COALESCE(o.short_order_code, o.order_number) AS order_number, os.status_key
           FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.id = ? FOR UPDATE`, [orderId]))[0];
        if (!order) throw new Error('Order nahi mila.');
        if (order.status_key !== 'delivered') throw new Error('Return sirf delivered order par ho sakta hai.');

        const ph = itemIds.map(() => '?').join(',');
        const items = await t.query<Row>(`SELECT id, item_status FROM order_items WHERE order_id = ? AND id IN (${ph}) FOR UPDATE`, [orderId, ...itemIds]);
        if (items.length !== itemIds.length) throw new Error('Select kiya gaya garment is order ka nahi hai.');
        for (const row of items) if (row.item_status === 'Rework') throw new Error('Ek garment pehle se rework mein hai.');

        // Photo (optional) -> existing order_photos table, so it shows on the order page too.
        let photoId: number | null = null;
        if (photo && 'buffer' in photo && photoExt) {
          savedPhotoFile = await this.storage.saveBuffer(photo.buffer, ORDER_PHOTOS, photoExt);
          const caption = clip('Return: ' + reason.reason_name + (note !== '' ? ' - ' + note : ''), 255);
          photoId = (await t.execute('INSERT INTO order_photos (order_id, order_item_id, file_path, caption, uploaded_by) VALUES (?,?,?,?,?)',
            [orderId, itemIds.length === 1 ? itemIds[0] : null, savedPhotoFile, caption, userId])).insertId;
        }

        const reworkReason = clip('Customer return: ' + reason.reason_name + (note !== '' ? ' - ' + note : ''), 255);
        for (const row of items) {
          const iid = Number(row.id);
          const reworkId = (await t.execute("INSERT INTO rework_records (order_item_id, reason, rework_date, status) VALUES (?,?,CURDATE(),'Pending')", [iid, reworkReason])).insertId;
          await t.execute('INSERT INTO customer_returns (order_id, order_item_id, reason_id, reason_text, note, photo_id, rework_id, created_by) VALUES (?,?,?,?,?,?,?,?)',
            [orderId, iid, reasonId, reason.reason_name, note !== '' ? note : null, photoId, reworkId, userId]);
          await t.execute("UPDATE order_items SET item_status = 'Rework' WHERE id = ?", [iid]);
          await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,'Rework',?,NOW(),?,'return')",
            [iid, row.item_status, userId, reworkReason]);
          await this.audit.using(t).record({ action: 'create', module: 'customer_returns', recordId: String(reworkId), oldValue: null, newValue: { order_id: orderId, order_item_id: iid, reason: reason.reason_name }, userId, ip });
        }

        // Garments that stay with the customer: they were delivered.
        const others = await t.query<Row>(`SELECT id, item_status FROM order_items WHERE order_id = ? AND id NOT IN (${ph}) AND item_status NOT IN ('Delivered','Rework','Damaged','Missing')`, [orderId, ...itemIds]);
        for (const oth of others) {
          await t.execute("UPDATE order_items SET item_status = 'Delivered' WHERE id = ?", [oth.id]);
          await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,'Delivered',?,NOW(),'Already delivered (order partly returned)','return')",
            [oth.id, oth.item_status, userId]);
        }

        const rw = (await t.query<Row>("SELECT id FROM order_statuses WHERE status_key = 'rework'"))[0]?.id;
        if (rw) {
          await t.execute('UPDATE orders SET status_id = ? WHERE id = ?', [rw, orderId]);
          await this.audit.using(t).record({ action: 'edit', module: 'orders', recordId: String(orderId), oldValue: { status_id: order.status_id }, newValue: { status_id: Number(rw), reason: 'customer return' }, userId, ip });
        }
      });
    } catch (e) {
      if (savedPhotoFile) await this.storage.remove(ORDER_PHOTOS, savedPhotoFile);
      return { success: false, errors: [(e as Error).message] };
    }

    await this.notifications.notify('qc_failed', `Customer return - Order ${order!.order_number}: ${itemIds.length} garment(s) back in rework (${reason.reason_name}).`, Number(order!.customer_id), orderId);
    return { success: true, count: itemIds.length };
  }
}
