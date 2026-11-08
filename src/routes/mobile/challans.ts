import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile, unlink } from 'node:fs/promises';
import { addDays, todayIn } from '../../lib/dates.js';
import { ApiError, num, ok } from '../../lib/http.js';
import { toInt } from '../../lib/php.js';
import { qInt, qStr } from '../../lib/query.js';
import { getSetting } from '../../services/settings.js';

type Raw = Record<string, any>;
type Q = Record<string, unknown>;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SAVED_WHATSAPP_NUMBERS = 5;

/**
 * Ports of the challan_* endpoints: generate/edit/delete (the state machine in ChallanService),
 * list/detail (for the Android list + review screens), pdf (view/print), send-via-WhatsApp, and the
 * two reports (date-wise, garments-wise).
 *
 * challans_list's join chain is exactly the shape the live PHP app's rewrite once got wrong: a
 * LEFT JOIN users (for created_by_name) was accidentally dropped, and it only broke once real
 * challans existed to list -- an empty-result smoke test would never have caught it. Both this
 * file's query AND its test are built around that lesson: the test seeds real challans before
 * asserting on the list, not just an empty-state call.
 */
export async function registerMobileChallanRoutes(app: FastifyInstance) {
  const { db, challans, challanPdf, whatsapp, env } = app.services;
  const tz = env.APP_TIMEZONE;

  /** Up to MAX_SAVED_WHATSAPP_NUMBERS numbers (most-recently-used first) a challan is commonly sent
   * to -- a driver/courier, not necessarily any customer's own number. The first JSON-array-valued
   * setting in this app; no existing settings helper covers writing one, so it's read/written here
   * directly, the same ad hoc way every other settings write in this codebase already works. */
  const getSavedWhatsAppNumbers = async (): Promise<string[]> => {
    try {
      const parsed = JSON.parse((await getSetting(db, 'challan_whatsapp_numbers', '[]')) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  };
  const saveWhatsAppNumber = async (numberToSave: string) => {
    const current = await getSavedWhatsAppNumbers();
    const next = [numberToSave, ...current.filter((n) => n !== numberToSave)].slice(0, MAX_SAVED_WHATSAPP_NUMBERS);
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('challan_whatsapp_numbers', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [JSON.stringify(next)]);
  };

  const route = (method: 'GET' | 'POST', name: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => {
    app.route({ method, url: `/${name}`, handler });
    app.route({ method, url: `/${name}.php`, handler });
  };
  const auth = async (req: FastifyRequest) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'challans.manage');
    return ctx;
  };
  const body = (req: FastifyRequest): Raw => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError('invalid_request', 'Invalid request payload.', 400);
    return b as Raw;
  };
  /** null = unrestricted (no fixed store on this login). A fixed-store login only acts on / sees challans touching its own store's orders. */
  const allowedStores = (ctx: { store_id: number | null }): number[] | null => (ctx.store_id !== null ? [ctx.store_id] : null);
  const storeClause = (allowed: number[] | null, alias = 'ch') =>
    allowed !== null ? ` AND EXISTS (SELECT 1 FROM challan_orders co2 JOIN orders o2 ON o2.id = co2.order_id WHERE co2.challan_id = ${alias}.id AND o2.store_id IN (?))` : '';

  // ---- generate / edit / delete -----------------------------------------------------------------
  route('POST', 'challan_generate', async (req) => {
    const ctx = await auth(req);
    const p = body(req);
    const orderIds = Array.isArray(p.order_ids) ? p.order_ids : [];
    const result = await challans.generate(orderIds, !!p.with_amount, { userId: ctx.id, ip: req.ip }, allowedStores(ctx));
    if (!result.success) throw new ApiError('validation_failed', (result.errors ?? ['Could not create the challan.']).join(' '), 422, { field_errors: result.errors });
    return ok({ challan_id: num(result.challan_id), challan_number: result.challan_number, reused: !!result.reused });
  });

  route('POST', 'challan_edit', async (req) => {
    const ctx = await auth(req);
    const p = body(req);
    const challanId = toInt(p.challan_id);
    if (!challanId) throw new ApiError('invalid_request', 'A valid challan_id is required.', 422);
    const orderIds = Array.isArray(p.order_ids) ? p.order_ids : [];
    const result = await challans.edit(challanId, orderIds, !!p.with_amount, { userId: ctx.id, ip: req.ip }, allowedStores(ctx));
    if (!result.success) throw new ApiError(result.errors?.[0] === 'Challan not found.' ? 'not_found' : 'validation_failed', (result.errors ?? ['Could not update the challan.']).join(' '), result.errors?.[0] === 'Challan not found.' ? 404 : 422, { field_errors: result.errors });
    return ok({ challan_id: challanId, challan_number: result.challan_number });
  });

  route('POST', 'challan_delete', async (req) => {
    const ctx = await auth(req);
    const p = body(req);
    const challanId = toInt(p.challan_id);
    if (!challanId) throw new ApiError('invalid_request', 'A valid challan_id is required.', 422);
    const result = await challans.delete(challanId, { userId: ctx.id, ip: req.ip }, allowedStores(ctx));
    if (!result.success) throw new ApiError(result.errors?.[0] === 'Challan not found.' ? 'not_found' : 'forbidden', (result.errors ?? ['Could not delete the challan.']).join(' '), result.errors?.[0] === 'Challan not found.' ? 404 : 403);
    return ok({ deleted: true });
  });

  // ---- list / detail ------------------------------------------------------------------------------
  route('GET', 'challans_list', async (req) => {
    const ctx = await auth(req);
    const q = req.query as Q;
    const search = qStr(q.q);
    const page = Math.max(1, qInt(q.page) || 1);
    const perPage = 25;
    const allowed = allowedStores(ctx);

    let where = '1=1';
    const params: unknown[] = [];
    if (allowed !== null) { where += storeClause(allowed); params.push(allowed); }
    if (search !== '') {
      where += ` AND EXISTS (SELECT 1 FROM challan_orders co3 JOIN orders o3 ON o3.id = co3.order_id WHERE co3.challan_id = ch.id AND (ch.challan_number LIKE ? OR o3.order_number LIKE ? OR o3.short_order_code LIKE ?))`;
      params.push(...Array(3).fill(`%${search}%`));
    }
    const [{ n }] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM challans ch WHERE ${where}`, params)) as [{ n: number }];
    const rows = await db.query<Raw>(
      `SELECT ch.id, ch.challan_number, ch.with_amount, ch.created_at, u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM challan_orders co WHERE co.challan_id = ch.id) AS order_count,
              (SELECT GROUP_CONCAT(DISTINCT COALESCE(o.short_order_code, o.order_number) ORDER BY o.id SEPARATOR ', ')
                 FROM challan_orders co JOIN orders o ON o.id = co.order_id WHERE co.challan_id = ch.id) AS order_numbers,
              (SELECT COALESCE(SUM(oi.total), 0) FROM order_items oi WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ch.id)) AS total_value
       FROM challans ch
       LEFT JOIN users u ON u.id = ch.created_by
       WHERE ${where}
       ORDER BY ch.id DESC LIMIT ? OFFSET ?`,
      [...params, perPage, (page - 1) * perPage],
    );
    return ok({
      results: rows.map((r) => ({
        id: num(r.id), challan_number: r.challan_number, with_amount: !!Number(r.with_amount), created_at: r.created_at, created_by_name: r.created_by_name,
        order_count: num(r.order_count), order_numbers: r.order_numbers ?? '', total_value: num(r.total_value),
      })),
      page, per_page: perPage, total: num(n), total_pages: Math.ceil(num(n) / perPage),
    });
  });

  const loadChallan = async (ctx: { store_id: number | null }, challanId: number): Promise<Raw> => {
    if (challanId <= 0) throw new ApiError('invalid_request', 'A valid challan_id is required.', 422);
    const allowed = allowedStores(ctx);
    let where = 'ch.id = ?';
    const params: unknown[] = [challanId];
    if (allowed !== null) { where += storeClause(allowed); params.push(allowed); }
    const [challan] = await db.query<Raw>(`SELECT ch.*, u.full_name AS created_by_name FROM challans ch LEFT JOIN users u ON u.id = ch.created_by WHERE ${where}`, params);
    if (!challan) throw new ApiError('not_found', 'Challan not found.', 404);
    return challan;
  };

  route('GET', 'challan_detail', async (req) => {
    const ctx = await auth(req);
    const challan = await loadChallan(ctx, qInt((req.query as Q).id));
    const orders = await db.query<Raw>(
      `SELECT o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number, c.full_name AS customer_name, c.mobile, o.order_date
       FROM challan_orders co JOIN orders o ON o.id = co.order_id JOIN customers c ON c.id = o.customer_id
       WHERE co.challan_id = ? ORDER BY o.id`, [challan.id]);
    const items = await db.query<Raw>(
      `SELECT oi.order_id, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, COALESCE(s.service_name, 'Unknown Service') AS service_name, oi.quantity, oi.unit_price, oi.total
       FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id
       WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ?) ORDER BY oi.id`, [challan.id]);
    return ok({
      challan: { id: num(challan.id), challan_number: challan.challan_number, with_amount: !!Number(challan.with_amount), created_at: challan.created_at, created_by_name: challan.created_by_name },
      combined: orders.length > 1,
      orders: orders.map((o) => ({ order_id: num(o.order_id), order_number: o.order_number, customer_name: o.customer_name, mobile: o.mobile, order_date: o.order_date })),
      items: items.map((i) => ({ order_id: num(i.order_id), garment_name: i.garment_name, service_name: i.service_name, quantity: num(i.quantity), unit_price: num(i.unit_price), total: num(i.total) })),
      // populates the Send-via-WhatsApp number picker -- a challan commonly goes to a saved
      // driver/courier number, not necessarily any one order's own customer
      saved_whatsapp_numbers: await getSavedWhatsAppNumbers(),
    });
  });

  // ---- WhatsApp send -----------------------------------------------------------------------------
  route('POST', 'challan_send_whatsapp', async (req) => {
    const ctx = await auth(req);
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError('invalid_request', 'Invalid request payload.', 400);
    const p = b as Raw;
    const challan = await loadChallan(ctx, toInt(p.challan_id));
    const toNumber = qStr(p.to_number);
    if (toNumber === '') throw new ApiError('invalid_request', 'A WhatsApp number is required.', 422);
    const result = await whatsapp.sendChallan(Number(challan.id), toNumber, ctx.id);
    if (!result.success) {
      // same code/status split as whatsapp_send_invoice: a PDF-generation failure is this server's
      // own fault (500), anything else (no account configured, Meta rejected the send, ...) is
      // reported the same way as any other upstream-send failure (502).
      const pdfFailed = result.code === 'pdf_failed';
      throw new ApiError(pdfFailed ? 'server_error' : 'send_failed', result.error ?? 'Could not send the challan.', pdfFailed ? 500 : 502);
    }
    if (p.save_number) await saveWhatsAppNumber(toNumber);
    return ok({ sent: true, mode: result.mode });
  });

  // ---- PDF (view/print) ----------------------------------------------------------------------------
  route('GET', 'challan_pdf', async (req, reply) => {
    const ctx = await auth(req);
    const challan = await loadChallan(ctx, qInt((req.query as Q).id));
    const gen = await challanPdf.generate(Number(challan.id));
    if (!gen.success) throw new ApiError('action_failed', gen.error ?? 'Could not generate the PDF.', 422);
    try {
      const buf = await readFile(gen.file_path!);
      reply.header('Content-Disposition', `inline; filename="${challan.challan_number}.pdf"`);
      return reply.type('application/pdf').send(buf);
    } finally {
      await unlink(gen.file_path!).catch(() => {});
    }
  });

  // ---- reports ---------------------------------------------------------------------------------------
  const resolvePeriod = (q: Q) => {
    let period = String(q.period ?? 'week');
    const customFrom = String(q.from ?? ''), customTo = String(q.to ?? '');
    const today = todayIn(tz);
    let from: string, to: string;
    switch (period) {
      case '15days': from = addDays(today, -14); to = today; break;
      case '30days': from = addDays(today, -29); to = today; break;
      case 'custom': from = ISO.test(customFrom) ? customFrom : addDays(today, -6); to = ISO.test(customTo) ? customTo : today; break;
      default: period = 'week'; from = addDays(today, -6); to = today;
    }
    return { period, from, to };
  };

  route('GET', 'challan_report_date_wise', async (req) => {
    const ctx = await auth(req);
    const q = req.query as Q;
    const { period, from, to } = resolvePeriod(q);
    const allowed = allowedStores(ctx);
    let where = 'DATE(ch.created_at) BETWEEN ? AND ?';
    const params: unknown[] = [from, to];
    if (allowed !== null) { where += storeClause(allowed); params.push(allowed); }
    const rows = await db.query<Raw>(
      `SELECT DATE(ch.created_at) AS day, COUNT(DISTINCT ch.id) AS challan_count,
              COALESCE(SUM((SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ch.id))), 0) AS garment_count,
              COALESCE(SUM((SELECT COALESCE(SUM(oi.total), 0) FROM order_items oi WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ch.id))), 0) AS total_value
       FROM challans ch WHERE ${where} GROUP BY DATE(ch.created_at) ORDER BY day DESC`, params);
    return ok({
      period, from, to,
      report: rows.map((r) => ({ date: r.day, challan_count: num(r.challan_count), garment_count: num(r.garment_count), total_value: num(r.total_value) })),
    });
  });

  route('GET', 'challan_report_garments_wise', async (req) => {
    const ctx = await auth(req);
    const q = req.query as Q;
    const { period, from, to } = resolvePeriod(q);
    const allowed = allowedStores(ctx);
    let where = 'DATE(ch.created_at) BETWEEN ? AND ?';
    const params: unknown[] = [from, to];
    if (allowed !== null) { where += storeClause(allowed); params.push(allowed); }
    const rows = await db.query<Raw>(
      `SELECT COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, COALESCE(SUM(oi.quantity), 0) AS quantity, COALESCE(SUM(oi.total), 0) AS total_value
       FROM challans ch
       JOIN challan_orders co ON co.challan_id = ch.id
       JOIN order_items oi ON oi.order_id = co.order_id
       LEFT JOIN garments g ON g.id = oi.garment_id
       WHERE ${where}
       GROUP BY COALESCE(g.garment_name, 'Unknown Garment')
       ORDER BY quantity DESC`, params);
    return ok({
      period, from, to,
      report: rows.map((r) => ({ garment_name: r.garment_name, quantity: num(r.quantity), total_value: num(r.total_value) })),
    });
  });
}
