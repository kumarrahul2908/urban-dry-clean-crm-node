import type { Db } from '../db/pool.js';
import type { AuditLog } from '../audit/auditLog.js';
import { BusinessError } from '../lib/errors.js';
import type { Actor, Result } from './orderService.js';
import type { OrderHooks } from './hooks.js';
import type { LaundryGarmentService } from './laundryGarmentService.js';
import type { NotificationService } from './notificationService.js';

type Raw = Record<string, any>;

/** Port of includes/QcService.php: QC pass/fail, rework lifecycle, packing. Business failures -> {success:false, errors}. */
export class QcService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly laundry: LaundryGarmentService,
    private readonly notifications: NotificationService,
    private readonly hooks: OrderHooks,
    private readonly log: (m: string) => void = console.error,
  ) {}

  private fail(e: unknown, prefix = ''): Result {
    if (e instanceof BusinessError) return { success: false, errors: [`${prefix}${e.message}`] };
    this.log(`[qc-service] unexpected: ${(e as Error)?.stack ?? e}`);
    return { success: false, errors: [`${prefix}An unexpected error occurred.`] };
  }

  passQc(orderItemId: number, a: Actor, remarks = '') { return this.recordDecision(orderItemId, a, 'Passed', null, remarks, 'Ready'); }

  failQc(orderItemId: number, a: Actor, reason: string, remarks = '') {
    reason = reason.trim();
    if (reason === '') return Promise.resolve<Result>({ success: false, errors: ['A rework reason is required when failing QC.'] });
    return this.recordDecision(orderItemId, a, 'Rework', reason, remarks, 'Rework');
  }

  async recordLaundryQc(laundryGarmentId: number, a: Actor, result: 'Passed' | 'Rework', reason: string | null, remarks = ''): Promise<Result> {
    if (result === 'Rework' && (reason ?? '').trim() === '') return { success: false, errors: ['A rework reason is required when failing QC.'] };
    let garment: Raw;
    try {
      garment = await this.db.tx(async (t) => {
        const [g] = await t.query<Raw>(
          `SELECT lg.id, lg.order_item_id, oi.order_id, os.status_key AS order_status_key, o.customer_id, o.order_number, g.garment_name
           FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id
           JOIN order_statuses os ON os.id = o.status_id JOIN garments g ON g.id = lg.garment_id WHERE lg.id = ? FOR UPDATE`, [laundryGarmentId]);
        if (!g) throw new BusinessError('Laundry garment not found.');
        if (g.order_status_key === 'cancelled') throw new BusinessError('This order has been cancelled — QC cannot be recorded.');
        const current = await this.laundry.using(t).getCurrentStatus(laundryGarmentId);
        if (current !== 'QC') throw new BusinessError(`This garment is at status "${current}" — QC can only be recorded when it is at "QC".`);
        const qc = await t.execute('INSERT INTO qc_records (laundry_garment_id, checked_by, result, reason, remarks, checked_at) VALUES (?,?,?,?,?,NOW())', [laundryGarmentId, a.userId, result, reason, remarks !== '' ? remarks : null]);
        if (result === 'Rework') {
          await t.execute("INSERT INTO rework_records (laundry_garment_id, qc_record_id, reason, rework_date, status) VALUES (?,?,?,CURDATE(),'Pending')", [laundryGarmentId, qc.insertId, reason]);
        }
        await t.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,'QC',?,?,NOW(),?,'qc')",
          [laundryGarmentId, result === 'Passed' ? 'Ready' : 'Rework', a.userId, reason || remarks || null]);
        await this.audit.using(t).record({ action: 'edit', module: 'qc_records', recordId: String(qc.insertId), newValue: { laundry_garment_id: laundryGarmentId, result }, userId: a.userId, ip: a.ip });
        return g;
      });
    } catch (e) {
      return this.fail(e);
    }
    if (result === 'Passed') {
      await this.laundry.syncBatchStatusIfFullyReady(Number(garment.order_item_id), a.userId);
      await this.notifications.notify('order_ready', `${garment.garment_name} (Order ${garment.order_number}) passed QC.`, Number(garment.customer_id), Number(garment.order_id));
    } else {
      await this.notifications.notify('qc_failed', `${garment.garment_name} (Order ${garment.order_number}) failed QC — rework required: ${reason}`, Number(garment.customer_id), Number(garment.order_id));
    }
    return { success: true };
  }

  private async recordDecision(orderItemId: number, a: Actor, result: string, reason: string | null, remarks: string, newItemStatus: string): Promise<Result> {
    let item: Raw;
    try {
      item = await this.db.tx(async (t) => {
        const [it] = await t.query<Raw>(
          `SELECT oi.item_status, oi.order_id, os.status_key AS order_status_key, o.customer_id, o.order_number, g.garment_name
           FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN garments g ON g.id = oi.garment_id
           WHERE oi.id = ? FOR UPDATE`, [orderItemId]);
        if (!it) throw new BusinessError('Garment/order item not found.');
        if (it.order_status_key === 'cancelled') throw new BusinessError('This order has been cancelled — QC cannot be recorded.');
        if (it.item_status !== 'QC') throw new BusinessError(`This item is at status "${it.item_status}" — QC can only be recorded when it is at "QC" (workshop processing must be completed first).`);
        const qc = await t.execute('INSERT INTO qc_records (order_item_id, checked_by, result, reason, remarks, checked_at) VALUES (?,?,?,?,?,NOW())', [orderItemId, a.userId, result, reason, remarks !== '' ? remarks : null]);
        if (newItemStatus === 'Rework') {
          await t.execute("INSERT INTO rework_records (order_item_id, qc_record_id, reason, rework_date, status) VALUES (?,?,?,CURDATE(),'Pending')", [orderItemId, qc.insertId, reason]);
        }
        await t.execute('UPDATE order_items SET item_status = ? WHERE id = ?', [newItemStatus, orderItemId]);
        await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,'QC',?,?,NOW(),?,'qc')",
          [orderItemId, newItemStatus, a.userId, reason || remarks || null]);
        await this.audit.using(t).record({ action: 'edit', module: 'qc_records', recordId: String(qc.insertId), newValue: { order_item_id: orderItemId, result }, userId: a.userId, ip: a.ip });
        return it;
      });
    } catch (e) {
      return this.fail(e);
    }
    if (result === 'Passed') {
      await this.notifications.notify('order_ready', `${item.garment_name} (Order ${item.order_number}) passed QC — ready for packing.`, Number(item.customer_id), Number(item.order_id));
      await this.hooks.orderReady(Number(item.order_id));
    } else {
      await this.notifications.notify('qc_failed', `${item.garment_name} (Order ${item.order_number}) failed QC — rework required: ${reason}`, Number(item.customer_id), Number(item.order_id));
    }
    return { success: true };
  }

  startRework(reworkId: number, a: Actor) { return this.reworkTransition(reworkId, ['Pending'], 'In Progress', null, a); }
  completeRework(reworkId: number, a: Actor) { return this.reworkTransition(reworkId, ['In Progress'], 'Completed', 'QC', a); }

  private async reworkTransition(reworkId: number, allowedFrom: string[], newReworkStatus: string, newItemStatus: string | null, a: Actor): Promise<Result> {
    try {
      await this.db.tx(async (t) => {
        const audit = this.audit.using(t);
        const [anchor] = await t.query<Raw>('SELECT order_item_id, laundry_garment_id FROM rework_records WHERE id = ?', [reworkId]);
        if (!anchor) throw new BusinessError('Rework record not found.');
        const stateErr = (status: string) => new BusinessError(`This rework item is at status "${status}" — cannot perform this action from its current state.`);
        if (anchor.laundry_garment_id) {
          const [rw] = await t.query<Raw>('SELECT rr.* FROM rework_records rr WHERE rr.id = ? FOR UPDATE', [reworkId]);
          if (!allowedFrom.includes(rw!.status)) throw stateErr(rw!.status);
          await t.execute('UPDATE rework_records SET status = ? WHERE id = ?', [newReworkStatus, reworkId]);
          if (newItemStatus !== null) {
            await t.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,'Rework',?,?,NOW(),'Rework completed — returned to QC Pending','rework')", [anchor.laundry_garment_id, newItemStatus, a.userId]);
          }
          await audit.record({ action: 'edit', module: 'rework_records', recordId: String(reworkId), oldValue: { status: rw!.status }, newValue: { status: newReworkStatus }, userId: a.userId, ip: a.ip });
          return;
        }
        const [rw] = await t.query<Raw>('SELECT rr.*, oi.item_status FROM rework_records rr JOIN order_items oi ON oi.id = rr.order_item_id WHERE rr.id = ? FOR UPDATE', [reworkId]);
        if (!rw) throw new BusinessError('Rework record not found.');
        if (!allowedFrom.includes(rw.status)) throw stateErr(rw.status);
        await t.execute('UPDATE rework_records SET status = ? WHERE id = ?', [newReworkStatus, reworkId]);
        if (newItemStatus !== null) {
          if (rw.item_status !== 'Rework') throw new BusinessError('This garment is no longer in Rework status (someone may have already actioned it).');
          await t.execute('UPDATE order_items SET item_status = ? WHERE id = ?', [newItemStatus, rw.order_item_id]);
          await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,'Rework',?,?,NOW(),'Rework completed — returned to QC Pending','rework')", [rw.order_item_id, newItemStatus, a.userId]);
        }
        await audit.record({ action: 'edit', module: 'rework_records', recordId: String(reworkId), oldValue: { status: rw.status }, newValue: { status: newReworkStatus }, userId: a.userId, ip: a.ip });
      });
    } catch (e) {
      return this.fail(e);
    }
    return { success: true };
  }

  async markPacked(orderItemId: number, a: Actor): Promise<Result> {
    try {
      await this.db.tx(async (t) => {
        const [r] = await t.query<{ item_status: string }>('SELECT item_status FROM order_items WHERE id = ? FOR UPDATE', [orderItemId]);
        if (!r) throw new BusinessError('Garment/order item not found.');
        if (r.item_status !== 'Ready') throw new BusinessError(`This item is at status "${r.item_status}" — only QC-passed items ("Ready") can be marked Packed.`);
        await t.execute("UPDATE order_items SET item_status = 'Packed' WHERE id = ?", [orderItemId]);
        await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, module) VALUES (?,'Ready','Packed',?,NOW(),'packing')", [orderItemId, a.userId]);
        await this.audit.using(t).record({ action: 'edit', module: 'order_items', recordId: String(orderItemId), oldValue: { item_status: 'Ready' }, newValue: { item_status: 'Packed' }, userId: a.userId, ip: a.ip });
      });
    } catch (e) {
      return this.fail(e);
    }
    return { success: true };
  }
}
