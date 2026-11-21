import { readFile, unlink } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError, ok } from '../../lib/http.js';
import { phpEmpty, toInt } from '../../lib/php.js';
import { qInt } from '../../lib/query.js';
import { generateDocumentNumber } from '../../services/documentNumber.js';
import { getSetting } from '../../services/settings.js';

type Raw = Record<string, any>;
const bodyOf = (req: FastifyRequest): Raw => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Raw) : {});
const idList = (v: unknown): number[] => [...new Set((Array.isArray(v) ? v : []).map((x) => toInt(x)).filter((x) => x !== 0))];

/** Ports of api/mobile/challan_{list,detail,generate,update,delete,pdf,send_whatsapp,whatsapp_numbers}.php (customer Challans for the Android app). */
export async function registerMobileChallanRoutes(app: FastifyInstance) {
  const { db, challanPdf, whatsapp } = app.services;
  type Ctx = Awaited<ReturnType<typeof app.requireToken>>;
  const route = (method: 'GET' | 'POST', name: string, permission: string, handler: (req: FastifyRequest, ctx: Ctx, reply: FastifyReply) => Promise<unknown>) => {
    const h = async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await app.requireToken(req);
      app.requirePermission(ctx, permission);
      return handler(req, ctx, reply);
    };
    app.route({ method, url: `/${name}`, handler: h });
    app.route({ method, url: `/${name}.php`, handler: h });
  };
  /** PHP: a method other than the expected one answers 405 AFTER auth. */
  const methodGuard = (method: 'GET' | 'POST', name: string, permission: string, handler: (req: FastifyRequest, ctx: Ctx, reply: FastifyReply) => Promise<unknown>) => {
    route(method, name, permission, handler);
    const other = method === 'GET' ? 'POST' : 'GET';
    route(other, name, permission, async () => { throw new ApiError('method_not_allowed', `Use ${method}.`, 405); });
  };
  const challanOrderIds = async (challanId: number) => (await db.query<Raw>('SELECT order_id FROM challan_orders WHERE challan_id = ? ORDER BY order_id', [challanId])).map((r) => Number(r.order_id));

  methodGuard('GET', 'challan_list', 'billing.view', async (req) => {
    const q = req.query as Raw;
    const search = String(q.q ?? '').trim();
    const page = Math.max(1, qInt(q.page) || 1);
    const perPage = 25;
    const offset = (page - 1) * perPage;
    let whereIds = '1=1';
    const idParams: unknown[] = [];
    if (search !== '') {
      whereIds += ' AND (ch.challan_number LIKE ? OR o.order_number LIKE ? OR o.short_order_code LIKE ? OR c.full_name LIKE ?)';
      const like = `%${search}%`;
      idParams.push(like, like, like, like);
    }
    const total = Number((await db.query<Raw>(`SELECT COUNT(DISTINCT ch.id) AS n FROM challans ch JOIN challan_orders co ON co.challan_id = ch.id JOIN orders o ON o.id = co.order_id JOIN customers c ON c.id = o.customer_id WHERE ${whereIds}`, idParams))[0]!.n);
    const challanIds = (await db.query<Raw>(
      `SELECT DISTINCT ch.id FROM challans ch JOIN challan_orders co ON co.challan_id = ch.id JOIN orders o ON o.id = co.order_id JOIN customers c ON c.id = o.customer_id
       WHERE ${whereIds} ORDER BY ch.id DESC LIMIT ${perPage} OFFSET ${offset}`, idParams)).map((r) => Number(r.id));
    let rows: Raw[] = [];
    if (challanIds.length) {
      rows = await db.query<Raw>(
        `SELECT ch.id, ch.challan_number, ch.with_amount, ch.combine_format, ch.created_at, u.full_name AS created_by_name,
         COUNT(DISTINCT co.order_id) AS order_count,
         GROUP_CONCAT(DISTINCT COALESCE(o.short_order_code, o.order_number) ORDER BY o.id SEPARATOR ', ') AS order_numbers,
         MIN(o.id) AS first_order_id, MIN(c.full_name) AS full_name,
         MIN(c.mobile) AS customer_mobile, MIN(c.address) AS customer_address,
         MIN(c.area) AS customer_area, MIN(c.city) AS customer_city,
         SUM((SELECT COALESCE(SUM(quantity * pieces_per_unit), 0) FROM order_items WHERE order_items.order_id = o.id)) AS garment_count
         FROM challans ch
         JOIN challan_orders co ON co.challan_id = ch.id
         JOIN orders o ON o.id = co.order_id
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users u ON u.id = ch.created_by
         WHERE ch.id IN (${challanIds.map(() => '?').join(',')})
         GROUP BY ch.id ORDER BY ch.id DESC`, challanIds);
    }
    return ok({ challans: rows, page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) });
  });

  methodGuard('GET', 'challan_detail', 'billing.view', async (req) => {
    const challanId = qInt((req.query as Raw).challan_id);
    if (!challanId) throw new ApiError('invalid_request', 'challan_id is required.', 422);
    const challan = (await db.query<Raw>('SELECT id, challan_number, with_amount, combine_format FROM challans WHERE id = ?', [challanId]))[0];
    if (!challan) throw new ApiError('not_found', 'Challan not found.', 404);
    return ok({ challan_id: Number(challan.id), challan_number: challan.challan_number, with_amount: !!Number(challan.with_amount), combine_format: challan.combine_format ?? 'aggregated', order_ids: await challanOrderIds(challanId) });
  });

  methodGuard('POST', 'challan_generate', 'billing.view', async (req, ctx) => {
    const raw = bodyOf(req);
    // Backward compatible: accepts either order_ids (array, new) or order_id (single, old callers).
    const given = raw.order_ids ?? (raw.order_id !== undefined && raw.order_id !== null ? [raw.order_id] : []);
    if (!Array.isArray(given)) throw new ApiError('invalid_request', 'order_ids must be an array.', 422);
    let orderIds = idList(given);
    let withAmount = !phpEmpty(raw.with_amount);
    const combineFormat = ['order_wise', 'delivery'].includes(String(raw.combine_format ?? 'aggregated')) ? String(raw.combine_format) : 'aggregated';
    if (combineFormat === 'delivery') withAmount = true; // delivery challan always shows each order's final amount
    if (!orderIds.length) throw new ApiError('invalid_request', 'At least one order_id is required.', 422);
    const found = (await db.query<Raw>(`SELECT id FROM orders WHERE id IN (${orderIds.map(() => '?').join(',')})`, orderIds)).map((r) => Number(r.id));
    const missing = orderIds.filter((x) => !found.includes(x));
    if (missing.length) throw new ApiError('not_found', 'Order(s) not found: ' + missing.join(', '), 404);

    // Reuse check: compare as a SET against every existing challan at this with_amount AND combine_format.
    orderIds = [...orderIds].sort((a, b) => a - b);
    for (const cand of await db.query<Raw>('SELECT id, challan_number FROM challans WHERE with_amount = ? AND combine_format = ?', [withAmount ? 1 : 0, combineFormat])) {
      const ex = await challanOrderIds(Number(cand.id));
      if (ex.length === orderIds.length && ex.every((v, i) => v === orderIds[i])) {
        return ok({ challan_id: Number(cand.id), challan_number: cand.challan_number, with_amount: withAmount, combine_format: combineFormat, order_ids: orderIds, reused: true });
      }
    }
    const challanNumber = await generateDocumentNumber(db, 'customer_challan_prefix', 6);
    let challanId: number;
    try {
      challanId = await db.tx(async (t) => {
        const ins = await t.execute('INSERT INTO challans (challan_number, order_id, with_amount, combine_format, created_by) VALUES (?, ?, ?, ?, ?)', [challanNumber, orderIds[0], withAmount ? 1 : 0, combineFormat, ctx.id]);
        for (const oid of orderIds) await t.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?, ?)', [ins.insertId, oid]);
        return ins.insertId;
      });
    } catch { throw new ApiError('generate_failed', 'Could not create the challan.', 500); }
    return ok({ challan_id: challanId, challan_number: challanNumber, with_amount: withAmount, combine_format: combineFormat, order_ids: orderIds, reused: false });
  });

  methodGuard('POST', 'challan_update', 'billing.view', async (req) => {
    const raw = bodyOf(req);
    const challanId = toInt(raw.challan_id);
    let orderIds = idList(raw.order_ids);
    let withAmount = !phpEmpty(raw.with_amount);
    const combineFormat = ['order_wise', 'delivery'].includes(String(raw.combine_format ?? 'aggregated')) ? String(raw.combine_format) : 'aggregated';
    if (combineFormat === 'delivery') withAmount = true;
    if (!challanId || !orderIds.length) throw new ApiError('invalid_request', 'challan_id and at least one order_id are required.', 422);
    const challan = (await db.query<Raw>('SELECT id, challan_number FROM challans WHERE id = ?', [challanId]))[0];
    if (!challan) throw new ApiError('not_found', 'Challan not found.', 404);
    const found = await db.query<Raw>(`SELECT id FROM orders WHERE id IN (${orderIds.map(() => '?').join(',')})`, orderIds);
    if (found.length !== orderIds.length) throw new ApiError('not_found', 'One or more selected orders could not be found.', 404);
    orderIds = [...orderIds].sort((a, b) => a - b);
    try {
      await db.tx(async (t) => {
        await t.execute('UPDATE challans SET with_amount = ?, combine_format = ?, order_id = ? WHERE id = ?', [withAmount ? 1 : 0, combineFormat, orderIds[0], challanId]);
        await t.execute('DELETE FROM challan_orders WHERE challan_id = ?', [challanId]);
        for (const oid of orderIds) await t.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?, ?)', [challanId, oid]);
      });
    } catch { throw new ApiError('update_failed', 'Could not update the challan.', 500); }
    return ok({ challan_id: challanId, challan_number: challan.challan_number, with_amount: withAmount, combine_format: combineFormat, order_ids: orderIds });
  });

  methodGuard('POST', 'challan_delete', 'billing.view', async (req) => {
    const challanId = toInt(bodyOf(req).challan_id);
    if (!challanId) throw new ApiError('invalid_request', 'challan_id is required.', 422);
    if (!(await db.query('SELECT id FROM challans WHERE id = ?', [challanId])).length) throw new ApiError('not_found', 'Challan not found.', 404);
    try {
      await db.tx(async (t) => { await t.execute('DELETE FROM challan_orders WHERE challan_id = ?', [challanId]); await t.execute('DELETE FROM challans WHERE id = ?', [challanId]); });
    } catch { throw new ApiError('delete_failed', 'Could not delete the challan.', 500); }
    return ok({ deleted: true });
  });

  // GET challan_pdf: the Bearer token may also arrive as ?token= (a raw binary download from Android's download manager can't always set headers).
  const pdfHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Raw;
    if (!req.headers.authorization && !phpEmpty(q.token)) req.headers.authorization = 'Bearer ' + String(q.token);
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'billing.view');
    if (req.method !== 'GET') throw new ApiError('method_not_allowed', 'Use GET.', 405);
    const challanId = qInt(q.challan_id);
    if (!challanId) throw new ApiError('invalid_request', 'challan_id is required.', 422);
    const challan = (await db.query<Raw>('SELECT with_amount, combine_format, challan_number FROM challans WHERE id = ?', [challanId]))[0];
    if (!challan) throw new ApiError('not_found', 'Challan not found.', 404);
    const orderIds = await challanOrderIds(challanId);
    if (!orderIds.length) throw new ApiError('not_found', 'This challan has no orders linked to it.', 404);
    const r = await challanPdf.generate(orderIds, !!Number(challan.with_amount), String(challan.challan_number), challan.combine_format ?? 'aggregated');
    if (!r.success || !r.file_path) throw new ApiError('pdf_failed', r.error ?? 'Could not generate the PDF.', 500);
    const bytes = await readFile(r.file_path);
    await unlink(r.file_path).catch(() => {});
    const filename = 'Challan-' + String(challan.challan_number).replace(/[^A-Za-z0-9_-]+/g, '-') + '.pdf';
    return reply.header('Content-Disposition', `inline; filename="${filename}"`).type('application/pdf').send(bytes);
  };
  for (const name of ['challan_pdf', 'challan_pdf.php']) { app.get(`/${name}`, pdfHandler); app.post(`/${name}`, pdfHandler); }

  methodGuard('POST', 'challan_send_whatsapp', 'billing.view', async (req, ctx) => {
    const raw = bodyOf(req);
    const challanId = toInt(raw.challan_id);
    const toNumber = String(raw.number ?? '').trim();
    if (!challanId || toNumber === '') throw new ApiError('invalid_request', 'challan_id and number are required.', 422);
    const challan = (await db.query<Raw>('SELECT with_amount, combine_format, challan_number FROM challans WHERE id = ?', [challanId]))[0];
    if (!challan) throw new ApiError('not_found', 'Challan not found.', 404);
    const orderIds = await challanOrderIds(challanId);
    if (!orderIds.length) throw new ApiError('not_found', 'This challan has no orders linked to it.', 404);
    const res = await whatsapp.sendChallan(orderIds, toNumber, !!Number(challan.with_amount), String(challan.challan_number), ctx.id, challan.combine_format ?? 'aggregated');
    if (res.success) return ok({ mode: res.mode });
    throw new ApiError('send_failed', res.error ?? 'Could not send on WhatsApp.', 422);
  });

  // GET/POST challan_whatsapp_numbers (permission admin.settings)
  const numbersHandler = async (req: FastifyRequest) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'admin.settings');
    if (req.method === 'GET') {
      let saved: unknown = [];
      try { saved = JSON.parse(String((await getSetting(db, 'challan_whatsapp_numbers', '[]')) ?? '[]')); } catch { saved = []; }
      return ok({ numbers: Array.isArray(saved) ? saved : [] });
    }
    const raw = bodyOf(req);
    const input = raw.numbers ?? [];
    if (!Array.isArray(input)) throw new ApiError('invalid_request', 'numbers must be an array.', 422);
    if (input.length > 5) throw new ApiError('invalid_request', 'Maximum 5 numbers allowed.', 422);
    const numbers: string[] = [];
    for (const rn of input) {
      const digits = String(rn ?? '').replace(/\D+/g, '');
      if (digits.length < 10) throw new ApiError('invalid_request', `"${String(rn ?? '')}" doesn't look like a valid mobile number.`, 422);
      numbers.push(digits);
    }
    const enc = JSON.stringify(numbers);
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('challan_whatsapp_numbers', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [enc, enc]);
    return ok({ numbers });
  };
  for (const name of ['challan_whatsapp_numbers', 'challan_whatsapp_numbers.php']) { app.get(`/${name}`, numbersHandler); app.post(`/${name}`, numbersHandler); }
}
