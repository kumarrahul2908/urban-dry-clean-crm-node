import type { Db } from '../db/pool.js';
import type { AuditLog } from '../audit/auditLog.js';
import { addDays, checkDate, fmtJ, fmtJMy, fmtMy, fmtYm, timeIn } from '../lib/dates.js';
import { numberFormat2, round2 } from '../lib/php.js';
import type { WorkshopService } from './workshopService.js';

type Raw = Record<string, any>;
export const WI_PAID_EPSILON = 0.004;

export const wiStates: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
export const wiTerms: Record<number, string> = { 0: 'Due on Receipt', 7: 'Net 7', 15: 'Net 15', 30: 'Net 30', 45: 'Net 45', 60: 'Net 60' };

export const wiPeriodLabel = (from: string, to: string) =>
  from === to ? fmtJMy(from) : fmtYm(from) === fmtYm(to) ? `${fmtJ(from)}-${fmtJMy(to)}` : `${fmtJMy(from)}-${fmtJMy(to)}`;
export const wiSubject = (from: string, to: string) => (fmtYm(from) === fmtYm(to) ? `Charges ${fmtMy(to)}` : `Charges ${fmtMy(from)}-${fmtMy(to)}`);

export function wiSplit(total: number, workshopPct: number): [number, number] {
  const workshopShare = round2((total * workshopPct) / 100);
  return [workshopShare, round2(total - workshopShare)];
}

export function wiApplyGst(workshopShare: number, gstMode: string, gstRate: number): [number, number, number] {
  if (gstMode === 'exclusive') {
    const gst = round2((workshopShare * gstRate) / 100);
    return [workshopShare, gst, round2(workshopShare + gst)];
  }
  if (gstMode === 'inclusive') {
    const base = round2(workshopShare / (1 + gstRate / 100));
    return [base, round2(workshopShare - base), workshopShare];
  }
  return [workshopShare, 0, workshopShare];
}

export type WiResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: string; error: string };
const wiErr = (code: string, error: string): { ok: false; code: string; error: string } => ({ ok: false, code, error });
const okDate = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return !!m && checkDate(Number(m[1]), Number(m[2]), Number(m[3])); };

/** Port of includes/WorkshopInvoice.php (the money-handling half: billable items, invoice creation, payments, void). */
export class WorkshopInvoice {
  constructor(private readonly db: Db, private readonly audit: AuditLog, private readonly workshops: WorkshopService, private readonly tz: string, private readonly now: () => Date = () => new Date(), private readonly log: (m: string) => void = console.error) {}

  async issuer(workshopId: number) {
    const [w] = await this.db.query<Raw>('SELECT * FROM workshops WHERE id = ?', [workshopId]);
    if (!w) return null;
    const code = String(w.state_code ?? '');
    return {
      workshop_id: Number(w.id), workshop_name: String(w.workshop_name),
      company_name: String(w.company_name ?? '').trim() !== '' ? String(w.company_name).trim() : String(w.workshop_name),
      address: String(w.address ?? ''), phone: String(w.phone ?? ''), email: String(w.email ?? ''), gstin: String(w.gstin ?? ''),
      state_code: code, state_name: wiStates[code] ?? '', prefix: String(w.invoice_prefix ?? ''), next_number: Number(w.invoice_next_number ?? 1),
      terms_days: Number(w.payment_terms_days ?? 0),
      item_description: String(w.item_description ?? '').trim() !== '' ? String(w.item_description) : 'Dry Clean charges',
      notes: String(w.invoice_notes ?? ''), bank_details: String(w.bank_details ?? ''), commission: Number(w.commission_workshop_percent),
    };
  }

