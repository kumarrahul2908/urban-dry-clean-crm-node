import type { Db } from '../db/pool.js';
import type { AuditLog } from '../audit/auditLog.js';
import { BusinessError, IdempotencyConflictError } from '../lib/errors.js';
import { datePlusDays, yearIn } from '../lib/dates.js';
import { isNumeric, phpEmpty, phpRound, round2, toFloat, toInt } from '../lib/php.js';
import type { CustomerWallet } from './customerWallet.js';
import { generateDocumentNumber, generateInvoiceNumber, generateOrderNumber, generateShortOrderCode } from './documentNumber.js';
import { GarmentTagService } from './garmentTagService.js';
import type { OrderHooks } from './hooks.js';
import type { NotificationService } from './notificationService.js';
import { OrderFinance } from './orderFinance.js';
import type { PricingEngine, RateRow } from './pricingEngine.js';
import { getSetting } from './settings.js';
import { formatCurrency } from './settingsFmt.js';

type Raw = Record<string, any>;
export interface Actor { userId: number; ip?: string | null }
export interface Result { success: boolean; errors?: string[]; [k: string]: any }

import { limitError } from '../tenancy/limits.js';
const clean = (v: unknown): string => String(v ?? '').trim();

/**
 * PHP: in_array($in ?? 'Percent', ['Percent','Flat'], true) ? $in : 'Percent'. When the client omits
 * discount_type the PHP stores NULL (and, because NULL !== 'Percent', prices the discount as FLAT).
 * Kept bug-for-bug so totals never change for an old client; see docs/PARITY.md.
 */
export function phpDiscountType(v: unknown): string | null {
  return ['Percent', 'Flat'].includes((v ?? 'Percent') as string) ? ((v ?? null) as string | null) : 'Percent';
}
const asObj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const asList = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(asObj) : []);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fail = (...errors: string[]): Result => ({ success: false, errors });

interface PricedLine {
  garment_id: number; service_id: number; garment_name: string; service_name: string;
  quantity: number; unit: string; unit_price: number; weight: number | null; weight_rate: number | null;
  subtotal: number; tax_percent: number; brand_id: number | null; color_id: number | null;
  defect_ids: number[]; remarks: string; rate_overridden: boolean; is_manual_override: boolean;
  original_configured_rate: string | null; pieces_per_unit: number; piece_names: string | null;
  discount?: number; tax?: number; total?: number;
}

/**
 * Port of includes/OrderService.php: order creation (piece + laundry/weight), payments, refunds,
 * item add/remove, edit, cancel and the aggregate recalculation. Business rules, messages and
 * rounding are kept 1:1; see docs/PARITY.md for the deliberate differences.
 *
 * Every public method returns {success, errors?...} like the PHP original and never throws for
 * business failures. Unexpected (non-business) errors are logged and reported generically instead
 * of leaking SQL text to the client.
 */
