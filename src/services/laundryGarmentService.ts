import type { Db } from '../db/pool.js';
import type { OrderHooks } from './hooks.js';

type Raw = Record<string, any>;

/** Port of includes/LaundryGarmentService.php (per-garment status of weight-based orders). */
export class LaundryGarmentService {
  constructor(private readonly db: Db, private readonly hooks: OrderHooks, private readonly log: (m: string) => void = console.error) {}

  using(db: Db) { return new LaundryGarmentService(db, this.hooks, this.log); }

  async getCurrentStatus(laundryGarmentId: number): Promise<string> {
    const r = await this.db.query<{ new_status: string }>(
      'SELECT new_status FROM garment_status_history WHERE laundry_garment_id = ? ORDER BY changed_at DESC, id DESC LIMIT 1', [laundryGarmentId]);
    return r[0] ? r[0].new_status : 'Pending';
  }

  async listForBatch(orderItemId: number): Promise<Raw[]> {
    const rows = await this.db.query<Raw>(
      `SELECT lg.id, lg.sequence, g.garment_name, oi.quantity AS total_garments, o.id AS order_id, o.order_number, c.full_name AS customer_name, s.service_name,
              bc.id AS barcode_id, bc.barcode_value, bc.qr_token
       FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
       JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN barcodes bc ON bc.laundry_garment_id = lg.id
       WHERE lg.order_item_id = ? ORDER BY lg.sequence`, [orderItemId]);
    for (const r of rows) r.status = await this.getCurrentStatus(Number(r.id));
    return rows;
  }

  /** Over-fetches 4x the limit then filters by current status, exactly like the PHP original. */
  async listByStatus(statuses: string[], limit = 200): Promise<Raw[]> {
    const rows = await this.db.query<Raw>(
      `SELECT lg.id, lg.sequence, g.garment_name, oi.quantity AS total_garments, oi.id AS order_item_id, o.id AS order_id, o.order_number, o.due_date,
              c.full_name AS customer_name, s.service_name, s.id AS service_id, os.status_key AS order_status_key
       FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id
       JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id
       WHERE os.status_key != 'cancelled' ORDER BY lg.id DESC LIMIT ${limit * 4}`);
    const matched: Raw[] = [];
    for (const r of rows) {
      const status = await this.getCurrentStatus(Number(r.id));
      if (statuses.includes(status)) {
        r.status = status;
        matched.push(r);
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }

  async getHistory(laundryGarmentId: number): Promise<Raw[]> {
    return this.db.query<Raw>(
      `SELECT changed_at, previous_status, new_status, module, remarks, u.full_name AS changed_by_name
       FROM garment_status_history gsh LEFT JOIN users u ON u.id = gsh.changed_by WHERE gsh.laundry_garment_id = ? ORDER BY changed_at ASC, id ASC`, [laundryGarmentId]);
  }

  async isBatchFullyAtStatus(orderItemId: number, acceptable: string[]) {
    const garments = await this.listForBatch(orderItemId);
    const matching = garments.filter((g) => acceptable.includes(g.status)).length;
    return { ready: garments.length > 0 && matching === garments.length, total: garments.length, matching };
  }

  /** When every physical garment of a batch has individually passed QC, the batch row becomes 'Ready'. */
  async syncBatchStatusIfFullyReady(orderItemId: number, userId: number): Promise<void> {
    const check = await this.isBatchFullyAtStatus(orderItemId, ['Ready']);
    if (!check.ready) return;
    let orderId: number | null = null;
    try {
      const done = await this.db.tx(async (t) => {
        const [cur] = await t.query<{ item_status: string }>('SELECT item_status FROM order_items WHERE id = ? FOR UPDATE', [orderItemId]);
        if (!cur || cur.item_status === 'Ready' || cur.item_status === 'Packed') return false;
        await t.execute("UPDATE order_items SET item_status = 'Ready' WHERE id = ?", [orderItemId]);
        await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'qc')",
          [orderItemId, cur.item_status, 'Ready', userId, `All ${check.total} physical garments individually passed QC — batch marked Ready for packing.`]);
        return true;
      });
      if (!done) return;
      const [o] = await this.db.query<{ order_id: number }>('SELECT order_id FROM order_items WHERE id = ?', [orderItemId]);
      orderId = o ? Number(o.order_id) : null;
    } catch (e) {
      this.log(`[laundry] syncBatchStatusIfFullyReady failed: ${(e as Error).message}`);
      return;
    }
    if (orderId) await this.hooks.orderReady(orderId);
  }
}
