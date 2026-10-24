import type { FastifyInstance } from 'fastify';
import { piecesInLine } from '../../lib/garmentPieces.js';
import { phpEmpty } from '../../lib/php.js';
import { wiStates, wiTerms } from '../../services/workshopInvoice.js';
import { wsBillingScope, wsItemBelongs, wsScheduleData, wsScope } from '../../services/workshopScope.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { flt, int, numberFormat } from '../format.js';
import { e, html, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { wsDashboardStyle } from './workshop.static.js';
import { wsScheduleRender } from './wsSchedule.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const orDash = (v: unknown) => { const s = String(v ?? ''); return s === '' || s === '0' ? '—' : s; };
const flash = (ctx: WebCtx, r: { success: boolean; errors?: string[] }, ok: string) => ctx.flashSet(r.success ? 'success' : 'danger', r.success ? ok : (r.errors ?? []).join(' '));
const isNumericStr = (s: string) => /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);
/** PHP 8 string <=> string */
export const phpStrCmp = (a: string, b: string) => {
  if (isNumericStr(a) && isNumericStr(b)) return Math.sign(parseFloat(a) - parseFloat(b));
  const x = Buffer.from(a), y = Buffer.from(b);
  const c = Buffer.compare(x, y);
  return c;
};
/** PHP FILTER_VALIDATE_EMAIL (practical equivalent of its regex) */
export const validEmail = (s: string) => {
  if (s.length > 320 || /[^\x21-\x7e]/.test(s)) return false;
  const at = s.lastIndexOf('@');
  if (at < 1) return false;
  const local = s.slice(0, at), domain = s.slice(at + 1);
  if (local.length > 64) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) return false;
  return /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(domain) || /^\[(\d{1,3}\.){3}\d{1,3}\]$/.test(domain);
};