export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly wallet: CustomerWallet,
    private readonly pricing: PricingEngine,
    private readonly finance: OrderFinance,
    private readonly notifications: NotificationService,
    private readonly hooks: OrderHooks,
    private readonly tz: string,
    private readonly log: (m: string) => void = console.error,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Everything that must join one transaction, bound to its Db handle. */
  private scoped(t: Db) {
    return { db: t, audit: this.audit.using(t), wallet: this.wallet.using(t), finance: this.finance.using(t), tags: new GarmentTagService(t) };
  }

  async isEditable(order: { status_id: number }, db: Db = this.db): Promise<boolean> {
    const r = await db.query<{ status_key: string }>('SELECT status_key FROM order_statuses WHERE id = ?', [order.status_id]);
    return r[0]?.status_key === 'order_created';
  }

  // ---------------------------------------------------------------------------------------
  // Pricing of one piece/weight line (shared by createOrder and addItem; messages differ).
  // ---------------------------------------------------------------------------------------
  private async priceLine(raw: Raw, priceListId: number, canManualOverrideRate: boolean, label: { create: boolean; idx: number }): Promise<{ error: string } | { line: PricedLine }> {
    const { db, pricing } = { db: this.db, pricing: this.pricing };
    const c = label.create;
    const garmentId = toInt(raw.garment_id);
    const serviceId = toInt(raw.service_id);
    const [svcRow] = await db.query<{ billing_unit: string }>('SELECT billing_unit FROM services WHERE id = ?', [serviceId]);
    const mode: 'weight' | 'piece' = svcRow?.billing_unit === 'weight' ? 'weight' : 'piece';
    let quantity = toFloat(raw.quantity);
    const weight = toFloat(raw.weight);
    const rateOverrideRaw = raw.rate_override ?? null;
    const hasRateOverride = rateOverrideRaw !== null && rateOverrideRaw !== '';
    const claimsManualOverride = !phpEmpty(raw.manual_override);

    const [g] = await db.query<{ garment_name: string; pieces_per_unit: number | null; piece_names: string | null }>('SELECT garment_name, pieces_per_unit, piece_names FROM garments WHERE id = ?', [garmentId]);
    const garmentName = g?.garment_name || `Garment #${garmentId}`;
    // a Set garment (e.g. 2-piece Suit) is ONE ordered unit but several physical pieces, each tagged; weight lines never multiply
    const piecesPerUnit = mode === 'piece' ? Math.max(1, toInt(g?.pieces_per_unit ?? 1)) : 1;
    const pieceNames = mode === 'piece' ? (g?.piece_names ?? null) : null;
    const [s] = await db.query<{ service_name: string }>('SELECT service_name FROM services WHERE id = ?', [serviceId]);
    const serviceName = s?.service_name || `Service #${serviceId}`;

    const pre = c ? `${garmentName}: ` : '';
    const cap = (t: string) => (c ? t : t.charAt(0).toUpperCase() + t.slice(1));
    if (!garmentId || !serviceId) return { error: c ? `Line ${label.idx + 1}: garment and service are required.` : 'Garment and service are required.' };
    if (mode === 'piece' && quantity <= 0) return { error: `${pre}${cap('quantity must be greater than zero.')}` };
    if (mode === 'weight' && weight <= 0) return { error: `${pre}${cap('weight must be greater than zero.')}` };
    if (hasRateOverride && (!isNumeric(rateOverrideRaw) || toFloat(rateOverrideRaw) < 0)) {
      return { error: `${pre}${cap('the entered rate override must be a non-negative number.')}` };
    }

    const rate = await pricing.getRate(priceListId, garmentId, serviceId);
    const weightRateMissing = mode === 'weight' && (rate === null || rate.weight_rate === null);
    const noConfiguredPrice = rate === null || weightRateMissing;

    let lineSubtotal: number, unitPrice: number, weightSnap: number | null, weightRateSnap: number | null, taxPercent: number, isManual: boolean;
    if (claimsManualOverride) {
      if (!canManualOverrideRate) return { error: `${pre}${cap('you are not authorized to use Manual Rate Override.')}` };
      if (!hasRateOverride) return { error: `${pre}${cap('a manual override rate is required.')}` };
      if (mode === 'weight') {
        const r = toFloat(rateOverrideRaw);
        lineSubtotal = round2(weight * r); unitPrice = 0; weightSnap = weight; weightRateSnap = r; quantity = 1;
      } else {
        const r = toFloat(rateOverrideRaw);
        lineSubtotal = round2(quantity * r); unitPrice = r; weightSnap = null; weightRateSnap = null;
      }
      taxPercent = rate !== null ? toFloat(rate.tax_percent ?? 0) : 0;
      isManual = true;
    } else if (noConfiguredPrice) {
      return {
        error: rate === null
          ? `No price configured for ${garmentName} / ${serviceName}. Please configure a rate before selling this item, or use Manual Rate Override if authorized.`
          : `${garmentName} / ${serviceName} is not configured for weight-based pricing. Use Manual Rate Override if authorized.`,
      };
    } else {
      const rt = rate as RateRow;
      if (mode === 'weight') {
        const r = hasRateOverride ? toFloat(rateOverrideRaw) : toFloat(rt.weight_rate);
        lineSubtotal = round2(weight * r);
        if (rt.min_weight_charge !== null && lineSubtotal < toFloat(rt.min_weight_charge)) lineSubtotal = round2(toFloat(rt.min_weight_charge));
        unitPrice = 0; weightSnap = weight; weightRateSnap = r; quantity = 1;
      } else {
        const r = hasRateOverride ? toFloat(rateOverrideRaw) : toFloat(rt.piece_rate);
        lineSubtotal = round2(quantity * r); unitPrice = r; weightSnap = null; weightRateSnap = null;
      }
      taxPercent = toFloat(rt.tax_percent ?? 0);
      isManual = false;
    }

    return {
      line: {
        garment_id: garmentId, service_id: serviceId, garment_name: garmentName, service_name: serviceName,
        quantity, unit: mode === 'weight' ? 'Kg' : String(raw.unit ?? 'Pcs'), pieces_per_unit: piecesPerUnit, piece_names: pieceNames, unit_price: unitPrice,
        weight: weightSnap, weight_rate: weightRateSnap, subtotal: lineSubtotal, tax_percent: taxPercent,
        brand_id: !phpEmpty(raw.brand_id) ? toInt(raw.brand_id) : null,
        color_id: !phpEmpty(raw.color_id) ? toInt(raw.color_id) : null,
        defect_ids: (Array.isArray(raw.defect_ids) ? raw.defect_ids : []).map(toInt).filter((n: number) => n !== 0),
        remarks: clean(raw.remarks), rate_overridden: hasRateOverride, is_manual_override: isManual,
        original_configured_rate: isManual ? (rate !== null ? (mode === 'weight' ? rate.weight_rate : (rate.piece_rate ?? null)) : null) : null,
      },
    };
  }

  /** Discount/urgent/tax split shared by createOrder, createLaundryOrder (items) — same arithmetic as PHP. */
  private computeTotals(items: { subtotal: number; tax_percent: number; discount?: number; tax?: number; total?: number }[], discountType: string | null, discountValue: number, urgentPct: number, deliveryCharge: number) {
    const subtotal = round2(sum(items.map((i) => i.subtotal)));
    let discountAmount = discountType === 'Percent' ? round2((subtotal * Math.min(discountValue, 100)) / 100) : round2(Math.min(discountValue, subtotal));
    const effectiveDiscountPercent = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
    return { subtotal, discountAmount, effectiveDiscountPercent, finish: (maxCap?: { discountAmount: number }) => {
      if (maxCap) discountAmount = maxCap.discountAmount;
      const urgentCharge = round2(((subtotal - discountAmount) * urgentPct) / 100);
      const taxableBase = round2(subtotal - discountAmount + urgentCharge);
      let runningDiscount = 0, runningTax = 0;
      const n = items.length;
      items.forEach((p, i) => {
        const share = subtotal > 0 ? p.subtotal / subtotal : 0;
        p.discount = i === n - 1 ? round2(discountAmount - runningDiscount) : round2(discountAmount * share);
        p.tax = round2(taxableBase * share * p.tax_percent / 100);
        runningDiscount += p.discount;
        runningTax += p.tax;
        p.total = round2(p.subtotal - p.discount + p.tax);
      });
      const finalDiscount = round2(runningDiscount);
      const taxAmount = round2(runningTax);
      return { discountAmount: finalDiscount, urgentCharge, taxableBase, taxAmount, grandTotal: round2(taxableBase + taxAmount + deliveryCharge) };
    } };
  }

  // ---------------------------------------------------------------------------------------
  // createOrder (per-piece)
  // ---------------------------------------------------------------------------------------
  async createOrder(input: Raw, actor: Actor, canOverrideDiscount: boolean, storeId: number, canManualOverrideRate = false, clientRequestId: string | null = null): Promise<Result> {
    { const lim = await limitError(this.db, 'orders'); if (lim) return { success: false, errors: [lim] }; }
    const errors: string[] = [];
    let warnings: string[] = [];
    const customerId = toInt(input.customer_id);
    const items = Array.isArray(input.items) ? asList(input.items) : [];
    const urgentLevelId = !phpEmpty(input.urgent_level_id) ? toInt(input.urgent_level_id) : null;
    const discountType = phpDiscountType(input.discount_type);
    const discountValue = Math.max(0, toFloat(input.discount_value));
    const homeDelivery = !phpEmpty(input.home_delivery);
    const deliveryCharge = homeDelivery ? Math.max(0, toFloat(input.delivery_charge)) : 0;
    const notes = clean(input.notes);
    const packagingPreference = ['HANGER', 'FOLD'].includes(input.packaging_preference) ? input.packaging_preference : null;
    const priceListOverride = !phpEmpty(input.price_list_id) ? toInt(input.price_list_id) : null;
    const paymentLines = asList(input.payments);
    const walletAmount = Math.max(0, toFloat(input.wallet_amount));

    const [customer] = await this.db.query('SELECT * FROM customers WHERE id = ? AND is_active = 1', [customerId]);
    if (!customer) errors.push('Please select a valid, active customer.');
    if (items.length === 0) errors.push('Add at least one garment to the order.');

    let urgentLevel: Raw | undefined;
    if (urgentLevelId) {
      [urgentLevel] = await this.db.query<Raw>('SELECT * FROM urgent_levels WHERE id = ? AND is_active = 1', [urgentLevelId]);
      if (!urgentLevel) errors.push('Selected urgent level is invalid or inactive.');
    }
    if (errors.length) return { success: false, errors };

    let priceListId: number;
    try {
      priceListId = priceListOverride || (await this.pricing.resolvePriceListId(customerId));
    } catch (e) {
      return fail((e as Error).message);
    }

    const priced: PricedLine[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      const r = await this.priceLine(items[idx]!, priceListId, canManualOverrideRate, { create: true, idx });
      if ('error' in r) errors.push(r.error);
      else priced.push(r.line);
    }
    if (errors.length) return { success: false, errors };
    if (priced.length === 0) return fail('No valid items to order.');

    const totals = this.computeTotals(priced, discountType, discountValue, urgentLevel ? toFloat(urgentLevel.surcharge_percent) : 0, deliveryCharge);
    if (totals.subtotal <= 0) return fail('Order subtotal must be greater than zero.');
    const maxDiscount = toFloat(await getSetting(this.db, 'max_counter_discount_percent', '0'));
    if (!canOverrideDiscount && totals.effectiveDiscountPercent > maxDiscount + 0.01) {
      return fail(`This discount (${round2Str1(totals.effectiveDiscountPercent)}%) exceeds your authorized limit of ${maxDiscount}%. Ask a manager to apply a higher discount.`);
    }
    const { discountAmount, urgentCharge, taxAmount, grandTotal } = totals.finish();
    const subtotal = totals.subtotal;

    let paymentTotal = 0;
    for (const pl of paymentLines) {
      const amt = toFloat(pl.amount);
      if (amt < 0) return fail('Payment amounts cannot be negative.');
      paymentTotal += amt;
    }
    const totalCollected = round2(paymentTotal + walletAmount);
    const allowOverpayment = (await getSetting(this.db, 'allow_overpayment', '0')) === '1';
    if (!allowOverpayment && totalCollected > grandTotal + 0.01) {
      return fail(`Payment amount (${await formatCurrency(this.db, totalCollected)}) cannot exceed the order total (${await formatCurrency(this.db, grandTotal)}).`);
    }
    if (walletAmount > 0) {
      const balance = await this.wallet.getBalance(customerId);
      if (walletAmount > balance + 0.01) {
        return fail(`Requested advance/wallet amount exceeds the customer's available balance of ${await formatCurrency(this.db, balance)}.`);
      }
    }

    const dayOffset = urgentLevel ? toInt(urgentLevel.day_offset) : toInt(await getSetting(this.db, 'default_due_days', '2'));
    const dueDate = !phpEmpty(input.due_date) ? String(input.due_date) : datePlusDays(this.tz, dayOffset, this.now());
    const dueTime = !phpEmpty(input.due_time) ? String(input.due_time) : null;
    const willRecordPayment = (paymentLines.length > 0 && paymentTotal > 0) || walletAmount > 0;

    let orderNumber: string, shortOrderCode: string | null, invoiceNumber: string, paymentNumber: string | null;
    try {
      orderNumber = await generateOrderNumber(this.db, yearIn(this.tz, this.now()));
      shortOrderCode = await generateShortOrderCode(this.db, storeId);
      invoiceNumber = await generateInvoiceNumber(this.db);
      paymentNumber = willRecordPayment ? await generateDocumentNumber(this.db, 'payment_prefix', 6) : null;
    } catch (e) {
      this.log(`[order-service] number generation failed: ${(e as Error).message}`);
      return fail('Could not generate an order number. Please try again.');
    }

    const [status] = await this.db.query<{ id: number }>("SELECT id FROM order_statuses WHERE status_key = 'order_created'");
    if (!status) return fail('System configuration error: order_created status is missing.');

    let orderId = 0;
    try {
      await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const ins = await t.execute(
          `INSERT INTO orders (order_number, short_order_code, invoice_number, customer_id, store_id, price_list_id, order_date,
             due_date, due_time, urgent_level_id, home_delivery, notes, packaging_preference, subtotal, discount_type, discount_value,
             discount_amount, urgent_charge, tax_amount, delivery_charge, grand_total, status_id, order_type, created_by, client_request_id)
           VALUES (?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Counter', ?, ?)`,
          [orderNumber, shortOrderCode, invoiceNumber, customerId, storeId, priceListId, dueDate, dueTime, urgentLevelId, homeDelivery ? 1 : 0,
            notes, packagingPreference, subtotal, discountType, discountValue, discountAmount, urgentCharge, taxAmount, deliveryCharge, grandTotal,
            status.id, actor.userId, clientRequestId],
        );
        orderId = ins.insertId;

        // order-wide running count of physical pieces tagged so far (a 2-piece Suit pushes every later tag number by 2)
        let tagSequence = 1;
        for (let seq = 0; seq < priced.length; seq++) {
          const p = priced[seq]!;
          const it = await t.execute(
            `INSERT INTO order_items (order_id, garment_id, service_id, quantity, unit, pieces_per_unit, piece_names, unit_price, weight,
               weight_rate, is_manual_override, subtotal, discount, tax_percent, tax, total, brand_id, color_id, remarks)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [orderId, p.garment_id, p.service_id, p.quantity, p.unit, p.pieces_per_unit, p.piece_names, p.unit_price, p.weight, p.weight_rate, p.is_manual_override ? 1 : 0,
              p.subtotal, p.discount, p.tax_percent, p.tax, p.total, p.brand_id, p.color_id, p.remarks],
          );
          const itemId = it.insertId;
          if (p.is_manual_override) {
            await sc.audit.record({
              action: 'manual_rate_override', module: 'order_items', recordId: String(itemId),
              oldValue: { configured_rate: p.original_configured_rate },
              newValue: { garment: p.garment_name, service: p.service_name, billing_unit: p.weight !== null ? 'weight' : 'piece', override_rate: p.weight !== null ? p.weight_rate : p.unit_price, authorized_by_user_id: actor.userId, order_id: orderId },
              userId: actor.userId, ip: actor.ip,
            });
          }
          for (const defectId of p.defect_ids) {
            await t.execute('INSERT INTO order_item_defects (order_item_id, defect_id, recorded_by) VALUES (?,?,?)', [itemId, defectId, actor.userId]);
          }
          const pieceCount = Math.max(1, Math.round(p.quantity * p.pieces_per_unit));
          await sc.tags.generateForItem(orderId, orderNumber, itemId, tagSequence, pieceCount);
          tagSequence += pieceCount;
        }

        await sc.audit.record({
          action: 'create', module: 'orders', recordId: String(orderId),
          newValue: { order_number: orderNumber, customer_id: customerId, grand_total: grandTotal, item_count: priced.length, items_with_rate_override: priced.filter((p) => p.rate_overridden).length },
          userId: actor.userId, ip: actor.ip,
        });
        const pay = await this.recordPaymentIn(sc, orderId, customerId, paymentLines, walletAmount, actor, { paymentNumber, clientRequestId: null, requestFingerprint: null });
        warnings = warnings.concat(pay.errors ?? []);
        await sc.finance.recalculatePayments(orderId, actor.userId, actor.ip);
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY' && clientRequestId) return { success: false, errors: ['duplicate_client_request'], error_code: 'duplicate_client_request' };
      return this.wrapSaveError(e, 'Could not save the order — no changes were made.');
    }

    await this.afterCreate(customerId, orderId, orderNumber, grandTotal, true, shortOrderCode ?? orderNumber);
    // short_order_code is THE user-facing identifier: this central return is where every caller (web submit, mobile create) gets it
    return { success: true, order_id: orderId, order_number: shortOrderCode ?? orderNumber, invoice_number: invoiceNumber, grand_total: grandTotal, warnings };
  }

  private wrapSaveError(e: unknown, head: string): Result {
    if (e instanceof BusinessError) return fail(`${head} (${e.message})`);
    this.log(`[order-service] ${head} ${(e as Error)?.stack ?? e}`);
    return fail(`${head} (An unexpected error occurred.)`);
  }

  private async afterCreate(customerId: number, orderId: number, orderNumber: string, grandTotal: number, notify = true, waOrderNumber = orderNumber) {
    // PHP's createLaundryOrder() never wrote the in-app 'order_created' notification; only createOrder() did.
    if (notify) await this.notifications.notify('order_created', `Order ${orderNumber} created for ${await formatCurrency(this.db, grandTotal)}.`, customerId, orderId);
    try {
      await this.hooks.orderCreated({ customerId, orderId, orderNumber: waOrderNumber, grandTotal });
    } catch (e) {
      this.log(`order_created hook failed: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------------------
  /** Filters submitted lines to valid, active payment types; resolves the Wallet type. Pure reads. */
  private async preparePayment(db: Db, paymentLines: Raw[], walletAmountIn: number) {
    const softErrors: string[] = [];
    let walletAmount = walletAmountIn;
    const lines: { payment_type_id: number; amount: number }[] = [];
    for (const pl of paymentLines) {
      const typeId = toInt(pl.payment_type_id);
      const amt = round2(toFloat(pl.amount));
      if (amt <= 0) continue;
      const ok = await db.query('SELECT id FROM payment_types WHERE id = ? AND is_active = 1', [typeId]);
      if (!ok.length) { softErrors.push('Invalid or inactive payment type was skipped.'); continue; }
      lines.push({ payment_type_id: typeId, amount: amt });
    }
    let walletTypeId: number | null = null;
    if (walletAmount > 0) {
      const [w] = await db.query<{ id: number }>("SELECT id FROM payment_types WHERE type_name = 'Wallet' AND is_active = 1");
      walletTypeId = w ? Number(w.id) : null;
      if (!walletTypeId) {
        softErrors.push('Wallet payment type is not configured/active — the advance/wallet amount was not applied.');
        walletAmount = 0;
      }
    }
    return { lines, walletAmount, walletTypeId, softErrors };
  }

  /** Core of recordPayment(): runs on a scoped (transaction) handle; throws on failure. */
  private async recordPaymentIn(
    sc: ReturnType<OrderService['scoped']>, orderId: number, customerId: number, paymentLines: Raw[], walletAmountIn: number, actor: Actor,
    o: { paymentNumber: string | null; clientRequestId: string | null; requestFingerprint: string | null },
  ): Promise<Result> {
    const { db } = sc;
    const { lines, walletAmount, walletTypeId, softErrors } = await this.preparePayment(db, paymentLines, walletAmountIn);
    if (lines.length === 0 && walletAmount <= 0) return { success: true, errors: softErrors };
    if (o.paymentNumber === null) throw new Error('recordPayment() requires a pre-generated paymentNumber inside a transaction.');
    const paymentNumber = o.paymentNumber;

    const [locked] = await db.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!locked) throw new BusinessError(`Order #${orderId} not found.`);

    if (o.clientRequestId !== null) {
      const [ex] = await db.query<Raw>('SELECT id, payment_number, request_fingerprint FROM payments WHERE client_request_id = ? AND order_id = ?', [o.clientRequestId, orderId]);
      if (ex) {
        if (o.requestFingerprint !== null && ex.request_fingerprint === o.requestFingerprint) {
          return { success: true, errors: softErrors, payment_number: ex.payment_number, payment_id: Number(ex.id), idempotent_replay: true };
        }
        throw new IdempotencyConflictError('This request was already submitted with different payment details. Refresh and try again if this is a new payment.');
      }
    }

    const [st] = await db.query<{ status_key: string }>('SELECT status_key FROM order_statuses WHERE id = ?', [locked.status_id]);
    if (st?.status_key === 'cancelled') {
      throw new BusinessError('This order has been cancelled and can no longer accept payments. Use the refund/adjustment workflow instead.');
    }

    const totalPaidSoFar = await sc.finance.netPaid(orderId);
    const trueOutstanding = round2(Number(locked.grand_total) - totalPaidSoFar);
    const requestedTotal = round2(sum(lines.map((l) => l.amount)) + walletAmount);
    const allowOverpayment = (await getSetting(db, 'allow_overpayment', '0')) === '1';
    if (!allowOverpayment && requestedTotal > Math.max(0, trueOutstanding) + 0.01) {
      throw new BusinessError(
        `Payment amount (${await formatCurrency(db, requestedTotal)}) exceeds the current outstanding balance of ${await formatCurrency(db, Math.max(0, trueOutstanding))}. This order may have just been paid by another user — please refresh the order and try again.`,
      );
    }

    if (walletAmount > 0) {
      await sc.wallet.redeem(customerId, walletAmount, `Applied to order/payment ${paymentNumber}`, orderId, actor.userId, actor.ip ?? null);
      lines.push({ payment_type_id: walletTypeId!, amount: round2(walletAmount) });
    }
    const total = round2(sum(lines.map((l) => l.amount)));
    const ins = await db.execute(
      `INSERT INTO payments (payment_number, client_request_id, request_fingerprint, order_id, customer_id, payment_date, total_amount, payment_kind, created_by)
       VALUES (?,?,?,?,?,NOW(),?, 'Partial', ?)`,
      [paymentNumber, o.clientRequestId, o.requestFingerprint, orderId, customerId, total, actor.userId],
    );
    const paymentId = ins.insertId;
    for (const l of lines) await db.execute('INSERT INTO payment_transactions (payment_id, payment_type_id, amount) VALUES (?,?,?)', [paymentId, l.payment_type_id, l.amount]);
    await sc.audit.record({ action: 'payment', module: 'orders', recordId: String(orderId), newValue: { payment_number: paymentNumber, total }, userId: actor.userId, ip: actor.ip });
    await sc.finance.recalculatePayments(orderId, actor.userId, actor.ip);
    return { success: true, errors: softErrors, payment_number: paymentNumber, payment_id: paymentId, _total: total };
  }

  /** recordPayment() with its own transaction (the standalone "collect payment" flow). */
  async recordPayment(
    orderId: number, customerId: number, paymentLines: Raw[], walletAmount: number, actor: Actor,
    o: { clientRequestId?: string | null; requestFingerprint?: string | null } = {},
  ): Promise<Result> {
    // Nothing to record is not an error, and must not burn a payment number (same order as PHP).
    const prep = await this.preparePayment(this.db, paymentLines, walletAmount);
    if (prep.lines.length === 0 && prep.walletAmount <= 0) return { success: true, errors: prep.softErrors };
    let paymentNumber: string;
    try {
      paymentNumber = await generateDocumentNumber(this.db, 'payment_prefix', 6);
    } catch (e) {
      this.log(`[order-service] payment number generation failed: ${(e as Error).message}`);
      return fail('Could not generate a payment number. Please try again.');
    }
    try {
      const res = await this.db.tx((t) =>
        this.recordPaymentIn(this.scoped(t), orderId, customerId, paymentLines, walletAmount, actor, {
          paymentNumber, clientRequestId: o.clientRequestId ?? null, requestFingerprint: o.requestFingerprint ?? null,
        }),
      );
      if (res.success && res.payment_id && !res.idempotent_replay && res._total !== undefined) {
        await this.notifications.notify('payment_received', `Payment of ${await formatCurrency(this.db, res._total)} recorded (receipt ${res.payment_number}).`, customerId, orderId);
      }
      delete res._total;
      return res;
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return { success: false, errors: [e.message], error_code: 'idempotency_conflict' };
      return fail(this.prefixed(e, 'Could not record payment: '));
    }
  }

  private prefixed(e: unknown, prefix: string): string {
    if (e instanceof BusinessError) return `${prefix}${e.message}`;
    this.log(`[order-service] ${prefix}${(e as Error)?.stack ?? e}`);
    return `${prefix}An unexpected error occurred.`;
  }

  // ---------------------------------------------------------------------------------------
  // Refunds
  // ---------------------------------------------------------------------------------------
  async processRefund(
    orderId: number, refundAmount: number, refundLines: Raw[], creditToWallet: boolean, reason: string, remarks: string,
    actor: Actor, clientRequestId: string | null = null, requestFingerprint: string | null = null,
  ): Promise<Result> {
    if (reason.trim() === '') return fail('A refund reason is required.');
    if (refundAmount <= 0) return fail('Refund amount must be greater than zero.');
    const [order] = await this.db.query<Raw>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return fail('Order not found.');

    const lines: { payment_type_id: number; amount: number }[] = [];
    if (creditToWallet) {
      const [w] = await this.db.query<{ id: number }>("SELECT id FROM payment_types WHERE type_name = 'Wallet' AND is_active = 1");
      if (!w) return fail('Wallet payment type is not configured/active — cannot credit wallet.');
      lines.push({ payment_type_id: Number(w.id), amount: round2(refundAmount) });
    } else {
      if (refundLines.length === 0) return fail('At least one refund method/amount line is required.');
      const lineErrors: string[] = [];
      const seen = new Set<number>();
      for (let idx = 0; idx < refundLines.length; idx++) {
        const rl = asObj(refundLines[idx]);
        const label = `Refund line ${idx + 1}`;
        const typeId = toInt(rl.payment_type_id);
        const amt = round2(toFloat(rl.amount));
        if (typeId <= 0) { lineErrors.push(`${label}: a payment method must be selected.`); continue; }
        if (amt <= 0) { lineErrors.push(`${label}: amount must be greater than zero.`); continue; }
        if (seen.has(typeId)) {
          const [n] = await this.db.query<{ type_name: string }>('SELECT type_name FROM payment_types WHERE id = ?', [typeId]);
          lineErrors.push(`${label}: duplicate payment method "${n?.type_name || `payment type #${typeId}`}" — combine it into a single line instead of listing it twice.`);
          continue;
        }
        const [active] = await this.db.query<{ type_name: string }>('SELECT type_name FROM payment_types WHERE id = ? AND is_active = 1', [typeId]);
        if (!active) {
          const [any] = await this.db.query<{ type_name: string }>('SELECT type_name FROM payment_types WHERE id = ?', [typeId]);
          lineErrors.push(any ? `${label}: payment method "${any.type_name}" is currently inactive and cannot be used for a refund.` : `${label}: payment method (#${typeId}) does not exist.`);
          continue;
        }
        seen.add(typeId);
        lines.push({ payment_type_id: typeId, amount: amt });
      }
      if (lineErrors.length) return { success: false, errors: lineErrors };
      if (lines.length === 0) return fail('At least one valid refund method/amount line is required.');
      const linesTotal = round2(sum(lines.map((l) => l.amount)));
      if (Math.abs(linesTotal - refundAmount) > 0.01) {
        return fail(`Refund method amounts (${await formatCurrency(this.db, linesTotal)}) must add up exactly to the refund amount (${await formatCurrency(this.db, refundAmount)}).`);
      }
    }

    let refundNumber: string;
    try {
      refundNumber = await generateDocumentNumber(this.db, 'refund_prefix', 6);
    } catch {
      return fail('Could not generate a refund number. Please try again.');
    }

    try {
      return await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const [locked] = await t.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
        if (!locked) throw new BusinessError(`Order #${orderId} not found.`);

        if (clientRequestId !== null) {
          const [ex] = await t.query<Raw>('SELECT id, payment_number, request_fingerprint FROM payments WHERE client_request_id = ? AND order_id = ?', [clientRequestId, orderId]);
          if (ex) {
            if (requestFingerprint !== null && ex.request_fingerprint === requestFingerprint) {
              return { success: true, errors: [], refund_number: ex.payment_number, payment_id: Number(ex.id), idempotent_replay: true } as Result;
            }
            throw new IdempotencyConflictError('This refund request was already submitted with different details. Refresh and try again if this is a new refund.');
          }
        }

        const netPaid = await sc.finance.netPaid(orderId);
        if (refundAmount > Math.max(0, netPaid) + 0.01) {
          throw new BusinessError(
            `Refund amount (${await formatCurrency(t, refundAmount)}) exceeds the net amount actually paid on this order (${await formatCurrency(t, Math.max(0, netPaid))}). This may have changed since the page loaded — please refresh and try again.`,
          );
        }

        const combinedRemarks = (reason + (remarks !== '' ? ` — ${remarks}` : '')).trim();
        const ins = await t.execute(
          `INSERT INTO payments (payment_number, client_request_id, request_fingerprint, order_id, customer_id, payment_date, total_amount, payment_kind, remarks, approved_by, created_by)
           VALUES (?,?,?,?,?,NOW(),?, 'Refund', ?, ?, ?)`,
          [refundNumber, clientRequestId, requestFingerprint, orderId, locked.customer_id, refundAmount, combinedRemarks, actor.userId, actor.userId],
        );
        const paymentId = ins.insertId;
        for (const l of lines) await t.execute('INSERT INTO payment_transactions (payment_id, payment_type_id, amount) VALUES (?,?,?)', [paymentId, l.payment_type_id, l.amount]);
        if (creditToWallet) {
          await sc.wallet.deposit(Number(locked.customer_id), refundAmount, 'Refund', `Refund for order ${locked.order_number} (${refundNumber})`, orderId, actor.userId, actor.ip ?? null);
        }
        await sc.audit.record({
          action: 'refund', module: 'orders', recordId: String(orderId),
          newValue: { refund_number: refundNumber, amount: refundAmount, method: creditToWallet ? 'Wallet Credit' : 'Original Method', reason, approved_by: actor.userId },
          userId: actor.userId, ip: actor.ip,
        });
        await sc.finance.recalculatePayments(orderId, actor.userId, actor.ip);
        return { success: true, refund_number: refundNumber, payment_id: paymentId } as Result;
      });
    } catch (e) {
      if (e instanceof IdempotencyConflictError) return { success: false, errors: [e.message], error_code: 'idempotency_conflict' };
      return fail(this.prefixed(e, 'Could not process refund: '));
    }
  }

  // ---------------------------------------------------------------------------------------
  // Laundry (per-weight) order
  // ---------------------------------------------------------------------------------------
  async createLaundryOrder(input: Raw, actor: Actor, canOverrideDiscount: boolean, storeId: number, clientRequestId: string | null = null): Promise<Result> {
    { const lim = await limitError(this.db, 'orders'); if (lim) return { success: false, errors: [lim] }; }
    const errors: string[] = [];
    let warnings: string[] = [];
    const customerId = toInt(input.customer_id);
    const batches = Array.isArray(input.batches) ? asList(input.batches) : [];
    const urgentLevelId = !phpEmpty(input.urgent_level_id) ? toInt(input.urgent_level_id) : null;
    const discountType = phpDiscountType(input.discount_type);
    const discountValue = Math.max(0, toFloat(input.discount_value));
    const homeDelivery = !phpEmpty(input.home_delivery);
    const deliveryCharge = homeDelivery ? Math.max(0, toFloat(input.delivery_charge)) : 0;
    const notes = clean(input.notes);
    const packagingPreference = ['HANGER', 'FOLD'].includes(input.packaging_preference) ? input.packaging_preference : null;
    const paymentLines = asList(input.payments);
    const walletAmount = Math.max(0, toFloat(input.wallet_amount));

    const [customer] = await this.db.query('SELECT * FROM customers WHERE id = ? AND is_active = 1', [customerId]);
    if (!customer) errors.push('Please select a valid, active customer.');
    if (batches.length === 0) errors.push('Add at least one Laundry batch to the order.');
    let urgentLevel: Raw | undefined;
    if (urgentLevelId) {
      [urgentLevel] = await this.db.query<Raw>('SELECT * FROM urgent_levels WHERE id = ? AND is_active = 1', [urgentLevelId]);
      if (!urgentLevel) errors.push('Selected urgent level is invalid or inactive.');
    }
    if (errors.length) return { success: false, errors };

    let priceListId: number;
    try {
      priceListId = await this.pricing.resolvePriceListId(customerId);
    } catch (e) {
      return fail((e as Error).message);
    }

    interface Batch { service_id: number; service_name: string; weight: number; rate: number; subtotal: number; tax_percent: number; garment_count: number; garments: { garment_id: number; garment_name: string }[]; discount?: number; tax?: number; total?: number }
    const priced: Batch[] = [];
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]!;
      const serviceId = toInt(batch.service_id);
      const weight = toFloat(batch.weight);
      const rate = toFloat(batch.rate);
      const garmentLines = Array.isArray(batch.garments) ? asList(batch.garments) : [];
      const [service] = await this.db.query<{ service_name: string; billing_unit: string }>('SELECT service_name, billing_unit FROM services WHERE id = ? AND is_active = 1', [serviceId]);
      const b = `Batch ${bi + 1}`;
      if (!service) { errors.push(`${b}: service is invalid or inactive.`); continue; }
      if (service.billing_unit !== 'weight') { errors.push(`${b}: ${service.service_name} is not a weight-based service and cannot be used in a Per-Weight order.`); continue; }
      if (weight <= 0) { errors.push(`${b}: weight must be greater than zero.`); continue; }
      if (rate <= 0) { errors.push(`${b}: rate per KG must be greater than zero.`); continue; }
      if (garmentLines.length === 0) { errors.push(`${b}: at least one garment must be identified for tagging.`); continue; }

      const expanded: { garment_id: number; garment_name: string }[] = [];
      const declared = toInt(batch.garment_count);
      let bad = false;
      for (const line of garmentLines) {
        const garmentId = toInt(line.garment_id);
        const qty = toInt(line.quantity);
        if (qty <= 0) continue;
        const [g] = await this.db.query<{ garment_name: string; is_active: number }>('SELECT garment_name, is_active FROM garments WHERE id = ?', [garmentId]);
        if (!g || !g.is_active) { errors.push(`${b}: one of the selected garment types is invalid or inactive.`); bad = true; break; }
        for (let k = 0; k < qty; k++) expanded.push({ garment_id: garmentId, garment_name: g.garment_name });
      }
      if (bad) continue;
      if (expanded.length !== declared) {
        errors.push(`${b}: identified garments (${expanded.length}) do not match the declared garment count (${declared}). Please verify garment quantity.`);
        continue;
      }
      priced.push({ service_id: serviceId, service_name: service.service_name, weight, rate, subtotal: round2(weight * rate), tax_percent: 0, garment_count: declared, garments: expanded });
    }
    if (errors.length) return { success: false, errors };
    if (priced.length === 0) return fail('No valid Laundry batch to save.');

    const totals = this.computeTotals(priced, discountType, discountValue, urgentLevel ? toFloat(urgentLevel.surcharge_percent) : 0, deliveryCharge);
    if (totals.subtotal <= 0) return fail('Order subtotal must be greater than zero.');
    const maxDiscount = toFloat(await getSetting(this.db, 'max_counter_discount_percent', '0'));
    if (!canOverrideDiscount && totals.effectiveDiscountPercent > maxDiscount + 0.01) {
      return fail(`This discount (${String(phpRoundTo1(totals.effectiveDiscountPercent))}%) exceeds your authorized limit of ${maxDiscount}%. Ask a manager to apply a higher discount.`);
    }
    const { discountAmount, urgentCharge, taxAmount, grandTotal } = totals.finish();
    const subtotal = totals.subtotal;

    const dayOffset = urgentLevel ? toInt(urgentLevel.day_offset) : toInt(await getSetting(this.db, 'default_due_days', '2'));
    const dueDate = !phpEmpty(input.due_date) ? String(input.due_date) : datePlusDays(this.tz, dayOffset, this.now());
    const dueTime = !phpEmpty(input.due_time) ? String(input.due_time) : null;
    const willRecordPayment = (paymentLines.length > 0 && sum(paymentLines.map((p) => toFloat(p.amount))) > 0) || walletAmount > 0;

    let orderNumber: string, shortOrderCode: string | null, invoiceNumber: string, paymentNumber: string | null;
    try {
      orderNumber = await generateOrderNumber(this.db, yearIn(this.tz, this.now()));
      shortOrderCode = await generateShortOrderCode(this.db, storeId);
      invoiceNumber = await generateInvoiceNumber(this.db);
      paymentNumber = willRecordPayment ? await generateDocumentNumber(this.db, 'payment_prefix', 6) : null;
    } catch {
      return fail('Could not generate an order number. Please try again.');
    }
    const [status] = await this.db.query<{ id: number }>("SELECT id FROM order_statuses WHERE status_key = 'order_created'");
    if (!status) return fail('System configuration error: order_created status is missing.');

    let orderId = 0;
    try {
      await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const ins = await t.execute(
          `INSERT INTO orders (order_number, short_order_code, invoice_number, customer_id, store_id, price_list_id, order_date,
             due_date, due_time, urgent_level_id, home_delivery, notes, packaging_preference, subtotal, discount_type, discount_value,
             discount_amount, urgent_charge, tax_amount, delivery_charge, grand_total, status_id, order_type, order_mode, created_by, client_request_id)
           VALUES (?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Counter', 'weight', ?, ?)`,
          [orderNumber, shortOrderCode, invoiceNumber, customerId, storeId, priceListId, dueDate, dueTime, urgentLevelId, homeDelivery ? 1 : 0,
            notes, packagingPreference, subtotal, discountType, discountValue, discountAmount, urgentCharge, taxAmount, deliveryCharge, grandTotal,
            status.id, actor.userId, clientRequestId],
        );
        orderId = ins.insertId;
        let totalGarmentSequence = 0;
        for (const p of priced) {
          const it = await t.execute(
            `INSERT INTO order_items (order_id, garment_id, service_id, quantity, unit, unit_price, weight,
               weight_rate, subtotal, discount, tax_percent, tax, total, remarks)
             VALUES (?, NULL, ?, ?, 'Kg', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orderId, p.service_id, p.garment_count, p.weight, p.rate, p.subtotal, p.discount, p.tax_percent, p.tax, p.total, null],
          );
          let seqWithin = 1;
          for (const garment of p.garments) {
            const lg = await t.execute('INSERT INTO laundry_garments (order_item_id, garment_id, sequence) VALUES (?,?,?)', [it.insertId, garment.garment_id, seqWithin]);
            totalGarmentSequence++;
            await sc.tags.generateForLaundryGarment(orderId, orderNumber, lg.insertId, totalGarmentSequence);
            seqWithin++;
          }
        }
        await sc.audit.record({
          action: 'create', module: 'orders', recordId: String(orderId),
          newValue: { order_number: orderNumber, order_mode: 'weight', customer_id: customerId, grand_total: grandTotal, batch_count: priced.length, total_garments: sum(priced.map((p) => p.garment_count)) },
          userId: actor.userId, ip: actor.ip,
        });
        const pay = await this.recordPaymentIn(sc, orderId, customerId, paymentLines, walletAmount, actor, { paymentNumber, clientRequestId: null, requestFingerprint: null });
        warnings = pay.errors ?? [];
        await sc.finance.recalculatePayments(orderId, actor.userId, actor.ip);
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY' && clientRequestId) return { success: false, errors: ['duplicate_client_request'], error_code: 'duplicate_client_request' };
      return this.wrapSaveError(e, 'Could not save the Laundry order — no changes were made.');
    }

    await this.afterCreate(customerId, orderId, orderNumber, grandTotal, false, shortOrderCode ?? orderNumber);
    return { success: true, order_id: orderId, order_number: shortOrderCode ?? orderNumber, grand_total: grandTotal, warnings };
  }

  // ---------------------------------------------------------------------------------------
  // Editing
  // ---------------------------------------------------------------------------------------
  async addItem(orderId: number, raw: Raw, actor: Actor, canManualOverrideRate = false, clientRequestId: string | null = null): Promise<Result> {
    const [order] = await this.db.query<Raw>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return fail('Order not found.');
    if (!(await this.isEditable(order as { status_id: number }))) return fail('This order can no longer be edited (processing has begun).');

    const r = await this.priceLine(raw, Number(order.price_list_id), canManualOverrideRate, { create: false, idx: 0 });
    if ('error' in r) return fail(r.error);
    const p = r.line;

    try {
      const itemId = await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const [locked] = await t.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
        if (!locked || !(await this.isEditable(locked as { status_id: number }, t))) {
          throw new BusinessError('This order can no longer be edited — its status changed a moment ago.');
        }
        const ins = await t.execute(
          `INSERT INTO order_items (order_id, garment_id, service_id, quantity, unit, pieces_per_unit, piece_names, unit_price, weight,
             weight_rate, is_manual_override, subtotal, discount, tax_percent, tax, total, brand_id, color_id, remarks, client_request_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,0,?,?,?,?,?)`,
          [orderId, p.garment_id, p.service_id, p.quantity, p.unit, p.pieces_per_unit, p.piece_names, p.unit_price, p.weight, p.weight_rate, p.is_manual_override ? 1 : 0,
            p.subtotal, p.tax_percent, p.subtotal, p.brand_id, p.color_id, p.remarks, clientRequestId],
        );
        const id = ins.insertId;
        for (const defectId of p.defect_ids) await t.execute('INSERT INTO order_item_defects (order_item_id, defect_id, recorded_by) VALUES (?,?,?)', [id, defectId, actor.userId]);
        await sc.audit.record({ action: 'edit', module: 'orders', recordId: String(orderId), newValue: { item_added: id, garment_id: p.garment_id }, userId: actor.userId, ip: actor.ip });
        if (p.is_manual_override) {
          await sc.audit.record({
            action: 'manual_rate_override', module: 'order_items', recordId: String(id),
            oldValue: { configured_rate: p.original_configured_rate },
            newValue: { garment: p.garment_name, service: p.service_name, billing_unit: p.weight !== null ? 'weight' : 'piece', override_rate: p.weight !== null ? p.weight_rate : p.unit_price, authorized_by_user_id: actor.userId, order_id: orderId },
            userId: actor.userId, ip: actor.ip,
          });
        }
        // sequence = physical pieces already tagged on every OTHER item + 1 (a Set item may have contributed several)
        const [pre] = await t.query<{ n: string | number }>('SELECT COALESCE(SUM(quantity * pieces_per_unit), 0) AS n FROM order_items WHERE order_id = ? AND id != ?', [orderId, id]);
        // also never below the highest tag number already issued on this order: after an item in the middle was removed, the plain piece count
        // would re-issue a number that is still on a printed tag (the PHP original then fails on the duplicate barcode_value)
        const [top] = await t.query<{ n: string | number | null }>('SELECT MAX(item_sequence) AS n FROM barcodes WHERE order_id = ?', [orderId]);
        const sequence = Math.max(Math.round(Number(pre?.n ?? 0)), Number(top?.n ?? 0)) + 1;
        const pieceCount = Math.max(1, Math.round(p.quantity * p.pieces_per_unit));
        await sc.tags.generateForItem(orderId, String(order.order_number), id, sequence, pieceCount);
        await this.recalculateAggregates(sc, orderId, actor, true);
        return id;
      });
      return { success: true, item_id: itemId };
    } catch (e) {
      if (clientRequestId !== null && (e as { code?: string }).code === 'ER_DUP_ENTRY') {
        const [dup] = await this.db.query<{ id: number }>('SELECT id FROM order_items WHERE order_id = ? AND client_request_id = ?', [orderId, clientRequestId]);
        if (dup) return { success: true, item_id: Number(dup.id), idempotent_replay: true };
      }
      return fail(this.prefixed(e, 'Could not add item: '));
    }
  }

  /**
   * Changes quantity/weight/rate/brand/colour/remarks/defects of an item already on an editable order, re-pricing exactly like
   * addItem(). garment_id/service_id are not editable (that is "remove + add"), and tags are never regenerated on a quantity change
   * (renumbering already printed tags would be harmful).
   */
  async updateItem(orderId: number, itemId: number, raw: Raw, actor: Actor, canManualOverrideRate = false): Promise<Result> {
    const [order] = await this.db.query<Raw>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return fail('Order not found.');
    if (!(await this.isEditable(order as { status_id: number }))) return fail('This order can no longer be edited (processing has begun).');
    const [existing] = await this.db.query<Raw>('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]);
    if (!existing) return fail('Item not found on this order.');

    const garmentId = toInt(existing.garment_id);
    const serviceId = toInt(existing.service_id);
    const mode: 'weight' | 'piece' = existing.weight !== null ? 'weight' : 'piece';
    const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== null && raw[k] !== undefined;
    let quantity = toFloat(has('quantity') ? raw.quantity : existing.quantity);
    const weight = toFloat(has('weight') ? raw.weight : existing.weight);
    const rateOverrideRaw = raw.rate_override ?? null;
    const hasRateOverride = rateOverrideRaw !== null && rateOverrideRaw !== '';
    const claimsManualOverride = Object.prototype.hasOwnProperty.call(raw, 'manual_override') ? !phpEmpty(raw.manual_override) : Number(existing.is_manual_override) === 1;

    if (mode === 'piece' && quantity <= 0) return fail('Quantity must be greater than zero.');
    if (mode === 'weight' && weight <= 0) return fail('Weight must be greater than zero.');
    if (hasRateOverride && (!isNumeric(rateOverrideRaw) || toFloat(rateOverrideRaw) < 0)) return fail('The entered rate override must be a non-negative number.');

    const [g] = await this.db.query<{ garment_name: string }>('SELECT garment_name FROM garments WHERE id = ?', [garmentId]);
    const garmentName = g?.garment_name || `Garment #${garmentId}`;
    const [sv] = await this.db.query<{ service_name: string }>('SELECT service_name FROM services WHERE id = ?', [serviceId]);
    const serviceName = sv?.service_name || `Service #${serviceId}`;

    const rate = await this.pricing.getRate(toInt(order.price_list_id), garmentId, serviceId);
    const weightRateMissing = mode === 'weight' && (rate === null || rate.weight_rate === null);
    const noConfiguredPrice = rate === null || weightRateMissing;
    let originalConfiguredRate: string | null = null;
    let lineSubtotal: number, unitPrice: number, weightSnap: number | null, weightRateSnap: number | null, taxPercent: number, isManual: boolean;
    if (claimsManualOverride) {
      if (!canManualOverrideRate) return fail('You are not authorized to use Manual Rate Override.');
      if (!hasRateOverride) return fail('A manual override rate is required.');
      originalConfiguredRate = rate !== null ? (mode === 'weight' ? rate.weight_rate : (rate.piece_rate ?? null)) : null;
      const r = toFloat(rateOverrideRaw);
      if (mode === 'weight') { lineSubtotal = round2(weight * r); unitPrice = 0; weightSnap = weight; weightRateSnap = r; quantity = 1; }
      else { lineSubtotal = round2(quantity * r); unitPrice = r; weightSnap = null; weightRateSnap = null; }
      taxPercent = rate !== null ? toFloat(rate.tax_percent ?? 0) : 0;
      isManual = true;
    } else if (noConfiguredPrice) {
      return fail(rate === null
        ? `No price configured for ${garmentName} / ${serviceName}. Please configure a rate before selling this item, or use Manual Rate Override if authorized.`
        : `${garmentName} / ${serviceName} is not configured for weight-based pricing. Use Manual Rate Override if authorized.`);
    } else {
      const rt = rate as RateRow;
      taxPercent = toFloat(rt.tax_percent ?? 0);
      if (mode === 'weight') {
        const r = hasRateOverride ? toFloat(rateOverrideRaw) : toFloat(rt.weight_rate);
        lineSubtotal = round2(weight * r);
        if (rt.min_weight_charge !== null && lineSubtotal < toFloat(rt.min_weight_charge)) lineSubtotal = round2(toFloat(rt.min_weight_charge));
        unitPrice = 0; weightSnap = weight; weightRateSnap = r; quantity = 1;
      } else {
        const r = hasRateOverride ? toFloat(rateOverrideRaw) : toFloat(rt.piece_rate);
        lineSubtotal = round2(quantity * r); unitPrice = r; weightSnap = null; weightRateSnap = null;
      }
      isManual = false;
    }

    try {
      await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const [locked] = await t.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
        if (!locked || !(await this.isEditable(locked as { status_id: number }, t))) throw new BusinessError('This order can no longer be edited — its status changed a moment ago.');
        await t.execute(
          `UPDATE order_items SET quantity=?, unit_price=?, weight=?, weight_rate=?, is_manual_override=?,
             subtotal=?, tax_percent=?, tax=?, total=?, brand_id=?, color_id=?, remarks=? WHERE id=?`,
          [quantity, unitPrice, weightSnap, weightRateSnap, isManual ? 1 : 0, lineSubtotal, taxPercent, lineSubtotal, lineSubtotal,
            Object.prototype.hasOwnProperty.call(raw, 'brand_id') ? (!phpEmpty(raw.brand_id) ? toInt(raw.brand_id) : null) : existing.brand_id,
            Object.prototype.hasOwnProperty.call(raw, 'color_id') ? (!phpEmpty(raw.color_id) ? toInt(raw.color_id) : null) : existing.color_id,
            Object.prototype.hasOwnProperty.call(raw, 'remarks') ? clean(raw.remarks) : existing.remarks, itemId],
        );
        if (Object.prototype.hasOwnProperty.call(raw, 'defect_ids')) {
          await t.execute('DELETE FROM order_item_defects WHERE order_item_id = ?', [itemId]);
          for (const d of (Array.isArray(raw.defect_ids) ? raw.defect_ids : []).map(toInt).filter((n: number) => n !== 0)) {
            await t.execute('INSERT INTO order_item_defects (order_item_id, defect_id, recorded_by) VALUES (?,?,?)', [itemId, d, actor.userId]);
          }
        }
        await sc.audit.record({ action: 'edit', module: 'order_items', recordId: String(itemId), oldValue: existing, newValue: { quantity, unit_price: unitPrice, weight: weightSnap, total: lineSubtotal }, userId: actor.userId, ip: actor.ip });
        if (isManual && Number(existing.is_manual_override) !== 1) {
          await sc.audit.record({
            action: 'manual_rate_override', module: 'order_items', recordId: String(itemId),
            oldValue: { configured_rate: originalConfiguredRate },
            newValue: { garment: garmentName, service: serviceName, billing_unit: weightSnap !== null ? 'weight' : 'piece', override_rate: weightSnap !== null ? weightRateSnap : unitPrice, authorized_by_user_id: actor.userId, order_id: orderId },
            userId: actor.userId, ip: actor.ip,
          });
        }
        await this.recalculateAggregates(sc, orderId, actor, true);
      });
    } catch (e) {
      return fail(this.prefixed(e, 'Could not update item: '));
    }
    return { success: true };
  }

  /**
   * Renumbers every remaining tag/barcode on an order to a clean, gapless 1..N (N = total
   * physical pieces across its order_items), in their existing relative order. Called after
   * removeItem() closes a gap left by a deleted item. Also rebuilds barcode_value/
   * short_qr_payload — they are separate, pre-built strings (e.g. "A0005-18") stored at
   * tag-creation time via GarmentTagService.buildIdentifier(), not a live view of item_sequence,
   * so fixing the sequence column alone leaves the printed tag-id text stale.
   * Deliberately simple: doesn't try to preserve any particular tag's OLD number — the whole
   * point is that the old numbering is no longer trustworthy once an item's gone. Accepted
   * tradeoff: a tag already printed before the removal may no longer match its physical
   * garment's new number (items changed, so tags need reprinting anyway; a clean 1..N beats a
   * confusing 1..N-with-a-hole).
   */
  private async renumberTagSequences(t: Db, orderId: number): Promise<void> {
    const [order] = await t.query<{ short_order_code: string | null; order_number: string }>('SELECT short_order_code, order_number FROM orders WHERE id = ?', [orderId]);
    const code = order?.short_order_code ?? order?.order_number ?? null;
    if (code === null) return;
    const ids = (await t.query<{ id: number }>('SELECT id FROM barcodes WHERE order_id = ? ORDER BY item_sequence ASC, piece_index ASC', [orderId])).map((r) => Number(r.id));
    if (!ids.length) return;
    const tags = new GarmentTagService(t);
    let seq = 1;
    for (const barcodeId of ids) {
      const newIdentifier = await tags.buildIdentifier(code, seq);
      await t.execute('UPDATE barcodes SET item_sequence = ?, barcode_value = ?, short_qr_payload = ? WHERE id = ?', [seq, newIdentifier, newIdentifier, barcodeId]);
      seq++;
    }
  }

  async removeItem(orderId: number, itemId: number, actor: Actor): Promise<Result> {
    const [order] = await this.db.query<Raw>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return fail('Order not found.');
    if (!(await this.isEditable(order as { status_id: number }))) return fail('This order can no longer be edited (processing has begun).');
    const [{ n }] = (await this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [orderId])) as [{ n: number }];
    if (Number(n) <= 1) return fail('Cannot remove the last item on an order — cancel the order instead.');
    const [item] = await this.db.query<Raw>('SELECT * FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId]);
    if (!item) return fail('Item not found on this order.');
    try {
      await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const [locked] = await t.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
        if (!locked || !(await this.isEditable(locked as { status_id: number }, t))) throw new BusinessError('This order can no longer be edited — its status changed a moment ago.');
        await t.execute('DELETE FROM order_items WHERE id = ?', [itemId]);
        await sc.audit.record({ action: 'edit', module: 'orders', recordId: String(orderId), oldValue: item, newValue: { item_removed: itemId }, userId: actor.userId, ip: actor.ip });
        await this.renumberTagSequences(t, orderId);
        await this.recalculateAggregates(sc, orderId, actor, true);
      });
    } catch (e) {
      return fail(this.prefixed(e, 'Could not remove item: '));
    }
    return { success: true };
  }

  async editOrder(orderId: number, changes: Raw, actor: Actor, reason: string, canOverrideDiscount: boolean): Promise<Result> {
    const [order] = await this.db.query<Raw>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return fail('Order not found.');
    if (!(await this.isEditable(order as { status_id: number }))) return fail('This order can no longer be edited (processing has begun).');

    const has = (k: string) => Object.prototype.hasOwnProperty.call(changes, k);
    const financialFieldsChanged =
      (changes.discount_type !== undefined && changes.discount_type !== null && changes.discount_type !== order.discount_type) ||
      (changes.discount_value !== undefined && changes.discount_value !== null && toFloat(changes.discount_value) !== Number(order.discount_value)) ||
      (has('urgent_level_id') && toInt(changes.urgent_level_id ?? 0) !== toInt(order.urgent_level_id ?? 0));
    if (financialFieldsChanged && reason.trim() === '') return fail('A reason is required when changing discount or urgent level on an existing order.');

    const allowed = ['due_date', 'due_time', 'urgent_level_id', 'discount_type', 'discount_value', 'notes', 'workshop_notes', 'home_delivery', 'delivery_charge'];
    const updates: Raw = {};
    for (const f of allowed) if (has(f)) updates[f] = changes[f];
    if (Object.keys(updates).length === 0) return fail('No changes submitted.');

    try {
      await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const [locked] = await t.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
        if (!locked || !(await this.isEditable(locked as { status_id: number }, t))) throw new BusinessError('This order can no longer be edited — its status changed a moment ago.');
        const cols = Object.keys(updates);
        await t.execute(`UPDATE orders SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_by = ? WHERE id = ?`, [...cols.map((c) => updates[c]), actor.userId, orderId]);
        await sc.audit.record({ action: 'edit', module: 'orders', recordId: String(orderId), oldValue: order, newValue: { ...updates, reason }, userId: actor.userId, ip: actor.ip });
        await this.recalculateAggregates(sc, orderId, actor, canOverrideDiscount);
      });
    } catch (e) {
      return fail(this.prefixed(e, 'Could not update order: '));
    }
    return { success: true };
  }

  async cancelOrder(orderId: number, reason: string, actor: Actor): Promise<Result> {
    if (reason.trim() === '') return fail('A cancellation reason is required.');
    const [order] = await this.db.query<Raw>('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) return fail('Order not found.');
    if (!(await this.isEditable(order as { status_id: number }))) return fail('This order cannot be cancelled — processing has already begun.');
    const [cancelled] = await this.db.query<{ id: number }>("SELECT id FROM order_statuses WHERE status_key = 'cancelled'");
    if (!cancelled) return fail('System configuration error: cancelled status is missing.');

    let hasEffectivePayment = false;
    let effectivePaid = 0;
    try {
      await this.db.tx(async (t) => {
        const sc = this.scoped(t);
        const [locked] = await t.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
        if (!locked || !(await this.isEditable(locked as { status_id: number }, t))) throw new BusinessError('This order can no longer be cancelled — its status changed since this page loaded.');
        effectivePaid = await sc.finance.netPaid(orderId);
        hasEffectivePayment = effectivePaid > 0.01;
        await t.execute('UPDATE orders SET status_id = ?, cancelled_at = NOW(), cancelled_by = ?, cancelled_reason = ?, updated_by = ? WHERE id = ?', [cancelled.id, actor.userId, reason, actor.userId, orderId]);
        await sc.finance.markReceivableCancelled(orderId, hasEffectivePayment);
        await sc.audit.record({
          action: 'cancel', module: 'orders', recordId: String(orderId), oldValue: { status: order.status_id },
          newValue: { reason, effective_paid: effectivePaid, receivable_status: hasEffectivePayment ? 'Refund Due' : 'Cancelled' },
          userId: actor.userId, ip: actor.ip,
        });
      });
    } catch (e) {
      return fail(this.prefixed(e, 'Could not cancel order: '));
    }
    const warning = hasEffectivePayment
      ? `This order had a net effective payment of ${await formatCurrency(this.db, effectivePaid)} on file, now due back to the customer as a refund/credit. Payments have NOT been deleted or auto-refunded — process the refund/adjustment manually via the customer wallet or accounts, per your store policy. The receivable has been marked "Refund Due" so it no longer appears as a normal outstanding balance.`
      : null;
    return { success: true, warning };
  }

  /**
   * Sets orders.status_id to the 'delivered' order_status, optionally also calling recordPayment()
   * if payment lines were given. A failed payment attempt does NOT roll back the delivery status
   * change -- the garment has physically left the counter either way; the order simply stays (or
   * becomes) Due, retryable later via the Due List. payment_type_id=0 / amount<=0 means "Due" was
   * chosen -- nothing recorded, same as recordPayment() already does with an empty array.
   */
  async markDelivered(orderId: number, actor: Actor, paymentLines: Raw[] = []): Promise<Result> {
    const [o] = await this.db.query<Raw>('SELECT id, customer_id, status_id FROM orders WHERE id = ?', [orderId]);
    if (!o) return fail('Order not found.');
    const [delivered] = await this.db.query<{ id: number }>("SELECT id FROM order_statuses WHERE status_key = 'delivered'");
    if (!delivered) return fail('Delivered status is not configured.');
    try {
      await this.db.tx(async (t) => {
        await t.execute('UPDATE orders SET status_id = ? WHERE id = ?', [delivered.id, orderId]);
        await this.audit.using(t).record({ action: 'edit', module: 'orders', recordId: String(orderId), oldValue: { status_id: o.status_id }, newValue: { status_id: delivered.id }, userId: actor.userId, ip: actor.ip });
      });
    } catch (e) {
      return fail(this.prefixed(e, 'Could not mark the order delivered: '));
    }
    let paymentErrors: string[] = [];
    if (paymentLines.length) {
      const payResult = await this.recordPayment(orderId, Number(o.customer_id), paymentLines, 0.0, actor);
      if (!payResult.success) paymentErrors = payResult.errors ?? [];
    }
    return { success: true, payment_errors: paymentErrors };
  }

  /** Re-derives item discount/tax/total, order totals and payments after any edit. Joins the caller's transaction. */
  private async recalculateAggregates(sc: ReturnType<OrderService['scoped']>, orderId: number, actor: Actor, canOverrideDiscount: boolean): Promise<void> {
    const { db } = sc;
    const [order] = await db.query<Raw>('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw new BusinessError(`Order #${orderId} not found during recalculation.`);
    const items = await db.query<Raw>('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    if (items.length === 0) throw new BusinessError(`Order #${orderId} has no items to recalculate.`);

    const subtotal = round2(sum(items.map((i) => Number(i.subtotal))));
    const discountType = order.discount_type;
    const discountValue = Number(order.discount_value);
    let discountAmount = discountType === 'Percent' ? round2((subtotal * Math.min(discountValue, 100)) / 100) : round2(Math.min(discountValue, subtotal));
    const maxDiscount = toFloat(await getSetting(db, 'max_counter_discount_percent', '0'));
    const effectivePercent = subtotal > 0 ? (discountAmount / subtotal) * 100 : 0;
    if (!canOverrideDiscount && effectivePercent > maxDiscount + 0.01) discountAmount = round2((subtotal * maxDiscount) / 100);

    let urgentPct = 0;
    if (order.urgent_level_id) {
      const [ul] = await db.query<{ surcharge_percent: string }>('SELECT surcharge_percent FROM urgent_levels WHERE id = ?', [order.urgent_level_id]);
      urgentPct = toFloat(ul?.surcharge_percent ?? 0);
    }
    const urgentCharge = round2(((subtotal - discountAmount) * urgentPct) / 100);
    const taxableBase = round2(subtotal - discountAmount + urgentCharge);

    let runningTax = 0, runningDiscount = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const share = subtotal > 0 ? Number(item.subtotal) / subtotal : 0;
      const itemDiscount = i === items.length - 1 ? round2(discountAmount - runningDiscount) : round2(discountAmount * share);
      const itemTax = round2((taxableBase * share * Number(item.tax_percent)) / 100);
      const itemTotal = round2(Number(item.subtotal) - itemDiscount + itemTax);
      await db.execute('UPDATE order_items SET discount = ?, tax = ?, total = ? WHERE id = ?', [itemDiscount, itemTax, itemTotal, item.id]);
      runningDiscount += itemDiscount;
      runningTax += itemTax;
    }
    discountAmount = round2(runningDiscount);
    const taxAmount = round2(runningTax);
    const grandTotal = round2(taxableBase + taxAmount + Number(order.delivery_charge));
    await db.execute('UPDATE orders SET subtotal = ?, discount_amount = ?, urgent_charge = ?, tax_amount = ?, grand_total = ?, updated_by = ? WHERE id = ?', [subtotal, discountAmount, urgentCharge, taxAmount, grandTotal, actor.userId, orderId]);
    await sc.audit.record({ action: 'edit', module: 'orders', recordId: String(orderId), newValue: { recalculated: true, grand_total: grandTotal }, userId: actor.userId, ip: actor.ip });
    await sc.finance.recalculatePayments(orderId, actor.userId, actor.ip);
  }
}

const phpRoundTo1 = (n: number) => phpRound(n, 1);
const round2Str1 = (n: number) => String(phpRound(n, 1));
