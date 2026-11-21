import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canActAsDelivery, isDeliveryManager } from '../../auth/stores.js';
import { isStrtotimeDate, todayIn, checkDate } from '../../lib/dates.js';
import { ApiError, num, ok } from '../../lib/http.js';
import { toInt } from '../../lib/php.js';
import { qStr } from '../../lib/query.js';
import { getSetting } from '../../services/settings.js';

type Raw = Record<string, any>;
type Q = Record<string, unknown>;
const numOrNull = (v: unknown) => (v !== null && v !== undefined ? Number(v) : null);
const stripTags = (s: string) => s.replace(/<[^>]*>?/g, '');
const ELIGIBLE = `os.status_key != 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.item_status NOT IN ('Packed','Delivered'))
  AND EXISTS (SELECT 1 FROM order_items oip WHERE oip.order_id = o.id AND oip.item_status = 'Packed')
  AND EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM pickup_orders p WHERE p.order_id = o.id AND p.status NOT IN ('Picked Up','Cancelled','Completed'))
  AND NOT EXISTS (SELECT 1 FROM delivery_orders d WHERE d.order_id = o.id AND d.status NOT IN ('Delivered','Cancelled'))`;

/** Ports of pickup_list/action, delivery_manage_list/action, delivery_mark_out/delivered, my_deliveries_list. */
export async function registerMobileFulfillmentRoutes(app: FastifyInstance) {
  const { db, fulfillment, env, hooks } = app.services;
  const tz = env.APP_TIMEZONE;
  const route = (method: 'GET' | 'POST', name: string, permission: string, handler: (req: FastifyRequest, ctx: Awaited<ReturnType<typeof app.requireToken>>) => Promise<unknown>) => {
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
  const managerOnly = (ctx: Parameters<typeof isDeliveryManager>[0]) => {
    if (!isDeliveryManager(ctx)) throw new ApiError('forbidden', 'Only delivery managers can schedule deliveries and assign drivers.', 403);
  };

  // ---- pickups --------------------------------------------------------------------------------
  route('GET', 'pickup_list', 'pickup.manage', async (req) => {
    const q = req.query as Q;
    const orderSearch = String(q.order ?? '').trim(), customerSearch = String(q.customer ?? '').trim(), statusFilter = String(q.status ?? '').trim();
    if (!['', 'eligible', 'Scheduled', 'Assigned'].includes(statusFilter)) throw new ApiError('invalid_request', 'Invalid status filter.', 422);
    let ew = ELIGIBLE;
    const ep: unknown[] = [];
    if (orderSearch !== '') { ew += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; ep.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { ew += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; ep.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    let eligible: Raw[] = [];
    if (statusFilter === '' || statusFilter === 'eligible') {
      eligible = (await db.query<Raw>(
        `SELECT o.id, o.order_number, o.short_order_code, o.due_date, o.due_time, o.grand_total, o.total_paid, o.current_due, c.full_name AS customer_name, c.mobile, ul.level_name AS urgent_level_name,
                (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
         FROM orders o JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
         WHERE ${ew} ORDER BY (o.urgent_level_id IS NULL), o.due_date`, ep)).map((r) => ({
        order_id: num(r.id), order_number: r.short_order_code ?? r.order_number, due_date: r.due_date, due_time: r.due_time, grand_total: num(r.grand_total), current_due: num(r.current_due),
        customer_name: r.customer_name, mobile: r.mobile, urgent_level_name: r.urgent_level_name, item_count: num(r.item_count),
      }));
    }
    let where = '1=1';
    const params: unknown[] = [];
    if (statusFilter !== '' && statusFilter !== 'eligible') { where += ' AND p.status = ?'; params.push(statusFilter); }
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    const active = (await db.query<Raw>(
      `SELECT p.*, o.order_number, o.short_order_code, ul.level_name AS urgent_level_name, c.full_name AS customer_name, c.mobile, dr.driver_name
       FROM pickup_orders p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id JOIN customers c ON c.id = p.customer_id LEFT JOIN drivers dr ON dr.id = p.driver_id
       WHERE ${where} AND p.status NOT IN ('Picked Up','Cancelled','Completed') ORDER BY p.pickup_date`, params)).map((r) => ({
      pickup_id: num(r.id), pickup_number: r.pickup_number, status: r.status, pickup_date: r.pickup_date, pickup_time: r.pickup_time,
      order_id: r.order_id !== null ? num(r.order_id) : null, order_number: r.short_order_code ?? r.order_number, customer_name: r.customer_name, mobile: r.mobile,
      driver_id: r.driver_id !== null ? num(r.driver_id) : null, driver_name: r.driver_name, urgent_level_name: r.urgent_level_name,
    }));
    const drivers = (await db.query<Raw>('SELECT id, driver_name FROM drivers WHERE is_active=1 ORDER BY driver_name')).map((r) => ({ id: num(r.id), name: r.driver_name }));
    return ok({ eligible, active, drivers });
  });

  route('POST', 'pickup_action', 'pickup.manage', async (req, ctx) => {
    const p = body(req);
    const a = { userId: ctx.id, ip: req.ip };
    const action = String(p.action ?? '');
    switch (action) {
      case 'create': {
        const orderId = toInt(p.order_id);
        const pickupDate = String(p.pickup_date ?? todayIn(tz)).trim();
        const pickupTime = String(p.pickup_time ?? '').trim();
        const notes = stripTags(String(p.notes ?? '')).trim();
        if (!orderId) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate) || !isStrtotimeDate(pickupDate)) throw new ApiError('invalid_request', 'Invalid pickup date.', 422);
        if (pickupTime !== '' && !/^\d{2}:\d{2}(:\d{2})?$/.test(pickupTime)) throw new ApiError('invalid_request', 'Invalid pickup time.', 422);
        if ([...notes].length > 500) throw new ApiError('invalid_request', 'Notes are too long.', 422);
        const r = await fulfillment.createPickup(orderId, pickupDate, pickupTime, notes, a);
        if (!r.success) throw new ApiError('action_failed', (r.errors ?? ['Could not schedule the pickup.']).join(' '), 422);
        try {
          const [row] = await db.query<Raw>('SELECT o.order_number, o.short_order_code, c.id AS customer_id, c.full_name, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]);
          if (row && row.mobile) await hooks.pickupScheduled({ customerId: num(row.customer_id), orderId, orderNumber: row.short_order_code ?? row.order_number, customerName: row.full_name, mobile: row.mobile, pickupDate });
        } catch (e) { console.error('pickup_scheduled hook failed:', (e as Error).message); }
        return ok({ message: 'Pickup scheduled.' });
      }
      case 'assign_driver': {
        const pickupId = toInt(p.pickup_id), driverId = toInt(p.driver_id);
        if (!pickupId || !driverId) throw new ApiError('invalid_request', 'pickup_id and driver_id are required.', 422);
        const r = await fulfillment.assignPickupDriver(pickupId, driverId, a);
        if (!r.success) throw new ApiError('action_failed', (r.errors ?? ['Could not assign the driver.']).join(' '), 422);
        return ok({ message: 'Driver assigned.' });
      }
      case 'mark_picked_up': {
        const pickupId = toInt(p.pickup_id);
        if (!pickupId) throw new ApiError('invalid_request', 'A valid pickup_id is required.', 422);
        const r = await fulfillment.markPickedUp(pickupId, a);
        if (!r.success) throw new ApiError('action_failed', (r.errors ?? ['Could not mark as picked up.']).join(' '), 422);
        return ok({ message: 'Marked as Picked Up.' });
      }
      default:
        throw new ApiError('invalid_request', 'Unknown action.', 422);
    }
  });

  // ---- deliveries ------------------------------------------------------------------------------
  route('GET', 'delivery_manage_list', 'delivery.manage', async (req, ctx) => {
    managerOnly(ctx);
    const q = req.query as Q;
    const orderSearch = qStr(q.order), customerSearch = qStr(q.customer);
    let statusFilter = qStr(q.status);
    if (!['', 'eligible', 'Pending', 'Assigned', 'Out for Delivery'].includes(statusFilter)) statusFilter = '';
    let eligible: Raw[] = [];
    if (statusFilter === '' || statusFilter === 'eligible') {
      let ew = ELIGIBLE;
      const ep: unknown[] = [];
      if (orderSearch !== '') { ew += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; ep.push(`%${orderSearch}%`, `%${orderSearch}%`); }
      if (customerSearch !== '') { ew += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; ep.push(`%${customerSearch}%`, `%${customerSearch}%`); }
      eligible = (await db.query<Raw>(
        `SELECT o.id, o.order_number, o.short_order_code, o.due_date, o.due_time, o.grand_total, o.total_paid, o.current_due, c.full_name AS customer_name, c.mobile, c.address, ul.level_name AS urgent_level_name,
                (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
         FROM orders o JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
         WHERE ${ew} ORDER BY (o.urgent_level_id IS NULL), o.due_date`, ep)).map((o) => ({
        order_id: num(o.id), order_number: o.short_order_code ?? o.order_number, customer_name: o.customer_name, mobile: o.mobile, has_address: String(o.address ?? '').trim() !== '',
        item_count: num(o.item_count), grand_total: num(o.grand_total), total_paid: num(o.total_paid), current_due: num(o.current_due), due_date: o.due_date, urgent_level_name: o.urgent_level_name,
      }));
    }
    let where = '1=1';
    const params: unknown[] = [];
    if (statusFilter !== '' && statusFilter !== 'eligible') { where += ' AND dl.status = ?'; params.push(statusFilter); }
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    let active: Raw[] = [];
    if (statusFilter !== 'eligible') {
      active = (await db.query<Raw>(
        `SELECT dl.id, dl.delivery_number, dl.order_id, dl.phone, dl.address, dl.amount_due, dl.delivery_date, dl.status, dl.driver_id, o.order_number, o.short_order_code, ul.level_name AS urgent_level_name,
                c.full_name AS customer_name, drv.driver_name, (SELECT COUNT(*) FROM order_items WHERE order_id = dl.order_id) AS item_count
         FROM delivery_orders dl JOIN orders o ON o.id = dl.order_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id JOIN customers c ON c.id = dl.customer_id LEFT JOIN drivers drv ON drv.id = dl.driver_id
         WHERE ${where} AND dl.status NOT IN ('Delivered','Cancelled') ORDER BY dl.delivery_date`, params)).map((d) => ({
        delivery_id: num(d.id), delivery_number: d.delivery_number, order_id: num(d.order_id), order_number: d.short_order_code ?? d.order_number, customer_name: d.customer_name, phone: d.phone, address: d.address,
        item_count: num(d.item_count), amount_due: numOrNull(d.amount_due), delivery_date: d.delivery_date, status: d.status, driver_id: d.driver_id !== null ? num(d.driver_id) : null,
        driver_name: d.driver_name, urgent_level_name: d.urgent_level_name, can_assign: d.driver_id === null && ['Pending', 'Assigned'].includes(d.status),
      }));
    }
    const drivers = (await db.query<Raw>('SELECT id, driver_name FROM drivers WHERE is_active=1 ORDER BY driver_name')).map((d) => ({ id: num(d.id), driver_name: d.driver_name }));
    return ok({ eligible, active, drivers });
  });

  route('POST', 'delivery_manage_action', 'delivery.manage', async (req, ctx) => {
    managerOnly(ctx);
    const p = body(req);
    const a = { userId: ctx.id, ip: req.ip };
    const action = String(p.action ?? '');
    if (action === 'schedule') {
      const orderId = toInt(p.order_id);
      const date = String(p.delivery_date ?? '').trim();
      if (orderId <= 0) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (!m || !checkDate(Number(m[1]), Number(m[2]), Number(m[3]))) throw new ApiError('invalid_request', 'delivery_date must be a valid date (YYYY-MM-DD).', 422);
      const r = await fulfillment.createDelivery(orderId, date, '', '', a);
      if (!r.success) throw new ApiError('invalid_state', (r.errors ?? ['Delivery could not be scheduled.']).join(' '), 422);
      return ok({ message: 'Delivery scheduled.', delivery_id: num(r.delivery_id) });
    }
    if (action === 'assign_driver') {
      const deliveryId = toInt(p.delivery_id), driverId = toInt(p.driver_id);
      if (deliveryId <= 0 || driverId <= 0) throw new ApiError('invalid_request', 'Valid delivery_id and driver_id are required.', 422);
      const r = await fulfillment.assignDeliveryDriver(deliveryId, driverId, a);
      if (!r.success) throw new ApiError('invalid_state', (r.errors ?? ['Driver could not be assigned.']).join(' '), 422);
      return ok({ message: 'Driver assigned.' });
    }
    throw new ApiError('invalid_request', 'action must be "schedule" or "assign_driver".', 422);
  });

  const transition = (name: string, label: 'Out for Delivery' | 'Delivered') =>
    route('POST', name, 'delivery.manage', async (req, ctx) => {
      const p = body(req);
      const deliveryId = toInt(p.delivery_id);
      if (!deliveryId) throw new ApiError('invalid_request', 'A valid delivery_id is required.', 422);
      if (!(await canActAsDelivery(db, ctx, deliveryId))) throw new ApiError('forbidden', 'You are not authorized to update this delivery.', 403);
      const a = { userId: ctx.id, ip: req.ip };
      const r = label === 'Delivered' ? await fulfillment.markDelivered(deliveryId, a) : await fulfillment.markOutForDelivery(deliveryId, a);
      if (!r.success) throw new ApiError('validation_failed', 'Could not update the delivery.', 422, { field_errors: r.errors });
      return ok({ delivery_id: deliveryId, status: label });
    });
  transition('delivery_mark_out', 'Out for Delivery');
  transition('delivery_mark_delivered', 'Delivered');

  route('GET', 'my_deliveries_list', 'delivery.manage', async (_req, ctx) => {
    const [drv] = await db.query<{ id: number }>('SELECT id FROM drivers WHERE user_id = ?', [ctx.id]);
    let where = "dl.status NOT IN ('Delivered','Cancelled')";
    const params: unknown[] = [];
    if (drv) { where += ' AND dl.driver_id = ?'; params.push(drv.id); }
    else if (isDeliveryManager(ctx)) where += ' AND dl.driver_id IS NOT NULL';
    else where += ' AND 1 = 0';
    const rows = await db.query<Raw>(
      `SELECT dl.id, dl.delivery_number, dl.order_id, o.order_number, o.short_order_code, dl.customer_id, c.full_name AS customer_name, dl.phone, dl.address, dl.amount_due, dl.status, dl.delivery_date, dl.time_slot,
              ul.level_name AS urgent_level_name, (SELECT COUNT(*) FROM order_items WHERE order_id = dl.order_id) AS item_count
       FROM delivery_orders dl JOIN orders o ON o.id = dl.order_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id JOIN customers c ON c.id = dl.customer_id
       WHERE ${where} ORDER BY (o.urgent_level_id IS NULL), dl.delivery_date`, params);
    return ok({
      is_own_deliveries: !!drv,
      deliveries: rows.map((d) => ({
        id: num(d.id), delivery_number: d.delivery_number, order_id: num(d.order_id), order_number: d.short_order_code ?? d.order_number, customer_name: d.customer_name, phone: d.phone, address: d.address,
        amount_due: num(d.amount_due), status: d.status, delivery_date: d.delivery_date, time_slot: d.time_slot, urgent_level_name: d.urgent_level_name, item_count: num(d.item_count),
      })),
    });
  });
}
