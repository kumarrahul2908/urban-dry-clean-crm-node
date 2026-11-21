import { readFile, unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { addDays } from '../../lib/dates.js';
import { phpEmpty } from '../../lib/php.js';
import { CustomerSegments } from '../../services/customerSegments.js';
import { wsBillingScope } from '../../services/workshopScope.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { int, urlencode, wallDate, whatsappLinkNumber } from '../format.js';
import { e, html, raw } from '../html.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
/** mb_strimwidth($s, 0, $w, $trim) for Latin/emoji chat text (no East-Asian double-width handling). */
const strimwidth = (s: string, width: number, trim: string) => { const a = Array.from(s); return a.length <= width ? s : a.slice(0, width - Array.from(trim).length).join('') + trim; };
const nl2br = (escaped: string) => escaped.replace(/\r\n|\n\r|\n|\r/g, (m) => '<br />' + m);

/** Two-way WhatsApp message log (web), bulk messaging, Firebase settings and the workshop-invoice PDF download (Rahul, 21 Nov 2026). */
export function registerWhatsAppChatPages(app: FastifyInstance) {
  const { db, whatsapp, firebase, crypto, workshopBillPdf } = app.services;

  // ---- messages_list.php ----------------------------------------------------------------------------------
  webPage(app, '/modules/whatsapp/messages_list', { auth: 'billing.view' }, async (ctx, req) => {
    const search = clean((req.query as Record<string, unknown>).q);
    let where = '1=1';
    const params: unknown[] = [];
    if (search !== '') { where += ' AND (wm.phone_number LIKE ? OR c.full_name LIKE ?)'; const like = `%${search}%`; params.push(like, like); }
    const conversations = await db.query<Row>(
      `SELECT wm.phone_number, wm.direction, wm.message_type, wm.message_text, wm.status, wm.created_at, c.full_name, c.id AS customer_id
       FROM whatsapp_messages wm
       JOIN (SELECT phone_number, MAX(created_at) AS max_created FROM whatsapp_messages GROUP BY phone_number) latest ON latest.phone_number = wm.phone_number AND latest.max_created = wm.created_at
       LEFT JOIN customers c ON c.id = wm.customer_id
       WHERE ${where} GROUP BY wm.phone_number ORDER BY wm.created_at DESC LIMIT 100`, params);
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'WhatsApp Messages' }, html`
<div class="container-fluid py-3">
  <h4 class="fw-bold mb-3"><i class="fa-brands fa-whatsapp me-2" style="color:#25D366;"></i>WhatsApp Messages</h4>

  <form method="GET" class="mb-3">
    <div class="input-group" style="max-width:500px;">
      <input type="text" name="q" class="form-control" placeholder="Phone number or customer name" value="${search}">
      <button class="btn btn-outline-secondary" type="submit"><i class="fa-solid fa-magnifying-glass"></i></button>
    </div>
  </form>

  ${conversations.length === 0 ? html`
    <div class="card"><div class="card-body text-center text-muted py-5">
      <i class="fa-brands fa-whatsapp fa-2x mb-2"></i>
      <p class="mb-0">No WhatsApp messages logged yet.</p>
    </div></div>` : html`
    <div class="card">
      <div class="list-group list-group-flush">
        ${conversations.map((c) => html`
          <a href="${u('modules/whatsapp/messages_thread.php?phone=' + urlencode(str(c.phone_number)))}"
             class="list-group-item list-group-item-action d-flex justify-content-between align-items-start">
            <div>
              <div class="fw-bold">${c.full_name ?? c.phone_number}</div>
              <div class="text-muted small">${c.phone_number}</div>
              <div class="small mt-1">
                ${c.direction === 'outbound' ? html`
                  <i class="fa-solid fa-arrow-right text-primary"></i>` : html`
                  <i class="fa-solid fa-arrow-left text-success"></i>`}
                ${strimwidth(c.message_text !== null && c.message_text !== undefined ? str(c.message_text) : '[' + str(c.message_type) + ']', 80, '...')}
              </div>
            </div>
            <div class="text-end">
              <div class="text-muted small">${wallDate('d M, h:i A', c.created_at)}</div>
              ${c.direction === 'outbound' ? html`
                <span class="badge ${c.status === 'sent' ? 'bg-secondary' : (c.status === 'delivered' ? 'bg-info' : (c.status === 'read' ? 'bg-success' : 'bg-danger'))} mt-1">${str(c.status).charAt(0).toUpperCase() + str(c.status).slice(1)}</span>` : ''}
            </div>
          </a>`)}
      </div>
    </div>`}
</div>
`);
  });

  // ---- media.php: one message's attachment ------------------------------------------------------------------
  webPage(app, '/modules/whatsapp/media', { auth: 'billing.view' }, async (_ctx, req) => {
    const m = await whatsapp.messageMedia(int((req.query as Record<string, unknown>).id));
    if (!m) return new WebText('Media not available (Meta keeps customer media for about 30 days).', 404, 'text/plain');
    const headers: Record<string, string> = {};
    if (m.disposition) headers['Content-Disposition'] = m.disposition;
    if (m.cacheControl) headers['Cache-Control'] = m.cacheControl;
    if (m.nosniff) headers['X-Content-Type-Options'] = 'nosniff';
    return new WebText(m.body, 200, m.contentType, headers);
  });

  // ---- messages_thread.php ----------------------------------------------------------------------------------------
  webPage(app, '/modules/whatsapp/messages_thread', { auth: 'billing.view', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const phone = clean((req.query as Record<string, unknown>).phone);
    if (phone === '') return new WebRedirect('modules/whatsapp/messages_list.php');
    const b = body(ctx);
    const back = 'modules/whatsapp/messages_thread.php?phone=' + urlencode(phone);
    const customerIdOf = async () => Number((await db.query<Row>('SELECT id FROM customers WHERE mobile = ? LIMIT 1', [phone]))[0]?.id ?? 0);

    if (req.method === 'POST' && b.send_attachment !== undefined) {
      if (!ctx.csrfValid()) return csrfFail();
      const f = ctx.files.attachment;
      const result = await whatsapp.sendUploadedAttachment(await customerIdOf(), phone, f ? { buffer: f.buffer } : null, clean(b.caption), ctx.data.user_id ?? null);
      if (!result.success) ctx.flashSet('danger', result.error ?? 'Could not send the attachment.');
      return new WebRedirect(back);
    }
    if (req.method === 'POST' && b.reply_text !== undefined) {
      if (!ctx.csrfValid()) return csrfFail();
      const text = str(b.reply_text).trim();
      if (text !== '') {
        const result = await whatsapp.sendDirectReply(await customerIdOf(), phone, text, ctx.data.user_id ?? null);
        if (!result.success) ctx.flashSet('danger', result.error ?? 'Could not send the message.');
      }
      return new WebRedirect(back);
    }

    const messages = await db.query<Row>('SELECT wm.*, c.full_name FROM whatsapp_messages wm LEFT JOIN customers c ON c.id = wm.customer_id WHERE wm.phone_number = ? ORDER BY wm.created_at ASC LIMIT 500', [phone]);
    const customerName = messages.length ? (messages[messages.length - 1]!.full_name ?? null) : null;
    // Recent orders (service type, status) for the matched customer, if any.
    let customerId: number | null = null;
    for (const m of messages) if (!phpEmpty(m.customer_id)) { customerId = Number(m.customer_id); break; }
    let recentOrders: Row[] = [];
    if (customerId) {
      recentOrders = await db.query<Row>(
        `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.order_mode, o.order_date, o.grand_total, os.status_label, os.color AS status_color
         FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT 5`, [customerId]);
    }
    const u = (p: string) => ctx.baseUrl(p);
    const waDigits = whatsappLinkNumber(phone);
    const byProviderId = new Map<string, Row>();
    for (const pm of messages) if (!phpEmpty(pm.provider_message_id)) byProviderId.set(str(pm.provider_message_id), pm);
    const todayStr = ctx.today, yestStr = addDays(ctx.today, -1);
    let lastDay = '';
    const bubbles = messages.map((m) => {
      const out = m.direction === 'outbound';
      const type = str(m.message_type);
      const mediaSrc = u('modules/whatsapp/media.php?id=' + int(m.id));
      const day = str(m.created_at).slice(0, 10);
      const timeStr = e(wallDate('h:i A', m.created_at));
      const rawText = str(m.message_text);
      let caption = rawText.replace(/^\[(image|document|video|audio|sticker)\]\s*/, '').trim();
      const status = str(m.status).toLowerCase();
      const dayHtml = day !== lastDay ? (lastDay = day, html`
          <div class="wa-day"><span>${day === todayStr ? 'Today' : (day === yestStr ? 'Yesterday' : wallDate('d M Y', m.created_at))}</span></div>`) : '';
      if (type === 'call') return html`${dayHtml}
          <div class="wa-sys"><span><i class="fa-solid fa-phone me-1"></i>${rawText} &middot; ${raw(timeStr)}</span></div>`;
      if (type === 'reaction') {
        const target = byProviderId.get(str(m.media_url)) ?? null;
        let snippet = '';
        if (target) snippet = target.message_text !== null && target.message_text !== undefined && target.message_text !== '' ? strimwidth(str(target.message_text), 60, '…') : '[' + str(target.message_type) + ']';
        return html`${dayHtml}
          <div class="wa-sys"><span style="background:#fff;"><span style="font-size:17px;">${rawText}</span> reacted${snippet !== '' ? ' to “' + snippet + '”' : ''} &middot; ${raw(timeStr)}</span></div>`;
      }
      const mediaUrl = str(m.media_url);
      const hasLocal = out && mediaUrl.startsWith('local:');
      const isImg = ['image', 'sticker'].includes(type) && (!out || hasLocal);
      const isDoc = type === 'document' && (out || mediaUrl !== '' || !out);
      const media = isImg ? html`
              <a href="${mediaSrc}" target="_blank"><img class="wa-img" src="${mediaSrc}" alt="[${type}]" loading="lazy"></a>` : (type === 'video' && !out) ? html`
              <video controls preload="none" class="wa-img"><source src="${mediaSrc}"></video>` : (type === 'audio' && !out) ? html`
              <audio controls preload="none" src="${mediaSrc}" style="max-width:240px;"></audio>` : isDoc ? html`
              <a class="wa-doc" href="${mediaSrc}" target="_blank"><i class="fa-solid fa-file-pdf"></i><span>${caption !== '' ? strimwidth(caption, 40, '…') : 'Document'}<br><small class="text-muted">PDF</small></span></a>` : ['image', 'sticker', 'video', 'audio'].includes(type) ? html`
              <div class="text-muted small"><i class="fa-solid fa-image me-1"></i>[${type}] ${out ? '(purani bheji hui file ki copy available nahi)' : ''}</div>` : '';
      if (!isImg && !(type === 'video' && !out) && !(type === 'audio' && !out) && isDoc) caption = ''; // the document card already shows it
      const textPart = caption !== '' ? html`<span>${raw(nl2br(e(caption)))}</span>` : (rawText === '' && !isImg && !isDoc && !['image', 'sticker', 'video', 'audio'].includes(type) ? html`<em>[${type}]</em>` : '');
      const tick = out ? (status === 'failed' ? html`<span class="wa-tick fail" title="Failed">&#9888;</span>` : status === 'read' ? html`<span class="wa-tick read">&#10003;&#10003;</span>` : status === 'delivered' ? html`<span class="wa-tick">&#10003;&#10003;</span>` : html`<span class="wa-tick">&#10003;</span>`) : '';
      return html`${dayHtml}
        <div class="wa-row ${out ? 'out' : 'in'}">
          <div class="wa-bub">
            ${media}
            ${textPart}
            <span class="wa-meta">${raw(timeStr)}${tick}</span>
            <div style="clear:both"></div>
          </div>
        </div>`;
    });
    return layout(ctx, { title: 'WhatsApp — ' + (!phpEmpty(customerName) ? str(customerName) : phone) }, html`
<div class="container-fluid py-3">
  <div class="d-flex align-items-center mb-3">
    <a href="${u('modules/whatsapp/messages_list.php')}" class="btn btn-outline-secondary btn-sm me-3"><i class="fa-solid fa-arrow-left"></i></a>
    <div>
      <h5 class="fw-bold mb-0">${!phpEmpty(customerName) ? str(customerName) : phone}</h5>
      <div class="text-muted small">${phone}</div>
    </div>
    <div class="ms-auto d-flex gap-2">
      <a href="tel:+${waDigits}" class="btn btn-outline-primary btn-sm" title="Normal phone call"><i class="fa-solid fa-phone"></i> Call</a>
      <a href="https://wa.me/${waDigits}" target="_blank" rel="noopener" class="btn btn-outline-success btn-sm" title="Opens the WhatsApp chat - tap the call icon there"><i class="fa-brands fa-whatsapp"></i> WhatsApp call</a>
    </div>
  </div>

  ${customerId && recentOrders.length ? html`
    <div class="card mb-3">
      <div class="card-body py-2">
        <div class="small text-muted mb-1">Recent orders</div>
        <div class="d-flex flex-wrap gap-2">
          ${recentOrders.map((o) => html`
            <a href="${u('modules/orders/view.php?id=' + o.id)}" class="text-decoration-none">
              <span class="badge bg-light text-dark border">
                ${o.order_number} · ${o.order_mode === 'weight' ? 'Laundry' : 'Dry Cleaning'} ·
                <span style="color:${o.status_color};">${o.status_label}</span>
              </span>
            </a>`)}
        </div>
      </div>
    </div>` : !customerId ? html`
    <div class="alert alert-light border small py-2">Not a registered customer.</div>` : ''}

  <style>
    .wa-wall { background:#EFEAE2; background-image:radial-gradient(#e3dccf 1px, transparent 1px); background-size:18px 18px; border-radius:12px; max-height:62vh; overflow-y:auto; padding:12px 10px; margin-bottom:12px; }
    .wa-row { display:flex; margin-bottom:3px; }
    .wa-row.out { justify-content:flex-end; } .wa-row.in { justify-content:flex-start; }
    .wa-bub { max-width:min(78%,420px); padding:5px 7px 4px; border-radius:8px; box-shadow:0 1px .5px rgba(11,20,26,.13); font-size:14.2px; line-height:1.35; position:relative; word-wrap:break-word; }
    .wa-row.out .wa-bub { background:#D9FDD3; border-top-right-radius:2px; }
    .wa-row.in .wa-bub { background:#fff; border-top-left-radius:2px; }
    .wa-meta { float:right; margin:6px 0 -3px 10px; font-size:11px; color:#667781; white-space:nowrap; }
    .wa-tick { color:#8696a0; letter-spacing:-3px; margin-left:3px; } .wa-tick.read { color:#53bdeb; } .wa-tick.fail { color:#dc3545; letter-spacing:0; }
    .wa-day { text-align:center; margin:10px 0 8px; } .wa-day span { background:#fff; color:#54656f; font-size:12px; padding:3px 10px; border-radius:8px; box-shadow:0 1px .5px rgba(11,20,26,.13); }
    .wa-img { display:block; max-width:300px; max-height:340px; width:100%; object-fit:cover; border-radius:6px; margin-bottom:3px; }
    .wa-doc { display:flex; align-items:center; gap:10px; background:rgba(11,20,26,.06); border-radius:6px; padding:9px 10px; margin-bottom:3px; color:#111b21; text-decoration:none; }
    .wa-doc i { color:#e2533f; font-size:26px; }
    .wa-sys { text-align:center; margin:6px 0; } .wa-sys span { background:#FFF5C4; color:#54656f; font-size:12px; padding:3px 10px; border-radius:8px; }
  </style>
  <div class="wa-wall" id="waWall">
      ${messages.length === 0 ? html`
        <p class="text-muted text-center py-4">No messages yet.</p>` : ''}
      ${bubbles}
  </div>
  <script>var w=document.getElementById('waWall'); if (w) w.scrollTop = w.scrollHeight;</script>

  <form method="POST" enctype="multipart/form-data" class="d-flex gap-2" id="attachForm">
    ${ctx.csrfField()}
    <input type="hidden" name="send_attachment" value="1">
    <input type="file" name="attachment" id="attachInput" accept="image/jpeg,image/png,application/pdf" class="d-none" required>
    <input type="hidden" name="caption" id="attachCaption" value="">
  </form>
  <form method="POST" class="d-flex gap-2">
    ${ctx.csrfField()}
    <button type="button" class="btn btn-outline-secondary" title="Photo / PDF bhejein (max 10 MB)" onclick="document.getElementById('attachInput').click()"><i class="fa-solid fa-paperclip"></i></button>
    <input type="text" name="reply_text" id="replyText" class="form-control" placeholder="Type a reply..." required>
    <button type="submit" class="btn btn-success"><i class="fa-solid fa-paper-plane"></i></button>
  </form>
  <script>
  document.getElementById('attachInput').addEventListener('change', function () {
    if (!this.files.length) return;
    var f = this.files[0];
    if (f.size > 10 * 1024 * 1024) { alert('File 10 MB se badi hai.'); this.value = ''; return; }
    if (!confirm('Ye file bhejni hai? ' + f.name)) { this.value = ''; return; }
    document.getElementById('attachCaption').value = document.getElementById('replyText').value || '';
    document.getElementById('attachForm').submit();
  });
  </script>
  <p class="text-muted small mt-2">WhatsApp only allows free-form replies within 24 hours of the customer's last message — outside that window, this will fail (Meta's own policy, not a bug here).</p>
</div>
`);
  });

  // ---- bulk.php ----------------------------------------------------------------------------------------------------------
  webPage(app, '/modules/whatsapp/bulk', { auth: 'whatsapp.settings', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const errors: string[] = [];
    let success: string | null = null;
    const userId = ctx.data.user_id ?? 0;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const b = body(ctx);
      const action = clean(b.action);
      if (action === 'create_template') {
        const r = await whatsapp.createBulkTemplate(str(b.label), str(b.category ?? 'MARKETING'), str(b.body));
        if (r.success) success = 'Template Meta ko bhej diya gaya (status: ' + r.status + '). Approval aam taur par kuch minute se kuch ghante mein aata hai - "Status refresh" dabate rahein.';
        else errors.push(r.error ?? '');
      } else if (action === 'sync') {
        const r = await whatsapp.syncTemplateStatuses();
        if (r.success) success = 'Status refresh ho gaya (' + r.updated + ' template update hue).'; else errors.push(r.error ?? '');
      } else if (action === 'send') {
        const store = !phpEmpty(b.store_id) ? int(b.store_id) : null;
        const ids = ([] as unknown[]).concat(b['customer_ids[]'] ?? b.customer_ids ?? []).map((x) => int(x));
        const seg = clean(b.segment);
        const r = await whatsapp.startBulkCampaign(str(b.campaign_name), int(b.template_id), seg !== '' && seg !== '0' ? seg : null, ids, store, userId);
        if (r.success) {
          success = r.queued + ' message queue mein daale gaye' + (r.skipped ? ', ' + r.skipped + ' skip (pehle se queue mein)' : '')
            + (r.no_optin ? ', ' + r.no_optin + ' customer skip (WhatsApp opt-in nahi)' : '')
            + '. Ye WhatsApp queue worker ke chalte hi jayenge.';
        } else errors.push(r.error ?? '');
      }
    }
    // Auto-refresh pending template statuses when the page opens (one Meta call, only if something is pending).
    try {
      if (Number((await db.query<Row>("SELECT COUNT(*) AS n FROM notification_templates WHERE channel='WhatsApp' AND category IS NOT NULL AND meta_status IN ('PENDING','IN_APPEAL')"))[0]!.n) > 0) await whatsapp.syncTemplateStatuses();
    } catch { /* best effort */ }

    const templates = await db.query<Row>("SELECT id, template_key, subject, body, provider_template_name, meta_status, meta_reject_reason, category FROM notification_templates WHERE channel='WhatsApp' AND is_active=1 AND category IS NOT NULL ORDER BY id DESC");
    const approved = templates.filter((t) => !phpEmpty(t.provider_template_name));
    const segments = CustomerSegments.available;
    const fixed = ctx.fixedStoreId();
    const stores = fixed === null ? await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active=1 ORDER BY store_name') : await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active=1 AND id IN (?) ORDER BY store_name', [fixed]);
    let campaigns: Row[] = [];
    try { campaigns = await db.query<Row>('SELECT c.*, nt.subject AS tname FROM whatsapp_campaigns c JOIN notification_templates nt ON nt.id = c.template_id ORDER BY c.id DESC LIMIT 15'); } catch { /* optional */ }
    const badge: Record<string, string> = { APPROVED: 'success', PENDING: 'warning text-dark', IN_APPEAL: 'warning text-dark', REJECTED: 'danger', PAUSED: 'secondary', DISABLED: 'secondary' };
    const u = (p: string) => ctx.baseUrl(p);
    const tname = (t: Row) => (!phpEmpty(t.subject) ? str(t.subject) : str(t.template_key));
    return layout(ctx, { title: 'WhatsApp - Bulk Message' }, html`
<div class="col-12">
${errors.map((er) => html`<div class="alert alert-danger">${er}</div>`)}
${success ? html`<div class="alert alert-success">${success}</div>` : ''}

<div class="row g-3">
  <div class="col-lg-6">
    <div class="card h-100"><div class="card-body">
      <div class="d-flex justify-content-between align-items-center mb-2">
        <h6 class="fw-bold mb-0">1. Template banao (Meta par auto-submit)</h6>
        <form method="POST" class="m-0">${ctx.csrfField()}<input type="hidden" name="action" value="sync"><button class="btn btn-outline-secondary btn-sm"><i class="fa-solid fa-rotate me-1"></i>Status refresh</button></form>
      </div>
      <form method="POST">
        ${ctx.csrfField()}<input type="hidden" name="action" value="create_template">
        <div class="mb-2"><input type="text" name="label" class="form-control form-control-sm" maxlength="60" placeholder="Template ka naam (jaise: Diwali Offer)" required></div>
        <div class="mb-2"><select name="category" class="form-select form-select-sm">
          <option value="MARKETING">Marketing (offer / promotion)</option>
          <option value="UTILITY">Utility (order / service update)</option>
        </select></div>
        <div class="mb-1"><textarea name="body" id="tplBody" class="form-control" rows="5" maxlength="1000" placeholder="Namaste {customer_name}, ... Dhanyavaad, {business_name}" required></textarea></div>
        <div class="mb-2 small text-muted">Variable daalein:
          <button type="button" class="btn btn-outline-primary btn-sm py-0" onclick="insVar('{customer_name}')">{customer_name}</button>
          <button type="button" class="btn btn-outline-primary btn-sm py-0" onclick="insVar('{business_name}')">{business_name}</button>
          <div class="mt-1">Message variable se shuru ya khatam nahi ho sakta (Meta ka rule).</div></div>
        <button class="btn btn-primary btn-sm"><i class="fa-brands fa-meta me-1"></i>Template banao aur Meta ko bhejo</button>
      </form>
      <hr>
      <div class="small fw-semibold mb-1">Aapke templates</div>
      ${!templates.length ? html`<div class="text-muted small">Abhi koi nahi.</div>` : ''}
      ${templates.map((t) => { const ms = str(t.meta_status); return html`
        <div class="border rounded p-2 mb-1">
          <div class="d-flex justify-content-between"><strong class="small">${tname(t)}</strong>
            <span class="badge bg-${badge[ms] ?? 'secondary'}">${ms}</span></div>
          <div class="small text-muted">${strimwidth(str(t.body), 140, '...')}</div>
          ${ms === 'REJECTED' && !phpEmpty(t.meta_reject_reason) ? html`<div class="small text-danger">Reject reason: ${t.meta_reject_reason}</div>` : ''}
        </div>`; })}
    </div></div>
  </div>

  <div class="col-lg-6">
    <div class="card h-100"><div class="card-body">
      <h6 class="fw-bold">2. Bulk message bhejein</h6>
      ${!approved.length ? html`<div class="alert alert-warning small">Abhi koi template Meta se approve nahi hua. Approve hote hi yahan bhej sakenge.</div>` : ''}
      <form method="POST" onsubmit="return confirm('Ye bulk message sabko queue ho jayega. Pakka bhejna hai?');">
        ${ctx.csrfField()}<input type="hidden" name="action" value="send">
        <div class="mb-2"><input type="text" name="campaign_name" class="form-control form-control-sm" placeholder="Campaign ka naam" required></div>
        <div class="mb-2"><select name="template_id" class="form-select form-select-sm" required>
          <option value="">Approved template chunein...</option>
          ${approved.map((t) => html`<option value="${int(t.id)}">${tname(t)}</option>`)}
        </select></div>
        <div class="row g-2 mb-2">
          <div class="col-md-7"><select name="segment" class="form-select form-select-sm"><option value="">Segment (optional)</option>
            ${Object.entries(segments).map(([k, lbl]) => html`<option value="${k}">${lbl}</option>`)}</select></div>
          <div class="col-md-5"><select name="store_id" class="form-select form-select-sm"><option value="">Saare stores</option>
            ${stores.map((s) => html`<option value="${int(s.id)}">${s.store_name}</option>`)}</select></div>
        </div>
        <div class="mb-1 small fw-semibold">Customers chun kar (optional)</div>
        <input type="text" id="custQ" class="form-control form-control-sm mb-1" placeholder="Naam ya mobile se dhundein (2+ akshar)">
        <div id="custResults" class="list-group mb-2" style="max-height:160px;overflow:auto;"></div>
        <div id="custChips" class="mb-2 d-flex flex-wrap gap-1"></div>
        <div class="small text-muted mb-2">Segment, chune hue customers, ya dono ek saath. Sirf WhatsApp opt-in wale customers ko jaata hai.</div>
        <button class="btn btn-danger btn-sm" ${approved.length ? '' : 'disabled'}><i class="fa-solid fa-paper-plane me-1"></i>Bulk message queue karein</button>
      </form>
    </div></div>
  </div>
</div>

<div class="card mt-3"><div class="card-body">
  <h6 class="fw-bold">Recent bulk campaigns</h6>
  ${!campaigns.length ? html`<p class="text-muted small mb-0">Abhi koi nahi.</p>` : html`
  <div class="table-responsive"><table class="table table-sm">
    <thead><tr><th>Naam</th><th>Template</th><th>Segment</th><th>Recipients</th><th>Status</th><th>Date</th></tr></thead>
    ${campaigns.map((c) => html`<tr><td>${c.campaign_name}</td><td>${str(c.tname)}</td><td>${segments[str(c.segment_key)] ?? c.segment_key}</td><td>${int(c.recipient_count)}</td><td><span class="badge bg-secondary">${c.status}</span></td><td>${raw(e(ctx.datetime(c.created_at)))}</td></tr>`)}
  </table></div>`}
</div></div>
</div>
<script>
function insVar(v){var t=document.getElementById('tplBody');var s=t.selectionStart||0;t.value=t.value.slice(0,s)+v+t.value.slice(t.selectionEnd||s);t.focus();}
(function(){
  var q=document.getElementById('custQ'), res=document.getElementById('custResults'), chips=document.getElementById('custChips'), timer=null;
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
  function addChip(id,name){ if(chips.querySelector('[data-id="'+id+'"]')) return;
    var c=document.createElement('span'); c.className='badge bg-primary d-inline-flex align-items-center gap-1'; c.setAttribute('data-id',id);
    c.innerHTML=esc(name)+' <input type="hidden" name="customer_ids[]" value="'+id+'"><a href="#" style="color:#fff;text-decoration:none;" class="ms-1">&times;</a>';
    c.querySelector('a').onclick=function(e){e.preventDefault();c.remove();}; chips.appendChild(c); }
  q.addEventListener('input',function(){ clearTimeout(timer); var v=q.value.trim(); if(v.length<2){res.innerHTML='';return;}
    timer=setTimeout(function(){ fetch('${u('api/customers_search.php')}?q='+encodeURIComponent(v),{credentials:'same-origin'}).then(r=>r.json()).then(function(d){
      res.innerHTML=''; (d.results||[]).forEach(function(c){ var a=document.createElement('a'); a.href='#'; a.className='list-group-item list-group-item-action py-1 small';
        a.textContent=c.full_name+' - '+c.mobile; a.onclick=function(e){e.preventDefault();addChip(c.id,c.full_name);}; res.appendChild(a); }); }); },250); });
})();
</script>
`);
  });

  // ---- settings/firebase_settings.php -------------------------------------------------------------------------------------
  webPage(app, '/modules/settings/firebase_settings', { auth: 'whatsapp.settings', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const b = body(ctx);
    if (req.method === 'POST' && b.send_test_push !== undefined) {
      if (!ctx.csrfValid()) return csrfFail();
      await firebase.sendPushToAllStaff('Test notification', 'If you see this, Firebase push is working correctly.', { test: '1' });
      ctx.flashSet('success', 'Test push sent to every registered device. Check your phone.');
      return new WebRedirect('modules/settings/firebase_settings.php');
    }
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const json = str(b.service_account_json).trim();
      if (json !== '') {
        let decoded: any = null;
        try { decoded = JSON.parse(json); } catch { decoded = null; }
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || phpEmpty(decoded.private_key) || phpEmpty(decoded.client_email) || phpEmpty(decoded.project_id)) {
          ctx.flashSet('danger', 'That does not look like a valid Firebase service account JSON file (missing private_key/client_email/project_id).');
          return new WebRedirect('modules/settings/firebase_settings.php');
        }
        const encrypted = crypto.encrypt(json);
        await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('firebase_service_account_encrypted', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [encrypted, encrypted]);
        ctx.flashSet('success', 'Firebase service account saved for project: ' + e(decoded.project_id));
      }
      return new WebRedirect('modules/settings/firebase_settings.php');
    }
    const configured = str(await ctx.setting('firebase_service_account_encrypted', '')) !== '';
    let projectId: string | null = null;
    if (configured) { try { projectId = (await firebase.getServiceAccount())?.project_id ?? null; } catch { /* status line just less specific */ } }
    return layout(ctx, { title: 'Firebase Push Notifications' }, html`
<div class="container-fluid py-3" style="max-width:700px;">
  <h4 class="fw-bold mb-3"><i class="fa-solid fa-bell me-2"></i>Firebase Push Notifications</h4>

  ${configured ? html`
    <div class="alert alert-success d-flex justify-content-between align-items-center">
      <span><i class="fa-solid fa-check-circle me-1"></i> Configured${projectId ? ' for project: ' + projectId : ''}.</span>
      <form method="POST" class="mb-0">
        ${ctx.csrfField()}
        <input type="hidden" name="send_test_push" value="1">
        <button type="submit" class="btn btn-sm btn-outline-success">Send Test Push</button>
      </form>
    </div>
    <p class="text-muted small">Paste a new JSON below to replace the configured service account.</p>` : html`
    <div class="alert alert-light border">Not configured yet. WhatsApp reply notifications will not be sent until this is set up.</div>`}

  <form method="POST">
    ${ctx.csrfField()}
    <label class="form-label small text-muted">Service account JSON (from Firebase Console → Project Settings → Service Accounts → Generate new private key)</label>
    <textarea name="service_account_json" class="form-control font-monospace" rows="14" placeholder='{"type": "service_account", "project_id": "...", ...}'></textarea>
    <button type="submit" class="btn btn-primary mt-3">Save</button>
  </form>
</div>
`);
  });

  // ---- workshop/bill_pdf.php: the workshop invoice as a PDF (same scoping as bill_print.php) --------------------------------------
  webPage(app, '/modules/workshop/bill_pdf', { auth: 'login' }, async (ctx, req) => {
    if (!ctx.can('workshop.billing') && !ctx.can('billing.view')) return new WebText("<h2>403 - Access Denied</h2><p>You do not have permission to access this page.</p>", 403);
    const scope = await wsBillingScope(db, ctx.data.user_id ?? 0, ctx.roleName());
    const id = int((req.query as Record<string, unknown>).id);
    const ws = (await db.query<Row>('SELECT workshop_id FROM workshop_bills WHERE id = ?', [id]))[0];
    if (!ws || scope.blocked || (scope.workshop_id !== null && Number(ws.workshop_id) !== scope.workshop_id)) return new WebText('<h2>Bill not found</h2>', 404);
    const pdf = await workshopBillPdf.generate(id);
    if (!pdf.success || !pdf.file_path) return new WebText('<h2>Could not generate the PDF</h2>', 500);
    const bytes = await readFile(pdf.file_path);
    await unlink(pdf.file_path).catch(() => {});
    return new WebText(bytes, 200, 'application/pdf', { 'Content-Disposition': `inline; filename="${pdf.filename}"`, 'Content-Length': String(bytes.length) });
  });
}
