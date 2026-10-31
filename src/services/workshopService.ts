import type { Db } from '../db/pool.js';
import type { AuditLog } from '../audit/auditLog.js';
import { BusinessError } from '../lib/errors.js';
import { toInt } from '../lib/php.js';
import { generateDocumentNumber } from './documentNumber.js';
import type { Actor, Result } from './orderService.js';

type Raw = Record<string, any>;
const ids = (xs: unknown[]) => [...new Set(xs.map(toInt).filter((n) => n !== 0))];

/** Port of includes/WorkshopService.php (challans + workshop item lifecycle). */
export class WorkshopService {
  constructor(private readonly db: Db, private readonly audit: AuditLog, private readonly log: (m: string) => void = console.error) {}

  private fail(e: unknown, prefix = ''): Result {
    if (e instanceof BusinessError) return { success: false, errors: [`${prefix}${e.message}`] };
    this.log(`[workshop-service] unexpected: ${(e as Error)?.stack ?? e}`);
    return { success: false, errors: [`${prefix}An unexpected error occurred.`] };
  }

  /**
   * `allowedStoreIds`: null = unrestricted. NOTE: PHP evaluated this from the *web session*, which does not exist for the
   * mobile API, so mobile callers were never store-restricted. Node enforces the token user's fixed store (the intended rule).
   */
  async createChallan(workshopId: number, orderItemIds: unknown[], remarks: string, a: Actor, allowedStoreIds: number[] | null = null): Promise<Result> {
    const itemIds = ids(orderItemIds);
    if (itemIds.length === 0) return { success: false, errors: ['Select at least one garment to send to the workshop.'] };
    if (!(await this.db.query('SELECT id FROM workshops WHERE id = ? AND is_active = 1', [workshopId])).length) return { success: false, errors: ['Selected workshop is invalid or inactive.'] };
    const rows = await this.db.query<Raw>(
      `SELECT oi.id, oi.item_status, os.status_key AS order_status_key, o.order_number, o.store_id, g.garment_name
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN garments g ON g.id = oi.garment_id WHERE oi.id IN (?)`, [itemIds]);
    const found = rows.map((r) => Number(r.id));
    const errors: string[] = [];
    for (const id of itemIds) if (!found.includes(id)) errors.push(`Item #${id} not found.`);
    for (const r of rows) {
      if (allowedStoreIds !== null && !allowedStoreIds.includes(Number(r.store_id))) errors.push(`${r.garment_name} (Order ${r.order_number}) does not belong to a store you are authorized for.`);
      if (r.order_status_key === 'cancelled') errors.push(`${r.garment_name} (Order ${r.order_number}) belongs to a cancelled order and cannot be sent to workshop.`);
      else if (r.item_status !== 'Pending') errors.push(`${r.garment_name} (Order ${r.order_number}) is already at status "${r.item_status}" — not eligible (must be Pending).`);
    }
    if (errors.length) return { success: false, errors };
    const challanNumber = await generateDocumentNumber(this.db, 'challan_prefix', 6);
    try {
      const challanId = await this.db.tx(async (t) => {
        const ch = await t.execute('INSERT INTO workshop_challans (challan_number, workshop_id, challan_date, remarks, created_by) VALUES (?,?,NOW(),?,?)', [challanNumber, workshopId, remarks !== '' ? remarks : null, a.userId]);
        for (const itemId of itemIds) {
          await t.execute("INSERT INTO workshop_items (challan_id, order_item_id, status, sent_at) VALUES (?,?,'Sent',NOW())", [ch.insertId, itemId]);
          await t.execute("UPDATE order_items SET item_status = 'Workshop' WHERE id = ?", [itemId]);
          await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [itemId, 'Pending', 'Workshop', a.userId, `Sent via challan ${challanNumber}`]);
        }
        await this.audit.using(t).record({ action: 'create', module: 'workshop_challans', recordId: String(ch.insertId), newValue: { challan_number: challanNumber, workshop_id: workshopId, item_count: itemIds.length }, userId: a.userId, ip: a.ip });
        return ch.insertId;
      });
      return { success: true, challan_id: challanId, challan_number: challanNumber };
    } catch (e) { return this.fail(e, 'Could not create challan: '); }
  }

  async createLaundryChallan(workshopId: number, laundryGarmentIds: unknown[], remarks: string, a: Actor, allowedStoreIds: number[] | null = null): Promise<Result> {
    const lgIds = ids(laundryGarmentIds);
    if (lgIds.length === 0) return { success: false, errors: ['Select at least one Laundry garment to send to the workshop.'] };
    if (!(await this.db.query('SELECT id FROM workshops WHERE id = ? AND is_active = 1', [workshopId])).length) return { success: false, errors: ['Selected workshop is invalid or inactive.'] };
    const rows = await this.db.query<Raw>(
      `SELECT lg.id, os.status_key AS order_status_key, o.order_number, o.store_id, g.garment_name
       FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN garments g ON g.id = lg.garment_id
       WHERE lg.id IN (?)`, [lgIds]);
    const found = rows.map((r) => Number(r.id));
    const errors: string[] = [];
    for (const id of lgIds) if (!found.includes(id)) errors.push(`Laundry garment #${id} not found.`);
    for (const r of rows) {
      if (allowedStoreIds !== null && !allowedStoreIds.includes(Number(r.store_id))) errors.push(`${r.garment_name} (Order ${r.order_number}) does not belong to a store you are authorized for.`);
      if (r.order_status_key === 'cancelled') errors.push(`${r.garment_name} (Order ${r.order_number}) belongs to a cancelled order and cannot be sent to workshop.`);
    }
    if (errors.length) return { success: false, errors };
    const challanNumber = await generateDocumentNumber(this.db, 'challan_prefix', 6);
    try {
      const challanId = await this.db.tx(async (t) => {
        const ch = await t.execute('INSERT INTO workshop_challans (challan_number, workshop_id, challan_date, remarks, created_by) VALUES (?,?,NOW(),?,?)', [challanNumber, workshopId, remarks !== '' ? remarks : null, a.userId]);
        for (const lgId of lgIds) {
          await t.execute("INSERT INTO workshop_items (challan_id, laundry_garment_id, status, sent_at) VALUES (?,?,'Sent',NOW())", [ch.insertId, lgId]);
          await t.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [lgId, 'Pending', 'Workshop', a.userId, `Sent via challan ${challanNumber}`]);
        }
        await this.audit.using(t).record({ action: 'create', module: 'workshop_challans', recordId: String(ch.insertId), newValue: { challan_number: challanNumber, workshop_id: workshopId, laundry_garment_count: lgIds.length }, userId: a.userId, ip: a.ip });
        return ch.insertId;
      });
      return { success: true, challan_id: challanId, challan_number: challanNumber };
    } catch (e) { return this.fail(e, 'Could not create Laundry challan: '); }
  }

  startProcessing(id: number, a: Actor) { return this.transition(id, ['Sent', 'Received'], 'Processing', 'Processing', a, null); }

  /**
   * QC must happen INSIDE the workshop's own process, before ironing and packaging — not after
   * the garment is already back at the store. These three methods track in-workshop progress on
   * order_items.item_status (Processing -> QC -> Ready -> Packed) while workshop_items.status
   * stays 'Processing' throughout — only completeIroning (lands on 'Packed') also flips
   * workshop_items.status to 'Completed'. Piece (order_item-anchored) items only — a Laundry-
   * anchored row has no item_status to track this way (one physical garment's progress must never
   * silently overwrite the shared batch status) and is rejected outright.
   */
  completeWashing(id: number, a: Actor, remarks = '') { return this.itemStatusSubStage(id, ['Processing'], 'QC', a, remarks); }
  passQC(id: number, a: Actor, remarks = '') { return this.itemStatusSubStage(id, ['QC'], 'Ready', a, remarks); }
  completeIroning(id: number, a: Actor, remarks = '') { return this.itemStatusSubStage(id, ['Ready'], 'Packed', a, remarks, true); }

  /**
   * Processing -> Completed. For a piece item, this now REQUIRES item_status to already be
   * 'Packed' — i.e. completeWashing() -> passQC() -> completeIroning() must all have already run.
   * A Laundry-anchored item has no item_status to check and transitions directly, unaffected.
   */
  async completeProcessing(id: number, a: Actor, remarks = ''): Promise<Result> {
    const [anchor] = await this.db.query<Raw>('SELECT order_item_id, laundry_garment_id FROM workshop_items WHERE id = ?', [id]);
    if (anchor?.order_item_id) {
      const [oi] = await this.db.query<{ item_status: string }>('SELECT item_status FROM order_items WHERE id = ?', [anchor.order_item_id]);
      if (oi && oi.item_status !== 'Packed') return { success: false, errors: [`QC, ironing and packaging must be completed first (currently at "${oi.item_status}").`] };
    }
    return this.transition(id, ['Processing'], 'Completed', null, a, remarks);
  }

  acceptItem(id: number, a: Actor, remarks = '') { return this.historyOnly(id, ['Received'], 'Accepted', a, remarks); }
  returnToStore(id: number, a: Actor, remarks = '') { return this.historyOnly(id, ['Completed'], 'Returned', a, remarks); }

  async storeReceive(id: number, a: Actor, remarks = ''): Promise<Result> {
    try {
      await this.db.tx(async (t) => {
        const [anchor] = await t.query<Raw>('SELECT order_item_id, laundry_garment_id FROM workshop_items WHERE id = ? FOR UPDATE', [id]);
        if (!anchor) throw new BusinessError('Workshop item not found.');
        const current = await this.currentStatus(t, id);
        if (current !== 'Returned') throw new BusinessError(`This item is at status "${current}" — cannot be received by the store from its current state.`);
        // QC now happens INSIDE the workshop process (completeWashing(), well before this point) --
        // item_status is already 'Packed' by the time an item can reach 'Returned' at all
        // (completeProcessing() now requires it), so nothing further to set here.
        if (anchor.laundry_garment_id) {
          await t.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [anchor.laundry_garment_id, 'Returned', 'Store Received', a.userId, remarks || null]);
        } else {
          await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [anchor.order_item_id, 'Returned', 'Store Received', a.userId, remarks || null]);
        }
        await this.audit.using(t).record({ action: 'edit', module: 'workshop_items', recordId: String(id), oldValue: { status: 'Returned' }, newValue: { status: 'Store Received' }, userId: a.userId, ip: a.ip });
      });
    } catch (e) { return this.fail(e); }
    return { success: true };
  }

  /**
   * If workshop staff never click through every step for a garment that has physically already
   * come back, the store must still be able to receive it rather than being blocked waiting for
   * digital tracking that may never happen. Bypasses every intermediate from-state check and jumps
   * straight to 'Store Received' from whatever state the item is currently at (anything except
   * already Store Received/Unprocessed/Rejected). Logs the item's actual original status in the
   * history remarks -- an honest audit trail, never silently pretends QC/Ironing happened. For a
   * piece item, item_status is also force-set to 'Packed' if it hasn't already reached that point.
   */
  async forceStoreReceive(id: number, a: Actor, remarks = ''): Promise<Result> {
    try {
      await this.db.tx(async (t) => {
        const [anchor] = await t.query<Raw>(
          `SELECT wi.order_item_id, wi.laundry_garment_id, oi.item_status FROM workshop_items wi LEFT JOIN order_items oi ON oi.id = wi.order_item_id WHERE wi.id = ? FOR UPDATE`, [id]);
        if (!anchor) throw new BusinessError('Workshop item not found.');
        const current = await this.currentStatus(t, id);
        if (['Store Received', 'Unprocessed', 'Rejected'].includes(current)) throw new BusinessError(`This item is at status "${current}" — nothing to force-receive.`);
        const note = `Force-received by store (was at "${current}", workshop did not complete the normal tracking steps).${remarks ? ' ' + remarks : ''}`;
        if (anchor.laundry_garment_id) {
          await t.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [anchor.laundry_garment_id, current, 'Store Received', a.userId, note]);
        } else {
          if (anchor.item_status !== 'Packed') await t.execute("UPDATE order_items SET item_status = 'Packed' WHERE id = ?", [anchor.order_item_id]);
          await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [anchor.order_item_id, current, 'Store Received', a.userId, note]);
        }
        await t.execute("UPDATE workshop_items SET status = 'Completed', completed_at = COALESCE(completed_at, NOW()) WHERE id = ?", [id]);
        await this.audit.using(t).record({ action: 'edit', module: 'workshop_items', recordId: String(id), oldValue: { status: current }, newValue: { status: 'Store Received (forced)' }, userId: a.userId, ip: a.ip });
      });
    } catch (e) { return this.fail(e); }
    return { success: true };
  }

  getCurrentStatus(id: number) { return this.currentStatus(this.db, id); }
  private async currentStatus(db: Db, id: number): Promise<string> {
    const [wi] = await db.query<Raw>('SELECT status, order_item_id, laundry_garment_id FROM workshop_items WHERE id = ?', [id]);
    if (!wi) return 'Unknown';
    const [h] = wi.laundry_garment_id
      ? await db.query<{ new_status: string }>("SELECT new_status FROM garment_status_history WHERE laundry_garment_id = ? AND module = 'workshop' ORDER BY changed_at DESC, id DESC LIMIT 1", [wi.laundry_garment_id])
      : await db.query<{ new_status: string }>("SELECT new_status FROM garment_status_history WHERE order_item_id = ? AND module = 'workshop' ORDER BY changed_at DESC, id DESC LIMIT 1", [wi.order_item_id]);
    return h ? h.new_status : wi.status;
  }

  markUnprocessed(id: number, a: Actor, reason: string): Promise<Result> {
    reason = reason.trim();
    if ([...reason].length < 3) return Promise.resolve({ success: false, errors: ['Enter a reason for marking this item unprocessed.'] });
    return this.historyOnly(id, null, 'Unprocessed', a, reason, ['Rejected', 'Unprocessed']);
  }

  async resolveUnprocessed(id: number, a: Actor, remarks = ''): Promise<Result> {
    const current = await this.getCurrentStatus(id);
    if (current !== 'Unprocessed') return { success: false, errors: [`This item is not marked Unprocessed (current status: "${current}").`] };
    const [prev] = await this.db.query<{ previous_status: string | null }>(
      `SELECT previous_status FROM garment_status_history
       WHERE module = 'workshop' AND new_status = 'Unprocessed'
         AND (order_item_id = (SELECT order_item_id FROM workshop_items WHERE id = ?) OR laundry_garment_id = (SELECT laundry_garment_id FROM workshop_items WHERE id = ?))
       ORDER BY changed_at DESC, id DESC LIMIT 1`, [id, id]);
    const restoreTo = prev && prev.previous_status ? prev.previous_status : 'Sent';
    return this.historyOnly(id, ['Unprocessed'], restoreTo, a, remarks || 'Resolved');
  }

  /**
   * Backs completeWashing()/passQC()/completeIroning(): validates and advances
   * order_items.item_status only, leaving workshop_items.status at 'Processing' throughout —
   * except when `alsoCompleteWorkshopItem` is true (completeIroning's call, landing on 'Packed'),
   * which also flips workshop_items.status to 'Completed' in the same transaction. The
   * garment_status_history row must stay in workshop-vocabulary ('Processing'/'Completed'), never
   * item_status-vocabulary (QC/Ready/Packed), because getCurrentStatus() below reads history for
   * its truth source — conflating the two vocabularies there would break every other from-state
   * check (e.g. returnToStore()'s own).
   */
  private async itemStatusSubStage(id: number, allowedFromItemStatus: string[], newItemStatus: string, a: Actor, remarks: string | null, alsoCompleteWorkshopItem = false): Promise<Result> {
    try {
      await this.db.tx(async (t) => {
        const [laundryCheck] = await t.query<Raw>('SELECT laundry_garment_id FROM workshop_items WHERE id = ?', [id]);
        if (laundryCheck?.laundry_garment_id) throw new BusinessError('Laundry items do not use QC/Ironing/Packaging tracking — use Complete Processing directly.');
        const [wi] = await t.query<Raw>('SELECT wi.*, oi.item_status, oi.id AS order_item_id FROM workshop_items wi JOIN order_items oi ON oi.id = wi.order_item_id WHERE wi.id = ? FOR UPDATE', [id]);
        if (!wi) throw new BusinessError('Workshop item not found.');
        if (wi.status !== 'Processing') throw new BusinessError(`This item is at workshop status "${wi.status}" — QC/Ironing/Packaging only apply while an item is being processed.`);
        if (!allowedFromItemStatus.includes(wi.item_status)) throw new BusinessError(`This item is at "${wi.item_status}" — cannot perform this action from its current stage (someone may have already actioned it).`);
        await t.execute('UPDATE order_items SET item_status = ? WHERE id = ?', [newItemStatus, wi.order_item_id]);
        const workshopVocabStatus = alsoCompleteWorkshopItem ? 'Completed' : 'Processing';
        await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [wi.order_item_id, wi.status, workshopVocabStatus, a.userId, `${remarks || ''} [item_status -> ${newItemStatus}]`]);
        if (alsoCompleteWorkshopItem) {
          await t.execute("UPDATE workshop_items SET status = 'Completed', completed_at = NOW() WHERE id = ?", [id]);
          await this.audit.using(t).record({ action: 'edit', module: 'workshop_items', recordId: String(id), oldValue: { status: 'Processing' }, newValue: { status: 'Completed' }, userId: a.userId, ip: a.ip });
        }
      });
    } catch (e) { return this.fail(e); }
    return { success: true };
  }

  private async historyOnly(id: number, allowedFrom: string[] | null, newStatus: string, a: Actor, remarks: string | null, disallowedFrom: string[] | null = null): Promise<Result> {
    try {
      await this.db.tx(async (t) => {
        const [anchor] = await t.query<Raw>('SELECT order_item_id, laundry_garment_id FROM workshop_items WHERE id = ? FOR UPDATE', [id]);
        if (!anchor) throw new BusinessError('Workshop item not found.');
        const current = await this.currentStatus(t, id);
        if (disallowedFrom !== null && disallowedFrom.includes(current)) throw new BusinessError(`This item is at status "${current}" — cannot perform this action from its current state.`);
        if (allowedFrom !== null && !allowedFrom.includes(current)) throw new BusinessError(`This item is at status "${current}" — cannot perform this action from its current state (someone may have already actioned it).`);
        if (anchor.laundry_garment_id) {
          await t.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [anchor.laundry_garment_id, current, newStatus, a.userId, remarks || null]);
        } else {
          await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [anchor.order_item_id, current, newStatus, a.userId, remarks || null]);
        }
        await this.audit.using(t).record({ action: 'edit', module: 'workshop_items', recordId: String(id), oldValue: { status: current }, newValue: { status: newStatus }, userId: a.userId, ip: a.ip });
      });
    } catch (e) { return this.fail(e); }
    return { success: true };
  }

  private async transition(id: number, allowedFrom: string[], newWorkshopStatus: string, newItemStatus: string | null, a: Actor, remarks: string | null): Promise<Result> {
    try {
      await this.db.tx(async (t) => {
        const audit = this.audit.using(t);
        const [anchor] = await t.query<Raw>('SELECT order_item_id, laundry_garment_id FROM workshop_items WHERE id = ?', [id]);
        if (!anchor) throw new BusinessError('Workshop item not found.');
        const stateErr = (s: string) => new BusinessError(`This item is at status "${s}" — cannot perform this action from its current state (someone may have already actioned it).`);
        const extraCol = newWorkshopStatus === 'Completed' ? ', completed_at = NOW()' : '';
        const historyStatus = newItemStatus ?? newWorkshopStatus;
        if (anchor.laundry_garment_id) {
          const [wi] = await t.query<Raw>('SELECT wi.* FROM workshop_items wi WHERE wi.id = ? FOR UPDATE', [id]);
          if (!allowedFrom.includes(wi!.status)) throw stateErr(wi!.status);
          await t.execute(`UPDATE workshop_items SET status = ?${extraCol} WHERE id = ?`, [newWorkshopStatus, id]);
          await t.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [anchor.laundry_garment_id, wi!.status, historyStatus, a.userId, remarks || null]);
          await audit.record({ action: 'edit', module: 'workshop_items', recordId: String(id), oldValue: { status: wi!.status }, newValue: { status: newWorkshopStatus }, userId: a.userId, ip: a.ip });
          return;
        }
        const [wi] = await t.query<Raw>('SELECT wi.*, oi.item_status, oi.id AS order_item_id FROM workshop_items wi JOIN order_items oi ON oi.id = wi.order_item_id WHERE wi.id = ? FOR UPDATE', [id]);
        if (!wi) throw new BusinessError('Workshop item not found.');
        if (!allowedFrom.includes(wi.status)) throw stateErr(wi.status);
        await t.execute(`UPDATE workshop_items SET status = ?${extraCol} WHERE id = ?`, [newWorkshopStatus, id]);
        if (newItemStatus !== null) await t.execute('UPDATE order_items SET item_status = ? WHERE id = ?', [newItemStatus, wi.order_item_id]);
        await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) VALUES (?,?,?,?,NOW(),?,'workshop')", [wi.order_item_id, wi.item_status, historyStatus, a.userId, remarks || null]);
        await audit.record({ action: 'edit', module: 'workshop_items', recordId: String(id), oldValue: { status: wi.status }, newValue: { status: newWorkshopStatus }, userId: a.userId, ip: a.ip });
      });
    } catch (e) { return this.fail(e); }
    return { success: true };
  }
}
