import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, num, ok } from '../../lib/http.js';
import { phpEmpty, phpRound, toFloat, toInt } from '../../lib/php.js';
import { qInt, qStr } from '../../lib/query.js';
import { EXPENSE_TYPES, type EntryType } from '../../services/expenseService.js';

type Q = Record<string, unknown>;
type Raw = Record<string, any>;
const isScalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const scalarStr = (v: unknown) => (isScalar(v) ? String(v) : '');

/** Ports of feedback_*, expenses_list/expense_save and notifications_* under api/mobile/. */
export async function registerMobileMiscRoutes(app: FastifyInstance) {
  const { db, expenses } = app.services;

  const route = (method: 'GET' | 'POST', name: string, permission: string, handler: (req: FastifyRequest, ctx: Awaited<ReturnType<typeof app.requireToken>>) => Promise<unknown>) => {
    const h = async (req: FastifyRequest) => {
      const ctx = await app.requireToken(req);
      app.requirePermission(ctx, permission);
      return handler(req, ctx);
    };
    app.route({ method, url: `/${name}`, handler: h });
    app.route({ method, url: `/${name}.php`, handler: h });
  };
  const jsonBody = (req: FastifyRequest): Raw | null => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Raw) : null);

  // ---- feedback ------------------------------------------------------------------------------
  route('GET', 'feedback_list', 'feedback.manage', async (req) => {
    const q = req.query as Q;
    if (q.orders_for_customer !== undefined) {
      const orders = await db.query<Raw>('SELECT id, order_number, short_order_code, order_date FROM orders WHERE customer_id = ? ORDER BY order_date DESC, id DESC LIMIT 50', [qInt(q.orders_for_customer)]);
      return ok({ orders: orders.map((o) => ({ id: num(o.id), order_number: o.short_order_code ?? o.order_number, order_date: o.order_date })) });
    }
    const rating = qInt(q.rating);
    const status = qStr(q.status);
    const customer = qStr(q.customer);
    const order = qStr(q.order);
    let where = '1=1';
    const params: unknown[] = [];
    if (rating) { where += ' AND f.rating = ?'; params.push(rating); }
    if (status !== '') { where += ' AND f.status = ?'; params.push(status); }
    if (customer !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customer}%`, `%${customer}%`); }
    if (order !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${order}%`, `%${order}%`); }
    const rows = await db.query<Raw>(
      `SELECT f.*, c.full_name AS customer_name, c.mobile, o.order_number, o.short_order_code FROM feedback f JOIN customers c ON c.id = f.customer_id
       LEFT JOIN orders o ON o.id = f.order_id WHERE ${where} ORDER BY f.created_at DESC, f.id DESC LIMIT 100`, params);
    const [s] = await db.query<Raw>(
      `SELECT COUNT(*) AS total, AVG(rating) AS avg_rating, SUM(rating=5) AS r5, SUM(rating=4) AS r4, SUM(rating=3) AS r3, SUM(rating=2) AS r2, SUM(rating=1) AS r1,
              SUM(status='New') AS unreviewed, SUM(status='Resolved') AS resolved FROM feedback`);
    return ok({
      feedback: rows.map((f) => ({
        id: num(f.id), customer_id: num(f.customer_id), customer_name: f.customer_name, mobile: f.mobile,
        order_id: f.order_id !== null ? num(f.order_id) : null, order_number: f.short_order_code ?? f.order_number, rating: num(f.rating),
        comments: f.comments, status: f.status, created_at: f.created_at,
      })),
      summary: {
        total: num(s!.total), avg_rating: s!.avg_rating !== null ? phpRound(toFloat(s!.avg_rating), 1) : null,
        by_rating: { '5': num(s!.r5 ?? 0), '4': num(s!.r4 ?? 0), '3': num(s!.r3 ?? 0), '2': num(s!.r2 ?? 0), '1': num(s!.r1 ?? 0) },
        unreviewed: num(s!.unreviewed ?? 0), resolved: num(s!.resolved ?? 0),
      },
      statuses: ['New', 'Reviewed', 'Resolved'],
    });
  });

  route('POST', 'feedback_action', 'feedback.manage', async (req, ctx) => {
    const payload = jsonBody(req) ?? {};
    const action = scalarStr(payload.action).trim();
    const userId = ctx.id;

    if (action === 'set_status') {
      const feedbackId = toInt(payload.feedback_id);
      const newStatus = scalarStr(payload.status).trim();
      if (!['New', 'Reviewed', 'Resolved'].includes(newStatus)) throw new ApiError('validation_failed', 'Status must be New, Reviewed or Resolved.', 422);
      const changed = await db.tx(async (t) => {
        const [row] = await t.query<Raw>('SELECT id, status FROM feedback WHERE id = ? FOR UPDATE', [feedbackId]);
        if (!row) throw new ApiError('not_found', 'Feedback not found.', 404);
        const did = row.status !== newStatus;
        if (did) {
          await t.execute('UPDATE feedback SET status = ? WHERE id = ?', [newStatus, feedbackId]);
          await app.services.audit.using(t).record({ action: 'edit', module: 'feedback', recordId: String(feedbackId), oldValue: { status: row.status }, newValue: { status: newStatus }, userId, ip: req.ip });
        }
        return did;
      });
      return ok({ feedback_id: feedbackId, status: newStatus, changed });
    }

    if (action === 'add') {
      const customerId = toInt(payload.customer_id);
      const orderId = toInt(payload.order_id) || null;
      const ratingRaw = payload.rating ?? null;
      const rating = typeof ratingRaw !== 'object' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(String(ratingRaw ?? '')) && Math.trunc(Number(ratingRaw)) === Number(ratingRaw) ? Math.trunc(Number(ratingRaw)) : 0;
      const comments = scalarStr(payload.comments).trim();
      if (rating < 1 || rating > 5) throw new ApiError('validation_failed', 'Rating must be a whole number from 1 to 5.', 422);
      if (Buffer.byteLength(comments) > 65535) throw new ApiError('validation_failed', 'Comments are too long.', 422);
      return db.tx(async (t) => {
        const [c] = await t.query('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customerId]);
        if (!c) throw new ApiError('validation_failed', 'Invalid customer.', 422);
        if (orderId !== null) {
          const [o] = await t.query<{ customer_id: number }>('SELECT customer_id FROM orders WHERE id = ?', [orderId]);
          if (!o || Number(o.customer_id) !== customerId) throw new ApiError('validation_failed', 'The selected order does not belong to this customer.', 422);
        }
        const [dup] = await t.query<{ id: number }>(
          "SELECT id FROM feedback WHERE customer_id = ? AND order_id <=> ? AND rating = ? AND COALESCE(comments,'') = ? AND created_at >= NOW() - INTERVAL 2 MINUTE ORDER BY id DESC LIMIT 1",
          [customerId, orderId, rating, comments]);
        if (dup) return ok({ feedback_id: Number(dup.id), created: false, duplicate: true });
        const ins = await t.execute("INSERT INTO feedback (customer_id, order_id, rating, comments, status) VALUES (?,?,?,?, 'New')", [customerId, orderId, rating, comments]);
        await app.services.audit.using(t).record({ action: 'create', module: 'feedback', recordId: String(ins.insertId), newValue: { customer_id: customerId, order_id: orderId, rating }, userId, ip: req.ip });
        return ok({ feedback_id: ins.insertId, created: true, duplicate: false });
      });
    }
    throw new ApiError('validation_failed', 'Unknown action.', 422);
  });

  // ---- expenses / income ------------------------------------------------------------------------
  route('GET', 'expenses_list', 'expenses.manage', async (req) => {
    const q = req.query as Q;
    const type = String(q.type ?? 'expense');
    if (!EXPENSE_TYPES.includes(type as EntryType)) throw new ApiError('invalid_request', 'type must be expense or income.', 422);
    const data = await expenses.listEntries(type as EntryType, { from: q.from ?? null, to: q.to ?? null, category_id: q.category_id ?? null, q: q.q ?? '', page: q.page ?? 1, per_page: 25 });
    return ok({ ...data, categories: await expenses.categories(), payment_modes: await expenses.paymentModes() });
  });

  route('POST', 'expense_save', 'expenses.manage', async (req, ctx) => {
    const p = jsonBody(req);
    if (!p) throw new ApiError('invalid_request', 'Invalid request payload.', 400);
    const type = String(p.type ?? '');
    if (!EXPENSE_TYPES.includes(type as EntryType)) throw new ApiError('invalid_request', 'type must be expense or income.', 422);
    const id = !phpEmpty(p.id) ? toInt(p.id) : null;
    const r = await expenses.save(type as EntryType, id, p, ctx.id, req.ip);
    if (!r.success) {
      if ('not_found' in r && r.not_found) throw new ApiError('not_found', 'Entry not found.', 404);
      throw new ApiError('validation_failed', r.errors[0] ?? 'Could not save.', 422, { field_errors: r.errors });
    }
    return ok({ type, id: r.id, changed: r.changed, duplicate: r.duplicate });
  });

  // ---- in-app notifications ------------------------------------------------------------------------
  route('GET', 'notifications_list', 'notifications.manage', async (req, ctx) => {
    const filter = String((req.query as Q).filter ?? '');
    let where = "nl.channel = 'In-App' AND (nl.user_id = ? OR nl.user_id IS NULL)";
    if (filter === 'unread') where += ' AND nl.is_read = 0';
    const rows = await db.query<Raw>(
      `SELECT nl.id, nl.template_key, nl.message, nl.is_read, nl.created_at, nl.order_id, nl.customer_id, o.order_number, o.short_order_code, c.full_name AS customer_name
       FROM notification_logs nl LEFT JOIN orders o ON o.id = nl.order_id LEFT JOIN customers c ON c.id = nl.customer_id
       WHERE ${where} ORDER BY nl.created_at DESC LIMIT 100`, [ctx.id]);
    const [u] = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM notification_logs WHERE channel = 'In-App' AND (user_id = ? OR user_id IS NULL) AND is_read = 0", [ctx.id]);
    return ok({
      items: rows.map((r) => ({
        id: num(r.id), template_key: r.template_key, message: r.message, is_read: !!r.is_read, created_at: r.created_at,
        order_id: r.order_id !== null ? num(r.order_id) : null, order_number: r.short_order_code ?? r.order_number,
        customer_id: r.customer_id !== null ? num(r.customer_id) : null, customer_name: r.customer_name,
      })),
      unread_count: num(u!.n),
    });
  });

  route('POST', 'notifications_mark_read', 'notifications.manage', async (req, ctx) => {
    const p = jsonBody(req);
    if (!p) throw new ApiError('invalid_request', 'Invalid request payload.', 400);
    if (!phpEmpty(p.all)) {
      await db.execute("UPDATE notification_logs SET is_read = 1, read_at = NOW() WHERE channel = 'In-App' AND (user_id = ? OR user_id IS NULL) AND is_read = 0", [ctx.id]);
      return ok({ message: 'All notifications marked as read.' });
    }
    const id = toInt(p.notification_id);
    if (!id) throw new ApiError('invalid_request', 'A valid notification_id is required.', 422);
    const r = await db.execute("UPDATE notification_logs SET is_read = 1, read_at = NOW() WHERE id = ? AND channel = 'In-App' AND (user_id = ? OR user_id IS NULL)", [id, ctx.id]);
    if (r.affectedRows === 0) throw new ApiError('not_found', 'Notification not found.', 404);
    return ok({ message: 'Marked as read.' });
  });
}
