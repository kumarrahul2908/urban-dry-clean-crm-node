import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canActAsStoreForOrder, canEditOrderOfStore, resolveAuthorizedStoreId } from '../../auth/stores.js';
import type { UserContext } from '../../auth/apiAuth.js';
import { ApiError, num, ok } from '../../lib/http.js';
import { phpEmpty, round2, toFloat, toInt } from '../../lib/php.js';
import { qInt, qStr } from '../../lib/query.js';
import { getSetting } from '../../services/settings.js';

type Q = Record<string, unknown>;
type Raw = Record<string, any>;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const fmt2 = (n: number) => round2(n).toFixed(2);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Ports of the order / payment endpoints under api/mobile/ (+ OrderEditGuard). */
export async function registerMobileOrderRoutes(app: FastifyInstance) {
  const { db, orders: orderSvc, wallet } = app.services;

  const route = (method: 'GET' | 'POST', name: string, handler: (req: FastifyRequest) => Promise<unknown>) => {
    app.route({ method, url: `/${name}`, handler });
    app.route({ method, url: `/${name}.php`, handler });
  };
  const auth = async (req: FastifyRequest, permission: string) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, permission);
    return ctx;
  };
  const payload = (req: FastifyRequest): Raw => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError('invalid_request', 'Invalid request payload.', 400);
    return b as Raw;
  };
  const clientRequestIdOf = (v: unknown): string => {
    const id = String(v ?? '').trim();
    if (id === '' || id.length > 64) throw new ApiError('invalid_request', 'A valid client_request_id is required.', 422);
    return id;
  };

  // ---- OrderEditGuard --------------------------------------------------------------------
  const loadForMutation = async (ctx: UserContext, orderId: number): Promise<Raw> => {
    if (orderId <= 0) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
    const [order] = await db.query<Raw>('SELECT o.*, os.status_key FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.id = ?', [orderId]);
    if (!order) throw new ApiError('not_found', 'Order not found.', 404);
    if (!canEditOrderOfStore(ctx, Number(order.store_id))) throw new ApiError('forbidden', 'You can only change orders of your own store.', 403);
    return order;
  };
  const failFromService = (result: { errors?: string[] }, fallback: string): never => {
    const errors = result.errors ?? [fallback];
    const first = String(errors[0] ?? fallback);
    const moved = /no longer/i.test(first) || /cannot be cancelled/i.test(first);
    throw new ApiError(moved ? 'order_not_editable' : 'validation_failed', first, moved ? 409 : 422, { field_errors: errors });
  };
  const actions = async (ctx: UserContext, order: Raw, itemCount: number) => {
    const perms = ctx.permissions;
    const open = order.status_key === 'order_created' && canEditOrderOfStore(ctx, Number(order.store_id));
    const canEdit = open && perms.includes('orders.edit');
    return {
      can_edit: canEdit,
      can_add_item: canEdit && (order.order_mode ?? '') !== 'weight',
      can_remove_item: canEdit && itemCount > 1,
      can_cancel: open && perms.includes('orders.cancel'),
      can_override_discount: perms.includes('pos.override_discount'),
      can_manual_rate_override: perms.includes('pos.manual_rate_override'),
      max_discount_percent: toFloat(await getSetting(db, 'max_counter_discount_percent', '0')),
    };
  };
  const receivableStatus = async (orderId: number): Promise<string | null> =>
    (await db.query<{ status: string }>('SELECT status FROM accounts_receivable WHERE order_id = ?', [orderId]))[0]?.status ?? null;

  // ---- create ----------------------------------------------------------------------------
  route('POST', 'pos_orders_create', async (req) => {
    const ctx = await auth(req, 'pos.create');
    const p = payload(req);
    const clientRequestId = clientRequestIdOf(p.client_request_id);

    const replay = async () => {
      const [ex] = await db.query<Raw>('SELECT id, order_number, invoice_number, grand_total FROM orders WHERE client_request_id = ? AND created_by = ?', [clientRequestId, ctx.id]);
      return ex
        ? ok({ order_id: Number(ex.id), order_number: ex.order_number, invoice_number: ex.invoice_number, grand_total: num(ex.grand_total), warnings: [], idempotent_replay: true })
        : null;
    };
    const existing = await replay();
    if (existing) return existing;

    const canOverrideDiscount = ctx.permissions.includes('pos.override_discount');
    const canManualOverrideRate = ctx.permissions.includes('pos.manual_rate_override');
    const requested = p.store_id !== undefined && p.store_id !== null ? toInt(p.store_id) : null;
    const store = await resolveAuthorizedStoreId(db, ctx, requested);
    if (!store.success) throw new ApiError('store_required', store.error!, 422, { needs_selection: store.needs_selection });

    const result = await orderSvc.createOrder(p, { userId: ctx.id, ip: req.ip }, canOverrideDiscount, store.store_id!, canManualOverrideRate, clientRequestId);
    if (!result.success) {
      if (result.error_code === 'duplicate_client_request') {
        const again = await replay();
        if (again) return again;
      }
      throw new ApiError('validation_failed', 'Could not create the order.', 422, { field_errors: result.errors });
    }
    return ok({ order_id: result.order_id, order_number: result.order_number, invoice_number: result.invoice_number, grand_total: result.grand_total, warnings: result.warnings, idempotent_replay: false });
  });

  route('POST', 'laundry_orders_create', async (req) => {
    const ctx = await auth(req, 'pos.create');
    const p = payload(req);
    const clientRequestId = clientRequestIdOf(p.client_request_id);
    const replay = async () => {
      const [ex] = await db.query<Raw>('SELECT id, order_number, grand_total FROM orders WHERE client_request_id = ? AND created_by = ?', [clientRequestId, ctx.id]);
      return ex ? ok({ order_id: Number(ex.id), order_number: ex.order_number, grand_total: num(ex.grand_total), warnings: [], idempotent_replay: true }) : null;
    };
    const existing = await replay();
    if (existing) return existing;

    const canOverrideDiscount = ctx.permissions.includes('pos.override_discount');
    const store = await resolveAuthorizedStoreId(db, ctx);
    if (!store.success) throw new ApiError('store_required', store.error!, 422);
    const result = await orderSvc.createLaundryOrder(p, { userId: ctx.id, ip: req.ip }, canOverrideDiscount, store.store_id!, clientRequestId);
    if (!result.success) {
      if (result.error_code === 'duplicate_client_request') {
        const again = await replay();
        if (again) return again;
      }
      throw new ApiError('validation_failed', 'Could not create the Laundry order.', 422, { field_errors: result.errors });
    }
    return ok({ order_id: result.order_id, order_number: result.order_number, grand_total: result.grand_total, warnings: result.warnings, idempotent_replay: false });
  });

  // ---- reads -----------------------------------------------------------------------------
  route('GET', 'orders_list', async (req) => {
    await auth(req, 'orders.view');
    const q = req.query as Q;
    const search = qStr(q.q);
    const statusFilter = qInt(q.status_id);
    const dateFrom = qStr(q.from);
    const dateTo = qStr(q.to);
    const page = Math.max(1, qInt(q.page));
    const perPage = 20;
    let where = '1=1';
    const params: unknown[] = [];
    if (search !== '') {
      where += ' AND (o.order_number LIKE ? OR o.invoice_number LIKE ? OR c.full_name LIKE ? OR c.mobile LIKE ?)';
      params.push(...Array(4).fill(`%${search}%`));
    }
    if (statusFilter) { where += ' AND o.status_id = ?'; params.push(statusFilter); }
    if (dateFrom !== '') { where += ' AND DATE(o.order_date) >= ?'; params.push(dateFrom); }
    if (dateTo !== '') { where += ' AND DATE(o.order_date) <= ?'; params.push(dateTo); }
    const [{ n }] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${where}`, params)) as [{ n: number }];
    const results = await db.query(
      `SELECT o.id, o.order_number, o.invoice_number, o.order_date, o.due_date, o.order_mode,
              o.grand_total, o.total_paid, o.current_due, o.status_id,
              c.full_name AS customer_name, c.mobile AS customer_mobile,
              os.status_label, os.status_key, os.color
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_statuses os ON os.id = o.status_id
       WHERE ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
      [...params, perPage, (page - 1) * perPage],
    );
    return ok({ results, page, per_page: perPage, total: num(n), total_pages: Math.ceil(num(n) / perPage) });
  });

  route('GET', 'orders_search', async (req) => {
    await auth(req, 'packing.manage');
    const q = qStr((req.query as Q).q);
    if (q.length < 2) return ok({ results: [] });
    const like = `%${q}%`;
    const results = await db.query(
      `SELECT o.id, o.order_number, o.invoice_number, c.full_name AS customer_name, c.mobile
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.order_number LIKE ? OR o.invoice_number LIKE ? OR c.full_name LIKE ? OR c.mobile LIKE ?
       ORDER BY o.id DESC LIMIT 15`,
      [like, like, like, like],
    );
    return ok({ results });
  });

  route('GET', 'orders_detail', async (req) => {
    const ctx = await auth(req, 'orders.view');
    const id = qInt((req.query as Q).id);
    if (id <= 0) throw new ApiError('invalid_request', 'A valid order id is required.', 422);
    const [order] = await db.query<Raw>(
      `SELECT o.id, o.order_number, o.invoice_number, o.customer_id, o.store_id, s.store_name, o.price_list_id,
              o.order_mode, o.order_date, o.due_date, o.due_time, o.urgent_level_id,
              ul.level_name AS urgent_level_name, o.notes, o.workshop_notes, o.home_delivery, o.subtotal, o.discount_type,
              o.discount_value, o.discount_amount, o.urgent_charge, o.tax_amount, o.delivery_charge,
              o.grand_total, o.advance_paid, o.total_paid, o.current_due, o.status_id,
              os.status_key, os.status_label, os.color,
              c.full_name AS customer_name, c.mobile AS customer_mobile, c.address AS customer_address
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       JOIN order_statuses os ON os.id = o.status_id
       LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.id = ?`,
      [id],
    );
    if (!order) throw new ApiError('not_found', 'Order not found.', 404);

    let items: Raw[] = [];
    let laundryGarments: Raw[] = [];
    if (order.order_mode === 'weight') {
      items = await db.query<Raw>('SELECT oi.*, s.service_name FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id', [id]);
      laundryGarments = await db.query<Raw>(
        `SELECT lg.id, lg.order_item_id, g.garment_name, bc.item_sequence, oi.quantity AS total_garments
         FROM laundry_garments lg
         JOIN order_items oi ON oi.id = lg.order_item_id
         JOIN garments g ON g.id = lg.garment_id
         LEFT JOIN barcodes bc ON bc.laundry_garment_id = lg.id
         WHERE oi.order_id = ? ORDER BY bc.item_sequence`,
        [id],
      );
    } else {
      const all = await db.query<Raw>(
        `SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, g.sku,
                COALESCE(s.service_name, 'Unknown Service') AS service_name, b.brand_name, col.color_name
         FROM order_items oi
         LEFT JOIN garments g ON g.id = oi.garment_id
         LEFT JOIN services s ON s.id = oi.service_id
         LEFT JOIN brands b ON b.id = oi.brand_id
         LEFT JOIN colors col ON col.id = oi.color_id
         WHERE oi.order_id = ? ORDER BY oi.id`,
        [id],
      );
      items = all.filter((it) => !phpEmpty(it.garment_id) || !phpEmpty(it.service_id) || Number(it.subtotal) > 0 || Number(it.total) > 0);
      const defects = await db.query<{ order_item_id: number; defect_name: string }>(
        `SELECT oid.order_item_id, d.defect_name FROM order_item_defects oid
         JOIN defects d ON d.id = oid.defect_id WHERE oid.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
        [id],
      );
      const byItem = new Map<number, string[]>();
      for (const d of defects) byItem.set(Number(d.order_item_id), [...(byItem.get(Number(d.order_item_id)) ?? []), d.defect_name]);
      items = items.map((it) => ({ ...it, defects: byItem.get(Number(it.id)) ?? [] }));
    }

    const payments = await db.query(
      `SELECT p.*, u.full_name AS created_by_name,
        GROUP_CONCAT(CONCAT(pt.type_name, ': ', ptx.amount, CASE WHEN ptx.reference_no IS NOT NULL THEN CONCAT(' (', ptx.reference_no, ')') ELSE '' END) SEPARATOR ', ') AS breakdown
       FROM payments p
       JOIN payment_transactions ptx ON ptx.payment_id = p.id
       JOIN payment_types pt ON pt.id = ptx.payment_type_id
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.order_id = ? GROUP BY p.id ORDER BY p.id DESC`,
      [id],
    );
    const walletBalance = await wallet.getBalance(Number(order.customer_id));
    const [{ n }] = (await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [id])) as [{ n: number }];
    return ok({
      order,
      order_actions: await actions(ctx, order, num(n)),
      receivable_status: await receivableStatus(id),
      items,
      laundry_garments: laundryGarments,
      payments,
      wallet_balance: walletBalance,
    });
  });

  route('GET', 'payments_list', async (req) => {
    const ctx = await app.requireToken(req);
    if (!ctx.permissions.includes('payments.view') && !ctx.permissions.includes('payments.collect')) {
      throw new ApiError('forbidden', 'You do not have permission to view payments.', 403);
    }
    const q = req.query as Q;
    let dateFrom = qStr(q.date_from);
    let dateTo = qStr(q.date_to);
    if (dateFrom !== '' && !ISO_DATE.test(dateFrom)) dateFrom = '';
    if (dateTo !== '' && !ISO_DATE.test(dateTo)) dateTo = '';
    const paymentTypeId = qInt(q.payment_type_id);
    const search = qStr(q.q);
    const page = Math.max(1, qInt(q.page));
    const perPage = 30;

    const where = ['1=1'];
    const params: unknown[] = [];
    if (dateFrom !== '') { where.push('p.payment_date >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo !== '') { where.push('p.payment_date <= ?'); params.push(`${dateTo} 23:59:59`); }
    if (search !== '') {
      where.push('(o.order_number LIKE ? OR c.full_name LIKE ? OR pt.reference_no LIKE ? OR p.payment_number LIKE ?)');
      params.push(...Array(4).fill(`%${search}%`));
    }
    if (paymentTypeId) { where.push('EXISTS (SELECT 1 FROM payment_transactions ptf WHERE ptf.payment_id = p.id AND ptf.payment_type_id = ?)'); params.push(paymentTypeId); }
    const w = where.join(' AND ');
    const [{ n }] = (await db.query<{ n: number }>(
      `SELECT COUNT(DISTINCT p.id) AS n FROM payments p LEFT JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = p.customer_id LEFT JOIN payment_transactions pt ON pt.payment_id = p.id WHERE ${w}`,
      params,
    )) as [{ n: number }];
    const rows = await db.query<Raw>(
      `SELECT DISTINCT p.id, p.payment_number, p.order_id, o.order_number, c.full_name AS customer_name,
              p.payment_date, p.total_amount, p.payment_kind, p.remarks, u.full_name AS created_by_name
       FROM payments p LEFT JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = p.customer_id
       LEFT JOIN payment_transactions pt ON pt.payment_id = p.id LEFT JOIN users u ON u.id = p.created_by
       WHERE ${w} ORDER BY p.payment_date DESC, p.id DESC LIMIT ? OFFSET ?`,
      [...params, perPage, (page - 1) * perPage],
    );
    const linesByPayment = new Map<number, Raw[]>();
    if (rows.length) {
      const lines = await db.query<Raw>(
        `SELECT pt.payment_id, pty.type_name, pt.amount, pt.reference_no
         FROM payment_transactions pt JOIN payment_types pty ON pty.id = pt.payment_type_id
         WHERE pt.payment_id IN (?) ORDER BY pt.id`,
        [rows.map((r) => r.id)],
      );
      for (const l of lines) {
        const k = Number(l.payment_id);
        linesByPayment.set(k, [...(linesByPayment.get(k) ?? []), { type_name: l.type_name, amount: num(l.amount), reference_no: l.reference_no }]);
      }
    }
    const types = await db.query<Raw>('SELECT id, type_name FROM payment_types WHERE is_active=1 ORDER BY sort_order');
    return ok({
      payments: rows.map((p) => ({
        id: num(p.id), payment_number: p.payment_number, order_id: p.order_id !== null ? num(p.order_id) : null, order_number: p.order_number,
        customer_name: p.customer_name, payment_date: p.payment_date, total_amount: num(p.total_amount), payment_kind: p.payment_kind,
        remarks: p.remarks, created_by_name: p.created_by_name, lines: linesByPayment.get(Number(p.id)) ?? [],
      })),
      payment_types: types.map((t) => ({ id: num(t.id), type_name: t.type_name })),
      page, per_page: perPage, total: num(n),
    });
  });

  // ---- payment / refund --------------------------------------------------------------------
  const normalizeLines = (input: unknown): { payment_type_id: number; amount: number }[] => {
    const out: { payment_type_id: number; amount: number }[] = [];
    if (!Array.isArray(input)) return out;
    for (const line of input) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) continue;
      const typeId = toInt((line as Raw).payment_type_id);
      const amount = round2(toFloat((line as Raw).amount));
      if (typeId <= 0 || amount <= 0) continue;
      out.push({ payment_type_id: typeId, amount });
    }
    return out.sort((a, b) => a.payment_type_id - b.payment_type_id);
  };
  const currentDue = async (orderId: number) => num((await db.query<{ current_due: string }>('SELECT current_due FROM orders WHERE id = ?', [orderId]))[0]?.current_due ?? 0);

  route('POST', 'orders_record_payment', async (req) => {
    const ctx = await auth(req, 'payments.collect');
    const p = payload(req);
    const orderId = toInt(p.order_id);
    const clientRequestId = String(p.client_request_id ?? '').trim();
    const walletAmount = Math.max(0, round2(toFloat(p.wallet_amount)));
    if (!orderId) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
    if (clientRequestId === '' || clientRequestId.length > 64) throw new ApiError('invalid_request', 'A valid client_request_id is required.', 422);

    const [order] = await db.query<Raw>('SELECT id, customer_id, store_id FROM orders WHERE id = ?', [orderId]);
    if (!order) throw new ApiError('not_found', 'Order not found.', 404);
    if (!canActAsStoreForOrder(ctx, Number(order.store_id))) throw new ApiError('forbidden', "You are not authorized to collect payment for this order's store.", 403);

    const lines = normalizeLines(p.payment_lines);
    if (lines.length === 0 && walletAmount <= 0) throw new ApiError('invalid_request', 'At least one payment line or a wallet amount is required.', 422);
    const canonical = `${orderId}|${lines.map((l) => `${l.payment_type_id}:${fmt2(l.amount)}`).join(',')}|wallet:${fmt2(walletAmount)}`;

    const result = await orderSvc.recordPayment(orderId, Number(order.customer_id), lines, walletAmount, { userId: ctx.id, ip: req.ip }, { clientRequestId, requestFingerprint: sha256(canonical) });
    if (!result.success) {
      if (result.error_code === 'idempotency_conflict') throw new ApiError('idempotency_conflict', result.errors?.[0] ?? 'Idempotency conflict.', 409);
      throw new ApiError('validation_failed', 'Could not record payment.', 422, { field_errors: result.errors });
    }
    return ok({ payment_id: result.payment_id, payment_number: result.payment_number, updated_due: await currentDue(orderId), idempotent_replay: result.idempotent_replay ?? false });
  });

  route('POST', 'orders_record_refund', async (req) => {
    const ctx = await auth(req, 'payments.refund');
    const p = payload(req);
    const orderId = toInt(p.order_id);
    const clientRequestId = String(p.client_request_id ?? '').trim();
    const refundAmount = round2(toFloat(p.refund_amount));
    const creditToWallet = !phpEmpty(p.credit_to_wallet);
    const reason = String(p.reason ?? '').trim();
    const remarks = String(p.remarks ?? '').trim();
    if (!orderId) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
    if (clientRequestId === '' || clientRequestId.length > 64) throw new ApiError('invalid_request', 'A valid client_request_id is required.', 422);
    if (reason === '') throw new ApiError('invalid_request', 'A refund reason is required.', 422);
    if (refundAmount <= 0) throw new ApiError('invalid_request', 'Refund amount must be greater than zero.', 422);

    const [order] = await db.query<Raw>('SELECT id, customer_id, store_id FROM orders WHERE id = ?', [orderId]);
    if (!order) throw new ApiError('not_found', 'Order not found.', 404);
    if (!canActAsStoreForOrder(ctx, Number(order.store_id))) throw new ApiError('forbidden', "You are not authorized to process a refund for this order's store.", 403);

    const lines = normalizeLines(p.refund_lines);
    const canonical = `${orderId}|refund:${fmt2(refundAmount)}|wallet:${creditToWallet ? '1' : '0'}|${lines.map((l) => `${l.payment_type_id}:${fmt2(l.amount)}`).join(',')}|reason:${reason}|remarks:${remarks}`;
    const result = await orderSvc.processRefund(orderId, refundAmount, lines, creditToWallet, reason, remarks, { userId: ctx.id, ip: req.ip }, clientRequestId, sha256(canonical));
    if (!result.success) {
      if (result.error_code === 'idempotency_conflict') throw new ApiError('idempotency_conflict', result.errors?.[0] ?? 'Idempotency conflict.', 409);
      throw new ApiError('validation_failed', 'Could not process refund.', 422, { field_errors: result.errors });
    }
    return ok({ payment_id: result.payment_id, refund_number: result.refund_number, updated_due: await currentDue(orderId), idempotent_replay: result.idempotent_replay ?? false });
  });

  // ---- edit / cancel / items ---------------------------------------------------------------
  route('POST', 'order_cancel', async (req) => {
    const ctx = await auth(req, 'orders.cancel');
    const p = payload(req);
    const order = await loadForMutation(ctx, toInt(p.order_id));
    const orderId = Number(order.id);
    if (order.status_key === 'cancelled') throw new ApiError('already_cancelled', 'This order is already cancelled.', 409, { receivable_status: await receivableStatus(orderId) });
    const reason = typeof p.reason === 'string' || typeof p.reason === 'number' ? String(p.reason).trim() : '';
    if (reason.trim() === '') throw new ApiError('validation_failed', 'A cancellation reason is required.', 422);
    const result = await orderSvc.cancelOrder(orderId, reason, { userId: ctx.id, ip: req.ip });
    if (!result.success) failFromService(result, 'Could not cancel order.');
    return ok({ order_id: orderId, cancelled: true, receivable_status: await receivableStatus(orderId), warning: result.warning ?? null });
  });

  route('POST', 'order_edit', async (req) => {
    const ctx = await auth(req, 'orders.edit');
    const p = payload(req);
    const str = (k: string) => (typeof p[k] === 'string' || typeof p[k] === 'number' || typeof p[k] === 'boolean' ? String(p[k]) : '');
    const order = await loadForMutation(ctx, toInt(p.order_id));
    const orderId = Number(order.id);
    if (order.status_key !== 'order_created') throw new ApiError('order_not_editable', 'This order can no longer be edited — processing has begun.', 409);

    const homeDelivery = !phpEmpty(p.home_delivery);
    const changes: Raw = {
      due_date: str('due_date').trim(),
      due_time: str('due_time').trim() || null,
      urgent_level_id: !phpEmpty(p.urgent_level_id) ? toInt(p.urgent_level_id) : null,
      discount_type: ['Percent', 'Flat'].includes(str('discount_type')) ? str('discount_type') : 'Percent',
      discount_value: Math.max(0, toFloat(p.discount_value)),
      notes: str('notes').trim(),
      workshop_notes: str('workshop_notes').trim(),
      home_delivery: homeDelivery ? 1 : 0,
      delivery_charge: homeDelivery ? Math.max(0, toFloat(p.delivery_charge)) : 0,
    };
    const reason = str('reason').trim();

    const errors: string[] = [];
    const validDate = ISO_DATE.test(changes.due_date) && new Date(`${changes.due_date}T00:00:00Z`).toISOString().slice(0, 10) === changes.due_date;
    if (!validDate) errors.push('A valid due date (YYYY-MM-DD) is required.');
    if (changes.due_time !== null && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(changes.due_time)) errors.push('Due time must be HH:MM.');
    if (changes.urgent_level_id !== null) {
      if (!(await db.query('SELECT id FROM urgent_levels WHERE id = ? AND is_active = 1', [changes.urgent_level_id])).length) errors.push('Unknown urgent level.');
    }
    const canOverrideDiscount = ctx.permissions.includes('pos.override_discount');
    const maxDiscount = toFloat(await getSetting(db, 'max_counter_discount_percent', '0'));
    if (!canOverrideDiscount && changes.discount_type === 'Percent' && changes.discount_value > maxDiscount + 0.01) errors.push(`Discount exceeds your authorized limit of ${maxDiscount}%.`);
    if (errors.length) throw new ApiError('validation_failed', errors[0]!, 422, { field_errors: errors });

    const typeNow = order.discount_type || 'Percent';
    const discountChanged = changes.discount_type !== typeNow || Math.abs(changes.discount_value - Number(order.discount_value)) >= 0.005;
    const urgentChanged = toInt(changes.urgent_level_id) !== toInt(order.urgent_level_id);
    if (!discountChanged) { delete changes.discount_type; delete changes.discount_value; }
    if (!urgentChanged) delete changes.urgent_level_id;

    const same = !discountChanged && !urgentChanged
      && changes.due_date === String(order.due_date)
      && String(changes.due_time ?? '').slice(0, 5) === String(order.due_time ?? '').slice(0, 5)
      && changes.notes === String(order.notes ?? '')
      && changes.workshop_notes === String(order.workshop_notes ?? '')
      && changes.home_delivery === toInt(order.home_delivery)
      && Math.abs(changes.delivery_charge - Number(order.delivery_charge)) < 0.005;
    if (same) return ok({ order_id: orderId, changed: false, grand_total: num(order.grand_total), current_due: num(order.current_due) });

    const result = await orderSvc.editOrder(orderId, changes, { userId: ctx.id, ip: req.ip }, reason, canOverrideDiscount);
    if (!result.success) failFromService(result, 'Could not update order.');
    const [t] = await db.query<Raw>('SELECT grand_total, current_due FROM orders WHERE id = ?', [orderId]);
    return ok({ order_id: orderId, changed: true, grand_total: num(t!.grand_total), current_due: num(t!.current_due) });
  });

  route('POST', 'order_item_add', async (req) => {
    const ctx = await auth(req, 'orders.edit');
    const p = payload(req);
    const clientRequestId = clientRequestIdOf(typeof p.client_request_id === 'string' || typeof p.client_request_id === 'number' ? p.client_request_id : '');
    const order = await loadForMutation(ctx, toInt(p.order_id));
    const orderId = Number(order.id);
    const [seen] = await db.query<{ id: number }>('SELECT id FROM order_items WHERE order_id = ? AND client_request_id = ?', [orderId, clientRequestId]);
    if (seen) return ok({ order_id: orderId, item_id: Number(seen.id), idempotent_replay: true });
    if (order.status_key !== 'order_created') throw new ApiError('order_not_editable', 'This order can no longer be edited (processing has begun).', 409);
    if (order.order_mode === 'weight') throw new ApiError('validation_failed', 'This is a Per-Weight (Laundry) order and items cannot be added to it.', 422);

    const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    const raw: Raw = {
      garment_id: toInt(p.garment_id),
      service_id: toInt(p.service_id),
      quantity: toFloat(p.quantity),
      weight: toFloat(p.weight),
      rate_override: p.rate_override !== undefined && p.rate_override !== null && p.rate_override !== '' && scalar(p.rate_override) ? p.rate_override : null,
      manual_override: !phpEmpty(p.manual_override),
      brand_id: !phpEmpty(p.brand_id) ? toInt(p.brand_id) : null,
      color_id: !phpEmpty(p.color_id) ? toInt(p.color_id) : null,
      remarks: scalar(p.remarks) ? String(p.remarks) : '',
      defect_ids: Array.isArray(p.defect_ids) ? p.defect_ids.map(toInt).filter((n: number) => n !== 0) : [],
    };
    const result = await orderSvc.addItem(orderId, raw, { userId: ctx.id, ip: req.ip }, ctx.permissions.includes('pos.manual_rate_override'), clientRequestId);
    if (!result.success) failFromService(result, 'Could not add item.');
    return ok({ order_id: orderId, item_id: Number(result.item_id), idempotent_replay: !!result.idempotent_replay });
  });

  route('POST', 'order_item_remove', async (req) => {
    const ctx = await auth(req, 'orders.edit');
    const p = payload(req);
    const order = await loadForMutation(ctx, toInt(p.order_id));
    const orderId = Number(order.id);
    const itemId = toInt(p.item_id);
    if (!(await db.query('SELECT id FROM order_items WHERE id = ? AND order_id = ?', [itemId, orderId])).length) throw new ApiError('item_not_found', 'Item not found on this order.', 404);
    if (order.status_key !== 'order_created') throw new ApiError('order_not_editable', 'This order can no longer be edited (processing has begun).', 409);
    const result = await orderSvc.removeItem(orderId, itemId, { userId: ctx.id, ip: req.ip });
    if (!result.success) failFromService(result, 'Could not remove item.');
    return ok({ order_id: orderId, item_id: itemId, removed: true });
  });
}
