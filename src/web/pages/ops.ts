import type { FastifyInstance } from 'fastify';
import { phpEmpty } from '../../lib/php.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { httpBuildQuery, int } from '../format.js';
import { html, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { pager } from './payments.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const orDash = (v: unknown) => { const s = String(v ?? ''); return s === '' || s === '0' ? '—' : s; };
const urgentBadge = (name: unknown) => (name ? html`<span class="badge bg-danger">${String(name)}</span>` : '—');
const flash = (ctx: WebCtx, r: { success: boolean; errors?: string[] }, ok: string) => ctx.flashSet(r.success ? 'success' : 'danger', r.success ? ok : (r.errors ?? []).join(' '));

export function registerOpsPages(app: FastifyInstance) {
  const { db, qc, laundry, fulfillment, whatsapp } = app.services;
  const dueCell = (ctx: WebCtx, date: unknown, time: unknown) => raw(ctx.date(date) + (!phpEmpty(time) ? ' ' + ctx.date(time, 'h:i A') : ''));
  const actor = (ctx: WebCtx) => ({ userId: ctx.data.user_id!, ip: ctx.req.ip });
  const redirectTo = (page: string, qs: unknown) => new WebRedirect(page + (!phpEmpty(qs) ? '?' + String(qs) : ''));

  // ---- QC dashboard ----------------------------------------------------------------------------
  webPage(app, '/modules/qc/index', { auth: 'qc.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    if (req.method === 'POST') {
      const p = body(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      const action = clean(p.action);
      const garmentType = 'garment_type' in p ? clean(p.garment_type) : 'piece';
      const orderItemId = int(p.order_item_id), laundryId = int(p.laundry_garment_id);
      const a = actor(ctx);
      if (garmentType === 'laundry') {
        if (action === 'pass') flash(ctx, await qc.recordLaundryQc(laundryId, a, 'Passed', null, clean(p.remarks)), 'QC Passed for this garment.');
        else if (action === 'fail') flash(ctx, await qc.recordLaundryQc(laundryId, a, 'Rework', clean(p.reason), clean(p.remarks)), 'QC Failed for this garment — moved to Rework.');
      } else if (action === 'pass') flash(ctx, await qc.passQc(orderItemId, a, clean(p.remarks)), 'QC Passed — item is now Ready for packing.');
      else if (action === 'fail') flash(ctx, await qc.failQc(orderItemId, a, clean(p.reason), clean(p.remarks)), 'QC Failed — item moved to Rework.');
      return redirectTo('modules/qc/index.php', p.redirect_qs);
    }
    const statusFilter = clean(q.status), orderSearch = clean(q.order), customerSearch = clean(q.customer), garmentSearch = clean(q.garment), dueDate = clean(q.due_date);
    const urgentOnly = 'urgent_only' in q;
    const page = Math.max(1, int(q.page) || 1), perPage = 25, offset = (page - 1) * perPage;
    let where = "oi.item_status IN ('QC','Rework') AND os.status_key != 'cancelled'";
    const params: unknown[] = [];
    if (statusFilter !== '') { where += ' AND oi.item_status = ?'; params.push(statusFilter); }
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    if (garmentSearch !== '') { where += ' AND g.garment_name LIKE ?'; params.push(`%${garmentSearch}%`); }
    if (dueDate !== '') { where += ' AND o.due_date = ?'; params.push(dueDate); }
    if (urgentOnly) where += ' AND o.urgent_level_id IS NOT NULL';
    const baseSql = `FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id
      JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id WHERE ${where}`;
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n ${baseSql}`, params))[0]!.n);
    const rows = await db.query<Row>(
      `SELECT oi.id, oi.order_id, oi.item_status, oi.quantity, oi.weight, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time, c.full_name AS customer_name, g.garment_name, s.service_name, s.billing_unit, ul.level_name AS urgent_level_name
       ${baseSql} ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id LIMIT ${perPage} OFFSET ${offset}`, params);
    const totalPages = Math.ceil(total / perPage);
    const qsForRedirect = httpBuildQuery(q);
    const lgPending = await laundry.listByStatus(['QC']);
    const lgRework = await laundry.listByStatus(['Rework']);
    const lgAll = [...lgPending, ...lgRework];
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Quality Check Dashboard' }, html`

<div class="col-12">
  <div class="card">
    <div class="card-body">
      <form class="row g-2 mb-3" method="GET">
        <div class="col-md-2"><input type="text" name="order" class="form-control form-control-sm" value="${orderSearch}" placeholder="Order Number"></div>
        <div class="col-md-2"><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}" placeholder="Customer"></div>
        <div class="col-md-2"><input type="text" name="garment" class="form-control form-control-sm" value="${garmentSearch}" placeholder="Garment"></div>
        <div class="col-md-2">
          <select name="status" class="form-select form-select-sm">
            <option value="">All Statuses</option>
            <option value="QC" ${sel(statusFilter === 'QC')}>QC Pending</option>
            <option value="Rework" ${sel(statusFilter === 'Rework')}>In Rework</option>
          </select>
        </div>
        <div class="col-md-2"><input type="date" name="due_date" class="form-control form-control-sm" value="${dueDate}"></div>
        <div class="col-md-2 form-check d-flex align-items-center">
          <input class="form-check-input me-1" type="checkbox" name="urgent_only" id="urgentOnly" value="1" ${urgentOnly ? 'checked' : ''}>
          <label class="form-check-label small" for="urgentOnly">Urgent only</label>
        </div>
        <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100"><i class="fa-solid fa-filter me-1"></i>Filter</button></div>
      </form>

      <div class="table-responsive udc-cards-wrap">
        <table class="udc-cards table table-hover table-sm">
          <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Service</th><th>Qty/Weight</th><th>Billing Unit</th><th>Status</th><th>Due</th><th>Urgent</th><th>QC Actions</th></tr></thead>
          <tbody>
          ${rows.length === 0 ? html`<tr><td colspan="10" class="text-center text-muted py-4">No items found.</td></tr>` : ''}
          ${rows.map((r) => html`
            <tr>
              <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
              <td data-label="Customer">${r.customer_name}</td>
              <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?item_id=' + r.id)}">${r.garment_name}</a></td>
              <td data-label="Service">${r.service_name}</td>
              <td data-label="Qty/Weight">${r.weight !== null ? String(r.weight) : String(r.quantity)}</td>
              <td data-label="Billing Unit">${r.billing_unit === 'weight' ? 'KG' : 'Pcs'}</td>
              <td data-label="Status"><span class="badge bg-${r.item_status === 'Rework' ? 'danger' : 'warning text-dark'}">${r.item_status}</span></td>
              <td data-label="Due">${dueCell(ctx, r.due_date, r.due_time)}</td>
              <td data-label="Urgent">${urgentBadge(r.urgent_level_name)}</td>
              <td class="text-nowrap" data-label="QC Actions">
                ${r.item_status === 'QC' ? html`
                  <form method="POST" class="d-inline">
                    ${ctx.csrfField()}
                    <input type="hidden" name="action" value="pass">
                    <input type="hidden" name="order_item_id" value="${r.id}">
                    <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                    <button type="submit" class="btn btn-sm btn-outline-success">Pass</button>
                  </form>
                  <button type="button" class="btn btn-sm btn-outline-danger" data-bs-toggle="modal" data-bs-target="#failModal" data-item-id="${r.id}" data-garment="${r.garment_name}">Fail</button>` : html`
                  <span class="text-muted small">In rework queue</span>`}
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>

      ${pager(q, page, totalPages)}

      <hr class="my-4">
      <h6 class="fw-bold">Laundry Garments</h6>
      ${lgPending.length === 0 && lgRework.length === 0 ? html`
        <p class="text-muted small">No Laundry garments currently pending QC or in rework.</p>` : html`
      <div class="table-responsive udc-cards-wrap">
        <table class="udc-cards table table-hover table-sm">
          <thead><tr><th>Order</th><th>Customer</th><th>Sequence</th><th>Garment</th><th>Service</th><th>Due</th><th>Status</th><th>QC Actions</th></tr></thead>
          <tbody>
          ${lgAll.map((lg) => html`
            <tr>
              <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + lg.order_id)}">${lg.short_order_code ?? lg.order_number}</a></td>
              <td data-label="Customer">${lg.customer_name}</td>
              <td data-label="Sequence">${int(lg.sequence)} / ${int(lg.total_garments)}</td>
              <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?laundry_garment_id=' + lg.id)}">${lg.garment_name}</a></td>
              <td data-label="Service">${lg.service_name}</td>
              <td data-label="Due">${raw(ctx.date(lg.due_date))}</td>
              <td data-label="Status"><span class="badge bg-${lg.status === 'Rework' ? 'danger' : 'warning text-dark'}">${lg.status}</span></td>
              <td class="text-nowrap" data-label="QC Actions">
                ${lg.status === 'QC' ? html`
                  <form method="POST" class="d-inline">
                    ${ctx.csrfField()}
                    <input type="hidden" name="action" value="pass">
                    <input type="hidden" name="garment_type" value="laundry">
                    <input type="hidden" name="laundry_garment_id" value="${lg.id}">
                    <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                    <button type="submit" class="btn btn-sm btn-outline-success">Pass</button>
                  </form>
                  <button type="button" class="btn btn-sm btn-outline-danger" data-bs-toggle="modal" data-bs-target="#failModal" data-item-id="${lg.id}" data-garment-type="laundry" data-garment="${lg.garment_name + ' (' + int(lg.sequence) + '/' + int(lg.total_garments) + ')'}">Fail</button>` : html`
                  <span class="text-muted small">In rework queue</span>`}
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>
</div>

<!-- FAIL / REWORK MODAL — shared by both piece and Laundry rows; garment_type/hidden id fields
     are set by the JS handler below depending on which "Fail" button was clicked. -->
<div class="modal fade" id="failModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <form method="POST">
        ${ctx.csrfField()}
        <input type="hidden" name="action" value="fail">
        <input type="hidden" name="garment_type" id="failGarmentType" value="piece">
        <input type="hidden" name="order_item_id" id="failItemId">
        <input type="hidden" name="laundry_garment_id" id="failLaundryGarmentId">
        <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
        <div class="modal-header"><h5 class="modal-title">Fail QC — <span id="failGarmentName"></span></h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body">
          <label class="form-label small">Rework Reason *</label>
          <textarea name="reason" class="form-control" rows="2" required></textarea>
          <label class="form-label small mt-2">Additional Remarks</label>
          <textarea name="remarks" class="form-control" rows="2"></textarea>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="submit" class="btn btn-danger">Send to Rework</button>
        </div>
      </form>
    </div>
  </div>
</div>
${raw(`<script>
document.getElementById('failModal').addEventListener('show.bs.modal', function (e) {
  const btn = e.relatedTarget;
  const type = btn.getAttribute('data-garment-type') || 'piece';
  document.getElementById('failGarmentType').value = type;
  document.getElementById('failItemId').value = type === 'piece' ? btn.getAttribute('data-item-id') : '';
  document.getElementById('failLaundryGarmentId').value = type === 'laundry' ? btn.getAttribute('data-item-id') : '';
  document.getElementById('failGarmentName').textContent = btn.getAttribute('data-garment');
});
</script>`)}
`);
  });

  // ---- Rework queue ----------------------------------------------------------------------------
  webPage(app, '/modules/qc/rework', { auth: 'rework.manage' }, async (ctx, req) => {
    if (req.method === 'POST') {
      const p = body(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      const action = clean(p.action), id = int(p.rework_id);
      if (action === 'start') flash(ctx, await qc.startRework(id, actor(ctx)), 'Rework started.');
      else if (action === 'complete') flash(ctx, await qc.completeRework(id, actor(ctx)), 'Rework completed — returned to QC Pending.');
      return new WebRedirect('modules/qc/rework.php');
    }
    const rows = await db.query<Row>(
      `SELECT rr.id AS rework_id, rr.reason, rr.status AS rework_status, rr.created_at, oi.id AS order_item_id, oi.quantity, oi.weight, o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time,
       c.full_name AS customer_name, g.garment_name, s.service_name, s.billing_unit, ul.level_name AS urgent_level_name
       FROM rework_records rr JOIN order_items oi ON oi.id = rr.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
       JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       WHERE oi.item_status = 'Rework' AND rr.status != 'Completed' ORDER BY (o.urgent_level_id IS NULL), o.due_date, rr.id`);
    const laundryRows = await db.query<Row>(
      `SELECT rr.id AS rework_id, rr.reason, rr.status AS rework_status, rr.created_at, lg.id AS laundry_garment_id, lg.sequence, oi.quantity AS total_garments, o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time,
       c.full_name AS customer_name, g.garment_name, s.service_name
       FROM rework_records rr JOIN laundry_garments lg ON lg.id = rr.laundry_garment_id JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id
       WHERE rr.status != 'Completed' ORDER BY o.due_date, rr.id`);
    const u = (p: string) => ctx.baseUrl(p);
    const actions = (r: Row) => r.rework_status === 'Pending' ? html`
                  <form method="POST" class="d-inline">
                    ${ctx.csrfField()}
                    <input type="hidden" name="action" value="start">
                    <input type="hidden" name="rework_id" value="${r.rework_id}">
                    <button type="submit" class="btn btn-sm btn-outline-primary">Start Rework</button>
                  </form>` : r.rework_status === 'In Progress' ? html`
                  <form method="POST" class="d-inline">
                    ${ctx.csrfField()}
                    <input type="hidden" name="action" value="complete">
                    <input type="hidden" name="rework_id" value="${r.rework_id}">
                    <button type="submit" class="btn btn-sm btn-outline-success">Complete Rework</button>
                  </form>` : '';
    return layout(ctx, { title: 'Rework Queue' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold mb-3">Rework Queue</h6>
      <div class="table-responsive udc-cards-wrap">
        <table class="udc-cards table table-hover table-sm">
          <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Original Service</th><th>Rework Reason</th><th>Qty/Weight</th><th>Unit</th><th>Status</th><th>Due</th><th>Urgent</th><th>Actions</th></tr></thead>
          <tbody>
          ${rows.length === 0 ? html`<tr><td colspan="11" class="text-center text-muted py-4">No items currently in rework.</td></tr>` : ''}
          ${rows.map((r) => html`
            <tr>
              <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
              <td data-label="Customer">${r.customer_name}</td>
              <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?item_id=' + r.order_item_id)}">${r.garment_name}</a></td>
              <td data-label="Original Service">${r.service_name}</td>
              <td class="small" data-label="Rework Reason">${String(r.reason ?? '')}</td>
              <td data-label="Qty/Weight">${r.weight !== null ? String(r.weight) : String(r.quantity)}</td>
              <td data-label="Unit">${r.billing_unit === 'weight' ? 'KG' : 'Pcs'}</td>
              <td data-label="Status"><span class="badge bg-${r.rework_status === 'In Progress' ? 'warning text-dark' : 'secondary'}">${r.rework_status}</span></td>
              <td data-label="Due">${dueCell(ctx, r.due_date, r.due_time)}</td>
              <td data-label="Urgent">${urgentBadge(r.urgent_level_name)}</td>
              <td class="text-nowrap" data-label="Actions">
                ${actions(r)}
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>

      <hr class="my-4">
      <h6 class="fw-bold">Laundry Rework Queue</h6>
      ${laundryRows.length === 0 ? html`
        <p class="text-muted small">No Laundry garments currently in rework.</p>` : html`
      <div class="table-responsive udc-cards-wrap">
        <table class="udc-cards table table-hover table-sm">
          <thead><tr><th>Order</th><th>Customer</th><th>Sequence</th><th>Garment</th><th>Service</th><th>Reason</th><th>Status</th><th>Due</th><th>Actions</th></tr></thead>
          <tbody>
          ${laundryRows.map((r) => html`
            <tr>
              <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
              <td data-label="Customer">${r.customer_name}</td>
              <td data-label="Sequence">${int(r.sequence)} / ${int(r.total_garments)}</td>
              <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?laundry_garment_id=' + r.laundry_garment_id)}">${r.garment_name}</a></td>
              <td data-label="Service">${r.service_name}</td>
              <td class="small" data-label="Reason">${String(r.reason ?? '')}</td>
              <td data-label="Status"><span class="badge bg-${r.rework_status === 'In Progress' ? 'warning text-dark' : 'secondary'}">${r.rework_status}</span></td>
              <td data-label="Due">${raw(ctx.date(r.due_date))}</td>
              <td class="text-nowrap" data-label="Actions">
                ${actions(r)}
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>
</div>
`);
  });

  // ---- Packing queue ---------------------------------------------------------------------------
  webPage(app, '/modules/packing/index', { auth: 'packing.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    if (req.method === 'POST') {
      const p = body(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      flash(ctx, await qc.markPacked(int(p.order_item_id), actor(ctx)), 'Marked as Packed.');
      return redirectTo('modules/packing/index.php', p.redirect_qs);
    }
    const orderSearch = clean(q.order), customerSearch = clean(q.customer);
    let where = "oi.item_status = 'Ready' AND os.status_key != 'cancelled'";
    const params: unknown[] = [];
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    const rows = await db.query<Row>(
      `SELECT oi.id, oi.order_id, oi.quantity, oi.weight, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time, c.full_name AS customer_name, g.garment_name, s.billing_unit, ul.level_name AS urgent_level_name, bc.barcode_value, bc.qr_token
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = oi.garment_id
       JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id LEFT JOIN barcodes bc ON bc.order_item_id = oi.id
       WHERE ${where} ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id`, params);
    const grouped = new Map<number, { order_number: string; customer_name: string; items: Row[] }>();
    for (const r of rows) {
      const g = grouped.get(Number(r.order_id)) ?? grouped.set(Number(r.order_id), { order_number: r.order_number, customer_name: r.customer_name, items: [] }).get(Number(r.order_id))!;
      g.items.push(r);
    }
    const batches = await db.query<Row>(
      `SELECT oi.id, oi.order_id, oi.quantity AS total_garments, oi.weight, oi.weight_rate, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time, c.full_name AS customer_name, s.service_name, ul.level_name AS urgent_level_name
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id JOIN services s ON s.id = oi.service_id
       LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       WHERE oi.item_status = 'Ready' AND o.order_mode = 'weight' AND os.status_key != 'cancelled' ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id`);
    const qsForRedirect = httpBuildQuery(q);
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Packing Queue' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      <form class="row g-2 mb-3" method="GET">
        <div class="col-md-3"><input type="text" name="order" class="form-control form-control-sm" value="${orderSearch}" placeholder="Order Number"></div>
        <div class="col-md-3"><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}" placeholder="Customer"></div>
        <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100"><i class="fa-solid fa-filter me-1"></i>Filter</button></div>
      </form>

      ${grouped.size === 0 ? html`
        <p class="text-muted text-center py-4">No items are currently QC-passed and ready for packing.</p>` : ''}

      ${[...grouped].map(([orderId, group]) => html`
        <div class="mb-4">
          <h6 class="fw-bold mb-2">
            <a href="${u('modules/orders/view.php?id=' + orderId)}">${group.order_number}</a>
            — ${group.customer_name}
            <span class="badge bg-secondary">${group.items.length} item(s) ready</span>
          </h6>
          <table class="udc-cards table table-sm">
            <thead><tr><th>Garment</th><th>Qty/Weight</th><th>Unit</th><th>Due</th><th>Urgent</th><th>Barcode</th><th>Action</th></tr></thead>
            <tbody>
            ${group.items.map((it) => html`
              <tr>
                <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?item_id=' + it.id)}">${it.garment_name}</a></td>
                <td data-label="Qty/Weight">${it.weight !== null ? String(it.weight) : String(it.quantity)}</td>
                <td data-label="Unit">${it.billing_unit === 'weight' ? 'KG' : 'Pcs'}</td>
                <td data-label="Due">${dueCell(ctx, it.due_date, it.due_time)}</td>
                <td data-label="Urgent">${urgentBadge(it.urgent_level_name)}</td>
                <td data-label="Barcode"><code class="small">${orDash(it.barcode_value)}</code></td>
                <td data-label="Action">
                  <form method="POST" class="d-inline">
                    ${ctx.csrfField()}
                    <input type="hidden" name="order_item_id" value="${it.id}">
                    <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                    <button type="submit" class="btn btn-sm btn-success">Mark Packed</button>
                  </form>
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>`)}

      <hr class="my-4">
      <h6 class="fw-bold">Laundry Batches — Ready for Packing</h6>
      <p class="text-muted small">A batch appears here only once <strong>every</strong> physical garment in it has individually passed QC — never based on just one garment.</p>
      ${batches.length === 0 ? html`
        <p class="text-muted small">No Laundry batches are currently fully ready for packing.</p>` : batches.map((b) => html`
          <div class="mb-4">
            <h6 class="fw-bold mb-2">
              <a href="${u('modules/orders/view.php?id=' + b.order_id)}">${b.order_number}</a>
              — ${b.customer_name}
              <span class="badge bg-secondary">${int(b.total_garments)} garment(s), all QC-passed</span>
            </h6>
            <table class="udc-cards table table-sm">
              <thead><tr><th>Service</th><th>Weight</th><th>Rate/KG</th><th>Due</th><th>Urgent</th><th>Action</th></tr></thead>
              <tbody>
                <tr>
                  <td data-label="Service">${b.service_name}</td>
                  <td data-label="Weight">${String(b.weight ?? '')} KG</td>
                  <td data-label="Rate/KG">${raw(money(b.weight_rate))}</td>
                  <td data-label="Due">${dueCell(ctx, b.due_date, b.due_time)}</td>
                  <td data-label="Urgent">${urgentBadge(b.urgent_level_name)}</td>
                  <td data-label="Action">
                    <form method="POST" class="d-inline">
                      ${ctx.csrfField()}
                      <input type="hidden" name="order_item_id" value="${b.id}">
                      <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                      <button type="submit" class="btn btn-sm btn-success">Mark Batch Packed</button>
                    </form>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>`)}
    </div>
  </div>
</div>
`);
  });

  // ---- Home pickup -----------------------------------------------------------------------------
  webPage(app, '/modules/pickup/index', { auth: 'pickup.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    if (req.method === 'POST') {
      const p = body(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      const action = clean(p.action);
      const a = actor(ctx);
      if (action === 'create') {
        const orderId = int(p.order_id);
        const r = await fulfillment.createPickup(orderId, 'pickup_date' in p ? clean(p.pickup_date) : ctx.today, clean(p.pickup_time), clean(p.notes), a);
        flash(ctx, r, 'Pickup scheduled.');
        if (r.success) {
          try {
            const row = (await db.query<Row>('SELECT COALESCE(o.short_order_code, o.order_number) AS order_number, c.id AS customer_id, c.full_name, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]))[0];
            if (row && !phpEmpty(row.mobile)) {
              await whatsapp.enqueue(Number(row.customer_id), orderId, String(row.mobile), 'pickup_scheduled',
                { customer_name: row.full_name, order_number: row.order_number, pickup_date: clean(p.pickup_date), business_name: (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? ctx.svc.env.APP_NAME },
                `pickup_scheduled:${orderId}:${ctx.today}`);
            }
          } catch (ex) { console.error('WhatsApp pickup_scheduled enqueue failed:', (ex as Error).message); }
        }
      } else if (action === 'assign_driver') flash(ctx, await fulfillment.assignPickupDriver(int(p.pickup_id), int(p.driver_id), a), 'Driver assigned.');
      else if (action === 'mark_picked_up') flash(ctx, await fulfillment.markPickedUp(int(p.pickup_id), a), 'Marked as Picked Up.');
      return new WebRedirect('modules/pickup/index.php');
    }
    const orderSearch = clean(q.order), customerSearch = clean(q.customer), statusFilter = clean(q.status);
    let ew = `os.status_key != 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.item_status NOT IN ('Packed','Delivered'))
       AND EXISTS (SELECT 1 FROM order_items oip WHERE oip.order_id = o.id AND oip.item_status = 'Packed')
       AND EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM pickup_orders p WHERE p.order_id = o.id AND p.status NOT IN ('Picked Up','Cancelled','Completed'))
       AND NOT EXISTS (SELECT 1 FROM delivery_orders d WHERE d.order_id = o.id AND d.status NOT IN ('Delivered','Cancelled'))`;
    const ep: unknown[] = [];
    if (orderSearch !== '') { ew += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; ep.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { ew += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; ep.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    const eligible = statusFilter === '' || statusFilter === 'eligible' ? await db.query<Row>(
      `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time, o.grand_total, o.total_paid, o.current_due, c.full_name AS customer_name, c.mobile, ul.level_name AS urgent_level_name,
       (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       WHERE ${ew} ORDER BY (o.urgent_level_id IS NULL), o.due_date`, ep) : [];
    let where = '1=1';
    const params: unknown[] = [];
    if (statusFilter !== '' && statusFilter !== 'eligible') { where += ' AND p.status = ?'; params.push(statusFilter); }
    if (orderSearch !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderSearch}%`, `%${orderSearch}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    const active = await db.query<Row>(
      `SELECT p.*, COALESCE(o.short_order_code, o.order_number) AS order_number, ul.level_name AS urgent_level_name, c.full_name AS customer_name, c.mobile, dr.driver_name
       FROM pickup_orders p LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id JOIN customers c ON c.id = p.customer_id LEFT JOIN drivers dr ON dr.id = p.driver_id
       WHERE ${where} AND p.status NOT IN ('Picked Up','Cancelled','Completed') ORDER BY p.pickup_date`, params);
    const drivers = await db.query<Row>('SELECT id, driver_name FROM drivers WHERE is_active=1 ORDER BY driver_name');
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Home Pickup' }, html`
<div class="col-12">
  <div class="card mb-3">
    <div class="card-body">
      <form class="row g-2" method="GET">
        <div class="col-md-3"><input type="text" name="order" class="form-control form-control-sm" value="${orderSearch}" placeholder="Order Number"></div>
        <div class="col-md-3"><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}" placeholder="Customer/Mobile"></div>
        <div class="col-md-3">
          <select name="status" class="form-select form-select-sm">
            <option value="">All</option>
            <option value="eligible" ${sel(statusFilter === 'eligible')}>Eligible (not yet scheduled)</option>
            <option value="Scheduled" ${sel(statusFilter === 'Scheduled')}>Scheduled</option>
            <option value="Assigned" ${sel(statusFilter === 'Assigned')}>Assigned</option>
          </select>
        </div>
        <div class="col-md-3"><button class="btn btn-outline-primary btn-sm w-100">Filter</button></div>
      </form>
    </div>
  </div>

  ${eligible.length ? html`
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold">Eligible for Pickup (fully packed, not yet scheduled)</h6>
      <table class="udc-cards table table-sm">
        <thead><tr><th>Order</th><th>Customer</th><th>Mobile</th><th>Items</th><th>Total</th><th>Paid</th><th>Due</th><th>Due Date</th><th>Urgent</th><th></th></tr></thead>
        <tbody>
        ${eligible.map((o) => html`
          <tr>
            <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + o.id)}">${o.order_number}</a></td>
            <td data-label="Customer">${o.customer_name}</td>
            <td data-label="Mobile">${o.mobile}</td>
            <td data-label="Items">${int(o.item_count)}</td>
            <td data-label="Total">${raw(money(o.grand_total))}</td>
            <td data-label="Paid">${raw(money(o.total_paid))}</td>
            <td data-label="Due">${raw(money(o.current_due))}</td>
            <td data-label="Due Date">${raw(ctx.date(o.due_date))}</td>
            <td data-label="Urgent">${urgentBadge(o.urgent_level_name)}</td>
            <td data-label="">
              <form method="POST" class="d-flex gap-1">
                ${ctx.csrfField()}
                <input type="hidden" name="action" value="create">
                <input type="hidden" name="order_id" value="${o.id}">
                <input type="date" name="pickup_date" class="form-control form-control-sm" value="${ctx.today}" style="width:130px">
                <button type="submit" class="btn btn-sm btn-primary">Schedule</button>
              </form>
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold">Scheduled / Assigned Pickups</h6>
      <table class="udc-cards table table-sm">
        <thead><tr><th>Pickup #</th><th>Order</th><th>Customer</th><th>Mobile</th><th>Address</th><th>Date</th><th>Status</th><th>Driver</th><th>Urgent</th><th>Actions</th></tr></thead>
        <tbody>
        ${active.length === 0 ? html`<tr><td colspan="10" class="text-center text-muted py-3">No active pickups.</td></tr>` : ''}
        ${active.map((p) => html`
          <tr>
            <td data-label="Pickup #">${p.pickup_number}</td>
            <td data-label="Order">${p.order_number ? html`<a href="${u('modules/orders/view.php?id=' + p.order_id)}">${p.order_number}</a>` : '—'}</td>
            <td data-label="Customer">${p.customer_name}</td>
            <td data-label="Mobile">${p.mobile}</td>
            <td class="small" data-label="Address">${String(p.address ?? '')}</td>
            <td data-label="Date">${raw(ctx.date(p.pickup_date))}</td>
            <td data-label="Status"><span class="badge bg-info text-dark">${p.status}</span></td>
            <td data-label="Driver">${orDash(p.driver_name)}</td>
            <td data-label="Urgent">${urgentBadge(p.urgent_level_name)}</td>
            <td class="text-nowrap" data-label="Actions">
              ${!p.driver_id ? html`
                <form method="POST" class="d-inline">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="assign_driver">
                  <input type="hidden" name="pickup_id" value="${p.id}">
                  <select name="driver_id" class="form-select form-select-sm d-inline" style="width:auto;display:inline-block;">
                    ${drivers.map((d) => html`<option value="${d.id}">${d.driver_name}</option>`)}
                  </select>
                  <button type="submit" class="btn btn-sm btn-outline-primary">Assign</button>
                </form>` : ''}
              <form method="POST" class="d-inline">
                ${ctx.csrfField()}
                <input type="hidden" name="action" value="mark_picked_up">
                <input type="hidden" name="pickup_id" value="${p.id}">
                <button type="submit" class="btn btn-sm btn-outline-success">Picked Up</button>
              </form>
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>
</div>
`);
  });
}