  async billableItems(storeId: number | null, workshopId: number, from: string, to: string): Promise<Raw[]> {
    const params: unknown[] = [workshopId, from, to];
    let storeClause = '';
    if (storeId !== null) { storeClause = ' AND o.store_id = ?'; params.push(storeId); }
    const rows = await this.db.query<Raw>(
      `SELECT DISTINCT wi.id AS workshop_item_id, oi.id AS order_item_id, oi.total AS item_value, o.id AS order_id, o.order_number,
              o.store_id, COALESCE(s.store_name, 'Unassigned') AS store_name, g.garment_name, c.full_name AS customer_name
       FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id
       JOIN order_items oi ON oi.id = COALESCE(oi1.id, lg.order_item_id) JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
       LEFT JOIN stores s ON s.id = o.store_id LEFT JOIN garments g ON g.id = oi.garment_id
       WHERE wi.status != 'Rejected' AND wc.workshop_id = ? AND DATE(wi.sent_at) BETWEEN ? AND ?${storeClause}
         AND oi.id NOT IN (SELECT order_item_id FROM workshop_bill_items)
       ORDER BY store_name, o.order_number`, params);
    const out: Raw[] = [];
    for (const r of rows) if ((await this.workshops.getCurrentStatus(Number(r.workshop_item_id))) !== 'Unprocessed') out.push(r);
    return out;
  }

  private async nextInvoiceNumber(workshopId: number): Promise<string> {
    return this.db.tx(async (t) => {
      const [row] = await t.query<Raw>('SELECT invoice_prefix, invoice_next_number FROM workshops WHERE id = ? FOR UPDATE', [workshopId]);
      if (!row) throw new Error('Workshop not found');
      const prefix = String(row.invoice_prefix ?? '').trim() !== '' ? String(row.invoice_prefix).trim() : 'INV';
      let n = Math.max(1, Number(row.invoice_next_number));
      let num: string;
      for (;;) {
        num = `${prefix}-${String(n).padStart(5, '0')}`;
        if (!(await t.query('SELECT 1 FROM workshop_bills WHERE bill_number = ?', [num])).length) break;
        n++;
      }
      await t.execute('UPDATE workshops SET invoice_next_number = ? WHERE id = ?', [n + 1, workshopId]);
      return num;
    });
  }

