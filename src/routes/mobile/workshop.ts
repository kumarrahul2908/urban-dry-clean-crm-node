import type { FastifyInstance, FastifyRequest } from 'fastify';
import { addDays, todayIn } from '../../lib/dates.js';
import { ApiError, num, ok } from '../../lib/http.js';
import { phpEmpty, round2, toInt } from '../../lib/php.js';
import { wsBillingScope, wsItemBelongs, wsScheduleData, wsScope } from '../../services/workshopScope.js';

type Raw = Record<string, any>;
type Q = Record<string, unknown>;
const numOrNull = (v: unknown) => (v !== null && v !== undefined ? Number(v) : null);
const stripTags = (s: string) => s.replace(/<[^>]*>?/g, '');
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Ports of workshop_queue/action/schedule/report and workshop_billing_list/detail/generate/mark_paid. */
export async function registerMobileWorkshopRoutes(app: FastifyInstance) {
  const { db, workshop, workshopInvoice, laundry, env, hooks } = app.services;
  const tz = env.APP_TIMEZONE;
  const route = (method: 'GET' | 'POST', name: string, permissions: string[], handler: (req: FastifyRequest, ctx: Awaited<ReturnType<typeof app.requireToken>>) => Promise<unknown>) => {
    const h = async (req: FastifyRequest) => {
      const ctx = await app.requireToken(req);
      if (!permissions.some((p) => ctx.permissions.includes(p))) throw new ApiError('forbidden', 'You do not have permission to perform this action.', 403);
      return handler(req, ctx);
    };
    app.route({ method, url: `/${name}`, handler: h });
    app.route({ method, url: `/${name}.php`, handler: h });
  };
  const body = (req: FastifyRequest): Raw => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError('invalid_request', 'Invalid request payload.', 400);
    return b as Raw;
  };
  /** [isWorkshopStaff, workshopId]. A Workshop Staff login that is not linked to a workshop must not see everyone's work. */
  const scopeOf = async (ctx: { id: number; role_name: string }): Promise<number | null> => {
    const [isStaff, wid] = await wsScope(db, ctx.id, ctx.role_name);
    if (isStaff && wid === null) throw new ApiError('forbidden', 'Your login is not linked to a workshop.', 403);
    return wid;
  };

  // ---- queue -----------------------------------------------------------------------------------------
  route('GET', 'workshop_queue', ['workshop.manage'], async (req, ctx) => {
    const myWs = await scopeOf(ctx);
    const q = req.query as Q;
    const statusFilter = String(q.status ?? '').trim(), orderSearch = String(q.order ?? '').trim(), customerSearch = String(q.customer ?? '').trim(), garmentSearch = String(q.garment ?? '').trim();
    const dueDate = String(q.due_date ?? '').trim();
    const urgentOnly = !phpEmpty(q.urgent_only);
    const page = Math.max(1, toInt(q.page ?? 1));
    const perPage = 25;
    if (statusFilter !== '' && !['Pending', 'Workshop', 'Processing'].includes(statusFilter)) throw new ApiError('invalid_request', 'Invalid status filter.', 422);
    if (dueDate !== '' && !ISO.test(dueDate)) throw new ApiError('invalid_request', 'Invalid due date.', 422);

    let where = "oi.item_status IN ('Pending','Workshop','Processing') AND os.status_key != 'cancelled'";
    const params: unknown[] = [];
    if (myWs !== null) { where += ' AND wc.workshop_id = ?'; params.push(myWs); }
    if (statusFilter !== '') { where += ' AND oi.item_status = ?'; params.push(statusFilter); }
    if (orderSearch !== '') { where += ' AND o.order_number LIKE ?'; params.push(`%${orderSearch}%`); }
    if (customerSearch !== '') {
      if (myWs !== null) { where += ' AND c.full_name LIKE ?'; params.push(`%${customerSearch}%`); } // a workshop never searches by customer phone number
      else { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    }
    if (garmentSearch !== '') { where += ' AND g.garment_name LIKE ?'; params.push(`%${garmentSearch}%`); }
    if (dueDate !== '') { where += ' AND o.due_date = ?'; params.push(dueDate); }
    if (urgentOnly) where += ' AND o.urgent_level_id IS NOT NULL';
    const base = `FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id
      JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
      LEFT JOIN workshop_items wi ON wi.order_item_id = oi.id AND wi.status NOT IN ('Completed','Rejected') LEFT JOIN workshop_challans wc ON wc.id = wi.challan_id WHERE ${where}`;
    const [{ n }] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params)) as [{ n: number }];
    const rows = await db.query<Raw>(
      `SELECT oi.id, oi.order_id, oi.item_status, oi.quantity, oi.weight, oi.unit, o.order_number, o.due_date, o.due_time, c.full_name AS customer_name,
              g.garment_name, s.service_name, s.billing_unit, ul.level_name AS urgent_level_name, wi.id AS workshop_item_id, wi.status AS workshop_status, wc.challan_number
       ${base} ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params);
    const pieceItems = rows.map((r) => ({
      order_item_id: num(r.id), order_id: num(r.order_id), order_number: r.order_number, item_status: r.item_status, quantity: numOrNull(r.quantity), weight: numOrNull(r.weight),
      unit: r.unit, due_date: r.due_date, due_time: r.due_time, customer_name: r.customer_name, garment_name: r.garment_name, service_name: r.service_name,
      urgent_level_name: r.urgent_level_name, workshop_item_id: r.workshop_item_id !== null ? num(r.workshop_item_id) : null, workshop_status: r.workshop_status, challan_number: r.challan_number,
    }));
    const mapLaundry = (r: Raw) => ({
      laundry_garment_id: num(r.id), sequence: num(r.sequence), garment_name: r.garment_name, total_garments: num(r.total_garments), order_id: num(r.order_id), order_number: r.order_number,
      due_date: r.due_date, customer_name: r.customer_name, service_name: r.service_name, status: r.status,
      workshop_item_id: r.workshop_item && r.workshop_item.id !== undefined && r.workshop_item.id !== null ? num(r.workshop_item.id) : null,
    });
    const laundryPending = myWs !== null ? [] : await laundry.listByStatus(['Pending']); // unsent garments are a store-side list
    let laundryInProgress = await laundry.listByStatus(['Workshop', 'Processing']);
    if (laundryInProgress.length) {
      const wis = await db.query<Raw>(
        "SELECT wi.laundry_garment_id, wi.id, wi.status, wc.workshop_id FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id WHERE wi.laundry_garment_id IN (?) AND wi.status NOT IN ('Completed','Rejected')",
        [laundryInProgress.map((l) => l.id)]);
      const byLg = new Map<number, Raw>();
      for (const w of wis) byLg.set(Number(w.laundry_garment_id), w);
      for (const lg of laundryInProgress) lg.workshop_item = byLg.get(Number(lg.id)) ?? null;
      if (myWs !== null) laundryInProgress = laundryInProgress.filter((lg) => lg.workshop_item && Number(lg.workshop_item.workshop_id) === myWs);
    }
    const cands = await db.query<Raw>(
      `SELECT wi.id, wi.order_item_id, wi.laundry_garment_id, wi.status AS raw_status, wi.remarks, COALESCE(g1.garment_name, g2.garment_name) AS garment_name,
              COALESCE(o1.order_number, o2.order_number) AS order_number, COALESCE(o1.id, o2.id) AS order_id, COALESCE(c1.full_name, c2.full_name) AS customer_name
       FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
       LEFT JOIN orders o2 ON o2.id = oi2.order_id LEFT JOIN customers c2 ON c2.id = o2.customer_id
       WHERE wi.status IN ('Received', 'Completed')${myWs !== null ? ' AND wc.workshop_id = ?' : ''} ORDER BY wi.id DESC LIMIT 200`, myWs !== null ? [myWs] : []);
    const acceptQueue: Raw[] = [], returnQueue: Raw[] = [], storeReceiveQueue: Raw[] = [];
    for (const row of cands) {
      const current = await workshop.getCurrentStatus(Number(row.id));
      const item = { workshop_item_id: num(row.id), kind: row.laundry_garment_id !== null ? 'laundry' : 'piece', garment_name: row.garment_name, order_id: row.order_id !== null ? num(row.order_id) : null, order_number: row.order_number, customer_name: row.customer_name, current_status: current };
      if (current === 'Received') acceptQueue.push(item);
      else if (current === 'Completed') returnQueue.push(item);
      else if (current === 'Returned') storeReceiveQueue.push(item);
    }
    const workshops = (await db.query<Raw>('SELECT id, workshop_name FROM workshops WHERE is_active=1 ORDER BY workshop_name')).map((r) => ({ id: num(r.id), name: r.workshop_name }));
    return ok({
      can_create_challan: ctx.role_name !== 'Workshop Staff',
      piece: { items: pieceItems, total: num(n), page, total_pages: Math.ceil(num(n) / perPage) },
      laundry_pending: laundryPending.map((r) => mapLaundry({ ...r, workshop_item: null })),
      laundry_in_progress: laundryInProgress.map(mapLaundry),
      accept_queue: acceptQueue, return_queue: returnQueue, store_receive_queue: storeReceiveQueue, workshops,
    });
  });

  // ---- actions -----------------------------------------------------------------------------------------
  route('POST', 'workshop_action', ['workshop.manage'], async (req, ctx) => {
    const p = body(req);
    const a = { userId: ctx.id, ip: req.ip };
    const action = String(p.action ?? '');
    const remarks = stripTags(String(p.remarks ?? '')).trim();
    if ([...remarks].length > 500) throw new ApiError('invalid_request', 'Remarks are too long.', 422);
    const isStaff = ctx.role_name === 'Workshop Staff';
    const intList = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(toInt).filter((x) => x > 0))] : []);

    if (action === 'create_challan' || action === 'create_laundry_challan') {
      if (isStaff) throw new ApiError('forbidden', 'Workshop Staff cannot send garments to a workshop — this is a store-side action.', 403);
      const workshopId = toInt(p.workshop_id);
      const allowed = ctx.store_id !== null ? [ctx.store_id] : null;
      let result, ids: number[];
      if (action === 'create_challan') {
        ids = intList(p.item_ids);
        if (!ids.length) throw new ApiError('invalid_request', 'Select at least one item.', 422);
        result = await workshop.createChallan(workshopId, ids, remarks, a, allowed);
      } else {
        ids = intList(p.laundry_garment_ids);
        if (!ids.length) throw new ApiError('invalid_request', 'Select at least one garment.', 422);
        result = await workshop.createLaundryChallan(workshopId, ids, remarks, a, allowed);
      }
      if (!result.success) throw new ApiError('action_failed', (result.errors ?? ['Could not create the challan.']).join(' '), 422);
      return ok({ message: `Challan ${result.challan_number} created with ${ids.length} item(s).`, challan_id: num(result.challan_id), challan_number: result.challan_number });
    }
    const itemActions = ['start_processing', 'complete_processing', 'accept', 'return_to_store', 'store_receive', 'mark_unprocessed', 'resolve_unprocessed'];
    if (!itemActions.includes(action)) throw new ApiError('invalid_request', 'Unknown action.', 422);
    const wiId = toInt(p.workshop_item_id);
    if (!wiId) throw new ApiError('invalid_request', 'A valid workshop_item_id is required.', 422);
    const [, myWs] = await wsScope(db, ctx.id, ctx.role_name);
    if (myWs !== null && !(await wsItemBelongs(db, wiId, myWs))) throw new ApiError('not_found', 'Item not found.', 404);
    if (action === 'mark_unprocessed' && remarks.trim() === '') throw new ApiError('invalid_request', 'A reason is required to mark an item unprocessed.', 422);
    const result = await ({
      start_processing: () => workshop.startProcessing(wiId, a),
      complete_processing: () => workshop.completeProcessing(wiId, a, remarks),
      accept: () => workshop.acceptItem(wiId, a, remarks),
      return_to_store: () => workshop.returnToStore(wiId, a, remarks),
      store_receive: () => workshop.storeReceive(wiId, a, remarks),
      mark_unprocessed: () => workshop.markUnprocessed(wiId, a, remarks),
      resolve_unprocessed: () => workshop.resolveUnprocessed(wiId, a, remarks),
    } as Record<string, () => Promise<{ success: boolean; errors?: string[] }>>)[action]!();
    if (!result.success) throw new ApiError('action_failed', (result.errors ?? ['Could not update this item.']).join(' '), 422);
    if (action === 'complete_processing') {
      try { await hooks.workshopCompleted(wiId); } catch (e) { console.error('notifyWorkshopCompleted failed:', (e as Error).message); }
    }
    const messages: Record<string, string> = {
      start_processing: 'Processing started.', complete_processing: 'Marked as processing completed — ready for QC.', accept: 'Item accepted.',
      return_to_store: 'Item returned to store.', store_receive: 'Received at store — ready for QC.', mark_unprocessed: 'Item marked Unprocessed.',
      resolve_unprocessed: 'Item resolved — back in the active queue.',
    };
    return ok({ message: messages[action], workshop_item_id: wiId });
  });

  // ---- schedule + report ---------------------------------------------------------------------------------
  route('GET', 'workshop_schedule', ['workshop.manage'], async (_req, ctx) => {
    const myWs = await scopeOf(ctx);
    const today = todayIn(tz);
    const s = await wsScheduleData(db, myWs, today);
    const block = (byStore: ScheduleBucket) => {
      const stores: Raw[] = [];
      const tot = { orders: 0, garments: 0, bill_value: 0 };
      for (const [storeName, orders] of Object.entries(byStore)) {
        const rows: Raw[] = [];
        let g = 0, v = 0;
        for (const o of Object.values(orders)) {
          const val = round2(Object.values(o.items).reduce((x, y) => x + y, 0));
          rows.push({ order_id: num(o.order_id), order_number: o.order_number, customer: o.customer, due_time: o.due_time ? String(o.due_time).slice(0, 5) : null, garments: o.garments, bill_value: val, statuses: Object.keys(o.statuses) });
          g += o.garments; v += val;
        }
        stores.push({ store_name: storeName, orders: rows, garments: g, bill_value: round2(v) });
        tot.orders += rows.length; tot.garments += g; tot.bill_value += v;
      }
      tot.bill_value = round2(tot.bill_value);
      return [stores, tot] as const;
    };
    type ScheduleBucket = typeof s.today;
    const [todayStores, todayTot] = block(s.today);
    const [tomorrowStores, tomorrowTot] = block(s.tomorrow);
    const cap = 50;
    const overdueStores: Raw[] = [];
    const odOrders = new Set<number>();
    let odGarments = 0;
    for (const [storeName, rows] of Object.entries(s.overdue)) {
      overdueStores.push({ store_name: storeName, rows: rows.slice(0, cap).map((r) => ({ order_id: num(r.order_id), order_number: r.order_number, customer: r.customer, garment: r.garment, qty: r.qty, due_date: r.due_date, days: r.days, status: r.status })), total_rows: rows.length });
      for (const r of rows) { odOrders.add(Number(r.order_id)); odGarments += r.qty; }
    }
    return ok({
      today_date: s.today_date, tomorrow_date: s.tomorrow_date, today: todayStores, tomorrow: tomorrowStores, overdue: overdueStores,
      today_totals: todayTot, tomorrow_totals: tomorrowTot, overdue_totals: { orders: odOrders.size, garments: odGarments, bill_value: 0 },
    });
  });

  route('GET', 'workshop_report', ['workshop.manage'], async (req, ctx) => {
    const myWs = await scopeOf(ctx);
    const q = req.query as Q;
    let period = String(q.period ?? 'week');
    const storeFilter = toInt(q.store_id);
    const customFrom = String(q.from ?? ''), customTo = String(q.to ?? '');
    const today = todayIn(tz);
    let from: string, to: string;
    switch (period) {
      case '15days': from = addDays(today, -14); to = today; break;
      case '30days': from = addDays(today, -29); to = today; break;
      case 'custom': from = ISO.test(customFrom) ? customFrom : addDays(today, -6); to = ISO.test(customTo) ? customTo : today; break;
      default: period = 'week'; from = addDays(today, -6); to = today;
    }
    const params: unknown[] = [from, to];
    let storeClause = '';
    if (storeFilter) { storeClause = ' AND COALESCE(o1.store_id, o2.store_id) = ?'; params.push(storeFilter); }
    let wsClause = '';
    if (myWs !== null) { wsClause = ' AND wc.workshop_id = ?'; params.push(myWs); }
    const rows = await db.query<Raw>(
      `SELECT wi.id, wi.sent_at, COALESCE(o1.store_id, o2.store_id) AS store_id, COALESCE(s1.store_name, s2.store_name) AS store_name,
              COALESCE(g1.garment_name, g2.garment_name) AS garment_name, COALESCE(c1.full_name, c2.full_name) AS customer_name,
              CASE WHEN wi.laundry_garment_id IS NOT NULL THEN 1 ELSE COALESCE(oi1.quantity, 1) END AS garments
       FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN stores s1 ON s1.id = o1.store_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
       LEFT JOIN orders o2 ON o2.id = oi2.order_id LEFT JOIN stores s2 ON s2.id = o2.store_id LEFT JOIN customers c2 ON c2.id = o2.customer_id
       WHERE wi.status != 'Rejected' AND DATE(wi.sent_at) BETWEEN ? AND ?${storeClause}${wsClause} ORDER BY store_name, garment_name`, params);
    const byStore = new Map<number, { store_id: number; store_name: string; total: number; garments: Map<string, number>; customers: Set<string> }>();
    for (const r of rows) {
      const sid = Number(r.store_id ?? 0);
      if (!byStore.has(sid)) byStore.set(sid, { store_id: sid, store_name: r.store_name ?? 'Unassigned', total: 0, garments: new Map(), customers: new Set() });
      const s = byStore.get(sid)!;
      const qty = Number(r.garments);
      s.total += qty;
      const g = r.garment_name ?? 'Unknown';
      s.garments.set(g, (s.garments.get(g) ?? 0) + qty);
      if (r.customer_name) s.customers.add(r.customer_name);
    }
    const report = [...byStore.values()].map((s) => ({
      store_id: s.store_id, store_name: s.store_name, total_pieces: Math.round(s.total),
      garments: [...s.garments].sort((a, b) => b[1] - a[1]).map(([garment_name, cnt]) => ({ garment_name, count: Math.round(cnt) })),
      customers: [...s.customers].sort(),
    })).sort((a, b) => b.total_pieces - a.total_pieces);
    const stores = (await db.query<Raw>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name')).map((s) => ({ id: num(s.id), name: s.store_name }));
    return ok({ period, from, to, report, stores });
  });

  // ---- billing ---------------------------------------------------------------------------------------------
  const billingPerms = ['workshop.billing', 'billing.view'];
  route('GET', 'workshop_billing_list', billingPerms, async (req, ctx) => {
    const scope = await wsBillingScope(db, ctx.id, ctx.role_name);
    const statusFilter = String((req.query as Q).status ?? '');
    let where = "1=1 AND wb.status <> 'Void'";
    const params: unknown[] = [];
    if (statusFilter === 'Paid') where += " AND wb.status = 'Paid'";
    else if (statusFilter === 'Unpaid') where += " AND wb.status IN ('Unpaid','Partially Paid')";
    if (scope.workshop_id !== null) { where += ' AND wb.workshop_id = ?'; params.push(scope.workshop_id); }
    if (scope.blocked) where += ' AND 1 = 0';
    const bills = (await db.query<Raw>(
      `SELECT wb.id, wb.bill_number, wb.period_start, wb.period_end, wb.total_value, wb.workshop_share, wb.store_share, wb.share_percent, wb.status, wb.invoice_date, wb.due_date, wb.amount_paid,
              CASE WHEN wb.is_combined = 1 THEN 'All stores (combined)' ELSE s.store_name END AS store_name, w.workshop_name
       FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id JOIN workshops w ON w.id = wb.workshop_id WHERE ${where} ORDER BY wb.id DESC LIMIT 100`, params)).map((b) => ({
      id: num(b.id), bill_number: b.bill_number, store_name: b.store_name, workshop_name: b.workshop_name, period_start: b.period_start, period_end: b.period_end,
      total_value: num(b.total_value), workshop_share: num(b.workshop_share), store_share: num(b.store_share), share_percent: num(b.share_percent), status: b.status,
      invoice_date: b.invoice_date, due_date: b.due_date, amount_paid: num(b.amount_paid), balance_due: round2(num(b.workshop_share) - num(b.amount_paid)),
    }));
    const stores = await db.query<Raw>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
    let workshops = await db.query<Raw>('SELECT id, workshop_name, commission_workshop_percent FROM workshops WHERE is_active = 1 ORDER BY workshop_name');
    if (scope.workshop_id !== null) workshops = workshops.filter((w) => Number(w.id) === scope.workshop_id);
    if (scope.blocked) workshops = [];
    const types = await db.query<Raw>('SELECT id, type_name FROM payment_types WHERE is_active = 1 ORDER BY sort_order');
    return ok({
      can_manage_bills: scope.can_manage, bills,
      stores: stores.map((s) => ({ id: num(s.id), name: s.store_name })),
      workshops: workshops.map((w) => ({ id: num(w.id), workshop_name: w.workshop_name, commission_workshop_percent: num(w.commission_workshop_percent) })),
      payment_types: types.map((p) => ({ id: num(p.id), name: p.type_name })),
    });
  });

  route('GET', 'workshop_billing_detail', billingPerms, async (req, ctx) => {
    const billId = toInt((req.query as Q).id);
    if (!billId) throw new ApiError('invalid_request', 'A valid id is required.', 422);
    const scope = await wsBillingScope(db, ctx.id, ctx.role_name);
    const [bill] = await db.query<Raw>(
      `SELECT wb.*, CASE WHEN wb.is_combined = 1 THEN 'All stores (combined)' ELSE s.store_name END AS store_name, w.workshop_name, pt.type_name AS payment_type_name
       FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id JOIN workshops w ON w.id = wb.workshop_id LEFT JOIN payment_types pt ON pt.id = wb.payment_type_id WHERE wb.id = ?`, [billId]);
    if (!bill || scope.blocked || (scope.workshop_id !== null && Number(bill.workshop_id) !== scope.workshop_id)) throw new ApiError('not_found', 'Bill not found.', 404);
    const items = (await db.query<Raw>(
      `SELECT wbi.order_item_id, wbi.item_value, o.id AS order_id, o.order_number, g.garment_name, c.full_name AS customer_name
       FROM workshop_bill_items wbi JOIN order_items oi ON oi.id = wbi.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
       LEFT JOIN garments g ON g.id = oi.garment_id WHERE wbi.bill_id = ? ORDER BY o.order_number`, [billId])).map((it) => ({ order_id: num(it.order_id), order_number: it.order_number, garment_name: it.garment_name, customer_name: it.customer_name, item_value: num(it.item_value) }));
    const payments = (await db.query<Raw>(
      'SELECT p.amount, p.reference_no, p.paid_on, p.notes, pt.type_name FROM workshop_bill_payments p JOIN payment_types pt ON pt.id = p.payment_type_id WHERE p.bill_id = ? ORDER BY p.paid_on, p.id', [billId]))
      .map((p) => ({ amount: num(p.amount), payment_type_name: p.type_name, reference_no: p.reference_no, paid_on: p.paid_on, notes: p.notes }));
    return ok({
      can_manage_bills: scope.can_manage,
      bill: {
        id: num(bill.id), bill_number: bill.bill_number, store_name: bill.store_name, workshop_name: bill.workshop_name, period_start: bill.period_start, period_end: bill.period_end,
        total_value: num(bill.total_value), share_percent: num(bill.share_percent), workshop_share: num(bill.workshop_share), store_share: num(bill.store_share), status: bill.status,
        payment_type_name: bill.payment_type_name, reference_no: bill.reference_no, paid_at: bill.paid_at, subject: bill.subject, invoice_date: bill.invoice_date, due_date: bill.due_date,
        amount_paid: num(bill.amount_paid), balance_due: bill.status === 'Void' ? 0 : round2(num(bill.workshop_share) - num(bill.amount_paid)),
      },
      items, payments,
    });
  });

  route('POST', 'workshop_billing_generate', billingPerms, async (req, ctx) => {
    const scope = await wsBillingScope(db, ctx.id, ctx.role_name);
    if (!scope.can_manage) throw new ApiError('forbidden', 'You do not have permission to generate bills.', 403);
    const p = body(req);
    const storeId = toInt(p.store_id), workshopId = toInt(p.workshop_id);
    if (!storeId || !workshopId) throw new ApiError('invalid_request', 'Select a store and a workshop.', 422);
    if (scope.workshop_id !== null && workshopId !== scope.workshop_id) throw new ApiError('forbidden', 'You can only bill your own workshop.', 403);
    const res = await workshopInvoice.createInvoice(storeId, workshopId, String(p.from ?? ''), String(p.to ?? ''), todayIn(tz), null, ctx.id, null, null, 'none', 18, req.ip);
    if (!res.ok) throw new ApiError(res.code, res.error, ({ no_items: 422, invalid_request: 422, not_found: 404 } as Record<string, number>)[res.code] ?? 500);
    return ok({ bill_id: res.bill_id, bill_number: res.bill_number });
  });

  route('POST', 'workshop_billing_mark_paid', billingPerms, async (req, ctx) => {
    const scope = await wsBillingScope(db, ctx.id, ctx.role_name);
    if (!scope.can_manage) throw new ApiError('forbidden', 'You do not have permission to settle bills.', 403);
    const p = body(req);
    const billId = toInt(p.bill_id), paymentTypeId = toInt(p.payment_type_id);
    if (!billId || !paymentTypeId) throw new ApiError('invalid_request', 'Select a payment method.', 422);
    const [bill] = await db.query<Raw>('SELECT workshop_id, workshop_share, amount_paid FROM workshop_bills WHERE id = ?', [billId]);
    if (!bill || (scope.workshop_id !== null && Number(bill.workshop_id) !== scope.workshop_id)) throw new ApiError('not_found', 'Bill not found.', 404);
    let amount = p.amount !== undefined && p.amount !== null ? parseFloat(String(p.amount)) || 0 : 0;
    if (amount <= 0) amount = round2(num(bill.workshop_share) - num(bill.amount_paid)); // default: the full balance
    const res = await workshopInvoice.recordPayment(billId, amount, paymentTypeId, String(p.reference_no ?? ''), todayIn(tz), null, ctx.id, scope.workshop_id, req.ip);
    if (!res.ok) throw new ApiError(res.code, res.error, ({ not_found: 404, server_error: 500 } as Record<string, number>)[res.code] ?? 422);
    return ok({ message: res.status === 'Paid' ? 'Bill marked as Paid.' : 'Payment recorded.' });
  });
}
