import { readFile, unlink } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { addDays, todayIn } from '../../lib/dates.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { flt, formArray, int, numberFormat, urlencode } from '../format.js';
import { e, html, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { getSetting } from '../../services/settings.js';
import { challanPickerScript, challanStyle, challanWhatsAppScript } from './challans.static.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SAVED_WHATSAPP_NUMBERS = 5;

/**
 * Challan (delivery/packing-note) web pages: list, generate, edit, view, print (the PDF), delete and
 * a date-wise/garments-wise report — 7 endpoints, same count the changelog lists. The order picker on
 * generate/edit reuses the existing /api/orders_search endpoint rather than standing up a near-
 * identical second one, so generating a challan also needs the packing.manage permission that search
 * endpoint is already gated behind, alongside challans.manage.
 */
export function registerChallanPages(app: FastifyInstance) {
  const { db, challans, challanPdf, whatsapp } = app.services;
  const actor = (ctx: WebCtx) => ({ userId: ctx.data.user_id!, ip: ctx.req.ip });
  const u = (ctx: WebCtx) => (p: string) => ctx.baseUrl(p);
  const notFound = (ctx: WebCtx) => { ctx.flashSet('danger', 'Challan not found.'); return new WebRedirect('modules/challans/list.php'); };
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

  // ---- list --------------------------------------------------------------------------------------
  webPage(app, '/modules/challans/list', { auth: 'challans.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const search = clean(q.q);
    const page = Math.max(1, int(q.page) || 1);
    const perPage = 25;
    let where = '1=1';
    const params: unknown[] = [];
    if (search !== '') {
      where += ` AND EXISTS (SELECT 1 FROM challan_orders co3 JOIN orders o3 ON o3.id = co3.order_id WHERE co3.challan_id = ch.id AND (ch.challan_number LIKE ? OR o3.order_number LIKE ? OR o3.short_order_code LIKE ?))`;
      params.push(...Array(3).fill(`%${search}%`));
    }
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n FROM challans ch WHERE ${where}`, params))[0]!.n);
    // LEFT JOIN users for created_by_name -- the live PHP rewrite once dropped this join and it only
    // broke once real challans existed to list, not on an empty result set.
    const rows = await db.query<Row>(
      `SELECT ch.id, ch.challan_number, ch.with_amount, ch.created_at, u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM challan_orders co WHERE co.challan_id = ch.id) AS order_count,
              (SELECT GROUP_CONCAT(DISTINCT COALESCE(o.short_order_code, o.order_number) ORDER BY o.id SEPARATOR ', ')
                 FROM challan_orders co JOIN orders o ON o.id = co.order_id WHERE co.challan_id = ch.id) AS order_numbers,
              (SELECT COALESCE(SUM(oi.total), 0) FROM order_items oi WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ch.id)) AS total_value
       FROM challans ch LEFT JOIN users u ON u.id = ch.created_by
       WHERE ${where} ORDER BY ch.id DESC LIMIT ? OFFSET ?`,
      [...params, perPage, (page - 1) * perPage],
    );
    const totalPages = Math.ceil(total / perPage);
    const money = await ctx.loadMoney();
    const pageUrl = (p: number) => `?q=${urlencode(search)}&page=${p}`;

    return layout(ctx, { title: 'Challans' }, html`
<div class="col-12">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h4 class="fw-bold mb-0"><i class="fa-solid fa-truck me-2"></i>Challans</h4>
    <a href="${u(ctx)('modules/challans/generate.php')}" class="btn btn-primary"><i class="fa-solid fa-plus me-1"></i>New Challan</a>
  </div>
  <div class="card">
    <div class="card-body">
      <form class="d-flex gap-2 mb-3" method="GET">
        <input type="text" name="q" class="form-control" style="max-width:320px;" placeholder="Challan #, order # or customer" value="${search}">
        <button class="btn btn-outline-secondary" type="submit"><i class="fa-solid fa-magnifying-glass"></i></button>
        ${search !== '' ? html`<a href="?" class="btn btn-outline-secondary" title="Clear"><i class="fa-solid fa-xmark"></i></a>` : ''}
      </form>
      ${rows.length === 0 ? html`
      <div class="text-center text-muted py-5"><i class="fa-solid fa-inbox fa-2x mb-2"></i><p class="mb-0">${search !== '' ? 'No challans match this search.' : 'No challans yet.'}</p></div>` : html`
      <div class="table-responsive">
        <table class="table table-hover align-middle mb-0">
          <thead><tr><th>Challan #</th><th>Orders</th><th>With Amount</th><th class="text-end">Value</th><th>Created</th><th>By</th><th style="width:140px;"></th></tr></thead>
          <tbody>
          ${rows.map((r) => html`
            <tr>
              <td><a href="${u(ctx)('modules/challans/view.php?id=' + r.id)}">${r.challan_number}</a></td>
              <td class="small">${r.order_numbers ?? ''} <span class="text-muted">(${numberFormat(int(r.order_count), 0)})</span></td>
              <td>${Number(r.with_amount) ? html`<span class="badge bg-success">Yes</span>` : html`<span class="badge bg-secondary">No</span>`}</td>
              <td class="text-end">${raw(money(r.total_value))}</td>
              <td>${raw(ctx.datetime(r.created_at))}</td>
              <td>${str(r.created_by_name)}</td>
              <td>
                <a href="${u(ctx)('modules/challans/view.php?id=' + r.id)}" class="btn btn-sm btn-outline-secondary" title="View"><i class="fa-solid fa-eye"></i></a>
                <a href="${u(ctx)('modules/challans/print.php?id=' + r.id)}" target="_blank" class="btn btn-sm btn-outline-secondary" title="Print"><i class="fa-solid fa-print"></i></a>
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>
      ${totalPages > 1 ? html`
      <nav class="mt-3"><ul class="pagination pagination-sm mb-0">
        ${Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => html`
          <li class="page-item ${p === page ? 'active' : ''}"><a class="page-link" href="${pageUrl(p)}">${p}</a></li>`)}
      </ul></nav>` : ''}`}
    </div>
  </div>
</div>
${raw(challanStyle())}
`);
  });

  // ---- generate / edit (shared order-picker UI) ---------------------------------------------------
  const pickerPage = (mode: 'generate' | 'edit') => async (ctx: WebCtx, req: { method: string; body?: unknown }) => {
    const q = (req as any).query as Record<string, unknown>;
    const challanId = mode === 'edit' ? int(q.id) : 0;
    let challan: Row | undefined;
    let preselected: { order_id: number; label: string }[] = [];
    if (mode === 'edit') {
      [challan] = await db.query<Row>('SELECT * FROM challans WHERE id = ?', [challanId]);
      if (!challan) return notFound(ctx);
      const orders = await db.query<Row>(
        `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS code, c.full_name AS customer_name
         FROM challan_orders co JOIN orders o ON o.id = co.order_id JOIN customers c ON c.id = o.customer_id
         WHERE co.challan_id = ? ORDER BY o.id`, [challanId]);
      preselected = orders.map((o) => ({ order_id: Number(o.id), label: `${o.code} — ${o.customer_name}` }));
    }

    if (req.method === 'POST') {
      const p = (req as any).body as Record<string, unknown>;
      if (!ctx.csrfValid()) return new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
      const orderIds = formArray(p, 'order_ids').map((x) => int(x));
      const withAmount = !!clean(p.with_amount);
      const result = mode === 'generate'
        ? await challans.generate(orderIds, withAmount, actor(ctx))
        : await challans.edit(challanId, orderIds, withAmount, actor(ctx));
      if (!result.success) {
        ctx.flashSet('danger', (result.errors ?? ['Could not save the challan.']).join(' '));
      } else {
        ctx.flashSet('success', mode === 'generate'
          ? (result.reused ? `Reusing existing challan ${result.challan_number} (same orders already on it).` : `Challan ${result.challan_number} created.`)
          : `Challan ${result.challan_number} updated.`);
        return new WebRedirect(`modules/challans/view.php?id=${result.challan_id}`);
      }
    }

    return layout(ctx, { title: mode === 'generate' ? 'New Challan' : `Edit Challan ${challan?.challan_number ?? ''}` }, html`
<div class="col-12">
  <h4 class="fw-bold mb-3"><i class="fa-solid fa-truck me-2"></i>${mode === 'generate' ? 'New Challan' : `Edit Challan ${str(challan?.challan_number)}`}</h4>
  <div class="card">
    <div class="card-body">
      <form method="POST" id="chPickerForm">
        ${ctx.csrfField()}
        <div class="mb-3">
          <label class="form-check-label">
            <input type="checkbox" class="form-check-input" name="with_amount" value="1" ${Number(challan?.with_amount) ? 'checked' : ''}>
            With Amount (show rates/totals on the printed challan)
          </label>
        </div>
        <div class="mb-3">
          <label class="form-label fw-bold">Orders on this challan</label>
          <input type="text" id="chPickerSearch" class="form-control" placeholder="Search by order #, customer name or mobile…" autocomplete="off">
          <div class="ch-picker-results"><div id="chPickerDropdown" class="ch-picker-dropdown" style="display:none;"></div></div>
          <div id="chPickerChips" class="mt-2"></div>
          <div id="chPickerInputs"></div>
        </div>
        <button type="submit" class="btn btn-primary"><i class="fa-solid fa-floppy-disk me-1"></i>${mode === 'generate' ? 'Generate Challan' : 'Save Changes'}</button>
        <a href="${u(ctx)(mode === 'edit' ? `modules/challans/view.php?id=${challanId}` : 'modules/challans/list.php')}" class="btn btn-outline-secondary">Cancel</a>
      </form>
    </div>
  </div>
</div>
${raw(challanStyle())}
${raw(challanPickerScript(u(ctx)('api/orders_search.php'), preselected))}
`);
  };
  webPage(app, '/modules/challans/generate', { auth: 'challans.manage', methods: ['GET', 'POST'] }, pickerPage('generate'));
  webPage(app, '/modules/challans/edit', { auth: 'challans.manage', methods: ['GET', 'POST'] }, pickerPage('edit'));

  // ---- view ----------------------------------------------------------------------------------------
  webPage(app, '/modules/challans/view', { auth: 'challans.manage' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const [challan] = await db.query<Row>('SELECT ch.*, u.full_name AS created_by_name FROM challans ch LEFT JOIN users u ON u.id = ch.created_by WHERE ch.id = ?', [id]);
    if (!challan) return notFound(ctx);
    const orders = await db.query<Row>(
      `SELECT o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number, c.full_name AS customer_name, c.mobile, o.order_date
       FROM challan_orders co JOIN orders o ON o.id = co.order_id JOIN customers c ON c.id = o.customer_id
       WHERE co.challan_id = ? ORDER BY o.id`, [id]);
    const items = await db.query<Row>(
      `SELECT oi.order_id, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, COALESCE(s.service_name, 'Unknown Service') AS service_name, oi.quantity, oi.unit_price, oi.total
       FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id
       WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ?) ORDER BY oi.id`, [id]);
    const itemsByOrder = new Map<number, Row[]>();
    for (const it of items) { const k = Number(it.order_id); (itemsByOrder.get(k) ?? itemsByOrder.set(k, []).get(k)!).push(it); }
    const money = await ctx.loadMoney();
    const totalValue = items.reduce((s, it) => s + flt(it.total), 0);
    const savedNumbers = await getSavedWhatsAppNumbers();
    const defaultNumber = orders.length === 1 ? str(orders[0]!.mobile) : '';

    return layout(ctx, { title: `Challan ${challan.challan_number}` }, html`
<div class="col-12">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <div>
      <h4 class="fw-bold mb-0">${challan.challan_number}</h4>
      <div class="text-muted small">Created ${raw(ctx.datetime(challan.created_at))} by ${str(challan.created_by_name)} &middot; ${Number(challan.with_amount) ? 'With Amount' : 'Without Amount'} &middot; ${orders.length > 1 ? 'Combined' : 'Single order'}</div>
    </div>
    <div class="d-flex gap-2">
      <a href="${u(ctx)('modules/challans/print.php?id=' + id)}" target="_blank" class="btn btn-outline-secondary"><i class="fa-solid fa-print me-1"></i>Print / PDF</a>
      <button type="button" class="btn btn-success" id="btnSendWhatsapp" style="background:#25D366;border-color:#25D366;"><i class="fa-brands fa-whatsapp me-1"></i>Send via WhatsApp</button>
      <a href="${u(ctx)('modules/challans/edit.php?id=' + id)}" class="btn btn-outline-secondary"><i class="fa-solid fa-pen me-1"></i>Edit</a>
      <form method="POST" action="${u(ctx)('modules/challans/delete.php')}" onsubmit="return confirm('Delete this challan? This cannot be undone.');">
        ${ctx.csrfField()}
        <input type="hidden" name="challan_id" value="${id}">
        <button type="submit" class="btn btn-outline-danger"><i class="fa-solid fa-trash me-1"></i>Delete</button>
      </form>
    </div>
  </div>

  ${orders.map((o) => html`
  <div class="card mb-3">
    <div class="card-header d-flex justify-content-between align-items-center">
      <div><a href="${u(ctx)('modules/orders/view.php?id=' + o.order_id)}"><strong>${o.order_number}</strong></a> — ${o.customer_name} <span class="text-muted small">(${o.mobile})</span></div>
      <div class="small text-muted">Order date: ${raw(ctx.date(o.order_date))}</div>
    </div>
    <div class="table-responsive">
      <table class="table table-sm mb-0 align-middle">
        <thead><tr><th>Garment</th><th>Service</th><th class="text-end">Qty</th>${Number(challan.with_amount) ? html`<th class="text-end">Rate</th><th class="text-end">Amount</th>` : ''}</tr></thead>
        <tbody>
        ${(itemsByOrder.get(Number(o.order_id)) ?? []).map((it) => html`
          <tr>
            <td>${it.garment_name}</td>
            <td class="text-muted">${it.service_name}</td>
            <td class="text-end">${numberFormat(flt(it.quantity), 2)}</td>
            ${Number(challan.with_amount) ? html`<td class="text-end">${raw(money(it.unit_price))}</td><td class="text-end">${raw(money(it.total))}</td>` : ''}
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>`)}

  ${Number(challan.with_amount) ? html`
  <div class="card"><div class="card-body d-flex justify-content-between align-items-center">
    <strong>Total Value</strong><strong>${raw(money(totalValue))}</strong>
  </div></div>` : ''}
</div>

<div class="modal fade" id="sendWhatsappModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title"><i class="fa-brands fa-whatsapp me-2"></i>Send via WhatsApp</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <form method="POST" action="${u(ctx)('modules/challans/send_whatsapp.php')}">
        ${ctx.csrfField()}
        <input type="hidden" name="challan_id" value="${id}">
        <div class="modal-body">
          <div id="waError" class="alert alert-danger d-none"></div>
          ${savedNumbers.length > 0 ? html`
          <label class="form-label small">Saved numbers</label>
          <div class="d-flex flex-wrap gap-2 mb-2">
            ${savedNumbers.map((n) => html`<button type="button" class="btn btn-sm btn-outline-secondary wa-saved-number" data-number="${n}">${n}</button>`)}
          </div>` : ''}
          <label class="form-label small">WhatsApp number</label>
          <input type="text" name="to_number" id="waToNumber" class="form-control" placeholder="10-digit mobile number" value="${defaultNumber}" required>
          <div class="form-check mt-2">
            <input type="checkbox" class="form-check-input" name="save_number" value="1" id="waSaveNumber">
            <label class="form-check-label small" for="waSaveNumber">Save this number for next time</label>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="submit" class="btn btn-success" style="background:#25D366;border-color:#25D366;">Send</button>
        </div>
      </form>
    </div>
  </div>
</div>
${raw(challanWhatsAppScript())}
`);
  });

  // ---- print (PDF) -----------------------------------------------------------------------------------
  webPage(app, '/modules/challans/print', { auth: 'challans.manage' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const [challan] = await db.query<Row>('SELECT id, challan_number FROM challans WHERE id = ?', [id]);
    if (!challan) return notFound(ctx);
    const gen = await challanPdf.generate(id);
    if (!gen.success) { ctx.flashSet('danger', gen.error ?? 'Could not generate the PDF.'); return new WebRedirect(`modules/challans/view.php?id=${id}`); }
    try {
      const buf = await readFile(gen.file_path!);
      return new WebText(buf, 200, 'application/pdf', { 'Content-Disposition': `inline; filename="${challan.challan_number}.pdf"` });
    } finally {
      await unlink(gen.file_path!).catch(() => {});
    }
  });

  // ---- delete ------------------------------------------------------------------------------------
  webPage(app, '/modules/challans/delete', { auth: 'challans.manage', methods: ['POST'] }, async (ctx, req) => {
    if (!ctx.csrfValid()) return new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
    const p = req.body as Record<string, unknown>;
    const challanId = int(p.challan_id);
    const result = await challans.delete(challanId, actor(ctx));
    ctx.flashSet(result.success ? 'success' : 'danger', result.success ? 'Challan deleted.' : (result.errors ?? ['Could not delete the challan.']).join(' '));
    return new WebRedirect('modules/challans/list.php');
  });

  // ---- send via WhatsApp --------------------------------------------------------------------------
  webPage(app, '/modules/challans/send_whatsapp', { auth: 'challans.manage', methods: ['POST'] }, async (ctx, req) => {
    if (!ctx.csrfValid()) return new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
    const p = req.body as Record<string, unknown>;
    const challanId = int(p.challan_id);
    const toNumber = clean(p.to_number);
    if (toNumber === '') { ctx.flashSet('danger', 'A WhatsApp number is required.'); return new WebRedirect(`modules/challans/view.php?id=${challanId}`); }
    const result = await whatsapp.sendChallan(challanId, toNumber, ctx.data.user_id ?? null);
    if (result.success && !!clean(p.save_number)) await saveWhatsAppNumber(toNumber);
    ctx.flashSet(result.success ? 'success' : 'danger', result.success ? 'Challan sent via WhatsApp.' : (result.error ?? 'Could not send the challan.'));
    return new WebRedirect(`modules/challans/view.php?id=${challanId}`);
  });

  // ---- report (date-wise / garments-wise) -----------------------------------------------------------
  webPage(app, '/modules/challans/report', { auth: 'challans.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const type = clean(q.type) === 'garments' ? 'garments' : 'date';
    let period = str(q.period) || 'week';
    const customFrom = clean(q.from), customTo = clean(q.to);
    const today = ctx.today;
    let from: string, to: string;
    switch (period) {
      case '15days': from = addDays(today, -14); to = today; break;
      case '30days': from = addDays(today, -29); to = today; break;
      case 'custom': from = ISO.test(customFrom) ? customFrom : addDays(today, -6); to = ISO.test(customTo) ? customTo : today; break;
      default: period = 'week'; from = addDays(today, -6); to = today;
    }
    const money = await ctx.loadMoney();
    const reportUrl = (t: string) => `?type=${t}&period=${period}&from=${from}&to=${to}`;
    const periodUrl = (p: string) => `?type=${type}&period=${p}`;

    let dateRows: Row[] = [], garmentRows: Row[] = [];
    if (type === 'date') {
      dateRows = await db.query<Row>(
        `SELECT DATE(ch.created_at) AS day, COUNT(DISTINCT ch.id) AS challan_count,
                COALESCE(SUM((SELECT COALESCE(SUM(oi.quantity * GREATEST(oi.pieces_per_unit, 1)), 0) FROM order_items oi WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ch.id))), 0) AS garment_count,
                COALESCE(SUM((SELECT COALESCE(SUM(oi.total), 0) FROM order_items oi WHERE oi.order_id IN (SELECT order_id FROM challan_orders WHERE challan_id = ch.id))), 0) AS total_value
         FROM challans ch WHERE DATE(ch.created_at) BETWEEN ? AND ? GROUP BY DATE(ch.created_at) ORDER BY day DESC`, [from, to]);
    } else {
      garmentRows = await db.query<Row>(
        `SELECT COALESCE(g.garment_name, CONCAT('Laundry: ', s.service_name)) AS garment_name, COALESCE(SUM(oi.quantity * GREATEST(oi.pieces_per_unit, 1)), 0) AS quantity, COALESCE(SUM(oi.total), 0) AS total_value
         FROM challans ch JOIN challan_orders co ON co.challan_id = ch.id JOIN order_items oi ON oi.order_id = co.order_id LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id
         WHERE DATE(ch.created_at) BETWEEN ? AND ? GROUP BY COALESCE(g.garment_name, CONCAT('Laundry: ', s.service_name)) ORDER BY quantity DESC`, [from, to]);
    }

    return layout(ctx, { title: 'Challan Report' }, html`
<div class="col-12">
  <h4 class="fw-bold mb-3"><i class="fa-solid fa-chart-column me-2"></i>Challan Report</h4>
  <div class="card mb-3"><div class="card-body d-flex flex-wrap align-items-center gap-2">
    <div class="btn-group btn-group-sm" role="group">
      <a href="${reportUrl('date')}" class="btn ${type === 'date' ? 'btn-primary' : 'btn-outline-primary'}">Date-wise</a>
      <a href="${reportUrl('garments')}" class="btn ${type === 'garments' ? 'btn-primary' : 'btn-outline-primary'}">Garments-wise</a>
    </div>
    <div class="btn-group btn-group-sm ms-auto" role="group">
      ${([['week', 'This Week'], ['15days', '15 Days'], ['30days', '30 Days']] as [string, string][]).map(([val, label]) => html`
        <a href="${periodUrl(val)}" class="btn ${period === val ? 'btn-secondary' : 'btn-outline-secondary'}">${label}</a>`)}
    </div>
    <span class="text-muted small">${raw(ctx.date(from))} – ${raw(ctx.date(to))}</span>
  </div></div>

  ${type === 'date' ? html`
  <div class="card"><div class="table-responsive">
    <table class="table table-sm mb-0 align-middle">
      <thead><tr><th>Date</th><th class="text-end">Challans</th><th class="text-end">Garments</th><th class="text-end">Value</th></tr></thead>
      <tbody>
      ${dateRows.length === 0 ? html`<tr><td colspan="4" class="text-center text-muted py-4">No challans in this period.</td></tr>` : ''}
      ${dateRows.map((r) => html`
        <tr><td>${raw(ctx.date(r.day))}</td><td class="text-end">${numberFormat(int(r.challan_count), 0)}</td><td class="text-end">${numberFormat(flt(r.garment_count), 0)}</td><td class="text-end">${raw(money(r.total_value))}</td></tr>`)}
      </tbody>
    </table>
  </div></div>` : html`
  <div class="card"><div class="table-responsive">
    <table class="table table-sm mb-0 align-middle">
      <thead><tr><th>Garment</th><th class="text-end">Quantity</th><th class="text-end">Value</th></tr></thead>
      <tbody>
      ${garmentRows.length === 0 ? html`<tr><td colspan="3" class="text-center text-muted py-4">No challans in this period.</td></tr>` : ''}
      ${garmentRows.map((r) => html`
        <tr><td>${r.garment_name}</td><td class="text-end">${numberFormat(flt(r.quantity), 0)}</td><td class="text-end">${raw(money(r.total_value))}</td></tr>`)}
      </tbody>
    </table>
  </div></div>`}
</div>
`);
  });
}
