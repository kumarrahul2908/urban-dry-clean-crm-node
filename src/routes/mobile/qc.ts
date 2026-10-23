import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, num, ok } from '../../lib/http.js';
import { phpEmpty, toInt } from '../../lib/php.js';
import { qInt, qStr } from '../../lib/query.js';

type Raw = Record<string, any>;
type Q = Record<string, unknown>;
const numOrNull = (v: unknown) => (v !== null && v !== undefined ? Number(v) : null);
const stripTags = (s: string) => s.replace(/<[^>]*>?/g, '');

/** Ports of qc_queue / qc_action / rework_list / rework_action / packing_queue / packing_action. */
export async function registerMobileQcRoutes(app: FastifyInstance) {
  const { db, qc, laundry } = app.services;
  const route = (method: 'GET' | 'POST', name: string, permission: string, handler: (req: FastifyRequest, ctx: { id: number }) => Promise<unknown>) => {
    const h = async (req: FastifyRequest) => {
      const ctx = await app.requireToken(req);
      app.requirePermission(ctx, permission);
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

  // ---- QC ------------------------------------------------------------------------------------
  route('GET', 'qc_queue', 'qc.manage', async (req) => {
    const q = req.query as Q;
    let statusFilter = qStr(q.status);
    if (!['', 'QC', 'Rework'].includes(statusFilter)) statusFilter = '';
    const orderSearch = qStr(q.order), customerSearch = qStr(q.customer), garmentSearch = qStr(q.garment);
    let dueDate = qStr(q.due_date);
    if (dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) dueDate = '';
    const urgentOnly = !phpEmpty(q.urgent_only);
    const page = Math.max(1, qInt(q.page));
    const perPage = 25;

    let where = "oi.item_status IN ('QC','Rework') AND os.status_key != 'cancelled'";
    const params: unknown[] = [];
    if (statusFilter !== '') { where += ' AND oi.item_status = ?'; params.push(statusFilter); }
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    if (garmentSearch !== '') { where += ' AND g.garment_name LIKE ?'; params.push(`%${garmentSearch}%`); }
    if (dueDate !== '') { where += ' AND o.due_date = ?'; params.push(dueDate); }
    if (urgentOnly) where += ' AND o.urgent_level_id IS NOT NULL';
    const base = `FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id
      JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id WHERE ${where}`;
    const [{ n }] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, params)) as [{ n: number }];
    const rows = await db.query<Raw>(
      `SELECT oi.id, oi.order_id, oi.item_status, oi.quantity, oi.weight, o.order_number, o.short_order_code, o.due_date, o.due_time, c.full_name AS customer_name,
              g.garment_name, s.service_name, s.billing_unit, ul.level_name AS urgent_level_name
       ${base} ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params);
    const mapLaundry = (rs: Raw[]) => rs.map((lg) => ({
      laundry_garment_id: num(lg.id), sequence: num(lg.sequence), total_garments: num(lg.total_garments), order_id: num(lg.order_id), order_number: lg.order_number,
      customer_name: lg.customer_name, garment_name: lg.garment_name, service_name: lg.service_name, due_date: lg.due_date, status: lg.status, can_act: lg.status === 'QC',
    }));
    return ok({
      items: rows.map((r) => ({
        order_item_id: num(r.id), order_id: num(r.order_id), order_number: r.short_order_code ?? r.order_number, customer_name: r.customer_name, garment_name: r.garment_name,
        service_name: r.service_name, quantity: numOrNull(r.quantity), weight: numOrNull(r.weight), billing_unit: r.billing_unit, item_status: r.item_status,
        due_date: r.due_date, due_time: r.due_time, urgent_level_name: r.urgent_level_name, can_act: r.item_status === 'QC',
      })),
      page, per_page: perPage, total: num(n),
      laundry_qc_pending: mapLaundry(await laundry.listByStatus(['QC'])),
      laundry_in_rework: mapLaundry(await laundry.listByStatus(['Rework'])),
    });
  });

  route('POST', 'qc_action', 'qc.manage', async (req, ctx) => {
    const p = body(req);
    const actor = { userId: ctx.id, ip: req.ip };
    const action = String(p.action ?? '');
    const garmentType = String(p.garment_type ?? 'piece');
    const reason = stripTags(String(p.reason ?? '')).trim();
    const remarks = stripTags(String(p.remarks ?? '')).trim();
    if (!['pass', 'fail'].includes(action)) throw new ApiError('invalid_request', 'action must be "pass" or "fail".', 422);
    if (!['piece', 'laundry'].includes(garmentType)) throw new ApiError('invalid_request', 'garment_type must be "piece" or "laundry".', 422);
    if ([...reason].length > 500 || [...remarks].length > 500) throw new ApiError('invalid_request', 'Reason/remarks are too long.', 422);
    if (action === 'fail' && reason === '') throw new ApiError('invalid_request', 'A rework reason is required when failing QC.', 422);
    let result;
    if (garmentType === 'laundry') {
      const id = toInt(p.laundry_garment_id);
      if (id <= 0) throw new ApiError('invalid_request', 'A valid laundry_garment_id is required.', 422);
      result = action === 'pass' ? await qc.recordLaundryQc(id, actor, 'Passed', null, remarks) : await qc.recordLaundryQc(id, actor, 'Rework', reason, remarks);
    } else {
      const id = toInt(p.order_item_id);
      if (id <= 0) throw new ApiError('invalid_request', 'A valid order_item_id is required.', 422);
      result = action === 'pass' ? await qc.passQc(id, actor, remarks) : await qc.failQc(id, actor, reason, remarks);
    }
    if (!result.success) throw new ApiError('invalid_state', (result.errors ?? ['QC could not be recorded.']).join(' '), 422);
    return ok({ message: action === 'pass' ? 'QC Passed.' : 'QC Failed — moved to Rework.' });
  });

  // ---- rework -----------------------------------------------------------------------------------
  const nextAction = (s: string) => (s === 'Pending' ? 'start' : s === 'In Progress' ? 'complete' : null);
  route('GET', 'rework_list', 'rework.manage', async () => {
    const items = await db.query<Raw>(
      `SELECT rr.id AS rework_id, rr.reason, rr.status AS rework_status, rr.created_at, oi.id AS order_item_id, oi.quantity, oi.weight,
              o.id AS order_id, o.order_number, o.short_order_code, o.due_date, o.due_time, c.full_name AS customer_name, g.garment_name, s.service_name, s.billing_unit, ul.level_name AS urgent_level_name
       FROM rework_records rr JOIN order_items oi ON oi.id = rr.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
       JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       WHERE oi.item_status = 'Rework' AND rr.status != 'Completed' ORDER BY (o.urgent_level_id IS NULL), o.due_date, rr.id`);
    const lg = await db.query<Raw>(
      `SELECT rr.id AS rework_id, rr.reason, rr.status AS rework_status, rr.created_at, lg.id AS laundry_garment_id, lg.sequence, oi.quantity AS total_garments,
              o.id AS order_id, o.order_number, o.short_order_code, o.due_date, o.due_time, c.full_name AS customer_name, g.garment_name, s.service_name
       FROM rework_records rr JOIN laundry_garments lg ON lg.id = rr.laundry_garment_id JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id
       WHERE rr.status != 'Completed' ORDER BY o.due_date, rr.id`);
    return ok({
      items: items.map((r) => ({
        rework_id: num(r.rework_id), reason: r.reason, rework_status: r.rework_status, created_at: r.created_at, order_item_id: num(r.order_item_id), order_id: num(r.order_id),
        order_number: r.short_order_code ?? r.order_number, customer_name: r.customer_name, garment_name: r.garment_name, service_name: r.service_name, quantity: numOrNull(r.quantity),
        weight: numOrNull(r.weight), billing_unit: r.billing_unit, due_date: r.due_date, due_time: r.due_time, urgent_level_name: r.urgent_level_name, next_action: nextAction(r.rework_status),
      })),
      laundry: lg.map((r) => ({
        rework_id: num(r.rework_id), reason: r.reason, rework_status: r.rework_status, created_at: r.created_at, laundry_garment_id: num(r.laundry_garment_id), sequence: num(r.sequence),
        total_garments: num(r.total_garments), order_id: num(r.order_id), order_number: r.short_order_code ?? r.order_number, customer_name: r.customer_name, garment_name: r.garment_name,
        service_name: r.service_name, due_date: r.due_date, due_time: r.due_time, next_action: nextAction(r.rework_status),
      })),
    });
  });

  route('POST', 'rework_action', 'rework.manage', async (req, ctx) => {
    const p = body(req);
    const action = String(p.action ?? '');
    const reworkId = toInt(p.rework_id);
    if (!['start', 'complete'].includes(action)) throw new ApiError('invalid_request', 'action must be "start" or "complete".', 422);
    if (reworkId <= 0) throw new ApiError('invalid_request', 'A valid rework_id is required.', 422);
    const actor = { userId: ctx.id, ip: req.ip };
    const r = action === 'start' ? await qc.startRework(reworkId, actor) : await qc.completeRework(reworkId, actor);
    if (!r.success) throw new ApiError('invalid_state', (r.errors ?? ['Rework could not be updated.']).join(' '), 422);
    return ok({ message: action === 'start' ? 'Rework started.' : 'Rework completed — returned to QC Pending.' });
  });

  // ---- packing --------------------------------------------------------------------------------------
  route('GET', 'packing_queue', 'packing.manage', async (req) => {
    const q = req.query as Q;
    const orderSearch = qStr(q.order), customerSearch = qStr(q.customer);
    let where = "oi.item_status = 'Ready' AND os.status_key != 'cancelled'";
    const params: unknown[] = [];
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    const rows = await db.query<Raw>(
      `SELECT oi.id, oi.order_id, oi.quantity, oi.weight, o.order_number, o.short_order_code, o.due_date, o.due_time, c.full_name AS customer_name, g.garment_name, s.billing_unit,
              ul.level_name AS urgent_level_name, bc.barcode_value, bc.qr_token
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id
       JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       LEFT JOIN barcodes bc ON bc.order_item_id = oi.id WHERE ${where} ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id`, params);
    const groups = new Map<number, Raw>();
    for (const r of rows) {
      const oid = Number(r.order_id);
      if (!groups.has(oid)) groups.set(oid, { order_id: oid, order_number: r.short_order_code ?? r.order_number, customer_name: r.customer_name, items: [] });
      groups.get(oid)!.items.push({
        order_item_id: num(r.id), garment_name: r.garment_name, quantity: numOrNull(r.quantity), weight: numOrNull(r.weight), billing_unit: r.billing_unit,
        due_date: r.due_date, due_time: r.due_time, urgent_level_name: r.urgent_level_name, barcode_value: r.barcode_value,
      });
    }
    const batches = await db.query<Raw>(
      `SELECT oi.id, oi.order_id, oi.quantity AS total_garments, oi.weight, oi.weight_rate, o.order_number, o.short_order_code, o.due_date, o.due_time, c.full_name AS customer_name,
              s.service_name, ul.level_name AS urgent_level_name
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id
       JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       WHERE oi.item_status = 'Ready' AND o.order_mode = 'weight' AND os.status_key != 'cancelled' ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id`);
    return ok({
      orders: [...groups.values()],
      laundry_batches: batches.map((b) => ({
        order_item_id: num(b.id), order_id: num(b.order_id), order_number: b.short_order_code ?? b.order_number, customer_name: b.customer_name, service_name: b.service_name,
        total_garments: num(b.total_garments), weight: numOrNull(b.weight), weight_rate: numOrNull(b.weight_rate), due_date: b.due_date, due_time: b.due_time, urgent_level_name: b.urgent_level_name,
      })),
    });
  });

  route('POST', 'packing_action', 'packing.manage', async (req, ctx) => {
    const p = body(req);
    const id = toInt(p.order_item_id);
    if (id <= 0) throw new ApiError('invalid_request', 'A valid order_item_id is required.', 422);
    const r = await qc.markPacked(id, { userId: ctx.id, ip: req.ip });
    if (!r.success) throw new ApiError('invalid_state', (r.errors ?? ['Could not mark packed.']).join(' '), 422);
    return ok({ message: 'Marked as Packed.' });
  });
}
