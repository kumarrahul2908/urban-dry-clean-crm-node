import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFile, unlink } from 'node:fs/promises';
import { ApiError, num, ok } from '../../lib/http.js';
import { phpEmpty, toFloat, toInt } from '../../lib/php.js';
import { qInt } from '../../lib/query.js';
import { CustomerSegments } from '../../services/customerSegments.js';
import { wsBillingScope } from '../../services/workshopScope.js';

type Raw = Record<string, any>;
const jsonBody = (req: FastifyRequest): Raw => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Raw) : {});
/** mb_strimwidth($s, 0, $w, $trim) without wide-char (East Asian) handling: this data is Latin/emoji chat text. */
const strimwidth = (s: string, width: number, trim: string) => { const a = Array.from(s); return a.length <= width ? s : a.slice(0, width - Array.from(trim).length).join('') + trim; };

/** Ports of api/mobile/{whatsapp_conversations,whatsapp_thread,whatsapp_media,whatsapp_bulk,caller_lookup,fcm_register,workshop_billing_pdf,workshop_billing_send_whatsapp}.php. */
export async function registerMobileWhatsAppChatRoutes(app: FastifyInstance) {
  const { db, whatsapp, workshopBillPdf } = app.services;
  type Ctx = Awaited<ReturnType<typeof app.requireToken>>;
  const both = (method: 'GET' | 'POST', name: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => {
    app.route({ method, url: `/${name}`, handler });
    app.route({ method, url: `/${name}.php`, handler });
  };
  const authed = (permission: string, handler: (req: FastifyRequest, ctx: Ctx, reply: FastifyReply) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, permission);
    return handler(req, ctx, reply);
  };
  const sendMedia = (reply: FastifyReply, m: { contentType: string; body: Buffer; disposition?: string; cacheControl?: string; nosniff?: boolean }) => {
    if (m.disposition) reply.header('Content-Disposition', m.disposition);
    if (m.cacheControl) reply.header('Cache-Control', m.cacheControl);
    if (m.nosniff) reply.header('X-Content-Type-Options', 'nosniff');
    return reply.type(m.contentType).send(m.body);
  };

  // ---- conversations (one row per phone, newest first) ----------------------------------------------------
  const conversations = authed('billing.view', async (req) => {
    const search = String((req.query as Raw).q ?? '').trim();
    let where = '1=1';
    const params: unknown[] = [];
    if (search !== '') { where += ' AND (wm.phone_number LIKE ? OR c.full_name LIKE ?)'; const like = `%${search}%`; params.push(like, like); }
    const rows = await db.query<Raw>(
      `SELECT wm.phone_number, wm.direction, wm.message_type, wm.message_text, wm.status, wm.created_at, c.full_name, c.id AS customer_id
       FROM whatsapp_messages wm
       JOIN (SELECT phone_number, MAX(created_at) AS max_created FROM whatsapp_messages GROUP BY phone_number) latest ON latest.phone_number = wm.phone_number AND latest.max_created = wm.created_at
       LEFT JOIN customers c ON c.id = wm.customer_id
       WHERE ${where} GROUP BY wm.phone_number ORDER BY wm.created_at DESC LIMIT 100`, params);
    return ok({ conversations: rows });
  });
  both('GET', 'whatsapp_conversations', conversations);
  both('POST', 'whatsapp_conversations', authed('billing.view', async () => { throw new ApiError('method_not_allowed', 'Use GET.', 405); }));

  // ---- thread: GET (messages + customer context) / POST {phone,text} reply / POST multipart attachment --------------
  const thread = authed('billing.view', async (req, ctx) => {
    if (req.method === 'GET') {
      const phone = String((req.query as Raw).phone ?? '').trim();
      if (phone === '') throw new ApiError('invalid_request', 'phone is required.', 422);
      const messages = await db.query<Raw>('SELECT wm.*, c.full_name FROM whatsapp_messages wm LEFT JOIN customers c ON c.id = wm.customer_id WHERE wm.phone_number = ? ORDER BY wm.created_at ASC LIMIT 500', [phone]);
      // A reaction row stores the reacted-to message's provider id in media_url -- resolved to a short text so the app needs no second lookup.
      const byProviderId = new Map<string, Raw>();
      for (const pm of messages) if (!phpEmpty(pm.provider_message_id)) byProviderId.set(String(pm.provider_message_id), pm);
      for (const rm of messages) {
        rm.reacted_to_text = null;
        if (rm.message_type === 'reaction') {
          const t = byProviderId.get(String(rm.media_url));
          if (t) rm.reacted_to_text = t.message_text !== null && t.message_text !== '' ? strimwidth(String(t.message_text), 60, '…') : `[${t.message_type}]`;
          rm.media_url = null; // internal id, not for the client
        }
      }
      // Hide the internal stored-file name of media we sent; the app only needs to know a file exists.
      for (const lm of messages) if (typeof lm.media_url === 'string' && lm.media_url.startsWith('local:')) lm.media_url = 'local';
      let customer: Raw | null = null;
      const customerId = messages.map((m) => (phpEmpty(m.customer_id) ? 0 : Number(m.customer_id))).find((x) => x) ?? 0;
      if (customerId) {
        customer = (await db.query<Raw>('SELECT id, full_name, mobile FROM customers WHERE id = ?', [customerId]))[0] ?? null;
        if (customer) {
          const orders = await db.query<Raw>(
            `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.order_mode, o.order_date, o.grand_total, os.status_label, os.color AS status_color
             FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT 5`, [customerId]);
          customer.recent_orders = orders.map((o) => ({ ...o, service_type: o.order_mode === 'weight' ? 'Laundry' : 'Dry Cleaning' }));
        }
      }
      return ok({ messages, customer });
    }
    if (req.method !== 'POST') throw new ApiError('method_not_allowed', 'Use GET or POST.', 405);

    const customerIdOf = async (phone: string) => Number((await db.query<Raw>('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [phone]))[0]?.id ?? 0);
    if (req.isMultipart()) {
      // Multipart attachment (photo / PDF) from the app: fields phone, caption (optional), file 'attachment'.
      const fields: Raw = {}; let attachment: { buffer: Buffer } | null = null; let hasFile = false;
      for await (const part of req.parts()) {
        if (part.type === 'file') { const buf = await part.toBuffer(); if (part.fieldname === 'attachment' && part.filename) { attachment = { buffer: buf }; hasFile = true; } }
        else fields[part.fieldname] = String((part as { value: unknown }).value ?? '');
      }
      if (hasFile) {
        const phone = String(fields.phone ?? '').trim();
        if (phone === '') throw new ApiError('invalid_request', 'phone is required.', 422);
        const res = await whatsapp.sendUploadedAttachment(await customerIdOf(phone), phone, attachment, String(fields.caption ?? '').trim(), ctx.id);
        if (res.success) return ok({ sent: true });
        throw new ApiError('send_failed', res.error ?? 'Could not send the attachment.', 422);
      }
    }
    const raw = jsonBody(req);
    const phone = String(raw.phone ?? '').trim(), text = String(raw.text ?? '').trim();
    if (phone === '' || text === '') throw new ApiError('invalid_request', 'phone and text are required.', 422);
    const res = await whatsapp.sendDirectReply(await customerIdOf(phone), phone, text, ctx.id);
    if (res.success) return ok({ sent: true });
    throw new ApiError('send_failed', res.error ?? 'Could not send the message.', 422);
  });
  both('GET', 'whatsapp_thread', thread);
  both('POST', 'whatsapp_thread', thread);

  both('GET', 'whatsapp_media', authed('billing.view', async (req, _ctx, reply) => {
    const m = await whatsapp.messageMedia(qInt((req.query as Raw).id));
    if (!m) throw new ApiError('not_found', 'Media not available.', 404);
    return sendMedia(reply, m);
  }));

  // ---- bulk message (permission whatsapp.settings) ----------------------------------------------------------
  const bulkTemplates = async () => (await db.query<Raw>("SELECT id, template_key, subject, body, provider_template_name, meta_status, meta_reject_reason, category FROM notification_templates WHERE channel='WhatsApp' AND is_active=1 AND category IS NOT NULL ORDER BY id DESC"))
    .map((t) => ({ id: num(t.id), name: !phpEmpty(t.subject) ? t.subject : t.template_key, body: t.body, category: t.category, status: !phpEmpty(t.meta_status) ? t.meta_status : 'PENDING', approved: !phpEmpty(t.provider_template_name), reject_reason: t.meta_reject_reason }));
  const bulk = authed('whatsapp.settings', async (req, ctx) => {
    if (req.method === 'GET') {
      try {
        if (Number((await db.query<Raw>("SELECT COUNT(*) AS n FROM notification_templates WHERE channel='WhatsApp' AND category IS NOT NULL AND meta_status IN ('PENDING','IN_APPEAL')"))[0]!.n) > 0) await whatsapp.syncTemplateStatuses();
      } catch { /* best effort */ }
      return ok({ templates: await bulkTemplates(), segments: Object.entries(CustomerSegments.available).map(([key, label]) => ({ key, label })) });
    }
    if (req.method !== 'POST') throw new ApiError('method_not_allowed', 'Use GET or POST.', 405);
    const raw = jsonBody(req);
    const action = String(raw.action ?? '');
    if (action === 'create_template') {
      const r = await whatsapp.createBulkTemplate(String(raw.label ?? ''), String(raw.category ?? 'MARKETING'), String(raw.body ?? ''));
      if (!r.success) throw new ApiError('template_failed', r.error ?? '', 422);
      return ok({ template_id: r.template_id, status: r.status, templates: await bulkTemplates() });
    }
    if (action === 'sync') {
      const r = await whatsapp.syncTemplateStatuses();
      if (!r.success) throw new ApiError('sync_failed', r.error ?? '', 502);
      return ok({ updated: r.updated, templates: await bulkTemplates() });
    }
    if (action === 'send') {
      const store = !phpEmpty(raw.store_id) ? toInt(raw.store_id) : null;
      const ids = Array.isArray(raw.customer_ids) ? raw.customer_ids.map((x: unknown) => toInt(x)) : [];
      const r = await whatsapp.startBulkCampaign(String(raw.campaign_name ?? ''), toInt(raw.template_id), !phpEmpty(raw.segment) ? String(raw.segment) : null, ids, store, ctx.id);
      if (!r.success) throw new ApiError('send_failed', r.error ?? '', 422);
      return ok({ queued: r.queued, skipped: r.skipped, no_optin: r.no_optin });
    }
    throw new ApiError('invalid_request', 'Unknown action.', 422);
  });
  both('GET', 'whatsapp_bulk', bulk);
  both('POST', 'whatsapp_bulk', bulk);

  // ---- caller lookup (incoming phone call -> customer + order status popup) ------------------------------------
  both('GET', 'caller_lookup', authed('billing.view', async (req) => {
    const rawNumber = String((req.query as Raw).number ?? '').trim();
    const digits = rawNumber.replace(/\D+/g, '');
    const last10 = digits.slice(-10);
    const empty = { customer: null, orders: [] as Raw[], total_due: 0, ambiguous: false };
    let customer: Raw | undefined;
    if (last10.length >= 10) {
      customer = (await db.query<Raw>(
        `SELECT id, full_name, mobile FROM customers
         WHERE RIGHT(REGEXP_REPLACE(mobile, '[^0-9]', ''), 10) = ? OR RIGHT(REGEXP_REPLACE(COALESCE(alt_mobile, ''), '[^0-9]', ''), 10) = ? ORDER BY id DESC LIMIT 1`, [last10, last10]))[0];
    } else if (rawNumber !== '' && digits.length < 6) {
      // WhatsApp's own incoming-call notification shows the contact's SAVED NAME: match the CRM name exactly (case-insensitive); two with the same name -> ambiguous.
      const found = await db.query<Raw>('SELECT id, full_name, mobile FROM customers WHERE LOWER(TRIM(full_name)) = LOWER(?) ORDER BY id DESC LIMIT 2', [rawNumber]);
      if (found.length > 1) return ok({ ...empty, ambiguous: true });
      customer = found[0];
    } else return ok(empty);
    if (!customer) return ok(empty);
    const orders = await db.query<Raw>(
      `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.order_date, o.due_date, o.grand_total, o.current_due, os.status_key, os.status_label, os.color AS status_color,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.customer_id = ?
       ORDER BY (os.status_key IN ('delivered','cancelled')) ASC, o.id DESC LIMIT 4`, [customer.id]);
    const due = (await db.query<Raw>("SELECT COALESCE(SUM(o.current_due), 0) AS d FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.customer_id = ? AND os.status_key <> 'cancelled' AND o.current_due > 0", [customer.id]))[0]!.d;
    return ok({ customer: { id: num(customer.id), full_name: customer.full_name, mobile: customer.mobile }, orders, total_due: toFloat(due), ambiguous: false });
  }));
  both('POST', 'caller_lookup', authed('billing.view', async () => { throw new ApiError('method_not_allowed', 'Use GET.', 405); }));

  // ---- fcm_register: the app hands us its Firebase token (first install + every rotation) ---------------------------
  both('POST', 'fcm_register', async (req) => {
    const ctx = await app.requireToken(req);
    const deviceToken = String(jsonBody(req).device_token ?? '').trim();
    if (deviceToken === '') throw new ApiError('invalid_request', 'device_token is required.', 422);
    // A token is unique to one device: re-registering it (a different staff member on the same shared device) moves it to the new user.
    await db.execute('INSERT INTO fcm_tokens (user_id, device_token) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), updated_at = CURRENT_TIMESTAMP', [ctx.id, deviceToken]);
    return ok({ registered: true });
  });
  both('GET', 'fcm_register', async (req) => { await app.requireToken(req); throw new ApiError('method_not_allowed', 'Use POST.', 405); });

  // ---- workshop invoice: PDF + WhatsApp (permission workshop.billing OR billing.view) -------------------------------------
  const wsBillingAuth = async (req: FastifyRequest) => {
    const ctx = await app.requireToken(req);
    if (!ctx.permissions.includes('workshop.billing') && !ctx.permissions.includes('billing.view')) throw new ApiError('forbidden', 'You do not have permission to perform this action.', 403);
    return ctx;
  };
  both('GET', 'workshop_billing_pdf', async (req, reply) => {
    const ctx = await wsBillingAuth(req);
    const billId = qInt((req.query as Raw).id);
    const scope = await wsBillingScope(db, ctx.id, ctx.role_name ?? '');
    const ws = (await db.query<Raw>('SELECT workshop_id FROM workshop_bills WHERE id = ?', [billId]))[0];
    if (billId <= 0 || !ws || scope.blocked || (scope.workshop_id !== null && Number(ws.workshop_id) !== scope.workshop_id)) throw new ApiError('not_found', 'Bill not found.', 404);
    const pdf = await workshopBillPdf.generate(billId);
    if (!pdf.success || !pdf.file_path) throw new ApiError('pdf_failed', pdf.error ?? 'Could not generate the PDF.', 500);
    const bytes = await readFile(pdf.file_path);
    await unlink(pdf.file_path).catch(() => {});
    return reply.header('Content-Disposition', `inline; filename="${pdf.filename}"`).type('application/pdf').send(bytes);
  });
  both('POST', 'workshop_billing_send_whatsapp', async (req) => {
    const ctx = await wsBillingAuth(req);
    const raw = jsonBody(req);
    const billId = toInt(raw.bill_id);
    const number = String(raw.number ?? '').trim();
    if (billId <= 0 || number === '') throw new ApiError('invalid_request', 'bill_id and number are required.', 422);
    const scope = await wsBillingScope(db, ctx.id, ctx.role_name ?? '');
    const ws = (await db.query<Raw>('SELECT workshop_id FROM workshop_bills WHERE id = ?', [billId]))[0];
    if (!ws || scope.blocked || (scope.workshop_id !== null && Number(ws.workshop_id) !== scope.workshop_id)) throw new ApiError('not_found', 'Bill not found.', 404);
    if (!scope.can_manage) throw new ApiError('forbidden', 'You do not have permission to send invoices.', 403);
    const res = await whatsapp.sendWorkshopInvoice(billId, number, ctx.id);
    if (res.success) return ok({ mode: res.mode });
    throw new ApiError('send_failed', res.error ?? 'Could not send on WhatsApp.', 422);
  });
  both('GET', 'workshop_billing_send_whatsapp', async (req) => { await wsBillingAuth(req); throw new ApiError('method_not_allowed', 'Use POST.', 405); });
}
