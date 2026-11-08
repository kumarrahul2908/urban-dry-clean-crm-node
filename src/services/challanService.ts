import type { Db } from '../db/pool.js';
import type { AuditLog } from '../audit/auditLog.js';
import { BusinessError } from '../lib/errors.js';
import { toInt } from '../lib/php.js';
import { generateChallanNumber } from './documentNumber.js';
import type { Actor, Result } from './orderService.js';

type Raw = Record<string, any>;
const ids = (xs: unknown[]) => [...new Set(xs.map(toInt).filter((n) => n !== 0))].sort((a, b) => a - b);

/**
 * Challan generate/reuse/edit/delete state machine. `challans.order_id` is kept only as a
 * convenience pointer to the first order on the challan (for quick joins) — the real, authoritative
 * membership always lives in `challan_orders`, for single-order challans too.
 */
export class ChallanService {
  constructor(private readonly db: Db, private readonly audit: AuditLog, private readonly log: (m: string) => void = console.error) {}

  private fail(e: unknown, prefix = ''): Result {
    if (e instanceof BusinessError) return { success: false, errors: [`${prefix}${e.message}`] };
    this.log(`[challan-service] unexpected: ${(e as Error)?.stack ?? e}`);
    return { success: false, errors: [`${prefix}An unexpected error occurred.`] };
  }

  private async validateOrders(orderIds: number[], allowedStoreIds: number[] | null): Promise<string[]> {
    const rows = await this.db.query<Raw>(
      `SELECT o.id, o.order_number, o.store_id, os.status_key FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.id IN (?)`, [orderIds]);
    const found = new Map(rows.map((r) => [Number(r.id), r]));
    const errors: string[] = [];
    for (const id of orderIds) {
      const r = found.get(id);
      if (!r) { errors.push(`Order #${id} not found.`); continue; }
      if (allowedStoreIds !== null && !allowedStoreIds.includes(Number(r.store_id))) errors.push(`Order ${r.order_number} does not belong to a store you are authorized for.`);
      if (r.status_key === 'cancelled') errors.push(`Order ${r.order_number} is cancelled and cannot be put on a challan.`);
    }
    return errors;
  }

  /** The exact SET of orders this candidate matches, not a subset/superset — a challan covering
   * {1,2} is never "reused" for a request covering just {1}, or {1,2,3}. */
  private async findExactMatch(orderIds: number[], withAmount: boolean): Promise<{ id: number; challan_number: string } | null> {
    const [row] = await this.db.query<Raw>(
      `SELECT ch.id, ch.challan_number FROM challans ch
       WHERE ch.with_amount = ?
         AND (SELECT COUNT(*) FROM challan_orders co WHERE co.challan_id = ch.id) = ?
         AND (SELECT COUNT(*) FROM challan_orders co WHERE co.challan_id = ch.id AND co.order_id IN (?)) = ?
       ORDER BY ch.id DESC LIMIT 1`,
      [withAmount ? 1 : 0, orderIds.length, orderIds, orderIds.length],
    );
    return row ? { id: Number(row.id), challan_number: row.challan_number } : null;
  }

