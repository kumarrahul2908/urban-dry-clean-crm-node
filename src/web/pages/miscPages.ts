import type { FastifyInstance } from 'fastify';
import { phpEmpty, toInt } from '../../lib/php.js';
import { auditOptions, fetchAudit, parseFilters, roleAllowed } from '../../services/auditViewer.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { httpBuildQuery } from '../format.js';
import { raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplAuditIndex } from '../tpl/audit_index.js';
import { tplFeedbackIndex } from '../tpl/feedback_index.js';
import { tplNotificationsIndex } from '../tpl/notifications_index.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);

export function registerMiscPages(app: FastifyInstance) {
  const { db, audit } = app.services;

  // ---- audit log (read-only) -------------------------------------------------------------------
  webPage(app, '/modules/audit/index', { auth: 'audit.view' }, async (ctx, req) => {
    if (!roleAllowed(ctx.roleName() || null)) {
      return new WebText(`<h2>403 - Access Denied</h2><p>Only Super Admin and Admin can view the audit log.</p><p><a href="${ctx.baseUrl('modules/dashboard/index.php')}">Back to Dashboard</a></p>`, 403);
    }
    const parsed = parseFilters(req.query as Record<string, unknown>);
    const f = parsed.filters, errors = parsed.errors;
    const result = errors.length ? { rows: [] as Row[], total: 0, page: 1, per_page: f.per_page } : await fetchAudit(db, f);
    const options = await auditOptions(db);
    const pages = Math.max(1, Math.ceil(result.total / result.per_page));
    const qsHelper = (o: Record<string, unknown> | Map<string, unknown>) => {
      const over = o instanceof Map ? Object.fromEntries(o) : o;
      const merged: Record<string, unknown> = { module: f.module, action: f.action, user_id: f.user_id, record_id: f.record_id, date_from: f.date_from, date_to: f.date_to, ...over };
      const p: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(merged)) if (v !== null && v !== undefined && v !== '') p[k] = v;
      return '?' + httpBuildQuery(p);
    };
    const h = await tplHelpers(ctx, { qsHelper });
    return layout(ctx, { title: 'Audit Log' }, raw(tplAuditIndex({ errors, f, options, pages, result }, h)));
  });

  // ---- notifications ---------------------------------------------------------------------------
  webPage(app, '/modules/notifications/index', { auth: 'notifications.manage' }, async (ctx, req) => {
    const userId = Number(ctx.data.user_id);
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const action = clean(p.action);
      if (action === 'mark_read') {
        await db.execute("UPDATE notification_logs SET is_read = 1, read_at = NOW() WHERE id = ? AND channel = 'In-App' AND (user_id = ? OR user_id IS NULL)", [toInt(p.notification_id), userId]);
      } else if (action === 'mark_all_read') {
        await db.execute("UPDATE notification_logs SET is_read = 1, read_at = NOW() WHERE channel = 'In-App' AND (user_id = ? OR user_id IS NULL) AND is_read = 0", [userId]);
      }
      return new WebRedirect('modules/notifications/index.php');
    }
    const filter = clean((req.query as Record<string, unknown>).filter);
    let where = "channel = 'In-App' AND (user_id = ? OR user_id IS NULL)";
    if (filter === 'unread') where += ' AND is_read = 0';
    const notifications = await db.query<Row>(
      `SELECT nl.*, COALESCE(o.short_order_code, o.order_number) AS order_number, o.order_number AS long_order_number, c.full_name AS customer_name FROM notification_logs nl LEFT JOIN orders o ON o.id = nl.order_id LEFT JOIN customers c ON c.id = nl.customer_id
       WHERE ${where} ORDER BY nl.created_at DESC LIMIT 100`, [userId]);
    // Notifications saved before the short order code was used everywhere still have the long number inside their stored text: shown with the short code instead (the saved row is not changed).
    for (const n of notifications) if (n.long_order_number && n.order_number && n.long_order_number !== '0' && n.order_number !== '0') n.message = String(n.message ?? '').split(String(n.long_order_number)).join(String(n.order_number));
    const unreadCount = Number((await db.query<Row>("SELECT COUNT(*) AS n FROM notification_logs WHERE channel = 'In-App' AND (user_id = ? OR user_id IS NULL) AND is_read = 0", [userId]))[0]!.n);
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'Notifications' }, raw(tplNotificationsIndex({ filter, notifications, unreadCount }, h)));
  });

  // ---- feedback --------------------------------------------------------------------------------
  webPage(app, '/modules/feedback/index', { auth: 'feedback.manage' }, async (ctx, req) => {
    const uid = ctx.data.user_id ?? null;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const action = clean(p.action);
      const feedbackId = toInt(p.feedback_id);
      if (action === 'set_status') {
        const newStatus = clean(p.status);
        if (['New', 'Reviewed', 'Resolved'].includes(newStatus)) {
          const msg = await db.tx(async (t) => {
            const cur = (await t.query<Row>('SELECT status FROM feedback WHERE id = ? FOR UPDATE', [feedbackId]))[0];
            if (!cur) return ['danger', 'Feedback not found.'] as const;
            if (cur.status === newStatus) return ['info', 'Feedback status was already ' + newStatus + '.'] as const;
            await t.execute('UPDATE feedback SET status = ? WHERE id = ?', [newStatus, feedbackId]);
            await ctx.svc.audit.using(t).record({ action: 'edit', module: 'feedback', recordId: String(feedbackId), newValue: { status: newStatus }, userId: uid, ip: req.ip });
            return ['success', 'Feedback status updated.'] as const;
          });
          ctx.flashSet(msg[0], msg[1]);
        }
      } else if (action === 'add') {
        const customerId = toInt(p.customer_id);
        const orderId = toInt(p.order_id) || null;
        const rating = Math.max(1, Math.min(5, toInt(p.rating)));
        const comments = clean(p.comments);
        const customerOk = (await db.query('SELECT id FROM customers WHERE id = ?', [customerId])).length > 0;
        let orderOk = true;
        if (customerOk && orderId !== null) {
          const o = (await db.query<Row>('SELECT customer_id FROM orders WHERE id = ?', [orderId]))[0];
          orderOk = (o ? Number(o.customer_id) : 0) === customerId;
        }
        if (customerOk && !orderOk) ctx.flashSet('danger', 'The selected order does not belong to this customer.');
        else if (customerOk && rating >= 1) {
          const r = await db.execute("INSERT INTO feedback (customer_id, order_id, rating, comments, status) VALUES (?,?,?,?, 'New')", [customerId, orderId, rating, comments]);
          await audit.record({ action: 'create', module: 'feedback', recordId: String(r.insertId), newValue: { customer_id: customerId, rating }, userId: uid, ip: req.ip });
          ctx.flashSet('success', 'Feedback recorded.');
        } else ctx.flashSet('danger', 'Invalid customer or rating.');
      }
      return new WebRedirect('modules/feedback/index.php');
    }
    const q = req.query as Record<string, unknown>;
    const ratingFilter = toInt(q.rating), statusFilter = clean(q.status), customerSearch = clean(q.customer), orderSearch = clean(q.order);
    let where = '1=1';
    const params: unknown[] = [];
    if (ratingFilter) { where += ' AND f.rating = ?'; params.push(ratingFilter); }
    if (statusFilter !== '') { where += ' AND f.status = ?'; params.push(statusFilter); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    const rows = await db.query<Row>(
      `SELECT f.*, c.full_name AS customer_name, c.mobile, COALESCE(o.short_order_code, o.order_number) AS order_number FROM feedback f JOIN customers c ON c.id = f.customer_id LEFT JOIN orders o ON o.id = f.order_id
       WHERE ${where} ORDER BY f.created_at DESC LIMIT 100`, params);
    const summary = (await db.query<Row>(
      `SELECT COUNT(*) AS total, AVG(rating) AS avg_rating, SUM(rating=5) AS r5, SUM(rating=4) AS r4, SUM(rating=3) AS r3, SUM(rating=2) AS r2, SUM(rating=1) AS r1,
       SUM(status='New') AS unreviewed, SUM(status='Resolved') AS resolved FROM feedback`))[0]!;
    const customersForAdd = await db.query<Row>('SELECT id, full_name, mobile FROM customers WHERE is_active=1 ORDER BY full_name LIMIT 200');
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'Customer Feedback' }, raw(tplFeedbackIndex({ customerSearch, customersForAdd, orderSearch, ratingFilter, rows, statusFilter, summary }, h)));
  });
  void phpEmpty;
}
