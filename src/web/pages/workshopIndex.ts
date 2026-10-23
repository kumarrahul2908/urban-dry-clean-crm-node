import type { FastifyInstance } from 'fastify';
import { phpEmpty } from '../../lib/php.js';
import { wsItemBelongs, wsScope } from '../../services/workshopScope.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { formArray, httpBuildQuery, int, numberFormat } from '../format.js';
import { e, html, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { wsIndexScript, wsIndexStyle } from './workshop.static.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const orDash = (v: unknown) => { const s = String(v ?? ''); return s === '' || s === '0' ? '—' : s; };

export function registerWorkshopIndexPage(app: FastifyInstance) {
  const { db, workshop, laundry, hooks } = app.services;

  webPage(app, '/modules/workshop/index', { auth: 'workshop.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const errors: string[] = [];
    const isWorkshopStaff = ctx.data.user?.role_name === 'Workshop Staff';
    const myWs = (await wsScope(db, ctx.data.user_id ?? 0, ctx.data.user?.role_name ?? ''))[1];
    const actor = { userId: ctx.data.user_id!, ip: req.ip };
    const u = (p: string) => ctx.baseUrl(p);
    const redirectIdx = (qs: unknown) => new WebRedirect('modules/workshop/index.php' + (!phpEmpty(qs) ? '?' + String(qs) : ''));

    if (req.method === 'POST') {
      const p = body(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      const action = clean(p.action);
      if ((action === 'create_challan' || action === 'create_laundry_challan') && isWorkshopStaff) {
        return new WebText(`<h2>403 - Access Denied</h2><p>Workshop Staff cannot send garments to a workshop — this is a Store-side action.</p><p><a href="${u('modules/workshop/dashboard.php')}">Back to Workshop Dashboard</a></p>`, 403);
      }
      const wiId = int(p.workshop_item_id);
      if (myWs !== null && ['start_processing', 'complete_processing', 'start_processing_laundry', 'complete_processing_laundry', 'accept', 'return_to_store', 'mark_unprocessed', 'resolve_unprocessed'].includes(action) && !(await wsItemBelongs(db, wiId, myWs))) {
        ctx.flashSet('danger', 'Item not found.');
        return new WebRedirect('modules/workshop/index.php');
      }
      const flash = (r: { success: boolean; errors?: string[] }, ok: string) => ctx.flashSet(r.success ? 'success' : 'danger', r.success ? ok : (r.errors ?? []).join(' '));
      if (action === 'create_challan') {
        const ids = formArray(p, 'item_ids').map((x) => int(x));
        const r = await workshop.createChallan(int(p.workshop_id), ids, clean(p.remarks), actor) as Row;
        if (r.success) { ctx.flashSet('success', `Challan ${r.challan_number} created with ${ids.length} item(s).`); return new WebRedirect('modules/workshop/challan_view.php?id=' + r.challan_id); }
        errors.push(...r.errors);
      } else if (action === 'start_processing') { flash(await workshop.startProcessing(wiId, actor), 'Processing started.'); return redirectIdx(p.redirect_qs); }
      else if (action === 'complete_processing') {
        const r = await workshop.completeProcessing(wiId, actor, clean(p.remarks));
        flash(r, 'Marked as processing completed — ready for QC.');
        if (r.success) await hooks.workshopCompleted(wiId);
        return redirectIdx(p.redirect_qs);
      } else if (action === 'create_laundry_challan') {
        const ids = formArray(p, 'laundry_garment_ids').map((x) => int(x));
        const r = await workshop.createLaundryChallan(int(p.workshop_id), ids, clean(p.remarks), actor) as Row;
        if (r.success) { ctx.flashSet('success', `Laundry challan ${r.challan_number} created with ${ids.length} garment(s).`); return new WebRedirect('modules/workshop/challan_view.php?id=' + r.challan_id); }
        errors.push(...r.errors);
      } else if (action === 'start_processing_laundry' || action === 'complete_processing_laundry') {
        const r = action === 'start_processing_laundry' ? await workshop.startProcessing(wiId, actor) : await workshop.completeProcessing(wiId, actor, clean(p.remarks));
        flash(r, 'Updated.');
        if (r.success && action === 'complete_processing_laundry') await hooks.workshopCompleted(wiId);
        return redirectIdx(p.redirect_qs);
      } else if (action === 'accept' || action === 'return_to_store') {
        const r = action === 'accept' ? await workshop.acceptItem(wiId, actor, clean(p.remarks)) : await workshop.returnToStore(wiId, actor, clean(p.remarks));
        flash(r, action === 'accept' ? 'Item accepted.' : 'Item returned to store.');
        return redirectIdx(p.redirect_qs);
      } else if (action === 'mark_unprocessed') {
        flash(await workshop.markUnprocessed(wiId, actor, clean(p.reason)), 'Item marked Unprocessed. It will not be billed until resolved.');
        return redirectIdx(p.redirect_qs);
      } else if (action === 'resolve_unprocessed') {
        flash(await workshop.resolveUnprocessed(wiId, actor), 'Item resolved — back in the active queue.');
        return redirectIdx(p.redirect_qs);
      }
    }

    const statusFilter = clean(q.status), orderSearch = clean(q.order), customerSearch = clean(q.customer), garmentSearch = clean(q.garment), dueDate = clean(q.due_date);
    const urgentOnly = 'urgent_only' in q;
    const page = Math.max(1, int(q.page) || 1), perPage = 25, offset = (page - 1) * perPage;
    let where = "oi.item_status IN ('Pending','Workshop','Processing') AND os.status_key != 'cancelled'";
    const params: unknown[] = [];
    if (myWs !== null) { where += ' AND wc.workshop_id = ?'; params.push(myWs); }
    if (statusFilter !== '') { where += ' AND oi.item_status = ?'; params.push(statusFilter); }
    if (orderSearch !== '') { where += ' AND o.order_number LIKE ?'; params.push(`%${orderSearch}%`); }
    if (customerSearch !== '') {
      if (myWs !== null) { where += ' AND c.full_name LIKE ?'; params.push(`%${customerSearch}%`); }
      else { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    }
    if (garmentSearch !== '') { where += ' AND g.garment_name LIKE ?'; params.push(`%${garmentSearch}%`); }
    if (dueDate !== '') { where += ' AND o.due_date = ?'; params.push(dueDate); }
    if (urgentOnly) where += ' AND o.urgent_level_id IS NOT NULL';
    const baseSql = `FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = oi.garment_id
      JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id LEFT JOIN workshop_items wi ON wi.order_item_id = oi.id AND wi.status NOT IN ('Completed','Rejected')
      LEFT JOIN workshop_challans wc ON wc.id = wi.challan_id WHERE ${where}`;
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n ${baseSql}`, params))[0]!.n);
    const rows = await db.query<Row>(
      `SELECT oi.id, oi.order_id, oi.item_status, oi.quantity, oi.weight, oi.unit, o.order_number, o.due_date, o.due_time, c.full_name AS customer_name, g.garment_name, s.service_name, s.billing_unit,
       ul.level_name AS urgent_level_name, wi.id AS workshop_item_id, wi.status AS workshop_status, wc.challan_number
       ${baseSql} ORDER BY (o.urgent_level_id IS NULL), o.due_date, oi.id LIMIT ${perPage} OFFSET ${offset}`, params);
    const totalPages = Math.ceil(total / perPage);
    const workshops = await db.query<Row>('SELECT id, workshop_name FROM workshops WHERE is_active=1 ORDER BY workshop_name');
    const qsForRedirect = httpBuildQuery(q);

    const laundryPending = myWs !== null ? [] : await laundry.listByStatus(['Pending']);
    let laundryInProgress = await laundry.listByStatus(['Workshop', 'Processing']);
    if (laundryInProgress.length) {
      const ids = laundryInProgress.map((l) => Number(l.id));
      const wis = await db.query<Row>(`SELECT wi.laundry_garment_id, wi.id, wi.status, wc.workshop_id FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id WHERE wi.laundry_garment_id IN (${ids.map(() => '?').join(',')}) AND wi.status NOT IN ('Completed','Rejected')`, ids);
      const byLg = new Map<number, Row>();
      for (const wi of wis) byLg.set(Number(wi.laundry_garment_id), wi);
      for (const l of laundryInProgress) l.workshop_item = byLg.get(Number(l.id)) ?? null;
      if (myWs !== null) laundryInProgress = laundryInProgress.filter((l) => !!l.workshop_item && Number(l.workshop_item.workshop_id) === myWs);
    }

    const cols = `COALESCE(g1.garment_name, g2.garment_name) AS garment_name, COALESCE(o1.order_number, o2.order_number) AS order_number, COALESCE(o1.id, o2.id) AS order_id, COALESCE(c1.full_name, c2.full_name) AS customer_name`;
    const joins = `FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id LEFT JOIN orders o2 ON o2.id = oi2.order_id LEFT JOIN customers c2 ON c2.id = o2.customer_id`;
    const cand = await db.query<Row>(`SELECT wi.id, wi.order_item_id, wi.laundry_garment_id, wi.status AS raw_status, wi.remarks, ${cols} ${joins} WHERE wi.status IN ('Received', 'Completed')${myWs !== null ? ' AND wc.workshop_id = ?' : ''} ORDER BY wi.id DESC LIMIT 200`, myWs !== null ? [myWs] : []);
    const acceptQueue: Row[] = [], returnQueue: Row[] = [];
    for (const row of cand) {
      const cur = await workshop.getCurrentStatus(Number(row.id));
      row.current_status = cur;
      if (cur === 'Received') acceptQueue.push(row); else if (cur === 'Completed') returnQueue.push(row);
    }
    const upAll = await db.query<Row>(
      `SELECT DISTINCT wi.id, COALESCE(o1.id, o2.id) AS order_id, COALESCE(o1.order_number, o2.order_number) AS order_number, COALESCE(c1.full_name, c2.full_name) AS customer_name, COALESCE(g1.garment_name, g2.garment_name) AS garment_name,
       h.remarks AS reason, h.changed_at AS marked_at
       FROM garment_status_history h
       JOIN workshop_items wi ON (h.order_item_id IS NOT NULL AND h.order_item_id = wi.order_item_id) OR (h.laundry_garment_id IS NOT NULL AND h.laundry_garment_id = wi.laundry_garment_id)
       JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id LEFT JOIN orders o2 ON o2.id = oi2.order_id LEFT JOIN customers c2 ON c2.id = o2.customer_id
       WHERE h.module = 'workshop' AND h.new_status = 'Unprocessed'${myWs !== null ? ' AND wc.workshop_id = ?' : ''} ORDER BY h.changed_at DESC LIMIT 200`, myWs !== null ? [myWs] : []);
    const unprocessed: Row[] = [];
    for (const r of upAll) if ((await workshop.getCurrentStatus(Number(r.id))) === 'Unprocessed') unprocessed.push(r);

    const wsHasFilters = statusFilter !== '' || orderSearch !== '' || customerSearch !== '' || garmentSearch !== '' || dueDate !== '' || urgentOnly;
    const showingFrom = total ? offset + 1 : 0, showingTo = Math.min(offset + perPage, total);
    const pendingCount = rows.filter((r) => r.item_status === 'Pending').length;
    const dueCell = (date: unknown, time: unknown) => raw(ctx.date(date) + (!phpEmpty(time) ? ' ' + ctx.date(time, 'h:i A') : ''));
    const unprocForm = (id: unknown) => html`
                <form method="POST" class="d-inline" onsubmit="var r=prompt('Reason this garment is unprocessed:'); if(!r){return false;} this.querySelector('[name=reason]').value=r; return true;">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="mark_unprocessed">
                  <input type="hidden" name="workshop_item_id" value="${id}">
                  <input type="hidden" name="reason" value="">
                  <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                  <button type="submit" class="ws-btn ws-btn--xs ws-btn--danger" title="Click to mark this garment unprocessed">Mark Unprocessed</button>
                </form>`;
    const rowActions = (r: Row) => html`
                ${r.item_status === 'Workshop' && r.workshop_item_id ? html`
                  <form method="POST" class="d-inline">
                    ${ctx.csrfField()}
                    <input type="hidden" name="action" value="start_processing">
                    <input type="hidden" name="workshop_item_id" value="${r.workshop_item_id}">
                    <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                    <button type="submit" class="ws-btn ws-btn--xs ws-btn--start">Start</button>
                  </form>` : r.item_status === 'Processing' && r.workshop_item_id ? html`
                  <form method="POST" class="d-inline">
                    ${ctx.csrfField()}
                    <input type="hidden" name="action" value="complete_processing">
                    <input type="hidden" name="workshop_item_id" value="${r.workshop_item_id}">
                    <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                    <button type="submit" class="ws-btn ws-btn--xs ws-btn--done">Complete</button>
                  </form>` : ''}
                ${['Workshop', 'Processing'].includes(r.item_status) && r.workshop_item_id ? unprocForm(r.workshop_item_id) : ''}`;

    let pager: Raw | string = '';
    if (totalPages > 1) {
      const wsStart = Math.max(1, page - 2), wsEnd = Math.min(totalPages, page + 2);
      const url = (n: number) => '?' + httpBuildQuery({ ...q, page: n });
      const nums: Raw[] = [];
      for (let i = wsStart; i <= wsEnd; i++) nums.push(html`
      <li><a class="${i === page ? 'is-active' : ''}" href="${url(i)}">${i}</a></li>`);
      pager = html`
<div class="col-12">
  <nav class="ws-pager">
    <div class="ws-pager-info">Showing ${numberFormat(showingFrom, 0)}–${numberFormat(showingTo, 0)} of ${numberFormat(total, 0)}</div>
    <ul class="ws-pages">
      ${page > 1 ? html`
        <li><a href="${url(1)}" aria-label="First page"><i class="fa-solid fa-angles-left"></i></a></li>
        <li><a href="${url(page - 1)}" aria-label="Previous page"><i class="fa-solid fa-angle-left"></i></a></li>` : ''}
      ${wsStart > 1 ? html`<li class="ws-gap">…</li>` : ''}
      ${nums}
      ${wsEnd < totalPages ? html`<li class="ws-gap">…</li>` : ''}
      ${page < totalPages ? html`
        <li><a href="${url(page + 1)}" aria-label="Next page"><i class="fa-solid fa-angle-right"></i></a></li>
        <li><a href="${url(totalPages)}" aria-label="Last page"><i class="fa-solid fa-angles-right"></i></a></li>` : ''}
    </ul>
  </nav>
</div>`;
    }

    const workshopOptions = workshops.map((w) => html`<option value="${w.id}">${w.workshop_name}</option>`);
    const procRows = rows.filter((r) => r.item_status !== 'Pending');
    const mainBlock = isWorkshopStaff ? html`
<div class="col-12">
  <div class="ws-note"><i class="fa-solid fa-circle-info"></i>Sending garments to a workshop is a Store-side action. Your Incoming/Accept, Processing, and Return queues are below.</div>
</div>

<div class="col-12">
  <div class="card ws-card">
    <div class="card-body">
      <h6 class="ws-sec"><i class="fa-solid fa-gears"></i>Processing<span class="ws-count">${procRows.length}</span></h6>
      ${procRows.length === 0 ? html`
        <p class="ws-empty-line">Nothing sent to you is waiting to start or finish processing right now.</p>` : html`
      <div class="table-responsive udc-cards-wrap">
        <table class="table table-hover table-sm udc-cards ws-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Status</th><th>Due</th><th></th></tr></thead>
          <tbody>
          ${procRows.map((r) => html`
            <tr>
              <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
              <td class="udc-card-head">${r.customer_name}</td>
              <td data-label="Garment">${r.garment_name}</td>
              <td data-label="Status"><span class="ws-pill ws-pill--${r.item_status === 'Processing' ? 'processing' : 'workshop'}">${r.item_status}</span></td>
              <td data-label="Due">${raw(ctx.date(r.due_date))}</td>
              <td class="text-nowrap" data-label="">
                ${rowActions(r)}
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>
</div>
` : html`
<!-- ===== Filters ===== -->
<div class="col-12">
  <div class="card ws-card">
    <div class="card-body">
      <form class="ws-filters" method="GET">
        <div class="ws-field"><label>Order</label><input type="text" name="order" class="form-control ws-input" value="${orderSearch}" placeholder="Order number"></div>
        <div class="ws-field"><label>Customer</label><input type="text" name="customer" class="form-control ws-input" value="${customerSearch}" placeholder="Name or mobile"></div>
        <div class="ws-field"><label>Garment</label><input type="text" name="garment" class="form-control ws-input" value="${garmentSearch}" placeholder="Garment"></div>
        <div class="ws-field">
          <label>Status</label>
          <select name="status" class="form-select ws-input">
            <option value="">All statuses</option>
            <option value="Pending" ${sel(statusFilter === 'Pending')}>Pending (not sent)</option>
            <option value="Workshop" ${sel(statusFilter === 'Workshop')}>In Workshop (sent)</option>
            <option value="Processing" ${sel(statusFilter === 'Processing')}>Processing</option>
          </select>
        </div>
        <div class="ws-field"><label>Due date</label><input type="date" name="due_date" class="form-control ws-input" value="${dueDate}"></div>
        <label class="ws-check">
          <input type="checkbox" name="urgent_only" id="urgentOnly" value="1" ${urgentOnly ? 'checked' : ''}>
          <span>Urgent only</span>
        </label>
        <button class="ws-btn ws-btn--primary" type="submit"><i class="fa-solid fa-filter"></i>Filter</button>
        ${wsHasFilters ? html`<a href="?" class="ws-btn"><i class="fa-solid fa-xmark"></i>Clear</a>` : ''}
      </form>
    </div>
  </div>
</div>

<!-- ===== Per-piece queue ===== -->
<div class="col-12">
  <div class="card ws-card">
    <div class="card-body">
      <h6 class="ws-sec"><i class="fa-solid fa-shirt"></i>Per-Piece Queue<span class="ws-count">${rows.length}</span></h6>

      <form method="POST" id="challanForm">
        ${ctx.csrfField()}
        <input type="hidden" name="action" value="create_challan">

        <div class="ws-sendbar">
          <div class="ws-sendbar-left">
            <button type="button" class="ws-btn ws-btn--sm" id="selectAllPendingBtn">Select all pending${pendingCount ? ' (' + pendingCount + ')' : ''}</button>
            <button type="button" class="ws-btn ws-btn--sm" id="clearSelectionBtn">Clear</button>
          </div>
          <div class="ws-sendbar-right">
            <select name="workshop_id" class="form-select ws-input ws-input--sm">
              ${workshopOptions}
            </select>
            <input type="text" name="remarks" class="form-control ws-input ws-input--sm" placeholder="Store instruction (optional) — e.g. no bleach">
            <button type="submit" class="ws-btn ws-btn--primary ws-btn--sm"><i class="fa-solid fa-paper-plane"></i>Send to Workshop</button>
          </div>
        </div>

        <div class="table-responsive udc-cards-wrap">
          <table class="table table-hover table-sm udc-cards ws-table">
            <thead><tr><th></th><th>Order</th><th>Customer</th><th>Garment</th><th>Service</th><th class="text-end">Qty/Weight</th><th>Unit</th><th>Status</th><th>Due</th><th>Urgent</th><th>Actions</th></tr></thead>
            <tbody>
            ${rows.length === 0 ? html`<tr><td colspan="11" class="ws-empty"><i class="fa-solid fa-inbox"></i><span>${wsHasFilters ? 'No items match these filters.' : 'Nothing in the queue.'}</span></td></tr>` : ''}
            ${rows.map((r) => html`
              <tr>
                <td data-label="">
                  ${r.item_status === 'Pending' ? html`
                    <input type="checkbox" name="item_ids[]" value="${r.id}" class="row-check ws-check-box">` : ''}
                </td>
                <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
                <td class="udc-card-head">${r.customer_name}</td>
                <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?item_id=' + r.id)}">${r.garment_name}</a></td>
                <td data-label="Service"><span class="ws-chip">${r.service_name}</span></td>
                <td class="text-end" data-label="Qty/Weight">${r.weight !== null ? String(r.weight) : String(r.quantity)}</td>
                <td data-label="Unit">${r.billing_unit === 'weight' ? 'KG' : 'Pcs'}</td>
                <td data-label="Status">
                  <span class="ws-pill ws-pill--${r.item_status === 'Pending' ? 'pending' : (r.item_status === 'Processing' ? 'processing' : 'workshop')}">${r.item_status}</span>
                  ${r.challan_number ? html`<div class="ws-challan">${r.challan_number}</div>` : ''}
                </td>
                <td data-label="Due">${dueCell(r.due_date, r.due_time)}</td>
                <td data-label="Urgent">${r.urgent_level_name ? html`<span class="ws-pill ws-pill--urgent">${r.urgent_level_name}</span>` : '—'}</td>
                <td class="text-nowrap" data-label="Actions">
                  ${rowActions(r)}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
      </form>
    </div>
  </div>
</div>

<!-- ===== Laundry garments ===== -->
<div class="col-12">
  <div class="card ws-card">
    <div class="card-body">
      <h6 class="ws-sec"><i class="fa-solid fa-weight-scale"></i>Laundry Garments<span class="ws-count">${laundryPending.length + laundryInProgress.length}</span></h6>

      ${laundryPending.length === 0 && laundryInProgress.length === 0 ? html`
        <p class="ws-empty-line">No Laundry garments currently pending or in workshop.</p>` : html`
        ${laundryPending.length ? html`
        <form method="POST" id="laundryChallanForm">
          ${ctx.csrfField()}
          <input type="hidden" name="action" value="create_laundry_challan">
          <div class="ws-sendbar">
            <div class="ws-sendbar-left">
              <button type="button" class="ws-btn ws-btn--sm" id="lgSelectAllBtn">Select all (${laundryPending.length})</button>
              <button type="button" class="ws-btn ws-btn--sm" id="lgClearBtn">Clear</button>
            </div>
            <div class="ws-sendbar-right">
              <select name="workshop_id" class="form-select ws-input ws-input--sm">
                ${workshopOptions}
              </select>
              <input type="text" name="remarks" class="form-control ws-input ws-input--sm" placeholder="Store instruction (optional) — e.g. no bleach">
              <button type="submit" class="ws-btn ws-btn--primary ws-btn--sm"><i class="fa-solid fa-paper-plane"></i>Send to Workshop</button>
            </div>
          </div>
          <div class="table-responsive udc-cards-wrap">
            <table class="table table-hover table-sm udc-cards ws-table">
              <thead><tr><th></th><th>Order</th><th>Customer</th><th>Sequence</th><th>Garment</th><th>Service</th><th>Due</th></tr></thead>
              <tbody>
              ${laundryPending.map((lg) => html`
                <tr>
                  <td data-label=""><input type="checkbox" name="laundry_garment_ids[]" value="${lg.id}" class="lg-row-check ws-check-box"></td>
                  <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + lg.order_id)}">${lg.order_number}</a></td>
                  <td class="udc-card-head">${lg.customer_name}</td>
                  <td data-label="Sequence"><span class="ws-seq">${int(lg.sequence)}/${int(lg.total_garments)}</span></td>
                  <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?laundry_garment_id=' + lg.id)}">${lg.garment_name}</a></td>
                  <td data-label="Service"><span class="ws-chip">${lg.service_name}</span></td>
                  <td data-label="Due">${raw(ctx.date(lg.due_date))}</td>
                </tr>`)}
              </tbody>
            </table>
          </div>
        </form>` : ''}

        ${laundryInProgress.length ? html`
        <div class="table-responsive udc-cards-wrap mt-3">
          <table class="table table-hover table-sm udc-cards ws-table">
            <thead><tr><th>Order</th><th>Customer</th><th>Sequence</th><th>Garment</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
            ${laundryInProgress.map((lg) => html`
              <tr>
                <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + lg.order_id)}">${lg.order_number}</a></td>
                <td class="udc-card-head">${lg.customer_name}</td>
                <td data-label="Sequence"><span class="ws-seq">${int(lg.sequence)}/${int(lg.total_garments)}</span></td>
                <td data-label="Garment"><a href="${u('modules/barcode/garment_detail.php?laundry_garment_id=' + lg.id)}">${lg.garment_name}</a></td>
                <td data-label="Status"><span class="ws-pill ws-pill--workshop">${lg.status}</span></td>
                <td class="text-nowrap" data-label="Actions">
                  ${lg.workshop_item && lg.workshop_item.status === 'Sent' ? html`
                    <form method="POST" class="d-inline">
                      ${ctx.csrfField()}
                      <input type="hidden" name="action" value="start_processing_laundry">
                      <input type="hidden" name="workshop_item_id" value="${lg.workshop_item.id}">
                      <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                      <button type="submit" class="ws-btn ws-btn--xs ws-btn--start">Start</button>
                    </form>` : lg.workshop_item && lg.workshop_item.status === 'Processing' ? html`
                    <form method="POST" class="d-inline">
                      ${ctx.csrfField()}
                      <input type="hidden" name="action" value="complete_processing_laundry">
                      <input type="hidden" name="workshop_item_id" value="${lg.workshop_item.id}">
                      <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                      <button type="submit" class="ws-btn ws-btn--xs ws-btn--done">Complete</button>
                    </form>` : ''}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>` : ''}`}
    </div>
  </div>
</div>
`;

    return layout(ctx, { title: 'Workshop Dashboard' }, html`

<div class="col-12">
  <div class="ws-head">
    <div class="ws-head-title">
      <h4>Workshop</h4>
      <span>${numberFormat(total, 0)} item${total === 1 ? '' : 's'} in the queue${wsHasFilters ? ' (filtered)' : ''}</span>
    </div>
    <div class="ws-head-counts">
      <span class="ws-hcount ws-hcount--accept"><strong>${acceptQueue.length}</strong>awaiting accept</span>
      <span class="ws-hcount ws-hcount--return"><strong>${returnQueue.length}</strong>ready to return</span>
    </div>
  </div>
</div>

${errors.length ? html`
  <div class="col-12"><div class="ws-errors"><ul>${errors.map((er) => html`<li>${er}</li>`)}</ul></div></div>` : ''}

${mainBlock}

<!-- ===== Accept queue ===== -->
<div class="col-lg-6">
  <div class="card ws-card h-100">
    <div class="card-body">
      <h6 class="ws-sec"><i class="fa-solid fa-inbox"></i>Incoming — Awaiting Accept<span class="ws-count ws-count--accept">${acceptQueue.length}</span></h6>
      ${acceptQueue.length === 0 ? html`
        <p class="ws-empty-line">Nothing awaiting Accept right now.</p>` : html`
      <div class="table-responsive udc-cards-wrap">
        <table class="table table-hover table-sm udc-cards ws-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Store Instruction</th><th></th></tr></thead>
          <tbody>
          ${acceptQueue.map((r) => html`
            <tr>
              <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
              <td class="udc-card-head">${r.customer_name}</td>
              <td data-label="Garment">${r.garment_name}</td>
              <td class="small" data-label="Instruction">${orDash(r.remarks)}</td>
              <td data-label="">
                <form method="POST" class="d-inline">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="accept">
                  <input type="hidden" name="workshop_item_id" value="${r.id}">
                  <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                  <button type="submit" class="ws-btn ws-btn--xs ws-btn--primary">Accept</button>
                </form>
                ${unprocForm(r.id)}
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>
</div>

<!-- ===== Return queue ===== -->
<div class="col-lg-6">
  <div class="card ws-card h-100">
    <div class="card-body">
      <h6 class="ws-sec"><i class="fa-solid fa-truck-ramp-box"></i>Ready to Return to Store<span class="ws-count ws-count--return">${returnQueue.length}</span></h6>
      ${returnQueue.length === 0 ? html`
        <p class="ws-empty-line">Nothing ready to return right now.</p>` : html`
      <div class="table-responsive udc-cards-wrap">
        <table class="table table-hover table-sm udc-cards ws-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th></th></tr></thead>
          <tbody>
          ${returnQueue.map((r) => html`
            <tr>
              <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
              <td class="udc-card-head">${r.customer_name}</td>
              <td data-label="Garment">${r.garment_name}</td>
              <td data-label="">
                <form method="POST" class="d-inline">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="return_to_store">
                  <input type="hidden" name="workshop_item_id" value="${r.id}">
                  <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                  <button type="submit" class="ws-btn ws-btn--xs ws-btn--done">Return to Store</button>
                </form>
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>`}
    </div>
  </div>
</div>

<!-- ===== Unprocessed items ===== -->
${unprocessed.length ? html`
<div class="col-12">
  <div class="card ws-card border-danger">
    <div class="card-body">
      <h6 class="ws-sec text-danger"><i class="fa-solid fa-triangle-exclamation"></i>Unprocessed<span class="ws-count ws-count--return">${unprocessed.length}</span></h6>
      <p class="ws-empty-line">Garments the workshop could not process. Excluded from billing until resolved.</p>
      <div class="table-responsive udc-cards-wrap">
        <table class="table table-hover table-sm udc-cards ws-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Reason</th><th>Marked</th><th></th></tr></thead>
          <tbody>
          ${unprocessed.map((r) => html`
            <tr>
              <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${String(r.order_number ?? '')}</a></td>
              <td class="udc-card-head">${String(r.customer_name ?? '')}</td>
              <td data-label="Garment">${String(r.garment_name ?? '')}</td>
              <td class="small" data-label="Reason">${orDash(r.reason)}</td>
              <td class="small" data-label="Marked">${raw(ctx.date(r.marked_at))}</td>
              <td data-label="">
                <form method="POST" class="d-inline">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="resolve_unprocessed">
                  <input type="hidden" name="workshop_item_id" value="${r.id}">
                  <input type="hidden" name="redirect_qs" value="${qsForRedirect}">
                  <button type="submit" class="ws-btn ws-btn--xs ws-btn--primary" title="Return this item to the active queue">Resolve</button>
                </form>
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>` : ''}

${pager}

${raw(wsIndexStyle(u, JSON.stringify, e))}

${raw(wsIndexScript(u, JSON.stringify, e))}
`);
  });
}