  async createInvoice(
    storeId: number | null, workshopId: number, from: string, to: string, invoiceDate: string, subjectIn: string | null, userId: number,
    expectedTotal: number | null = null, expectedCount: number | null = null, gstModeIn = 'none', gstRate = 18, ip: string | null = null,
  ): Promise<WiResult<{ bill_id: number; bill_number: string; workshop_share: number; grand_total: number }>> {
    const gstMode = ['none', 'inclusive', 'exclusive'].includes(gstModeIn) ? gstModeIn : 'none';
    const issuer = await this.issuer(workshopId);
    if (!issuer) return wiErr('not_found', 'Workshop not found.');
    if (!okDate(from) || !okDate(to) || from > to) return wiErr('invalid_request', 'Enter a valid date range.');
    if (!okDate(invoiceDate)) return wiErr('invalid_request', 'Enter a valid invoice date.');
    let billTo: string;
    if (storeId !== null) {
      const [s] = await this.db.query<{ store_name: string }>('SELECT store_name FROM stores WHERE id = ?', [storeId]);
      if (!s) return wiErr('not_found', 'Store not found.');
      billTo = s.store_name;
    } else {
      const [bn] = await this.db.query<{ setting_value: string | null }>("SELECT setting_value FROM settings WHERE setting_key = 'business_name'");
      billTo = String(bn?.setting_value ?? '').trim() !== '' ? `${String(bn!.setting_value).trim()} - All Stores` : 'All Stores';
    }
    const items = await this.billableItems(storeId, workshopId, from, to);
    if (items.length === 0) return wiErr('no_items', 'No unbilled items found for this store, workshop, and period.');
    const total = round2(items.reduce((s, i) => s + Number(i.item_value), 0));
    if (expectedTotal !== null && (Math.abs(total - expectedTotal) > 0.005 || items.length !== expectedCount)) return wiErr('changed', 'The items changed since you reviewed them.');
    const [workshopShare, storeShare] = wiSplit(total, issuer.commission);
    const [, gstAmount, grandTotal] = wiApplyGst(workshopShare, gstMode, gstRate);
    const days = Math.max(0, issuer.terms_days);
    const dueDate = addDays(invoiceDate, days);
    const terms = wiTerms[days] ?? `Net ${days}`;
    const subject = (subjectIn ?? '').trim() !== '' ? [...subjectIn!.trim()].slice(0, 150).join('') : wiSubject(from, to);
    const snapshot = JSON.stringify({
      issuer: { company_name: issuer.company_name, address: issuer.address, phone: issuer.phone, email: issuer.email, gstin: issuer.gstin, state_code: issuer.state_code, state_name: issuer.state_name, notes: issuer.notes, bank_details: issuer.bank_details },
      bill_to: billTo, item_description: issuer.item_description, period_label: wiPeriodLabel(from, to),
    });
    const billNumber = await this.nextInvoiceNumber(workshopId);
    let billId: number;
    try {
      billId = await this.db.tx(async (t) => {
        const ins = await t.execute(
          `INSERT INTO workshop_bills (bill_number, store_id, is_combined, workshop_id, period_start, period_end, invoice_date, due_date,
              terms_label, subject, item_count, total_value, share_percent, gst_mode, gst_rate, gst_amount, workshop_share, store_share, grand_total, snapshot_json, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [billNumber, storeId, storeId === null ? 1 : 0, workshopId, from, to, invoiceDate, dueDate, terms, subject, items.length, total, issuer.commission, gstMode, gstRate, gstAmount, workshopShare, storeShare, grandTotal, snapshot, userId]);
        for (const it of items) await t.execute('INSERT INTO workshop_bill_items (bill_id, order_item_id, item_value) VALUES (?, ?, ?)', [ins.insertId, it.order_item_id, it.item_value]);
        return ins.insertId;
      });
    } catch (e) {
      this.log(`[workshop-invoice] create failed: ${(e as Error).stack}`);
      return wiErr('server_error', 'Could not generate the invoice. Please review and try again.');
    }
    await this.audit.record({ action: 'create', module: 'workshop_bills', recordId: String(billId), newValue: { bill_number: billNumber, total_value: total, workshop_share: workshopShare, is_combined: storeId === null }, userId, ip });
    return { ok: true, bill_id: billId, bill_number: billNumber, workshop_share: workshopShare, grand_total: grandTotal };
  }

  async recordPayment(
    billId: number, amountIn: number, paymentTypeId: number, referenceIn: string | null, paidOn: string, notesIn: string | null, userId: number, scopeWorkshopId: number | null, ip: string | null = null,
  ): Promise<WiResult<{ status: string; amount_paid: number; balance: number }>> {
    const amount = round2(amountIn);
    if (amount <= 0) return wiErr('invalid_request', 'Enter an amount greater than zero.');
    if (!okDate(paidOn)) return wiErr('invalid_request', 'Enter a valid payment date.');
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now());
    if (paidOn > todayStr) return wiErr('invalid_request', 'The payment date cannot be in the future.');
    if (!(await this.db.query('SELECT 1 FROM payment_types WHERE id = ? AND is_active = 1', [paymentTypeId])).length) return wiErr('invalid_request', 'Select a payment method.');
    const reference = (referenceIn ?? '').trim() !== '' ? [...referenceIn!.trim()].slice(0, 100).join('') : null;
    const notes = (notesIn ?? '').trim() !== '' ? [...notesIn!.trim()].slice(0, 255).join('') : null;
    type Out = WiResult<{ status: string; amount_paid: number; balance: number; _old: Raw }>;
    let result: Out;
    try {
      result = await this.db.tx(async (t): Promise<Out> => {
        const [b] = await t.query<Raw>('SELECT id, workshop_id, status, grand_total, amount_paid FROM workshop_bills WHERE id = ? FOR UPDATE', [billId]);
        if (!b || (scopeWorkshopId !== null && Number(b.workshop_id) !== scopeWorkshopId)) return wiErr('not_found', 'Bill not found.');
        if (b.status === 'Void') return wiErr('void', 'This bill is void.');
        if (b.status === 'Paid') return wiErr('already_paid', 'This bill is already marked Paid.');
        const balance = round2(Number(b.grand_total) - Number(b.amount_paid));
        if (amount > balance + WI_PAID_EPSILON) return wiErr('too_much', `The amount is more than the balance due (Rs. ${numberFormat2(balance)}).`);
        await t.execute('INSERT INTO workshop_bill_payments (bill_id, amount, payment_type_id, reference_no, paid_on, notes, received_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [billId, amount, paymentTypeId, reference, paidOn, notes, userId]);
        const newPaid = round2(Number(b.amount_paid) + amount);
        const newStatus = newPaid + WI_PAID_EPSILON >= Number(b.grand_total) ? 'Paid' : 'Partially Paid';
        await t.execute('UPDATE workshop_bills SET amount_paid = ?, status = ?, payment_type_id = ?, reference_no = ?, paid_at = ?, paid_by = ? WHERE id = ?',
          [newPaid, newStatus, paymentTypeId, reference, `${paidOn} ${timeIn(this.tz, this.now())}`, userId, billId]);
        return { ok: true, status: newStatus, amount_paid: newPaid, balance: round2(Number(b.grand_total) - newPaid), _old: b };
      });
    } catch (e) {
      this.log(`[workshop-invoice] payment failed: ${(e as Error).stack}`);
      return wiErr('server_error', 'Could not record the payment. Please try again.');
    }
    if (!result.ok) return result;
    await this.audit.record({
      action: 'update', module: 'workshop_bills', recordId: String(billId), oldValue: { status: result._old.status, amount_paid: Number(result._old.amount_paid) },
      newValue: { status: result.status, amount_paid: result.amount_paid, payment: amount, payment_type_id: paymentTypeId, reference_no: reference }, userId, ip,
    });
    return { ok: true, status: result.status, amount_paid: result.amount_paid, balance: result.balance };
  }

  async voidInvoice(billId: number, reasonIn: string, userId: number, scopeWorkshopId: number | null, ip: string | null = null): Promise<WiResult> {
    const reason = reasonIn.trim();
    if ([...reason].length < 3) return wiErr('invalid_request', 'Enter a reason for voiding this bill.');
    try {
      const r = await this.db.tx(async (t): Promise<WiResult> => {
        const [b] = await t.query<Raw>('SELECT id, workshop_id, status, amount_paid FROM workshop_bills WHERE id = ? FOR UPDATE', [billId]);
        if (!b || (scopeWorkshopId !== null && Number(b.workshop_id) !== scopeWorkshopId)) return wiErr('not_found', 'Bill not found.');
        if (b.status !== 'Unpaid' || Number(b.amount_paid) > 0) return wiErr('cannot_void', 'Only a bill with no payments recorded can be voided.');
        await t.execute("UPDATE workshop_bills SET status = 'Void', voided_at = NOW(), voided_by = ?, void_reason = ? WHERE id = ?", [userId, [...reason].slice(0, 255).join(''), billId]);
        await t.execute('DELETE FROM workshop_bill_items WHERE bill_id = ?', [billId]);
        return { ok: true };
      });
      if (!r.ok) return r;
    } catch (e) {
      this.log(`[workshop-invoice] void failed: ${(e as Error).stack}`);
      return wiErr('server_error', 'Could not void the bill. Please try again.');
    }
    await this.audit.record({ action: 'update', module: 'workshop_bills', recordId: String(billId), oldValue: { status: 'Unpaid' }, newValue: { status: 'Void', reason }, userId, ip });
    return { ok: true };
  }
}
