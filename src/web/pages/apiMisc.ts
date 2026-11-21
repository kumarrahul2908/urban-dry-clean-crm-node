import type { FastifyInstance } from 'fastify';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { numberFormat2, phpEmpty, toInt } from '../../lib/php.js';
import { formArray } from '../format.js';
import { WebText, webPage, type WebCtx } from '../context.js';
import { jsonEncode } from '../html.js';
import { sniffMime } from '../uploads.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const json = (d: unknown, status = 200) => new WebText(jsonEncode(d), status, 'application/json');
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const post = { methods: ['GET', 'POST'] as ('GET' | 'POST')[] };
const notPost = () => json({ success: false, error: 'Invalid request method.' }, 405);

export function registerApiMisc(app: FastifyInstance) {
  const { db, audit, whatsapp, orders, workshop } = app.services;

  // ---- api/voice_pos_parse.php: inert stub ------------------------------------------------------
  webPage(app, '/api/voice_pos_parse', { auth: 'public', ...post }, async () => json({ success: false, error: 'Voice POS has been removed from this environment.' }, 410));

  // ---- barcode_lookup / qr_lookup -----------------------------------------------------------------
  // These are two separate files in the real app; both now return the short order code (qr_lookup.php was brought in line on 2026-11-16).
  const lookup = async (ctx: WebCtx, ip: string, key: string, col: string, kind: 'barcode' | 'qr', token: string) => {
    const uid = ctx.data.user_id ?? null;
    const anchor = (await db.query<Row>(`SELECT order_item_id, laundry_garment_id FROM barcodes WHERE ${col} = ?`, [key]))[0];
    const miss = kind === 'barcode' ? 'No garment found for this barcode.' : 'No garment found for this QR code.';
    const fallbackId = kind === 'barcode' ? token : 'qr:' + token.slice(0, 8);
    const via = kind === 'barcode' ? null : col;
    const meta = (found: boolean, extra: Row) => (kind === 'barcode' ? { barcode: token, found, ...extra } : { via, found, ...extra });
    const orderNo = (r: Row) => r.short_order_code ?? r.order_number;
    if (anchor && anchor.laundry_garment_id) {
      const row = (await db.query<Row>(
        `SELECT b.id AS barcode_id, b.barcode_value, b.item_sequence, lg.id AS laundry_garment_id, g.garment_name, s.service_name, oi.item_status, oi.quantity AS total_garments,
         o.id AS order_id, o.order_number, o.short_order_code, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile AS customer_mobile
         FROM barcodes b JOIN laundry_garments lg ON lg.id = b.laundry_garment_id JOIN order_items oi ON oi.id = lg.order_item_id JOIN garments g ON g.id = lg.garment_id
         JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = b.order_id JOIN customers c ON c.id = o.customer_id WHERE b.${col} = ?`, [key]))[0];
      await audit.record({ action: 'lookup', module: 'garment_tags', recordId: String(row?.laundry_garment_id ?? fallbackId), newValue: meta(!!row, { mode: 'weight' }), userId: uid, ip });
      if (!row) return json({ success: false, message: miss });
      return json({ success: true, laundry_garment_id: row.laundry_garment_id, order_id: row.order_id, order_number: orderNo(row), sequence: row.item_sequence, total_garments: row.total_garments,
        customer_name: row.customer_name, customer_mobile: row.customer_mobile, garment_name: row.garment_name, service_name: row.service_name, status: row.item_status, due_date: ctx.date(row.due_date) });
    }
    const row = (await db.query<Row>(
      `SELECT b.id AS barcode_id, b.barcode_value, b.item_sequence, oi.id AS order_item_id, oi.remarks, g.garment_name, s.service_name, oi.item_status, o.id AS order_id, o.order_number, o.short_order_code, o.due_date, o.due_time,
       c.full_name AS customer_name, c.mobile AS customer_mobile FROM barcodes b JOIN order_items oi ON oi.id = b.order_item_id JOIN garments g ON g.id = oi.garment_id
       JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = b.order_id JOIN customers c ON c.id = o.customer_id WHERE b.${col} = ?`, [key]))[0];
    await audit.record({ action: 'lookup', module: 'garment_tags', recordId: String(row?.order_item_id ?? fallbackId), newValue: meta(!!row, {}), userId: uid, ip });
    if (!row) return json({ success: false, message: miss });
    return json({ success: true, order_item_id: row.order_item_id, order_id: row.order_id, order_number: orderNo(row), sequence: row.item_sequence, customer_name: row.customer_name,
      customer_mobile: row.customer_mobile, garment_name: row.garment_name, service_name: row.service_name, status: row.item_status, due_date: ctx.date(row.due_date), remarks: row.remarks });
  };
  webPage(app, '/api/barcode_lookup', { auth: 'garment_tags.view', methods: ['GET'] }, async (ctx, req) => {
    const barcode = clean((req.query as Record<string, unknown>).barcode);
    if (barcode === '') return json({ success: false, message: 'Enter a barcode.' });
    return lookup(ctx, req.ip, barcode, 'barcode_value', 'barcode', barcode);
  });
  webPage(app, '/api/qr_lookup', { auth: 'garment_tags.view', methods: ['GET'] }, async (ctx, req) => {
    const token = clean((req.query as Record<string, unknown>).token);
    const col = /^[a-f0-9]{32}$/.test(token) ? 'qr_token' : /^[A-Za-z]+[0-9]+-[0-9]+$/.test(token) ? 'short_qr_payload' : null;
    if (col === null) return json({ success: false, message: 'Invalid or malformed token.' });
    return lookup(ctx, req.ip, token, col, 'qr', token);
  });

  // ---- order photos --------------------------------------------------------------------------------
  const photoDir = (ctx: WebCtx) => join(ctx.svc.storage.root, 'order_photos');
  webPage(app, '/api/order_photo_list', { auth: 'orders.edit', methods: ['GET'] }, async (ctx, req) => {
    const orderId = toInt((req.query as Record<string, unknown>).order_id);
    if (!orderId) return json({ success: false, error: 'A valid order_id is required.' }, 422);
    const rows = await db.query<Row>('SELECT id, order_item_id, file_path, caption, created_at FROM order_photos WHERE order_id = ? ORDER BY created_at DESC', [orderId]);
    return json({ success: true, photos: rows.map((r) => ({ id: Number(r.id), order_item_id: r.order_item_id !== null ? Number(r.order_item_id) : null, url: ctx.baseUrl('uploads/order_photos/' + r.file_path), caption: r.caption, created_at: r.created_at })) });
  });
  // deleting photos is Admin-only now (Admin > Order Photos); order staff can only view them
  webPage(app, '/api/order_photo_delete', { auth: 'admin.settings', ...post }, async (ctx, req) => {
    if (req.method !== 'POST') return notPost();
    if (!ctx.csrfValid()) return csrfFail();
    const photoId = toInt(body(ctx).photo_id);
    if (!photoId) return json({ success: false, error: 'A valid photo_id is required.' }, 422);
    const row = (await db.query<Row>('SELECT order_id, file_path FROM order_photos WHERE id = ?', [photoId]))[0];
    if (!row) return json({ success: false, error: 'Photo not found.' }, 404);
    await db.execute('DELETE FROM order_photos WHERE id = ?', [photoId]);
    await unlink(join(photoDir(ctx), basename(String(row.file_path)))).catch(() => {});
    await audit.record({ action: 'delete', module: 'order_photos', recordId: String(photoId), oldValue: { order_id: row.order_id }, userId: ctx.data.user_id ?? null, ip: req.ip });
    return json({ success: true });
  });
  webPage(app, '/api/order_photo_upload', { auth: 'orders.edit', ...post }, async (ctx, req) => {
    if (req.method !== 'POST') return notPost();
    if (!ctx.csrfValid()) return csrfFail();
    const p = body(ctx);
    const orderId = toInt(p.order_id);
    const orderItemId = toInt(p.order_item_id) || null;
    const caption = clean(p.caption);
    if (Array.from(caption).length > 255) return json({ success: false, error: 'Caption is too long.' }, 422);
    if (!orderId) return json({ success: false, error: 'A valid order_id is required.' }, 422);
    if (!(await db.query('SELECT id FROM orders WHERE id = ?', [orderId])).length) return json({ success: false, error: 'Order not found.' }, 404);
    if (orderItemId && !(await db.query('SELECT id FROM order_items WHERE id = ? AND order_id = ?', [orderItemId, orderId])).length) return json({ success: false, error: 'That garment does not belong to this order.' }, 422);
    const file = ctx.files.image;
    if (!file) return json({ success: false, error: 'No photo was received.' }, 422);
    const allowed: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
    const ext = allowed[sniffMime(file.buffer)];
    if (!ext) return json({ success: false, error: 'Only JPEG, PNG, or WEBP photos are allowed.' }, 422);
    await mkdir(photoDir(ctx), { recursive: true });
    const filename = randomBytes(16).toString('hex') + '.' + ext;
    await writeFile(join(photoDir(ctx), filename), file.buffer, { mode: 0o644 });
    const uid = ctx.data.user_id ?? null;
    const r = await db.execute('INSERT INTO order_photos (order_id, order_item_id, file_path, caption, uploaded_by) VALUES (?, ?, ?, ?, ?)', [orderId, orderItemId, filename, caption !== '' ? caption : null, uid]);
    await audit.record({ action: 'create', module: 'order_photos', recordId: String(r.insertId), newValue: { order_id: orderId, order_item_id: orderItemId }, userId: uid, ip: req.ip });
    return json({ success: true, photo: { id: Number(r.insertId), order_id: orderId, order_item_id: orderItemId, url: ctx.baseUrl('uploads/order_photos/' + filename), caption: caption !== '' ? caption : null } });
  });

  // ---- WhatsApp senders ---------------------------------------------------------------------------
  const wa = (name: string, perm: string, handler: (ctx: WebCtx, p: Record<string, unknown>, ip: string) => Promise<WebText>) =>
    webPage(app, '/api/' + name, { auth: perm, ...post }, async (ctx, req) => {
      if (req.method !== 'POST') return notPost();
      if (!ctx.csrfValid()) return csrfFail();
      return handler(ctx, body(ctx), req.ip);
    });
  const uid = (ctx: WebCtx) => ctx.data.user_id ?? null;
  const mobileOf = async (customerId: number) => (await db.query<Row>('SELECT mobile FROM customers WHERE id = ?', [customerId]))[0]?.mobile ?? null;
  const errOf = (r: { success: boolean; error?: string | null }) => ('error' in r ? r.error ?? null : null);

  wa('whatsapp_send_due_reminder', 'accounts.view', async (ctx, p) => {
    const customerId = toInt(p.customer_id);
    if (!customerId) return json({ success: false, error: 'Missing customer_id.' }, 422);
    const customer = (await db.query<Row>('SELECT id, full_name, mobile FROM customers WHERE id = ?', [customerId]))[0];
    if (!customer) return json({ success: false, error: 'Customer not found.' }, 404);
    if (phpEmpty(customer.mobile)) return json({ success: false, error: 'This customer has no mobile number on file.' }, 422);
    const due = (await db.query<Row>("SELECT ar.due_amount, COALESCE(o.short_order_code, o.order_number) AS order_number FROM accounts_receivable ar JOIN orders o ON o.id = ar.order_id WHERE ar.customer_id = ? AND ar.status = 'Open' AND ar.due_amount > 0 ORDER BY ar.due_amount DESC LIMIT 1", [customerId]))[0];
    if (!due) return json({ success: false, error: 'This customer has no open due to remind about.' }, 422);
    const r = await whatsapp.enqueue(customerId, null, customer.mobile, 'payment_reminder', { due_amount: numberFormat2(parseFloat(due.due_amount)), order_number: due.order_number }, `due_reminder_manual:${customerId}:${ctx.today}`);
    return json({ success: r.success, error: r.error, duplicate: r.duplicate });
  });
  wa('whatsapp_send_invoice', 'billing.view', async (ctx, p) => {
    const orderId = toInt(p.order_id);
    if (!orderId) return json({ success: false, error: 'Missing order_id.' }, 422);
    const order = (await db.query<Row>('SELECT o.customer_id, o.invoice_number, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]))[0];
    if (!order) return json({ success: false, error: 'Order not found.' }, 404);
    if (phpEmpty(order.mobile)) return json({ success: false, error: 'This customer has no mobile number on file.' }, 422);
    const r = await whatsapp.sendInvoice(orderId, uid(ctx));
    return json({ success: r.success, error: r.error ?? null, mode: r.mode });
  });
  // ---- Mark as Delivered / standalone payment -----------------------------------------------------
  // "Mark as Delivered" button on Order Detail -- the modal collects a payment method (Cash/UPI/etc)
  // and amount, or Due (nothing collected, order stays/becomes due). markDelivered() does both the
  // status change and the optional payment in one call; see its own docblock for why a failed
  // payment doesn't roll back the delivery status.
  wa('orders_mark_delivered', 'billing.view', async (ctx, p) => {
    const orderId = toInt(p.order_id);
    if (!orderId) return json({ success: false, error: 'Missing order_id.' }, 422);
    const paymentTypeId = toInt(p.payment_type_id);
    const amount = Math.round((parseFloat(String(p.amount ?? 0)) || 0) * 100) / 100;
    // payment_type_id = 0 (or amount <= 0) means "Due" was chosen -- nothing to record, the order's
    // existing due balance is simply left as-is, same as recordPayment() already treats an empty array.
    const paymentLines = paymentTypeId > 0 && amount > 0 ? [{ payment_type_id: paymentTypeId, amount }] : [];
    const result = await orders.markDelivered(orderId, { userId: ctx.data.user_id!, ip: ctx.req.ip }, paymentLines);
    if (!result.success) return json({ success: false, error: (result.errors ?? []).join(' ') }, 422);
    return json({ success: true, payment_errors: result.payment_errors ?? [] });
  });
  // Standalone payment action, independent of the delivery-status change above -- "payment can be
  // marked even after delivery too". Used from Order Detail's own "Add Payment" button (available
  // whether delivered or not) and from the Due List page. Thin wrapper around recordPayment() -- same
  // function the order-creation flow itself already uses, nothing new there.
  wa('orders_record_payment', 'billing.view', async (ctx, p) => {
    const orderId = toInt(p.order_id);
    const paymentTypeId = toInt(p.payment_type_id);
    const amount = Math.round((parseFloat(String(p.amount ?? 0)) || 0) * 100) / 100;
    if (!orderId) return json({ success: false, error: 'Missing order_id.' }, 422);
    if (!paymentTypeId || amount <= 0) return json({ success: false, error: 'Choose a payment method and enter an amount greater than zero.' }, 422);
    const order = (await db.query<Row>('SELECT customer_id FROM orders WHERE id = ?', [orderId]))[0];
    if (!order) return json({ success: false, error: 'Order not found.' }, 404);
    const result = await orders.recordPayment(orderId, Number(order.customer_id), [{ payment_type_id: paymentTypeId, amount }], 0.0, { userId: ctx.data.user_id!, ip: ctx.req.ip });
    if (!result.success) return json({ success: false, error: (result.errors ?? []).join(' ') }, 422);
    return json({ success: true });
  });
  // ---- order-scoped Send to / Receive from Workshop (Order Detail buttons) -------------------------
  // Same WorkshopService calls modules/workshop/send.php and receive.php make, pre-filtered to one order's own items.
  wa('orders_send_to_workshop', 'workshop.manage', async (ctx, p) => {
    const orderId = toInt(p.order_id), workshopId = toInt(p.workshop_id);
    const itemIds = formArray(p, 'item_ids').map((x) => toInt(x));
    if (!orderId || !workshopId || itemIds.length === 0) return json({ success: false, error: 'Missing order, workshop, or garment selection.' }, 422);
    // Defense in depth: only items that actually belong to this order and are still Pending can be sent -- never trust the client-submitted id list.
    const validIds = (await db.query<Row>("SELECT id FROM order_items WHERE id IN (?) AND order_id = ? AND item_status = 'Pending'", [itemIds, orderId])).map((r) => Number(r.id));
    if (validIds.length === 0) return json({ success: false, error: 'None of the selected garments are still pending for this order.' }, 422);
    const result = await workshop.createChallan(workshopId, validIds, '', { userId: ctx.data.user_id!, ip: ctx.req.ip }) as Row;
    if (!result.success) return json({ success: false, error: (result.errors ?? ['Could not create the challan.']).join(' ') }, 422);
    return json({ success: true, challan_id: result.challan_id });
  });
  wa('orders_receive_from_workshop', 'workshop.manage', async (ctx, p) => {
    const orderId = toInt(p.order_id);
    const wiIds = formArray(p, 'workshop_item_ids').map((x) => toInt(x));
    if (!orderId || wiIds.length === 0) return json({ success: false, error: 'Missing order or garment selection.' }, 422);
    // Defense in depth: every submitted workshop_item_id must genuinely belong to THIS order (via a piece order_item or a Laundry batch's order_item).
    const validIds = (await db.query<Row>(
      `SELECT wi.id FROM workshop_items wi
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id
       LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
       WHERE wi.id IN (?) AND (oi1.order_id = ? OR oi2.order_id = ?)`, [wiIds, orderId, orderId])).map((r) => Number(r.id));
    if (validIds.length === 0) return json({ success: false, error: 'None of the selected garments belong to this order.' }, 422);
    const actor = { userId: ctx.data.user_id!, ip: ctx.req.ip };
    let receivedCount = 0;
    let errors: string[] = [];
    for (const wiId of validIds) {
      const current = await workshop.getCurrentStatus(wiId);
      let r2: { success: boolean; errors?: string[] };
      if (current === 'Completed' || current === 'Returned') {
        if (current === 'Completed') {
          const r1 = await workshop.returnToStore(wiId, actor, '');
          if (!r1.success) { errors = errors.concat(r1.errors ?? []); continue; }
        }
        r2 = await workshop.storeReceive(wiId, actor, '');
      } else {
        r2 = await workshop.forceStoreReceive(wiId, actor, '');
      }
      if (r2.success) receivedCount++; else errors = errors.concat(r2.errors ?? []);
    }
    const uniq = [...new Set(errors)];
    if (receivedCount > 0 && errors.length === 0) return json({ success: true, received_count: receivedCount });
    if (receivedCount > 0) return json({ success: true, received_count: receivedCount, error: `${errors.length} garment(s) could not be received: ${uniq.join(' ')}` });
    return json({ success: false, error: uniq.join(' ') || 'Could not receive the selected garments.' }, 422);
  });
  wa('whatsapp_send_media', 'whatsapp.settings', async (ctx, p) => {
    const customerId = toInt(p.customer_id);
    const caption = clean(p.caption);
    const file = ctx.files.media;
    if (!customerId || !file) return json({ success: false, error: 'Select a customer and a valid file.' }, 422);
    const mobile = await mobileOf(customerId);
    if (phpEmpty(mobile)) return json({ success: false, error: 'Customer not found or has no mobile number.' }, 404);
    if (file.buffer.length > 10 * 1024 * 1024) return json({ success: false, error: 'File is too large (max 10 MB).' }, 422);
    const realMime = sniffMime(file.buffer);
    const allowed: Record<string, [string, string]> = { 'image/jpeg': ['image', 'jpg'], 'image/png': ['image', 'png'], 'application/pdf': ['document', 'pdf'] };
    if (!allowed[realMime]) return json({ success: false, error: `File type not allowed (detected: ${realMime}). Only JPEG/PNG images and PDF documents are supported.` }, 422);
    const [mediaType, ext] = allowed[realMime]!;
    const dir = join(ctx.svc.storage.root, 'whatsapp_media_tmp');
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const dest = join(dir, randomBytes(16).toString('hex') + '.' + ext);
    await writeFile(dest, file.buffer);
    const r = await whatsapp.sendMediaMessage(customerId, mobile, dest, realMime, mediaType, caption, uid(ctx));
    await unlink(dest).catch(() => {});
    return json({ success: r.success, error: errOf(r) });
  });
  wa('whatsapp_send_reply', 'whatsapp.settings', async (ctx, p) => {
    const customerId = toInt(p.customer_id);
    const text = clean(p.text);
    if (!customerId || text === '') return json({ success: false, error: 'Missing customer or message text.' }, 422);
    const customer = (await db.query<Row>('SELECT mobile, full_name FROM customers WHERE id = ?', [customerId]))[0];
    if (!customer || phpEmpty(customer.mobile)) return json({ success: false, error: 'Customer not found or has no mobile number.' }, 404);
    const r = await whatsapp.sendDirectReply(customerId, customer.mobile, text, uid(ctx));
    return json({ success: r.success, error: errOf(r) });
  });
  wa('whatsapp_send_template', 'whatsapp.settings', async (ctx, p) => {
    const customerId = toInt(p.customer_id);
    const templateKey = clean(p.template_key);
    if (!customerId || templateKey === '') return json({ success: false, error: 'Select a customer and a template.' }, 422);
    const mobile = await mobileOf(customerId);
    if (phpEmpty(mobile)) return json({ success: false, error: 'Customer not found or has no mobile number.' }, 404);
    const tpl = (await db.query<Row>("SELECT template_param_order FROM notification_templates WHERE template_key = ? AND channel = 'WhatsApp' AND is_active = 1", [templateKey]))[0];
    if (!tpl) return json({ success: false, error: 'Unknown or inactive template.' }, 422);
    let d: unknown = null;
    try { d = JSON.parse(String(tpl.template_param_order ?? '')); } catch { /* → [] */ }
    const order: unknown[] = phpEmpty(d) ? [] : Array.isArray(d) ? d : typeof d === 'object' && d ? Object.values(d) : [];
    const variables: Record<string, string> = {};
    for (const name of order) variables[String(name)] = clean(p[`variables[${String(name)}]`]);
    const r = await whatsapp.enqueue(customerId, null, mobile, templateKey, variables, `manual_send:${customerId}:${templateKey}:${Math.floor(Date.now() / 1000)}`);
    return json({ success: r.success, error: r.error ?? null });
  });
  wa('whatsapp_send_test_message', 'whatsapp.settings', async (ctx, p) => {
    const accountId = toInt(p.account_id);
    const to = clean(p.to_number);
    const text = 'text' in p ? clean(p.text) : 'This is a test message from Urban Dry Clean.';
    if (!accountId) return json({ success: false, error: 'No account specified.' }, 400);
    if (to === '' || !/^\+?[0-9]{8,15}$/.test(to)) return json({ success: false, error: 'Enter a valid destination phone number (digits only, with optional leading +).' }, 422);
    const r = await whatsapp.sendTestMessage(accountId, to, text, uid(ctx));
    return json({ success: r.success, error: errOf(r) });
  });
  wa('whatsapp_test_connection', 'whatsapp.settings', async (_ctx, p) => {
    const accountId = toInt(p.account_id);
    if (!accountId) return json({ success: false, error: 'No account specified.' }, 400);
    const r = await whatsapp.testAccountConnection(accountId);
    return json({ success: r.success, error: r.error ?? null });
  });
}
