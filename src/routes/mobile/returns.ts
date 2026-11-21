import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, num, ok } from '../../lib/http.js';
import { toFloat, toInt } from '../../lib/php.js';
import { qInt } from '../../lib/query.js';
import type { ReturnPhoto } from '../../services/returnService.js';

type Raw = Record<string, any>;

/** Ports of api/mobile/order_return.php and returns_list.php (Customer Returns, Rahul 21 Nov 2026). */
export async function registerMobileReturnRoutes(app: FastifyInstance) {
  const { db, returns, storage } = app.services;
  const route = (method: 'GET' | 'POST', name: string, permission: string, handler: (req: FastifyRequest, ctx: Awaited<ReturnType<typeof app.requireToken>>) => Promise<unknown>) => {
    const h = async (req: FastifyRequest) => {
      const ctx = await app.requireToken(req);
      app.requirePermission(ctx, permission);
      return handler(req, ctx);
    };
    app.route({ method, url: `/${name}`, handler: h });
    app.route({ method, url: `/${name}.php`, handler: h });
  };

  /** GET: order_id from the query. POST: multipart (order_id, item_ids "1,2,3", reason_id, note, optional photo) or form/JSON body. */
  const orderIdOf = (req: FastifyRequest, fields: Raw) => qInt((req.query as Raw).order_id ?? fields.order_id);

  const handler = async (req: FastifyRequest, ctx: Awaited<ReturnType<typeof app.requireToken>>) => {
    let fields: Raw = {};
    let photo: ReturnPhoto = null;
    if (req.method === 'POST') {
      if (req.isMultipart()) {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            const buf = await part.toBuffer();
            if (part.fieldname === 'photo' && part.filename) photo = part.file.truncated ? { tooLarge: true } : { buffer: buf };
          } else fields[part.fieldname] = String((part as { value: unknown }).value ?? '');
        }
      } else fields = (req.body as Raw) ?? {};
    }
    const orderId = orderIdOf(req, fields);
    if (!orderId) throw new ApiError('invalid_request', 'order_id is required.', 422);

    const order = (await db.query<Raw>(
      `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS order_number, os.status_key, os.status_label
       FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.id = ?`, [orderId]))[0];
    if (!order) throw new ApiError('not_found', 'Order not found.', 404);

    if (req.method === 'GET') {
      const items = (await returns.returnableItems(orderId)).map((i) => ({
        id: num(i.id), garment_name: i.garment_name, service_name: i.service_name,
        quantity: toInt(i.quantity), weight: i.weight !== null ? toFloat(i.weight) : null, billing_unit: i.billing_unit,
      }));
      return ok({
        can_return: order.status_key === 'delivered' && items.length > 0,
        order: { id: num(order.id), order_number: order.order_number, status_label: order.status_label },
        items,
        reasons: (await returns.activeReasons()).map((r) => ({ id: num(r.id), name: r.reason_name })),
      });
    }
    const ids = String(fields.item_ids ?? '').split(',').map((x) => toInt(x)).filter((x) => x !== 0);
    const res = await returns.createReturn(orderId, ids, toInt(fields.reason_id), String(fields.note ?? ''), photo, ctx.id, req.ip);
    if (res.success) return ok({ registered: res.count });
    throw new ApiError('return_failed', res.errors.join(' '), 422);
  };
  route('GET', 'order_return', 'orders.edit', handler);
  route('POST', 'order_return', 'orders.edit', handler);

  route('GET', 'returns_list', 'orders.view', async (req) => {
    const days = Math.max(1, Math.min(365, qInt((req.query as Raw).days) || 30));
    const rows = await db.query<Raw>(
      `SELECT cr.id, cr.created_at, cr.reason_text, cr.note, o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number,
       c.full_name, g.garment_name, oi.item_status, rr.status AS rework_status, p.file_path
       FROM customer_returns cr
       JOIN orders o ON o.id = cr.order_id JOIN customers c ON c.id = o.customer_id
       JOIN order_items oi ON oi.id = cr.order_item_id JOIN garments g ON g.id = oi.garment_id
       LEFT JOIN rework_records rr ON rr.id = cr.rework_id
       LEFT JOIN order_photos p ON p.id = cr.photo_id
       WHERE cr.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY cr.id DESC LIMIT 300`, [days]);
    return ok({
      returns: rows.map((r) => ({
        id: num(r.id), created_at: r.created_at, order_id: num(r.order_id), order_number: r.order_number, customer_name: r.full_name,
        garment_name: r.garment_name, reason: r.reason_text, note: r.note, item_status: r.item_status, rework_status: r.rework_status,
        photo_url: r.file_path ? storage.url('order_photos', r.file_path) : null,
      })),
    });
  });
}
