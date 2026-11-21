import type { FastifyInstance } from 'fastify';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { csvBody } from '../csv.js';
import { httpBuildQuery, int } from '../format.js';
import { html, raw } from '../html.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Customer Returns (Rahul, 21 Nov 2026): register a return of a delivered order, the returns table, and the admin-editable reasons list. */
export function registerCustomerReturnPages(app: FastifyInstance) {
  const { db, returns } = app.services;

  // ---- modules/orders/return.php ----------------------------------------------------------------
  webPage(app, '/modules/orders/return', { auth: 'orders.edit', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const b = body(ctx);
    const orderId = int(q.order_id ?? b.order_id);
    const order = (await db.query<Row>(
      `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.grand_total, c.full_name, c.mobile, os.status_key, os.status_label
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_statuses os ON os.id = o.status_id WHERE o.id = ?`, [orderId]))[0];
    if (!order) { ctx.flashSet('danger', 'Order nahi mila.'); return new WebRedirect('modules/orders/list.php'); }

    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const f = ctx.files.photo;
      const ids = ([] as unknown[]).concat(b['item_ids[]'] ?? b.item_ids ?? []).map((x) => int(x));
      const res = await returns.createReturn(orderId, ids, int(b.reason_id), String(b.note ?? ''), f ? { buffer: f.buffer } : null, ctx.data.user_id ?? 0, req.ip);
      if (res.success) {
        ctx.flashSet('success', res.count + ' garment return ho kar Rework queue mein chala gaya.');
        return new WebRedirect('modules/orders/returns.php');
      }
      ctx.flashSet('danger', res.errors.join(' '));
      return new WebRedirect('modules/orders/return.php?order_id=' + orderId);
    }

    const items = await returns.returnableItems(orderId);
    const reasons = await returns.activeReasons();
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Customer Return - ' + order.order_number }, html`
<div class="col-12 col-lg-8">
  <div class="card"><div class="card-body">
    <div class="d-flex justify-content-between align-items-start mb-2">
      <div>
        <h6 class="fw-bold mb-0">Customer Return - Order ${order.order_number}</h6>
        <div class="text-muted small">${order.full_name} &middot; ${order.mobile} &middot; <span class="badge bg-secondary">${order.status_label}</span></div>
      </div>
      <a href="${u('modules/orders/view.php?id=' + orderId)}" class="btn btn-outline-secondary btn-sm">Back</a>
    </div>
    ${order.status_key !== 'delivered' ? html`
      <div class="alert alert-warning">Return sirf <b>Delivered</b> order par ho sakta hai (abhi: ${order.status_label}).</div>` : !items.length ? html`
      <div class="alert alert-info">Is order ka koi garment return ke liye bacha nahi hai.</div>` : html`
    <form method="POST" enctype="multipart/form-data">
      ${ctx.csrfField()}<input type="hidden" name="order_id" value="${orderId}">
      <label class="form-label fw-semibold">Kaun se garments wapas aaye? *</label>
      <div class="mb-3">
        ${items.map((it) => html`
          <label class="d-flex align-items-center gap-2 border rounded p-2 mb-1">
            <input type="checkbox" name="item_ids[]" value="${int(it.id)}" class="form-check-input mt-0">
            <span>${it.garment_name} <span class="text-muted small">- ${it.service_name} (${it.billing_unit === 'weight' ? String(it.weight) + ' kg' : int(it.quantity) + ' pc'})</span></span>
          </label>`)}
      </div>
      <div class="mb-3">
        <label class="form-label fw-semibold">Reason *</label>
        <select name="reason_id" class="form-select" required>
          <option value="">-- Select --</option>
          ${reasons.map((r) => html`<option value="${int(r.id)}">${r.reason_name}</option>`)}
        </select>
      </div>
      <div class="mb-3">
        <label class="form-label fw-semibold">Note <span class="text-muted fw-normal">(optional)</span></label>
        <input type="text" name="note" class="form-control" maxlength="500" placeholder="Jaise: collar par daag reh gaya">
      </div>
      <div class="mb-3">
        <label class="form-label fw-semibold">Photo <span class="text-muted fw-normal">(optional)</span></label>
        <input type="file" name="photo" class="form-control" accept="image/jpeg,image/png,image/webp" capture="environment">
      </div>
      <p class="text-muted small">Select kiye garments Rework queue mein jayenge (Rework &rarr; QC &rarr; Ready &rarr; Packed &rarr; dobara delivery). Order ka amount aur payment wahi rahega.</p>
      <button class="btn btn-danger"><i class="fa-solid fa-rotate-left me-1"></i>Return Register Karein</button>
    </form>`}
  </div></div>
</div>
`);
  });

  // ---- modules/orders/returns.php ---------------------------------------------------------------
  webPage(app, '/modules/orders/returns', { auth: 'orders.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const today = ctx.today;
    const monthStart = today.slice(0, 8) + '01';
    let dateFrom = 'date_from' in q ? clean(q.date_from) : monthStart;
    let dateTo = 'date_to' in q ? clean(q.date_to) : today;
    if (!DATE_RE.test(dateFrom)) dateFrom = monthStart;
    if (!DATE_RE.test(dateTo)) dateTo = today;
    const reasonFilter = int(q.reason_id);

    const fixed = ctx.fixedStoreId();
    const sf = fixed !== null ? ' AND o.store_id IN (?)' : '';
    const sfParams: unknown[] = fixed !== null ? [fixed] : [];
    const rf = reasonFilter ? ' AND cr.reason_id = ?' : '';
    const rows = await db.query<Row>(
      `SELECT cr.id, cr.created_at, cr.reason_text, cr.note, o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number,
       c.full_name, c.mobile, g.garment_name, oi.item_status, rr.status AS rework_status, u.full_name AS by_name, p.file_path
       FROM customer_returns cr
       JOIN orders o ON o.id = cr.order_id JOIN customers c ON c.id = o.customer_id
       JOIN order_items oi ON oi.id = cr.order_item_id JOIN garments g ON g.id = oi.garment_id
       LEFT JOIN rework_records rr ON rr.id = cr.rework_id
       LEFT JOIN users u ON u.id = cr.created_by
       LEFT JOIN order_photos p ON p.id = cr.photo_id
       WHERE DATE(cr.created_at) BETWEEN ? AND ?${sf}${rf}
       ORDER BY cr.id DESC LIMIT 1000`, [dateFrom, dateTo, ...sfParams, ...(reasonFilter ? [reasonFilter] : [])]);

    if ('export' in q) {
      return new WebText(csvBody(['Date', 'Order', 'Customer', 'Mobile', 'Garment', 'Reason', 'Note', 'Now', 'Entered By'],
        rows.map((r) => [r.created_at, r.order_number, r.full_name, r.mobile, r.garment_name, r.reason_text, r.note, r.item_status, r.by_name])), 200, 'text/csv; charset=utf-8',
      { 'Content-Disposition': `attachment; filename="customer_returns_${dateFrom}_${dateTo}.csv"` });
    }

    const reasons = await db.query<Row>('SELECT id, reason_name FROM return_reasons ORDER BY sort_order, id');
    // Reason-wise summary for the period.
    const summaryMap = new Map<string, number>();
    for (const r of rows) summaryMap.set(String(r.reason_text), (summaryMap.get(String(r.reason_text)) ?? 0) + 1);
    const summary = [...summaryMap.entries()].sort((x, y) => y[1] - x[1]);
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Customer Returns' }, html`
<div class="col-12">
  <div class="card mb-3"><div class="card-body">
    <form class="row g-2" method="GET">
      <div class="col-md-3"><input type="date" name="date_from" class="form-control form-control-sm" value="${dateFrom}"></div>
      <div class="col-md-3"><input type="date" name="date_to" class="form-control form-control-sm" value="${dateTo}"></div>
      <div class="col-md-3"><select name="reason_id" class="form-select form-select-sm"><option value="0">Saare reasons</option>
        ${reasons.map((rs) => html`<option value="${int(rs.id)}" ${reasonFilter === int(rs.id) ? 'selected' : ''}>${rs.reason_name}</option>`)}</select></div>
      <div class="col-md-1"><button class="btn btn-outline-primary btn-sm w-100">Apply</button></div>
      <div class="col-md-2 text-end"><a class="small" href="?${httpBuildQuery({ ...q, export: 1 })}">Export CSV</a></div>
    </form>
  </div></div>
  <div class="card"><div class="card-body">
    <div class="d-flex justify-content-between mb-2">
      <h6 class="fw-bold mb-0">Customer Returns (${rows.length})</h6>
      <span class="small text-muted">${summary.map(([k, v]) => html`<span class="badge bg-light text-dark border me-1">${k}: ${v}</span>`)}</span>
    </div>
    <div class="table-responsive udc-cards-wrap">
      <table class="udc-cards table table-hover table-sm align-middle">
        <thead><tr><th>Date</th><th>Order</th><th>Customer</th><th>Garment</th><th>Reason</th><th>Note</th><th>Photo</th><th>Ab kahan</th><th>By</th></tr></thead>
        <tbody>
        ${!rows.length ? html`<tr><td colspan="9" class="text-center text-muted py-4">Is period mein koi return nahi.</td></tr>` : ''}
        ${rows.map((r) => { const ph = r.file_path ? u('uploads/order_photos/' + r.file_path) : null; return html`
          <tr>
            <td data-label="Date">${raw(ctx.datetime(r.created_at))}</td>
            <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + int(r.order_id))}">${r.order_number}</a></td>
            <td data-label="Customer">${r.full_name}<div class="small text-muted">${r.mobile}</div></td>
            <td data-label="Garment">${r.garment_name}</td>
            <td data-label="Reason">${r.reason_text}</td>
            <td class="small" data-label="Note">${String(r.note ?? '')}</td>
            <td data-label="Photo">${ph ? html`<a href="${ph}" target="_blank"><img src="${ph}" alt="" loading="lazy" style="width:40px;height:40px;object-fit:cover;border-radius:6px;"></a>` : raw('&mdash;')}</td>
            <td data-label="Ab kahan"><span class="badge bg-${r.item_status === 'Rework' ? 'danger' : (r.item_status === 'Delivered' ? 'success' : 'info text-dark')}">${r.item_status}</span>${r.rework_status ? html`<div class="small text-muted">Rework: ${r.rework_status}</div>` : ''}</td>
            <td class="small" data-label="By">${String(r.by_name ?? '')}</td>
          </tr>`; })}
        </tbody>
      </table>
    </div>
  </div></div>
</div>
`);
  });

  // ---- modules/master_data/return_reasons.php --------------------------------------------------
  webPage(app, '/modules/master_data/return_reasons', { auth: 'master.manage', methods: ['GET', 'POST'] }, async (ctx, req) => {
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const b = body(ctx);
      const action = clean(b.action);
      const id = int(b.id);
      const name = clean(b.reason_name);
      const sort = int(b.sort_order);
      if (action === 'add' || action === 'edit') {
        if (name === '' || Array.from(name).length > 120) {
          ctx.flashSet('danger', 'Reason ka naam zaroori hai (max 120 akshar).');
        } else if (action === 'add') {
          await db.execute('INSERT INTO return_reasons (reason_name, sort_order) VALUES (?,?)', [name, sort]);
          ctx.flashSet('success', 'Reason add ho gaya.');
        } else {
          await db.execute('UPDATE return_reasons SET reason_name = ?, sort_order = ? WHERE id = ?', [name, sort, id]);
          ctx.flashSet('success', 'Reason update ho gaya.');
        }
      } else if (action === 'toggle') {
        await db.execute('UPDATE return_reasons SET is_active = 1 - is_active WHERE id = ?', [id]);
      } else if (action === 'delete') {
        // Past returns keep their text (customer_returns.reason_text); only the link is cleared.
        await db.execute('DELETE FROM return_reasons WHERE id = ?', [id]);
        ctx.flashSet('success', 'Reason delete ho gaya (purane returns mein text bacha rahega).');
      }
      return new WebRedirect('modules/master_data/return_reasons.php');
    }
    const rows = await db.query<Row>('SELECT r.*, (SELECT COUNT(*) FROM customer_returns c WHERE c.reason_id = r.id) AS used FROM return_reasons r ORDER BY sort_order, id');
    return layout(ctx, { title: 'Return Reasons' }, html`
<div class="col-12">
  <div class="card"><div class="card-body">
    <p class="text-muted small">Customer return ke time ye reasons dropdown mein aate hain (web aur app dono). Inactive reason dropdown mein nahi dikhta.</p>
    <form method="POST" class="row g-2 mb-3">
      ${ctx.csrfField()}<input type="hidden" name="action" value="add">
      <div class="col-md-6"><input type="text" name="reason_name" class="form-control" placeholder="Naya reason (jaise: Button toota)" maxlength="120" required></div>
      <div class="col-md-2"><input type="number" name="sort_order" class="form-control" placeholder="Order" value="0"></div>
      <div class="col-md-2"><button class="btn btn-primary w-100"><i class="fa-solid fa-plus me-1"></i>Add</button></div>
    </form>
    <div class="table-responsive udc-cards-wrap">
      <table class="udc-cards table table-hover align-middle">
        <thead><tr><th>Reason</th><th style="width:110px">Sort</th><th>Used</th><th>Status</th><th class="text-end">Actions</th></tr></thead>
        <tbody>
        ${rows.map((r) => html`
          <tr>
            <form method="POST" id="f${int(r.id)}">${ctx.csrfField()}<input type="hidden" name="id" value="${int(r.id)}"><input type="hidden" name="action" value="edit"></form>
            <td data-label="Reason"><input form="f${int(r.id)}" type="text" name="reason_name" class="form-control form-control-sm" value="${r.reason_name}" maxlength="120"></td>
            <td data-label="Sort"><input form="f${int(r.id)}" type="number" name="sort_order" class="form-control form-control-sm" value="${int(r.sort_order)}"></td>
            <td data-label="Used">${int(r.used)}</td>
            <td data-label="Status">${Number(r.is_active) ? raw('<span class="badge bg-success">Active</span>') : raw('<span class="badge bg-secondary">Inactive</span>')}</td>
            <td class="text-end text-nowrap" data-label="Actions">
              <button form="f${int(r.id)}" class="btn btn-sm btn-outline-primary" title="Save"><i class="fa-solid fa-floppy-disk"></i></button>
              <form method="POST" class="d-inline">${ctx.csrfField()}<input type="hidden" name="id" value="${int(r.id)}"><input type="hidden" name="action" value="toggle"><button class="btn btn-sm btn-outline-secondary" title="Activate/Deactivate"><i class="fa-solid fa-power-off"></i></button></form>
              <form method="POST" class="d-inline" onsubmit="return confirm('Ye reason delete karein?');">${ctx.csrfField()}<input type="hidden" name="id" value="${int(r.id)}"><input type="hidden" name="action" value="delete"><button class="btn btn-sm btn-outline-danger" title="Delete"><i class="fa-solid fa-trash"></i></button></form>
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div></div>
</div>
`);
  });
}