  /**
   * Generate a challan covering `orderIds`. If a challan already exists covering this EXACT same
   * set of orders with the same with_amount flag, that existing challan is reused (no duplicate is
   * created) — the same idea as pos_orders_create's client_request_id replay, but keyed on the order
   * set + with_amount instead of an explicit client token, since a challan is naturally re-derivable
   * from "which orders, which variant" alone.
   */
  async generate(orderIdsRaw: unknown[], withAmount: boolean, a: Actor, allowedStoreIds: number[] | null = null): Promise<Result> {
    const orderIds = ids(orderIdsRaw);
    if (orderIds.length === 0) return { success: false, errors: ['Select at least one order for this challan.'] };
    const errors = await this.validateOrders(orderIds, allowedStoreIds);
    if (errors.length) return { success: false, errors };

    const existing = await this.findExactMatch(orderIds, withAmount);
    if (existing) return { success: true, challan_id: existing.id, challan_number: existing.challan_number, reused: true };

    const challanNumber = await generateChallanNumber(this.db);
    try {
      const challanId = await this.db.tx(async (t) => {
        const ch = await t.execute('INSERT INTO challans (challan_number, order_id, with_amount, created_by) VALUES (?,?,?,?)', [challanNumber, orderIds[0], withAmount ? 1 : 0, a.userId]);
        for (const orderId of orderIds) await t.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?,?)', [ch.insertId, orderId]);
        await this.audit.using(t).record({ action: 'create', module: 'challans', recordId: String(ch.insertId), newValue: { challan_number: challanNumber, order_ids: orderIds, with_amount: withAmount }, userId: a.userId, ip: a.ip });
        return ch.insertId;
      });
      return { success: true, challan_id: challanId, challan_number: challanNumber, reused: false };
    } catch (e) { return this.fail(e, 'Could not create challan: '); }
  }

  /**
   * Replace which orders (and/or the with_amount variant) an EXISTING challan covers. Unlike
   * generate(), edit() never dedups against other challans — the operator is explicitly editing
   * THIS challan, so silently redirecting them to a different one would be surprising.
   */
  async edit(challanId: number, orderIdsRaw: unknown[], withAmount: boolean, a: Actor, allowedStoreIds: number[] | null = null): Promise<Result> {
    const orderIds = ids(orderIdsRaw);
    if (orderIds.length === 0) return { success: false, errors: ['Select at least one order for this challan.'] };
    const [challan] = await this.db.query<Raw>('SELECT * FROM challans WHERE id = ?', [challanId]);
    if (!challan) return { success: false, errors: ['Challan not found.'] };
    const errors = await this.validateOrders(orderIds, allowedStoreIds);
    if (errors.length) return { success: false, errors };

    try {
      await this.db.tx(async (t) => {
        const before = (await t.query<{ order_id: number }>('SELECT order_id FROM challan_orders WHERE challan_id = ?', [challanId])).map((r) => Number(r.order_id));
        await t.execute('DELETE FROM challan_orders WHERE challan_id = ?', [challanId]);
        for (const orderId of orderIds) await t.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?,?)', [challanId, orderId]);
        await t.execute('UPDATE challans SET order_id = ?, with_amount = ? WHERE id = ?', [orderIds[0], withAmount ? 1 : 0, challanId]);
        await this.audit.using(t).record({
          action: 'edit', module: 'challans', recordId: String(challanId),
          oldValue: { order_ids: before, with_amount: !!Number(challan.with_amount) },
          newValue: { order_ids: orderIds, with_amount: withAmount },
          userId: a.userId, ip: a.ip,
        });
      });
      return { success: true, challan_id: challanId, challan_number: challan.challan_number };
    } catch (e) { return this.fail(e, 'Could not update challan: '); }
  }

  async delete(challanId: number, a: Actor, allowedStoreIds: number[] | null = null): Promise<Result> {
    const [challan] = await this.db.query<Raw>('SELECT * FROM challans WHERE id = ?', [challanId]);
    if (!challan) return { success: false, errors: ['Challan not found.'] };
    if (allowedStoreIds !== null) {
      const orderIds = (await this.db.query<{ order_id: number }>('SELECT order_id FROM challan_orders WHERE challan_id = ?', [challanId])).map((r) => Number(r.order_id));
      const errors = await this.validateOrders(orderIds, allowedStoreIds);
      // a cancelled order on an already-created challan must not block deleting the challan itself
      if (errors.some((e) => /authorized/.test(e))) return { success: false, errors: ['You are not authorized to delete this challan.'] };
    }
    try {
      await this.db.tx(async (t) => {
        await t.execute('DELETE FROM challan_orders WHERE challan_id = ?', [challanId]);
        await t.execute('DELETE FROM challans WHERE id = ?', [challanId]);
        await this.audit.using(t).record({ action: 'delete', module: 'challans', recordId: String(challanId), oldValue: { challan_number: challan.challan_number }, userId: a.userId, ip: a.ip });
      });
      return { success: true };
    } catch (e) { return this.fail(e, 'Could not delete challan: '); }
  }
}
