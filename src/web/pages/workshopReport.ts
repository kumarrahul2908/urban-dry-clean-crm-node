import type { FastifyInstance } from 'fastify';
import { addDays } from '../../lib/dates.js';
import { phpEmpty } from '../../lib/php.js';
import { wsScope } from '../../services/workshopScope.js';
import { webPage } from '../context.js';
import { flt, int, numberFormat } from '../format.js';
import { html, raw } from '../html.js';
import { layout } from '../layout.js';
import { phpStrCmp } from './workshop.js';

type Row = Record<string, any>;
const sel = (c: boolean) => (c ? 'selected' : '');
const dash = (v: unknown) => { const s = String(v ?? ''); return s === '' || s === '0' ? '—' : s; };
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
/** fmt_qty() */
const fmtQty = (q: number) => (q === Math.floor(q) ? String(Math.trunc(q)) : numberFormat(q, 2).replace(/,/g, '').replace(/0+$/, '').replace(/\.+$/, ''));
const plural = (n: number, w: string) => w + (n === 1 ? '' : 's');

export function registerWorkshopReportPage(app: FastifyInstance) {
  const { db, workshop } = app.services;

  webPage(app, '/modules/workshop/report', { auth: 'workshop.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const myWs = (await wsScope(db, ctx.data.user_id ?? 0, ctx.data.user?.role_name ?? ''))[1];
    let period = typeof q.period === 'string' ? q.period : 'week';
    const storeFilter = int(q.store_id);
    const customFrom = typeof q.from === 'string' ? q.from : '', customTo = typeof q.to === 'string' ? q.to : '';
    const today = ctx.today;
    let from: string, to: string;
    if (period === '15days') { from = addDays(today, -14); to = today; }
    else if (period === '30days') { from = addDays(today, -29); to = today; }
    else if (period === 'custom') {
      from = /^\d{4}-\d{2}-\d{2}$/.test(customFrom) ? customFrom : addDays(today, -6);
      to = /^\d{4}-\d{2}-\d{2}$/.test(customTo) ? customTo : today;
    } else { period = 'week'; from = addDays(today, -6); to = today; }

    const params: unknown[] = [from, to];
    let storeClause = '';
    if (storeFilter) { storeClause = ' AND COALESCE(o1.store_id, o2.store_id) = ?'; params.push(storeFilter); }
    let wsClause = '';
    if (myWs !== null) { wsClause = ' AND wc.workshop_id = ?'; params.push(myWs); }
    const rows = await db.query<Row>(
      `SELECT wi.id, wi.sent_at, COALESCE(o1.store_id, o2.store_id) AS store_id, COALESCE(s1.store_name, s2.store_name) AS store_name, COALESCE(g1.garment_name, g2.garment_name) AS garment_name,
       COALESCE(c1.full_name, c2.full_name) AS customer_name, COALESCE(o1.id, o2.id) AS order_id, COALESCE(o1.order_number, o2.order_number) AS order_number,
       COALESCE(o1.short_order_code, o2.short_order_code) AS short_order_code,
       COALESCE(oi1.id, oi2.id) AS order_item_id, COALESCE(oi1.total, oi2.total) AS item_value,
       CASE WHEN wi.laundry_garment_id IS NOT NULL THEN 1 ELSE COALESCE(oi1.quantity, 1) * COALESCE(oi1.pieces_per_unit, 1) END AS garments
       FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN stores s1 ON s1.id = o1.store_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id LEFT JOIN orders o2 ON o2.id = oi2.order_id
       LEFT JOIN stores s2 ON s2.id = o2.store_id LEFT JOIN customers c2 ON c2.id = o2.customer_id
       WHERE wi.status != 'Rejected' AND DATE(wi.sent_at) BETWEEN ? AND ?${storeClause}${wsClause} ORDER BY store_name, order_number, garment_name`, params);

    interface OrderAgg { number: string; customer: string | null; garments: number; items: Map<number, number>; amount: number }
    interface StoreAgg { name: string; garments_total: number; garments: Map<string, number>; customers: Set<string>; orders: Map<number, OrderAgg>; amount: number; order_count: number }
    const byStore = new Map<number, StoreAgg>();
    for (const r of rows) {
      const sid = int(r.store_id);
      const qty = flt(r.garments);
      const st = byStore.get(sid) ?? byStore.set(sid, { name: r.store_name ?? 'Unassigned', garments_total: 0, garments: new Map(), customers: new Set(), orders: new Map(), amount: 0, order_count: 0 }).get(sid)!;
      st.garments_total += qty;
      const gname = r.garment_name ?? 'Unknown';
      st.garments.set(gname, (st.garments.get(gname) ?? 0) + qty);
      if (!phpEmpty(r.customer_name)) st.customers.add(r.customer_name);
      const oid = int(r.order_id);
      const o = st.orders.get(oid) ?? st.orders.set(oid, { number: r.short_order_code ?? r.order_number, customer: r.customer_name, garments: 0, items: new Map(), amount: 0 }).get(oid)!;
      o.garments += qty;
      o.items.set(int(r.order_item_id), flt(r.item_value));
    }
    const grand = { stores: 0, orders: 0, garments: 0, amount: 0 };
    for (const s of byStore.values()) {
      s.garments = new Map([...s.garments].sort((a, b) => b[1] - a[1]));
      s.customers = new Set([...s.customers].sort(phpStrCmp));
      s.orders = new Map([...s.orders].sort((a, b) => Buffer.compare(Buffer.from(String(a[1].number ?? '')), Buffer.from(String(b[1].number ?? '')))));
      s.amount = 0;
      for (const o of s.orders.values()) { o.amount = [...o.items.values()].reduce((a, b) => a + b, 0); s.amount += o.amount; }
      s.order_count = s.orders.size;
      grand.stores++; grand.orders += s.order_count; grand.garments += s.garments_total; grand.amount += s.amount;
    }
    const stores = new Map([...byStore].sort((a, b) => b[1].amount - a[1].amount));
    const storeList = await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');

    const upParams: unknown[] = [from, to];
    let upStore = '';
    if (storeFilter) { upStore = ' AND COALESCE(o1.store_id, o2.store_id) = ?'; upParams.push(storeFilter); }
    let upWs = '';
    if (myWs !== null) { upWs = ' AND wc.workshop_id = ?'; upParams.push(myWs); }
    const upRows = await db.query<Row>(
      `SELECT DISTINCT wi.id AS wi_id, h.remarks AS reason, h.changed_at AS marked_at, COALESCE(o1.id, o2.id) AS order_id, COALESCE(o1.order_number, o2.order_number) AS order_number,
       COALESCE(o1.short_order_code, o2.short_order_code) AS short_order_code,
       COALESCE(s1.store_name, s2.store_name, 'Unassigned') AS store_name, COALESCE(c1.full_name, c2.full_name) AS customer_name, COALESCE(g1.garment_name, g2.garment_name) AS garment_name
       FROM garment_status_history h
       JOIN workshop_items wi ON (h.order_item_id IS NOT NULL AND h.order_item_id = wi.order_item_id) OR (h.laundry_garment_id IS NOT NULL AND h.laundry_garment_id = wi.laundry_garment_id)
       JOIN workshop_challans wc ON wc.id = wi.challan_id
       LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN stores s1 ON s1.id = o1.store_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
       LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id LEFT JOIN orders o2 ON o2.id = oi2.order_id
       LEFT JOIN stores s2 ON s2.id = o2.store_id LEFT JOIN customers c2 ON c2.id = o2.customer_id
       WHERE h.module = 'workshop' AND h.new_status = 'Unprocessed' AND DATE(wi.sent_at) BETWEEN ? AND ?${upStore}${upWs} ORDER BY store_name, h.changed_at DESC`, upParams);
    const unprocessed = new Map<string, Row[]>();
    for (const r of upRows) {
      if ((await workshop.getCurrentStatus(Number(r.wi_id))) !== 'Unprocessed') continue;
      (unprocessed.get(r.store_name) ?? unprocessed.set(r.store_name, []).get(r.store_name)!).push(r);
    }
    const upSorted = [...unprocessed].sort((a, b) => phpStrCmp(a[0], b[0]));
    const upCount = upSorted.reduce((n, [, l]) => n + l.length, 0);
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);

    return layout(ctx, { title: 'Workshop Report' }, html`
<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
  <h4 class="mb-0">Workshop Report</h4>
  <a href="${u('modules/workshop/index.php')}" class="btn btn-sm btn-outline-secondary">&larr; Back to Workshop</a>
</div>

<form class="card p-3 mb-3" method="get">
  <div class="row g-2 align-items-end">
    <div class="col-auto">
      <label class="form-label small mb-1">Period</label>
      <select name="period" class="form-select form-select-sm" onchange="this.form.submit()">
        <option value="week" ${sel(period === 'week')}>This Week</option>
        <option value="15days" ${sel(period === '15days')}>Last 15 Days</option>
        <option value="30days" ${sel(period === '30days')}>Last 30 Days</option>
        <option value="custom" ${sel(period === 'custom')}>Custom</option>
      </select>
    </div>
    ${period === 'custom' ? html`
    <div class="col-auto">
      <label class="form-label small mb-1">From</label>
      <input type="date" name="from" value="${from}" class="form-control form-control-sm">
    </div>
    <div class="col-auto">
      <label class="form-label small mb-1">To</label>
      <input type="date" name="to" value="${to}" class="form-control form-control-sm">
    </div>` : ''}
    <div class="col-auto">
      <label class="form-label small mb-1">Store</label>
      <select name="store_id" class="form-select form-select-sm" onchange="this.form.submit()">
        <option value="0">All Stores</option>
        ${storeList.map((s) => html`
          <option value="${s.id}" ${sel(storeFilter === Number(s.id))}>${s.store_name}</option>`)}
      </select>
    </div>
    <div class="col-auto"><button class="btn btn-sm btn-primary" type="submit">Apply</button></div>
  </div>
  <div class="small text-muted mt-2">${from} to ${to} &middot; based on when each garment was sent to the workshop</div>
</form>

${upCount > 0 ? html`
  <div class="card mb-3 border-danger">
    <div class="card-header bg-danger text-white d-flex justify-content-between align-items-center flex-wrap gap-2">
      <strong><i class="fa-solid fa-triangle-exclamation me-1"></i>Unprocessed</strong>
      <span class="badge bg-light text-danger">${upCount} ${plural(upCount, 'garment')}</span>
    </div>
    <div class="card-body">
      <p class="small text-muted mb-2">Garments the workshop could not process, still excluded from billing.</p>
      ${upSorted.map(([storeName, list]) => html`
        <h6 class="text-danger small text-uppercase mt-2">${storeName} (${list.length})</h6>
        <div class="table-responsive mb-2">
          <table class="table table-sm mb-0">
            <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th>Reason</th><th>Marked</th></tr></thead>
            <tbody>
              ${list.map((it) => html`
              <tr class="table-danger">
                <td><a class="text-danger fw-bold" href="${u('modules/orders/view.php?id=' + it.order_id)}">${String(it.short_order_code ?? it.order_number ?? '')}</a></td>
                <td>${String(it.customer_name ?? '')}</td>
                <td>${String(it.garment_name ?? '')}</td>
                <td class="small">${dash(it.reason)}</td>
                <td class="small">${raw(ctx.date(it.marked_at))}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>`)}
      <a href="${u('modules/workshop/index.php')}" class="small">Resolve from the Workshop page &rarr;</a>
    </div>
  </div>` : ''}

${stores.size === 0 ? html`
  <div class="card p-4 text-center text-muted">No garments were sent to the workshop in this period${storeFilter ? ' for this store' : ''}.</div>` : html`${[...stores.values()].map((store) => html`
  <div class="card mb-3">
    <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
      <strong>${store.name}</strong>
      <span>
        <span class="badge bg-secondary">${store.order_count} ${plural(store.order_count, 'order')}</span>
        <span class="badge bg-primary">${fmtQty(store.garments_total)} ${plural(store.garments_total === 1 ? 1 : 2, 'garment')}</span>
        <span class="badge bg-success">${raw(money(store.amount))}</span>
      </span>
    </div>
    <div class="card-body">
      <h6 class="text-muted small text-uppercase">Bill summary</h6>
      <div class="table-responsive mb-3">
        <table class="table table-sm mb-0">
          <thead><tr><th>Order</th><th>Customer</th><th class="text-end">Garments</th><th class="text-end">Amount</th></tr></thead>
          <tbody>
            ${[...store.orders].map(([oid, o]) => html`
            <tr>
              <td><a href="${u('modules/orders/view.php?id=' + oid)}">${String(o.number ?? '')}</a></td>
              <td>${String(o.customer ?? '')}</td>
              <td class="text-end">${fmtQty(o.garments)}</td>
              <td class="text-end">${raw(money(o.amount))}</td>
            </tr>`)}
          </tbody>
          <tfoot>
            <tr class="fw-bold">
              <td colspan="2" class="text-end">Store total (${store.order_count} ${plural(store.order_count, 'order')})</td>
              <td class="text-end">${fmtQty(store.garments_total)}</td>
              <td class="text-end">${raw(money(store.amount))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="row">
        <div class="col-md-6">
          <h6 class="text-muted small text-uppercase">Garment types</h6>
          <table class="table table-sm mb-0">
            ${[...store.garments].map(([gname, cnt]) => html`
              <tr><td>${gname}</td><td class="text-end fw-bold">${fmtQty(cnt)}</td></tr>`)}
          </table>
        </div>
        <div class="col-md-6">
          <h6 class="text-muted small text-uppercase">Customers (${store.customers.size})</h6>
          <div class="small" style="max-height:180px; overflow-y:auto;">
            ${raw([...store.customers].map(esc).join(', '))}
          </div>
        </div>
      </div>
    </div>
  </div>`)}

  <div class="card border-primary mb-3">
    <div class="card-header bg-primary text-white"><strong>Combined total &mdash; all stores</strong></div>
    <div class="table-responsive">
      <table class="table table-sm mb-0">
        <thead><tr><th>Store</th><th class="text-end">Orders</th><th class="text-end">Garments</th><th class="text-end">Amount</th></tr></thead>
        <tbody>
          ${[...stores.values()].map((store) => html`
          <tr>
            <td>${store.name}</td>
            <td class="text-end">${store.order_count}</td>
            <td class="text-end">${fmtQty(store.garments_total)}</td>
            <td class="text-end">${raw(money(store.amount))}</td>
          </tr>`)}
        </tbody>
        <tfoot>
          <tr class="fw-bold table-primary">
            <td>Total (${grand.stores} ${plural(grand.stores, 'store')})</td>
            <td class="text-end">${grand.orders}</td>
            <td class="text-end">${fmtQty(grand.garments)}</td>
            <td class="text-end">${raw(money(grand.amount))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>`}
`);
  });
}