export function registerWorkshopPages(app: FastifyInstance) {
  const { db, workshop, whatsapp } = app.services;
  const myWs = async (ctx: WebCtx) => (await wsScope(db, ctx.data.user_id ?? 0, ctx.data.user?.role_name ?? ''))[1];
  const allowedStores = (ctx: WebCtx): number[] | null => { const f = ctx.fixedStoreId(); return f !== null ? [f] : null; };
  const actor = (ctx: WebCtx) => ({ userId: ctx.data.user_id!, ip: ctx.req.ip });

  // ---- Workshop dashboard ----------------------------------------------------------------------
  webPage(app, '/modules/workshop/dashboard', { auth: 'workshop.manage' }, async (ctx, req) => {
    const sourceStoreFilter = int((req.query as Record<string, unknown>).store_id);
    const ws = await myWs(ctx);
    const rows = await db.query<Row>(
      `SELECT wi.id, wi.status AS raw_status, wi.remarks AS store_instruction, wi.sent_at,
       oi1.quantity AS piece_quantity, oi1.pieces_per_unit AS piece_pieces_per_unit,
       COALESCE(g1.garment_name, g2.garment_name) AS garment_name, COALESCE(o1.order_number, o2.order_number) AS order_number, COALESCE(o1.id, o2.id) AS order_id,
       COALESCE(o1.store_id, o2.store_id) AS store_id, COALESCE(s1.store_name, s2.store_name) AS store_name, COALESCE(o1.due_date, o2.due_date) AS due_date,
       COALESCE(o1.urgent_level_id, o2.urgent_level_id) IS NOT NULL AS is_urgent, COALESCE(c1.full_name, c2.full_name) AS customer_name
       FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN stores s1 ON s1.id = o1.store_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
       LEFT JOIN orders o2 ON o2.id = oi2.order_id LEFT JOIN stores s2 ON s2.id = o2.store_id LEFT JOIN customers c2 ON c2.id = o2.customer_id
       WHERE wi.status != 'Rejected'${ws !== null ? ' AND wc.workshop_id = ?' : ''} ORDER BY wi.id DESC LIMIT 500`, ws !== null ? [ws] : []);
    const today = ctx.today;
    const buckets: Record<string, Row[]> = { Incoming: [], Accepted: [], Processing: [], Completed: [], Returned: [], Unprocessed: [] };
    const urgent: Row[] = [], delayed: Row[] = [];
    const storeCounts = new Map<number, { name: string; count: number }>();
    for (const row of rows) {
      // physical pieces, not order_item LINES — a 3-piece Set garment is 1 workshop_items row but 3 garments.
      // Laundry rows (piece_quantity null, no oi1 join) already represent one physical garment each — no multiplication needed there.
      row.piece_count = row.piece_quantity !== null ? piecesInLine({ quantity: row.piece_quantity, pieces_per_unit: row.piece_pieces_per_unit }) : 1;
      const current = await workshop.getCurrentStatus(Number(row.id));
      if (current === 'Store Received') continue;
      const sid = int(row.store_id);
      if (sid) { const s = storeCounts.get(sid) ?? storeCounts.set(sid, { name: row.store_name, count: 0 }).get(sid)!; s.count += row.piece_count; }
      if (sourceStoreFilter && sid !== sourceStoreFilter) continue;
      row.current_status = current;
      if (['Sent', 'Received', 'Workshop'].includes(current)) buckets.Incoming!.push(row);
      else if (current === 'Accepted') buckets.Accepted!.push(row);
      else if (current === 'Processing') buckets.Processing!.push(row);
      else if (current === 'Completed') buckets.Completed!.push(row);
      else if (current === 'Returned') buckets.Returned!.push(row);
      else if (current === 'Unprocessed') buckets.Unprocessed!.push(row);
      if (row.is_urgent) urgent.push(row);
      if (!phpEmpty(row.due_date) && String(row.due_date) < today) delayed.push(row);
    }
    // arsort() on [name, count] arrays: PHP compares array values key by key, so "name" decides first (descending), then count
    const storeWise = [...storeCounts].sort((a, b) => phpStrCmp(b[1].name, a[1].name) || (b[1].count - a[1].count));
    const stores = await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    const schedule = await wsScheduleData(db, ws, today);
    const pieceSum = (list: Row[]) => list.reduce((s, r) => s + Number(r.piece_count ?? 1), 0);
    const counterRows: [string, number, string, string][][] = [
      [['Incoming', pieceSum(buckets.Incoming!), 'secondary', 'fa-inbox'], ['Accepted', pieceSum(buckets.Accepted!), 'info', 'fa-circle-check'], ['Processing', pieceSum(buckets.Processing!), 'primary', 'fa-gear'], ['Completed', pieceSum(buckets.Completed!), 'success', 'fa-box-check']],
      [['Ready to Return', pieceSum(buckets.Completed!), 'success', 'fa-truck-ramp-box'], ['Returned', pieceSum(buckets.Returned!), 'warning', 'fa-rotate-left'], ['Unprocessed', pieceSum(buckets.Unprocessed!), 'danger', 'fa-triangle-exclamation'], ['Delayed', pieceSum(delayed), 'danger', 'fa-triangle-exclamation'], ['Urgent', pieceSum(urgent), 'danger', 'fa-bolt']],
    ];
    const queue = (title: string, icon: string, list: Row[], emptyMsg: string, color: string) => html`
    <div class="card wd-queue-card mb-3">
      <div class="wd-queue-header" style="border-left:4px solid var(--bs-${color}, #6c757d);">
        <span class="title"><span>${raw(icon)}</span> ${title}</span>
        <span class="wd-queue-badge bg-${color} text-white">${pieceSum(list)}</span>
      </div>
      ${list.length === 0 ? html`
        <div class="wd-empty-state">${emptyMsg}</div>` : html`
      <div class="table-responsive">
        <table class="table table-hover table-sm mb-0">
          <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Source Store</th><th>Status</th><th>Instruction</th><th>Due</th></tr></thead>
          <tbody>
          ${list.map((r) => html`
            <tr class="${!phpEmpty(r.due_date) && String(r.due_date) < today ? 'table-danger' : ''}">
              <td><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
              <td>${r.customer_name}</td>
              <td>${r.garment_name}</td>
              <td>${String(r.store_name ?? '')}</td>
              <td><span class="badge bg-secondary">${r.current_status}</span> ${r.is_urgent ? raw('<span class="badge bg-danger">Urgent</span>') : ''}</td>
              <td class="small">${orDash(r.store_instruction)}</td>
              <td>${r.due_date ? raw(ctx.date(r.due_date)) : '—'}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>`}
    </div>
    `;
    return layout(ctx, { title: 'Workshop Dashboard' }, html`
${raw(wsDashboardStyle(u, JSON.stringify, e))}
<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
  <h4 class="mb-0">Workshop Dashboard</h4>
  <form method="GET" class="d-flex gap-2">
    <select name="store_id" class="form-select form-select-sm" onchange="this.form.submit()">
      <option value="">All Source Stores</option>
      ${stores.map((s) => html`
        <option value="${s.id}" ${sel(sourceStoreFilter === Number(s.id))}>${s.store_name}</option>`)}
    </select>
  </form>
</div>

<!-- STATUS SUMMARY — same live counts as before, grouped into two visual rows -->
<div class="row g-3 mb-4">${wsScheduleRender(schedule, money)}</div>

<h6 class="fw-bold text-uppercase text-muted small mb-2" style="letter-spacing:.05em;">Status Summary</h6>
${counterRows.map((row) => html`
<div class="row g-2 mb-2">
  ${row.map(([label, count, color, icon]) => html`
    <div class="col-6 col-md-3">
      <div class="card text-center border-0 shadow-sm h-100">
        <div class="card-body py-2 px-2">
          <i class="fa-solid ${icon} text-${color} mb-1"></i>
          <div class="fs-4 fw-bold text-${color}">${count}</div>
          <div class="small text-muted">${label}</div>
        </div>
      </div>
    </div>`)}
</div>`)}

<!-- STORE-WISE SUMMARY — same counts/filter link, presented as clickable rows instead of a bare table -->
<div class="card border-0 shadow-sm mt-3 mb-4">
  <div class="card-body">
    <h6 class="fw-bold mb-2">Store-wise Summary <span class="text-muted small fw-normal">(active workshop items, click a store to filter below)</span></h6>
    ${storeWise.length === 0 ? html`
      <div class="wd-empty-state"><i class="fa-solid fa-circle-info me-1"></i>No active workshop items right now.</div>` : html`
      ${storeWise.map(([sid, sw]) => html`
        <a href="?store_id=${sid}" class="wd-store-row ${sourceStoreFilter === sid ? 'active' : ''}">
          <span><i class="fa-solid fa-shop me-2 text-muted"></i>${sw.name}</span>
          <span class="wd-store-count">${sw.count}</span>
        </a>`)}
      ${sourceStoreFilter ? html`
        <div class="mt-2"><a href="?" class="small">Clear store filter (show all)</a></div>` : ''}`}
  </div>
</div>

<h6 class="fw-bold text-uppercase text-muted small mb-2" style="letter-spacing:.05em;">Workshop Work Queues</h6>
${queue('URGENT WORK', '🚨', urgent, 'No urgent items right now.', 'danger')}${queue('DELAYED', '⚠', delayed, 'Nothing overdue right now.', 'danger')}${queue('INCOMING', '📥', buckets.Incoming!, 'Nothing incoming right now.', 'secondary')}${queue('ACCEPTED', '✅', buckets.Accepted!, 'Nothing accepted and awaiting processing.', 'info')}${queue('PROCESSING', '⚙', buckets.Processing!, 'Nothing currently processing.', 'primary')}${queue('READY TO RETURN', '✔', buckets.Completed!, 'Nothing ready to return.', 'success')}${queue('RETURNED (awaiting store receive)', '↩', buckets.Returned!, 'Nothing awaiting store receive.', 'warning')}${queue('UNPROCESSED', '⚠', buckets.Unprocessed!, 'Nothing unprocessed right now.', 'danger')}
`);
  });

  // ---- Receiving (store side) ------------------------------------------------------------------
  webPage(app, '/modules/workshop/receiving', { auth: 'workshop.manage' }, async (ctx, req) => {
    const ws = await myWs(ctx);
    if (req.method === 'POST') {
      const p = body(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      const wiId = int(p.workshop_item_id);
      if (ws !== null && !(await wsItemBelongs(db, wiId, ws))) { ctx.flashSet('danger', 'Item not found.'); return new WebRedirect('modules/workshop/receiving.php'); }
      const r = await workshop.storeReceive(wiId, actor(ctx), clean(p.remarks));
      flash(ctx, r, 'Garment received back into the store.');
      if (r.success) {
        try {
          const row = (await db.query<Row>(
            `SELECT o.id AS order_id, o.order_number, c.id AS customer_id, c.full_name, c.mobile FROM workshop_items wi
             LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
             JOIN orders o ON o.id = COALESCE(oi1.order_id, oi2.order_id) JOIN customers c ON c.id = o.customer_id WHERE wi.id = ?`, [wiId]))[0];
          if (row && !phpEmpty(row.mobile)) {
            await whatsapp.enqueue(Number(row.customer_id), Number(row.order_id), String(row.mobile), 'store_received',
              { customer_name: row.full_name, order_number: row.order_number, business_name: (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? ctx.svc.env.APP_NAME }, `store_received:${row.order_id}`);
          }
        } catch (ex) { console.error('WhatsApp store_received enqueue failed:', (ex as Error).message); }
      }
      return new WebRedirect('modules/workshop/receiving.php');
    }
    const allowed = allowedStores(ctx);
    const cols = `COALESCE(g1.garment_name, g2.garment_name) AS garment_name, COALESCE(o1.order_number, o2.order_number) AS order_number, COALESCE(o1.id, o2.id) AS order_id, COALESCE(o1.store_id, o2.store_id) AS store_id, COALESCE(c1.full_name, c2.full_name) AS customer_name`;
    const joins = `FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id LEFT JOIN orders o2 ON o2.id = oi2.order_id LEFT JOIN customers c2 ON c2.id = o2.customer_id`;
    const cand = await db.query<Row>(`SELECT wi.id, wi.order_item_id, wi.laundry_garment_id, ${cols} ${joins} WHERE wi.status = 'Completed'${ws !== null ? ' AND wc.workshop_id = ?' : ''} ORDER BY wi.id DESC LIMIT 200`, ws !== null ? [ws] : []);
    const queue: Row[] = [];
    for (const row of cand) {
      if ((await workshop.getCurrentStatus(Number(row.id))) !== 'Returned') continue;
      if (allowed !== null && !allowed.includes(int(row.store_id))) continue;
      queue.push(row);
    }
    const all = await db.query<Row>(`SELECT wi.id, wi.status AS raw_status, ${cols} ${joins} WHERE wi.status != 'Rejected'${ws !== null ? ' AND wc.workshop_id = ?' : ''} ORDER BY wi.id DESC LIMIT 300`, ws !== null ? [ws] : []);
    const view: Row[] = [];
    for (const row of all) {
      if (allowed !== null && !allowed.includes(int(row.store_id))) continue;
      const current = await workshop.getCurrentStatus(Number(row.id));
      if (current === 'Returned') continue;
      row.current_status = current;
      view.push(row);
    }
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Workshop Returns — Receiving' }, html`
<h4 class="mb-3">Workshop Returns — Receiving</h4>
<p class="text-muted small">Garments the workshop has marked Returned, awaiting confirmation that your store has physically received them back.</p>

<div class="card">
  <div class="card-body">
    ${queue.length === 0 ? html`
      <p class="text-muted text-center py-4">Nothing awaiting receipt right now.</p>` : html`
    <div class="table-responsive">
      <table class="table table-hover table-sm">
        <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th></th></tr></thead>
        <tbody>
        ${queue.map((r) => html`
          <tr>
            <td><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
            <td>${r.customer_name}</td>
            <td>${r.garment_name}</td>
            <td>
              <form method="POST" class="d-inline">
                ${ctx.csrfField()}
                <input type="hidden" name="workshop_item_id" value="${r.id}">
                <button type="submit" class="btn btn-sm btn-success">Receive</button>
              </form>
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>`}
  </div>
</div>

<h5 class="mt-4 mb-2">All Workshop Status — Your Store</h5>
<div class="card">
  <div class="card-body">
    ${view.length === 0 ? html`
      <p class="text-muted text-center py-3">No garments currently in the workshop pipeline.</p>` : html`
    <div class="table-responsive">
      <table class="table table-hover table-sm">
        <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Status</th></tr></thead>
        <tbody>
        ${view.map((r) => html`
          <tr>
            <td><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
            <td>${r.customer_name}</td>
            <td>${r.garment_name}</td>
            <td><span class="badge bg-secondary">${r.current_status}</span></td>
          </tr>`)}
        </tbody>
      </table>
    </div>`}
  </div>
</div>
`);
  });

  // ---- Challan view / print --------------------------------------------------------------------
  const challanData = async (challanId: number, extraSelect: string, laundryOnlyTotals = true) => {
    void laundryOnlyTotals; void extraSelect;
    const anchors = await db.query<Row>('SELECT id, (order_item_id IS NOT NULL) AS is_piece FROM workshop_items WHERE challan_id = ? ORDER BY id', [challanId]);
    const pieceIds: number[] = [], laundryIds: number[] = [];
    for (const r of anchors) (r.is_piece ? pieceIds : laundryIds).push(Number(r.id));
    const byId = new Map<number, Row>();
    if (pieceIds.length) for (const r of await db.query<Row>(
      `SELECT wi.*, oi.quantity, oi.weight, oi.unit, oi.item_status, oi.pieces_per_unit, oi.total AS line_total, o.order_number, c.full_name AS customer_name, g.garment_name, s.service_name, s.billing_unit
       FROM workshop_items wi JOIN order_items oi ON oi.id = wi.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
       WHERE wi.id IN (${pieceIds.map(() => '?').join(',')})`, pieceIds)) byId.set(Number(r.id), r);
    if (laundryIds.length) for (const r of await db.query<Row>(
      `SELECT wi.*, lg.sequence, oi.quantity AS total_garments, oi.total AS line_total, oi.quantity AS batch_qty, o.order_number, c.full_name AS customer_name, g.garment_name, s.service_name, s.billing_unit
       FROM workshop_items wi JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id
       WHERE wi.id IN (${laundryIds.map(() => '?').join(',')})`, laundryIds)) byId.set(Number(r.id), r);
    const items = anchors.filter((r) => byId.has(Number(r.id))).map((r) => byId.get(Number(r.id))!);
    return { items, isLaundry: laundryIds.length > 0 };
  };

  webPage(app, '/modules/workshop/challan_view', { auth: 'workshop.manage' }, async (ctx, req) => {
    const challanId = int((req.query as Record<string, unknown>).id);
    const challan = (await db.query<Row>('SELECT wc.*, w.workshop_name, u.full_name AS created_by_name FROM workshop_challans wc JOIN workshops w ON w.id = wc.workshop_id LEFT JOIN users u ON u.id = wc.created_by WHERE wc.id = ?', [challanId]))[0];
    if (!challan) { ctx.flashSet('danger', 'Challan not found.'); return new WebRedirect('modules/workshop/index.php'); }
    const ws = await myWs(ctx);
    if (ws !== null && Number(challan.workshop_id) !== ws) { ctx.flashSet('danger', 'Challan not found.'); return new WebRedirect('modules/workshop/index.php'); }
    const { items, isLaundry } = await challanData(challanId, '');
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Challan ' + challan.challan_number }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      <div class="d-flex justify-content-between align-items-start mb-3">
        <div>
          <h5 class="fw-bold mb-0">${challan.challan_number}</h5>
          <p class="text-muted mb-0">${challan.workshop_name} &middot; ${raw(ctx.datetime(challan.challan_date))} &middot; by ${String(challan.created_by_name ?? '')}</p>
          ${!phpEmpty(challan.remarks) ? html`<p class="text-muted small mb-0">Remarks: ${challan.remarks}</p>` : ''}
        </div>
        <div>
          <a href="${u('modules/workshop/challan_print.php?id=' + challanId)}" target="_blank" class="btn btn-outline-primary btn-sm"><i class="fa-solid fa-print me-1"></i>Print Challan</a>
          <a href="${u('modules/workshop/index.php')}" class="btn btn-outline-secondary btn-sm">Back to Dashboard</a>
        </div>
      </div>
      <table class="table table-sm">
        ${isLaundry ? html`
        <thead><tr><th>#</th><th>Order</th><th>Customer</th><th>Sequence</th><th>Garment</th><th>Service</th><th>Status</th></tr></thead>
        <tbody>
        ${items.map((it, i) => html`
          <tr>
            <td>${i + 1}</td>
            <td>${it.order_number}</td>
            <td>${it.customer_name}</td>
            <td>${int(it.sequence)} / ${int(it.total_garments)}</td>
            <td>${it.garment_name}</td>
            <td>${it.service_name}</td>
            <td><span class="badge bg-info text-dark">${it.status}</span></td>
          </tr>`)}
        </tbody>` : html`
        <thead><tr><th>#</th><th>Order</th><th>Customer</th><th>Garment</th><th>Service</th><th>Qty/Weight</th><th>Billing Unit</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>
        ${items.map((it, i) => {
          const pcs = Math.max(1, int(it.pieces_per_unit ?? 1));
          return html`
          <tr>
            <td>${i + 1}</td>
            <td>${it.order_number}</td>
            <td>${it.customer_name}</td>
            <td>${it.garment_name}</td>
            <td>${it.service_name}</td>
            <td>${it.weight !== null ? String(it.weight) : html`${String(it.quantity)}${pcs > 1 ? html` (${flt(it.quantity) * pcs} pcs)` : ''}`}</td>
            <td>${it.billing_unit === 'weight' ? 'KG' : 'Pcs'}</td>
            <td>${numberFormat(flt(it.line_total ?? 0), 2)}</td>
            <td><span class="badge bg-info text-dark">${it.status}</span></td>
          </tr>`;
        })}
        <tr><td colspan="7" class="text-end fw-bold">Total Amount</td><td class="fw-bold">${numberFormat(items.reduce((s, it) => s + flt(it.line_total ?? 0), 0), 2)}</td><td></td></tr>
        </tbody>`}
      </table>
    </div>
  </div>
</div>
`);
  });

  webPage(app, '/modules/workshop/challan_print', { auth: 'workshop.manage' }, async (ctx, req) => {
    const challanId = int((req.query as Record<string, unknown>).id);
    const notFound = new WebText('<p style="font-family:sans-serif;padding:20px;">Challan not found.</p>', 200);
    const challan = (await db.query<Row>('SELECT wc.*, w.workshop_name FROM workshop_challans wc JOIN workshops w ON w.id = wc.workshop_id WHERE wc.id = ?', [challanId]))[0];
    if (!challan) return notFound;
    const ws = await myWs(ctx);
    if (ws !== null && Number(challan.workshop_id) !== ws) return notFound;
    const { items, isLaundry } = await challanData(challanId, '');
    const businessName = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? '';
    const logoPath = (await ctx.setting('logo_path', '')) ?? '';
    const u = (p: string) => ctx.baseUrl(p);
    return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Challan ${challan.challan_number}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background:#eef1f6; margin:0; padding:20px; color:#1c2230; }
  .sheet { max-width:800px; margin:0 auto; background:#fff; padding:28px; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #0b3d91; padding-bottom:14px; margin-bottom:16px; }
  .brand-name { font-size:20px; font-weight:800; color:#0b3d91; }
  .meta { text-align:right; font-size:13px; }
  .meta .title { font-size:18px; font-weight:700; color:#0b3d91; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { background:#f1f5f9; text-align:left; padding:7px 6px; border-bottom:2px solid #dde3ec; font-size:11px; text-transform:uppercase; color:#556; }
  td { padding:6px; border-bottom:1px solid #eef1f6; }
  .actions { text-align:center; margin:16px 0; }
  .actions button, .actions a { border:0; background:#0b3d91; color:#fff; padding:8px 16px; border-radius:6px; text-decoration:none; font-size:13px; margin:0 4px; cursor:pointer; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { box-shadow:none; padding:10mm; }
    .actions { display:none; }
    @page { size: A4; margin: 12mm; }
  }
</style>
</head>
<body>
<div class="actions"><button onclick="window.print()">Print</button> <a href="${u('modules/workshop/challan_view.php?id=' + challanId)}">Back</a></div>
<div class="sheet">
  <div class="header">
    <div>
      ${!phpEmpty(logoPath) ? html`<img src="${u('uploads/logo/' + logoPath)}" style="max-height:44px;margin-bottom:6px;">` : ''}
      <div class="brand-name">${businessName}</div>
    </div>
    <div class="meta">
      <div class="title">WORKSHOP CHALLAN</div>
      <div>Challan #: <strong>${challan.challan_number}</strong></div>
      <div>Workshop: ${challan.workshop_name}</div>
      <div>Date: ${raw(ctx.datetime(challan.challan_date))}</div>
    </div>
  </div>
  ${!phpEmpty(challan.remarks) ? html`<p><strong>Remarks:</strong> ${challan.remarks}</p>` : ''}
  <table>
    ${isLaundry ? (() => {
      // a laundry batch's amount is for the WHOLE order_item (the whole weighed batch), not per individual garment within it --
      // showing it once, on the batch's first row, avoids implying each garment has its own separate price.
      const seenBatch = new Set<string>();
      let total = 0;
      const rows = items.map((it, i) => {
        const batchKey = `${it.order_number}|${it.garment_name}|${it.total_garments}`;
        const showAmount = !seenBatch.has(batchKey);
        seenBatch.add(batchKey);
        if (showAmount) total += flt(it.line_total ?? 0);
        return html`
      <tr>
        <td>${i + 1}</td>
        <td>${it.order_number}</td>
        <td>${it.customer_name}</td>
        <td>${int(it.sequence)} / ${int(it.total_garments)}</td>
        <td>${it.garment_name}</td>
        <td>${it.service_name}</td>
        <td style="text-align:right;">${showAmount ? numberFormat(flt(it.line_total ?? 0), 2) : raw('&mdash;')}</td>
      </tr>`;
      });
      return html`
    <thead><tr><th>#</th><th>Order</th><th>Customer</th><th>Sequence</th><th>Garment</th><th>Service</th><th style="text-align:right;">Amount (whole batch)</th></tr></thead>
    <tbody>
    ${rows}
    </tbody>
    <tfoot><tr><td colspan="6" style="text-align:right;font-weight:700;">Total Amount</td><td style="text-align:right;font-weight:700;">${numberFormat(total, 2)}</td></tr></tfoot>`;
    })() : (() => {
      let total = 0;
      const rows = items.map((it, i) => {
        const pcs = Math.max(1, int(it.pieces_per_unit ?? 1));
        total += flt(it.line_total ?? 0);
        return html`
      <tr>
        <td>${i + 1}</td>
        <td>${it.order_number}</td>
        <td>${it.customer_name}</td>
        <td>${it.garment_name}</td>
        <td>${it.service_name}</td>
        <td>${it.weight !== null ? String(it.weight) : html`${String(it.quantity)}${pcs > 1 ? html` (${flt(it.quantity) * pcs} pcs)` : ''}`}</td>
        <td>${it.billing_unit === 'weight' ? 'KG' : 'Pcs'}</td>
        <td style="text-align:right;">${numberFormat(flt(it.line_total ?? 0), 2)}</td>
      </tr>`;
      });
      return html`
    <thead><tr><th>#</th><th>Order</th><th>Customer</th><th>Garment</th><th>Service</th><th>Qty/Weight</th><th>Unit</th><th style="text-align:right;">Amount</th></tr></thead>
    <tbody>
    ${rows}
    </tbody>
    <tfoot><tr><td colspan="7" style="text-align:right;font-weight:700;">Total Amount</td><td style="text-align:right;font-weight:700;">${numberFormat(total, 2)}</td></tr></tfoot>`;
    })()}
  </table>
  <!-- the same piece-vs-line undercount pattern as tag printing / the workshop dashboard: a weight-mode row already represents one
       physical garment (laundry_garments are tracked individually), a piece-mode row needs its own pieces_per_unit folded in. -->
  <p style="margin-top:20px;font-size:11px;color:#888;">Total garments (pieces): ${items.reduce((s, it) => s + (it.billing_unit === 'weight' ? 1 : piecesInLine({ quantity: it.quantity, pieces_per_unit: it.pieces_per_unit })), 0)} &middot; Total lines: ${items.length}</p>
  <div style="display:flex;justify-content:space-between;margin-top:36px;font-size:12px;">
    <div>Driver Name: _______________________</div>
    <div>Driver Signature: _______________________</div>
  </div>
</div>
</body>
</html>`;
  });

  // ---- Settings (company & invoice details) ----------------------------------------------------
  webPage(app, '/modules/workshop/settings', { auth: 'workshop.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const userId = ctx.data.user_id ?? 0;
    const scope = await wsBillingScope(db, userId, ctx.data.user?.role_name ?? '');
    const myWorkshopId = scope.workshop_id, canEdit = scope.can_manage;
    let all = await db.query<Row>('SELECT id, workshop_name FROM workshops ORDER BY workshop_name');
    if (myWorkshopId !== null) all = all.filter((w) => Number(w.id) === myWorkshopId);
    const ids = all.map((w) => Number(w.id));
    const post = req.method === 'POST' ? body(ctx) : null;
    let selId = int(q.workshop_id ?? post?.workshop_id ?? 0);
    if (!ids.includes(selId)) selId = ids[0] ?? 0;
    const errors: string[] = [];
    if (scope.blocked) { errors.push('This login is not linked to a workshop yet, so there are no workshop settings to show. Ask the administrator to link it to your workshop.'); selId = 0; }
    const mb = (s: string) => [...s].length;
    if (post && selId) {
      if (!ctx.csrfValid()) return csrfFail();
      if (!canEdit) errors.push('You do not have permission to change workshop settings.');
      else {
        const company = clean(post.company_name), address = clean(str(post.address).replace(/\r/g, '')), phone = clean(post.phone), email = clean(post.email);
        const gstin = clean(post.gstin).toUpperCase();
        let stateCode = clean(post.state_code);
        const prefix = clean(post.invoice_prefix).toUpperCase(), next = int(post.invoice_next_number), termsDays = int(post.payment_terms_days);
        const itemDesc = clean(post.item_description), notes = clean(str(post.invoice_notes).replace(/\r/g, '')), bank = clean(str(post.bank_details).replace(/\r/g, ''));
        if (company === '' || mb(company) > 150) errors.push('Enter the company name (up to 150 characters).');
        if (mb(address) > 500) errors.push('The address is too long (500 characters at most).');
        if (mb(phone) > 30) errors.push('The phone number is too long.');
        if (email !== '' && !validEmail(email)) errors.push('Enter a valid email address.');
        if (gstin !== '') {
          if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) errors.push('The GSTIN must be 15 characters in the standard format (for example 09AAMCC6729K1Z1).');
          else if (!(gstin.slice(0, 2) in wiStates)) errors.push('The first two digits of the GSTIN are not a valid state code.');
          else stateCode = gstin.slice(0, 2);
        } else if (stateCode !== '' && !(stateCode in wiStates)) errors.push('Select a valid state.');
        if (!/^[A-Z0-9]{2,10}$/.test(prefix)) errors.push('The invoice prefix must be 2 to 10 letters or digits (for example CDSU).');
        else if ((await db.query('SELECT 1 FROM workshops WHERE invoice_prefix = ? AND id <> ?', [prefix, selId])).length) errors.push('Another workshop already uses the prefix ' + prefix + '. Each workshop needs its own.');
        if (next < 1) errors.push('The next invoice number must be 1 or more.');
        else if (/^[A-Z0-9]{2,10}$/.test(prefix)) {
          let max = 0;
          const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$');
          for (const r of await db.query<Row>('SELECT bill_number FROM workshop_bills WHERE bill_number LIKE ?', [prefix + '-%'])) { const m = re.exec(String(r.bill_number)); if (m) max = Math.max(max, parseInt(m[1]!, 10)); }
          if (next <= max) errors.push('Invoices up to ' + prefix + '-' + String(max).padStart(5, '0') + ' are already issued. The next number must be ' + (max + 1) + ' or higher.');
        }
        if (!(termsDays in wiTerms)) errors.push('Select the payment terms.');
        if (itemDesc === '' || mb(itemDesc) > 120) errors.push('Enter the charge description shown on the invoice (up to 120 characters).');
        if (mb(notes) > 1000) errors.push('The notes are too long (1000 characters at most).');
        if (mb(bank) > 1000) errors.push('The bank / payment details are too long (1000 characters at most).');
        if (!errors.length) {
          const before = (await db.query<Row>('SELECT company_name, gstin, state_code, invoice_prefix, invoice_next_number, payment_terms_days FROM workshops WHERE id = ?', [selId]))[0] ?? null;
          await db.execute(
            `UPDATE workshops SET company_name = ?, address = ?, phone = ?, email = ?, gstin = ?, state_code = ?, invoice_prefix = ?, invoice_next_number = ?, payment_terms_days = ?, item_description = ?, invoice_notes = ?, bank_details = ? WHERE id = ?`,
            [company, address !== '' ? address : null, phone !== '' ? phone : null, email !== '' ? email : null, gstin !== '' ? gstin : null, stateCode !== '' ? stateCode : null, prefix, next, termsDays, itemDesc, notes !== '' ? notes : null, bank !== '' ? bank : null, selId]);
          await ctx.svc.audit.record({ action: 'update', module: 'workshops', recordId: String(selId), oldValue: before, newValue: { company_name: company, gstin, state_code: stateCode, invoice_prefix: prefix, invoice_next_number: next, payment_terms_days: termsDays }, userId, ip: req.ip });
          return new WebRedirect(ctx.baseUrl(`modules/workshop/settings.php?workshop_id=${selId}&saved=1`));
        }
      }
    }
    const w = selId ? (await db.query<Row>('SELECT * FROM workshops WHERE id = ?', [selId]))[0] ?? null : null;
    const v = (k: string, d = '') => (post && errors.length && k in post ? String(post[k]) : String(w?.[k] ?? d));
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Workshop Settings' }, html`
<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
  <h4 class="mb-0">Workshop Settings <span class="text-muted fs-6 fw-normal">&middot; company &amp; invoice details</span></h4>
  <div class="d-flex gap-2">
    ${ctx.can('workshop.billing') || ctx.can('billing.view') ? html`<a href="${u('modules/workshop/billing.php')}" class="btn btn-sm btn-outline-primary">Workshop Billing</a>` : ''}
    <a href="${u('modules/workshop/index.php')}" class="btn btn-sm btn-outline-secondary">&larr; Back to Workshop</a>
  </div>
</div>

${errors.map((er) => html`<div class="alert alert-danger">${er}</div>`)}
${'saved' in q ? html`<div class="alert alert-success">Settings saved.</div>` : ''}

${!w ? html`
  ${!scope.blocked ? html`<div class="alert alert-info">No workshop found.</div>` : ''}` : html`

${all.length > 1 ? html`
<form method="get" class="mb-3 d-flex gap-2 align-items-center">
  <label class="small mb-0 text-muted">Workshop</label>
  <select name="workshop_id" class="form-select form-select-sm w-auto" onchange="this.form.submit()">
    ${all.map((opt) => html`<option value="${opt.id}" ${sel(selId === Number(opt.id))}>${opt.workshop_name}</option>`)}
  </select>
</form>` : ''}

<div class="alert alert-light border small">
  These details are printed on every invoice <strong>${w.workshop_name}</strong> issues, in the company's name.
  An invoice that has already been issued keeps the details it was issued with, so changing them here only affects new invoices.
</div>

<form method="post" action="${u('modules/workshop/settings.php')}">
  <input type="hidden" name="csrf_token" value="${ctx.data.csrf_token ?? ''}">
  <input type="hidden" name="workshop_id" value="${selId}">
  <fieldset ${canEdit ? '' : 'disabled'}>
  <div class="row g-3">
    <div class="col-lg-6">
      <div class="card h-100">
        <div class="card-header"><strong>Company details</strong> <span class="text-muted small">(top of the invoice)</span></div>
        <div class="card-body">
          <div class="mb-3">
            <label class="form-label">Company name *</label>
            <input type="text" name="company_name" class="form-control" maxlength="150" required value="${v('company_name', String(w.workshop_name))}">
          </div>
          <div class="mb-3">
            <label class="form-label">Address</label>
            <textarea name="address" class="form-control" rows="4" maxlength="500" placeholder="One line per row, e.g.&#10;1002, Omaxe Forest Spa&#10;Sector 93B&#10;Noida Uttar Pradesh 201304&#10;India">${v('address')}</textarea>
          </div>
          <div class="row g-2">
            <div class="col-md-6 mb-3"><label class="form-label">Phone</label><input type="text" name="phone" class="form-control" maxlength="30" value="${v('phone')}"></div>
            <div class="col-md-6 mb-3"><label class="form-label">Email</label><input type="email" name="email" class="form-control" maxlength="120" value="${v('email')}"></div>
          </div>
          <div class="row g-2">
            <div class="col-md-6 mb-3">
              <label class="form-label">GSTIN</label>
              <input type="text" name="gstin" class="form-control text-uppercase" maxlength="15" placeholder="optional" value="${v('gstin')}">
              <div class="form-text">With a GSTIN the document is titled <em>TAX INVOICE</em>; without one it is titled <em>INVOICE</em>.</div>
            </div>
            <div class="col-md-6 mb-3">
              <label class="form-label">State (Place Of Supply)</label>
              <select name="state_code" class="form-select">
                <option value="">Select state...</option>
                ${Object.entries(wiStates).sort((a, b) => Number(a[0]) - Number(b[0])).map(([code, name]) => html`<option value="${code}" ${sel(v('state_code') === code)}>${name} (${code})</option>`)}
              </select>
              <div class="form-text">If you enter a GSTIN, its first two digits set the state.</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="col-lg-6">
      <div class="card h-100">
        <div class="card-header"><strong>Invoice settings</strong></div>
        <div class="card-body">
          <div class="row g-2">
            <div class="col-md-6 mb-3">
              <label class="form-label">Invoice prefix *</label>
              <input type="text" name="invoice_prefix" class="form-control text-uppercase" maxlength="10" required value="${v('invoice_prefix')}">
              <div class="form-text">Unique per workshop, e.g. <strong>CDSU</strong>.</div>
            </div>
            <div class="col-md-6 mb-3">
              <label class="form-label">Next invoice number *</label>
              <input type="number" name="invoice_next_number" class="form-control" min="1" required value="${v('invoice_next_number', '1')}">
              <div class="form-text">Next invoice will be <strong>${(phpEmpty(w.invoice_prefix) ? 'INV' : String(w.invoice_prefix)) + '-' + String(int(w.invoice_next_number)).padStart(5, '0')}</strong>.</div>
            </div>
          </div>
          <div class="mb-3">
            <label class="form-label">Payment terms</label>
            <select name="payment_terms_days" class="form-select">
              ${Object.entries(wiTerms).sort((a, b) => Number(a[0]) - Number(b[0])).map(([days, label]) => html`<option value="${days}" ${sel(int(v('payment_terms_days', '0')) === Number(days))}>${label}</option>`)}
            </select>
            <div class="form-text">The due date is the invoice date plus these days.</div>
          </div>
          <div class="mb-3">
            <label class="form-label">Charge description *</label>
            <input type="text" name="item_description" class="form-control" maxlength="120" required value="${v('item_description', 'Dry Clean charges')}">
            <div class="form-text">The line item on the invoice (the period, like 1-15Jun26, is added under it).</div>
          </div>
          <div class="mb-3">
            <label class="form-label">Notes</label>
            <textarea name="invoice_notes" class="form-control" rows="2" maxlength="1000">${v('invoice_notes')}</textarea>
          </div>
          <div class="mb-3">
            <label class="form-label">Bank / payment details <span class="text-muted small">(optional, printed under the notes)</span></label>
            <textarea name="bank_details" class="form-control" rows="3" maxlength="1000" placeholder="Bank name, account number, IFSC, UPI id...">${v('bank_details')}</textarea>
          </div>
          <div class="small text-muted">
            Commission: workshop <strong>${String(w.commission_workshop_percent)}%</strong> / store <strong>${numberFormat(100 - flt(w.commission_workshop_percent), 2)}%</strong>.
            ${ctx.can('master.manage') ? html`<a href="${u('modules/master_data/workshops.php')}">Change in Master Data &rarr; Workshops</a>` : 'It is set by the administrator.'}
          </div>
        </div>
      </div>
    </div>
  </div>
  </fieldset>
  ${canEdit ? html`
  <div class="mt-3"><button class="btn btn-primary" type="submit">Save settings</button></div>` : html`
  <div class="mt-3 text-muted small">You can view these settings but not change them.</div>`}
</form>`}
`);
  });
}
