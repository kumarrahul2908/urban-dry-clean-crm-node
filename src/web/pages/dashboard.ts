import type { FastifyInstance } from 'fastify';
import { addDays, dayMon } from '../../lib/dates.js';
import { wsScheduleData, wsScope } from '../../services/workshopScope.js';
import { webPage, type WebCtx } from '../context.js';
import { dMY, groupBy, qty } from '../format.js';
import { html, jsonEncode, pf, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { wsScheduleRender } from './wsSchedule.js';

type Row = Record<string, any>;
type Money = (v: unknown) => string;

export function registerDashboardPages(app: FastifyInstance) {
  const { db } = app.services;

  webPage(app, '/modules/dashboard/index', { auth: 'dashboard.view' }, async (ctx) => {
    const today = ctx.today;
    const money = await ctx.loadMoney();

    if (ctx.roleName() === 'Workshop Staff') {
      const [, wsId] = await wsScope(db, ctx.data.user_id!, 'Workshop Staff');
      return layout(ctx, { title: 'Dashboard' }, wsScheduleRender(await wsScheduleData(db, wsId, today), money));
    }

    const fixed = ctx.fixedStoreId();
    const allowed = fixed !== null ? [fixed] : null;
    const storeWhere = (alias = 'o', allowNull = false): [string, unknown[]] => {
      if (allowed === null) return ['', []];
      const ph = allowed.map(() => '?').join(',');
      return [` AND ${allowNull ? `(${alias}.store_id IS NULL OR ${alias}.store_id IN (${ph}))` : `${alias}.store_id IN (${ph})`}`, [...allowed]];
    };
    const [sf, sfp] = storeWhere();
    const scalar = async (sql: string, params: unknown[] = []) => {
      const r = await db.query<Row>(sql, params);
      const v = r[0] ? Object.values(r[0])[0] : 0;
      return v === null || v === undefined ? 0 : v;
    };
    const statusCount = (cond: string, extra = '', ep: unknown[] = []) =>
      scalar(`SELECT COUNT(*) FROM orders o JOIN order_statuses s ON s.id=o.status_id WHERE ${cond}${extra}${sf}`, [...ep, ...sfp]);

    const todaysOrders = await scalar(`SELECT COUNT(*) FROM orders o WHERE DATE(order_date) = ?${sf}`, [today, ...sfp]);
    const pendingOrders = await statusCount("s.status_key='received'");
    const processing = await statusCount("s.status_key IN ('workshop','processing')");
    const qcPending = await statusCount("s.status_key='qc'");
    const reworkCount = await statusCount("s.status_key='rework'");
    const readyCount = await statusCount("s.status_key='ready'");
    const packedCount = await statusCount("s.status_key='packed'");
    const outForDelivery = await statusCount("s.status_key='out_for_delivery'");
    const deliveredToday = await scalar(`SELECT COUNT(*) FROM orders o JOIN order_statuses s ON s.id=o.status_id WHERE s.status_key='delivered' AND DATE(o.updated_at)=?${sf}`, [today, ...sfp]);
    const todaysSales = await scalar(`SELECT COALESCE(SUM(grand_total),0) FROM orders o WHERE DATE(order_date) = ?${sf}`, [today, ...sfp]);
    const todaysCollection = await scalar(`SELECT COALESCE(SUM(p.total_amount),0) FROM payments p JOIN orders o ON o.id = p.order_id WHERE DATE(p.payment_date) = ?${sf}`, [today, ...sfp]);
    const outstanding = await scalar(`SELECT COALESCE(SUM(ar.due_amount),0) FROM accounts_receivable ar JOIN orders o ON o.id = ar.order_id WHERE ar.due_amount > 0${sf}`, sfp);
    const [sfn, sfnp] = storeWhere('o', true);
    const pickupPending = await scalar(`SELECT COUNT(*) FROM pickup_orders po LEFT JOIN orders o ON o.id = po.order_id WHERE po.status IN ('Requested','Scheduled','Assigned')${sfn}`, sfnp);
    const deliveryPending = await scalar(`SELECT COUNT(*) FROM delivery_orders do_ JOIN orders o ON o.id = do_.order_id WHERE do_.status IN ('Pending','Assigned','Out for Delivery')${sf}`, sfp);

    // ---- chart data
    const salesRows = await db.query<Row>(`SELECT DATE(order_date) d, COALESCE(SUM(grand_total),0) total FROM orders o WHERE order_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)${sf} GROUP BY DATE(order_date) ORDER BY d`, sfp);
    const byDate: Record<string, number> = {};
    for (const r of salesRows) byDate[String(r.d)] = parseFloat(String(r.total));
    const salesLabels: string[] = [], salesValues: unknown[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      salesLabels.push(dayMon(d));
      salesValues.push(d in byDate ? pf(byDate[d]) : 0);
    }
    const svcRows = await db.query<Row>(`SELECT s.service_name, COUNT(oi.id) cnt FROM order_items oi JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = oi.order_id WHERE 1=1${sf} GROUP BY s.id ORDER BY cnt DESC LIMIT 8`, sfp);
    const statusRows = await db.query<Row>(`SELECT os.status_label, os.color, COUNT(o.id) cnt FROM order_statuses os LEFT JOIN orders o ON o.status_id = os.id${sf} GROUP BY os.id ORDER BY os.sort_order`, sfp);
    const payRows = await db.query<Row>(`SELECT pt.type_name, COALESCE(SUM(ptx.amount),0) total FROM payment_transactions ptx JOIN payment_types pt ON pt.id = ptx.payment_type_id JOIN payments p ON p.id = ptx.payment_id JOIN orders o ON o.id = p.order_id WHERE p.payment_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${sf} GROUP BY pt.id ORDER BY total DESC`, sfp);
    const topGarments = await db.query<Row>(
      `SELECT garment_name, SUM(qty) AS qty FROM (
         SELECT g.garment_name, oi.quantity AS qty FROM order_items oi JOIN garments g ON g.id = oi.garment_id JOIN orders o ON o.id = oi.order_id
         WHERE o.order_mode = 'piece' AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${sf}
         UNION ALL
         SELECT g.garment_name, 1 AS qty FROM laundry_garments lg JOIN garments g ON g.id = lg.garment_id JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id
         WHERE o.order_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${sf}
       ) combined GROUP BY garment_name ORDER BY qty DESC LIMIT 5`, [...sfp, ...sfp]);
    const topCustomers = await db.query<Row>(`SELECT c.full_name, c.mobile, SUM(o.grand_total) total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)${sf} GROUP BY c.id ORDER BY total DESC LIMIT 5`, sfp);

    // ---- delivery schedule
    const tomorrow = addDays(today, 1);
    const garmentsExpr = `CASE WHEN o.order_mode = 'weight'
                   THEN (SELECT COUNT(*) FROM laundry_garments lg JOIN order_items oiw ON oiw.id = lg.order_item_id WHERE oiw.order_id = o.id)
                   ELSE (SELECT COALESCE(SUM(oiq.quantity), 0) FROM order_items oiq WHERE oiq.order_id = o.id) END`;
    const dueOrders = (date: string) => db.query<Row>(
      `SELECT o.id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_time, o.grand_total, o.current_due, COALESCE(s.store_name, 'Unassigned') AS store_name, c.full_name AS customer_name, os.status_label, ${garmentsExpr} AS garments
       FROM orders o JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id LEFT JOIN stores s ON s.id = o.store_id
       WHERE o.due_date = ? AND os.status_key NOT IN ('delivered','cancelled')${sf}
       ORDER BY store_name, o.due_time IS NULL, o.due_time, o.order_number`, [date, ...sfp]);
    const dueToday = await dueOrders(today);
    const dueTomorrow = await dueOrders(tomorrow);
    const overdueRows = await db.query<Row>(
      `SELECT o.id AS order_id, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, DATEDIFF(?, o.due_date) AS days_overdue, COALESCE(s.store_name, 'Unassigned') AS store_name, c.full_name AS customer_name,
              COALESCE(g.garment_name, sv.service_name) AS garment_name, oi.item_status, oi.quantity, (SELECT COUNT(*) FROM laundry_garments lg WHERE lg.order_item_id = oi.id) AS lg_count
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id
       LEFT JOIN stores s ON s.id = o.store_id LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services sv ON sv.id = oi.service_id
       WHERE o.due_date < ? AND os.status_key NOT IN ('delivered','cancelled') AND oi.item_status NOT IN ('Delivered','Damaged','Missing')${sf}
       ORDER BY store_name, o.due_date, o.order_number, oi.id`, [today, today, ...sfp]);

    const cards: [string, unknown, string, string][] = [
      ["Today's Orders", todaysOrders, 'fa-cart-shopping', '#0b3d91'],
      ['Pending Orders', pendingOrders, 'fa-hourglass-half', '#6c757d'],
      ['Processing', processing, 'fa-industry', '#fd7e14'],
      ['QC Pending', qcPending, 'fa-magnifying-glass', '#ffc107'],
      ['Rework', reworkCount, 'fa-rotate-left', '#dc3545'],
      ['Ready', readyCount, 'fa-circle-check', '#20c997'],
      ['Packed', packedCount, 'fa-box', '#0dcaf0'],
      ['Out for Delivery', outForDelivery, 'fa-truck', '#6610f2'],
      ['Delivered Today', deliveredToday, 'fa-house-circle-check', '#198754'],
      ["Today's Sales", money(todaysSales), 'fa-chart-line', '#0b3d91'],
      ["Today's Collection", money(todaysCollection), 'fa-money-bill-wave', '#00b4d8'],
      ['Outstanding', money(outstanding), 'fa-triangle-exclamation', '#dc3545'],
      ['Pickup Pending', pickupPending, 'fa-house-signal', '#6f42c1'],
      ['Delivery Pending', deliveryPending, 'fa-truck-fast', '#fd7e14'],
    ];

    const col = (rows: Row[], k: string) => rows.map((r) => r[k]);
    return layout(ctx, { title: 'Dashboard' }, html`
<style>.chart-card canvas{max-height:280px;}</style>
${dueSection('Going out today', dMY(today), dueToday, 'No orders are due today.', 'primary', ctx, money)}${dueSection('Going out tomorrow', dMY(tomorrow), dueTomorrow, 'No orders are due tomorrow.', 'info', ctx, money)}${overdueSection(overdueRows, ctx)}

${cards.map(([label, value, icon, color]) => html`
  <div class="col-6 col-md-4 col-xl-3">
    <div class="stat-card" style="background:${color};">
      <i class="fa-solid ${icon} stat-icon"></i>
      <div class="stat-value">${String(value)}</div>
      <div class="stat-label">${label}</div>
    </div>
  </div>`)}

<div class="col-lg-8">
  <div class="card chart-card p-3">
    <h6 class="fw-bold mb-3">Daily Sales (Last 7 Days)</h6>
    <canvas id="chartSales"></canvas>
  </div>
</div>
<div class="col-lg-4">
  <div class="card chart-card p-3">
    <h6 class="fw-bold mb-3">Orders by Status</h6>
    <canvas id="chartStatus"></canvas>
  </div>
</div>
<div class="col-lg-6">
  <div class="card chart-card p-3">
    <h6 class="fw-bold mb-3">Orders by Service</h6>
    <canvas id="chartService"></canvas>
  </div>
</div>
<div class="col-lg-6">
  <div class="card chart-card p-3">
    <h6 class="fw-bold mb-3">Payment Collection by Mode (30 Days)</h6>
    <canvas id="chartPayment"></canvas>
  </div>
</div>

<div class="col-lg-6">
  <div class="card p-3">
    <h6 class="fw-bold mb-3">Top Garments (30 Days)</h6>
    ${topGarments.length === 0 ? html`
      <p class="text-muted small mb-0">No order data yet.</p>` : html`
    <table class="table table-sm mb-0">
      <thead><tr><th>Garment</th><th class="text-end">Qty</th></tr></thead>
      <tbody>
      ${topGarments.map((g) => html`
        <tr><td>${g.garment_name}</td><td class="text-end">${String(Math.trunc(parseFloat(String(g.qty))))}</td></tr>`)}
      </tbody>
    </table>`}
  </div>
</div>
<div class="col-lg-6">
  <div class="card p-3">
    <h6 class="fw-bold mb-3">Top Customers (90 Days)</h6>
    ${topCustomers.length === 0 ? html`
      <p class="text-muted small mb-0">No order data yet.</p>` : html`
    <table class="table table-sm mb-0">
      <thead><tr><th>Customer</th><th>Mobile</th><th class="text-end">Total Spend</th></tr></thead>
      <tbody>
      ${topCustomers.map((c) => html`
        <tr><td>${c.full_name}</td><td>${c.mobile}</td><td class="text-end">${money(c.total)}</td></tr>`)}
      </tbody>
    </table>`}
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
new Chart(document.getElementById('chartSales'), {
  type: 'line',
  data: { labels: ${raw(jsonEncode(salesLabels))}, datasets: [{
    label: 'Sales', data: ${raw(jsonEncode(salesValues))},
    borderColor: '#0b3d91', backgroundColor: 'rgba(11,61,145,.1)', fill: true, tension: .3
  }]},
  options: { plugins: { legend: { display: false } } }
});
new Chart(document.getElementById('chartStatus'), {
  type: 'doughnut',
  data: { labels: ${raw(jsonEncode(col(statusRows, 'status_label')))}, datasets: [{
    data: ${raw(jsonEncode(statusRows.map((r) => Math.trunc(Number(r.cnt)))))}, backgroundColor: ${raw(jsonEncode(col(statusRows, 'color')))}
  }]}
});
new Chart(document.getElementById('chartService'), {
  type: 'bar',
  data: { labels: ${raw(jsonEncode(col(svcRows, 'service_name')))}, datasets: [{
    label: 'Items', data: ${raw(jsonEncode(svcRows.map((r) => Math.trunc(Number(r.cnt)))))}, backgroundColor: '#00b4d8'
  }]},
  options: { plugins: { legend: { display: false } } }
});
new Chart(document.getElementById('chartPayment'), {
  type: 'pie',
  data: { labels: ${raw(jsonEncode(col(payRows, 'type_name')))}, datasets: [{
    data: ${raw(jsonEncode(payRows.map((r) => pf(r.total))))},
    backgroundColor: ['#0b3d91','#00b4d8','#20c997','#fd7e14','#6f42c1','#dc3545']
  }]}
});
</script>
`);
  });
}

function dueSection(title: string, dateLabel: string, rows: Row[], emptyText: string, border: string, ctx: WebCtx, money: Money): Raw {
  let garments = 0, amount = 0;
  for (const r of rows) { garments += parseFloat(String(r.garments)) || 0; amount += parseFloat(String(r.grand_total)) || 0; }
  return html`
    <div class="col-12">
      <div class="card border-${border}">
        <div class="card-header bg-${border} bg-opacity-10 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <strong>${title} <span class="text-muted fw-normal small">&middot; ${dateLabel}</span></strong>
          <span>
            <span class="badge bg-secondary">${rows.length} order${rows.length === 1 ? '' : 's'}</span>
            <span class="badge bg-primary">${qty(garments)} garment${garments === 1 ? '' : 's'}</span>
            <span class="badge bg-success">${money(amount)}</span>
          </span>
        </div>
        <div class="card-body">
          ${rows.length === 0 ? html`
            <p class="text-muted small mb-0">${emptyText}</p>` : [...groupBy(rows, (r) => r.store_name)].map(([storeName, list]) => {
            const sg = list.reduce((a, r) => a + (parseFloat(String(r.garments)) || 0), 0), sa = list.reduce((a, r) => a + (parseFloat(String(r.grand_total)) || 0), 0);
            return html`
            <h6 class="mt-2 mb-1">${storeName} <span class="text-muted small fw-normal">&mdash; ${list.length} order${list.length === 1 ? '' : 's'} &middot; ${qty(sg)} garments &middot; ${money(sa)}</span></h6>
            <div class="table-responsive mb-2">
              <table class="table table-sm table-hover mb-0">
                <thead><tr><th>Order</th><th>Customer</th><th>Time</th><th class="text-end">Garments</th><th class="text-end">Amount</th><th class="text-end">Balance</th><th>Status</th></tr></thead>
                <tbody>
                ${list.map((r) => html`
                  <tr>
                    <td><a href="${ctx.baseUrl('modules/orders/view.php?id=' + r.id)}">${r.order_number}</a></td>
                    <td>${r.customer_name}</td>
                    <td>${r.due_time ? String(r.due_time).slice(0, 5) : '—'}</td>
                    <td class="text-end">${qty(r.garments)}</td>
                    <td class="text-end">${money(r.grand_total)}</td>
                    <td class="text-end">${money(r.current_due)}</td>
                    <td><span class="badge bg-light text-dark border">${r.status_label}</span></td>
                  </tr>`)}
                </tbody>
              </table>
            </div>`;
          })}
        </div>
      </div>
    </div>
    `;
}

function overdueSection(rows: Row[], ctx: WebCtx): Raw {
  const cap = 50;
  const orders = new Set<number>();
  let garments = 0;
  for (const r of rows) { orders.add(Number(r.order_id)); garments += Number(r.lg_count) > 0 ? Number(r.lg_count) : parseFloat(String(r.quantity)) || 0; }
  return html`
    <div class="col-12">
      <div class="card border-danger">
        <div class="card-header bg-danger text-white d-flex justify-content-between align-items-center flex-wrap gap-2">
          <strong><i class="fa-solid fa-triangle-exclamation me-1"></i>Overdue Garments <span class="fw-normal small">&middot; due date already passed, not delivered</span></strong>
          <span>
            <span class="badge bg-light text-danger">${orders.size} order${orders.size === 1 ? '' : 's'}</span>
            <span class="badge bg-light text-danger">${qty(garments)} garment${garments === 1 ? '' : 's'}</span>
          </span>
        </div>
        <div class="card-body">
          ${rows.length === 0 ? html`
            <p class="text-muted small mb-0">Nothing is overdue. 🎉</p>` : [...groupBy(rows, (r) => r.store_name)].map(([storeName, list]) => html`
            <h6 class="mt-2 mb-1 text-danger">${storeName} <span class="small fw-normal">&mdash; ${list.length} garment line${list.length === 1 ? '' : 's'} overdue</span></h6>
            <div class="table-responsive mb-2">
              <table class="table table-sm mb-0">
                <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th class="text-end">Qty</th><th>Due date</th><th>Overdue by</th><th>Status</th></tr></thead>
                <tbody>
                ${list.slice(0, cap).map((r) => {
                  const lg = Number(r.lg_count) > 0;
                  const q = lg ? Number(r.lg_count) : parseFloat(String(r.quantity)) || 0;
                  const days = Math.trunc(Number(r.days_overdue));
                  return html`
                  <tr class="table-danger">
                    <td><a class="text-danger fw-bold" href="${ctx.baseUrl('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
                    <td>${r.customer_name}</td>
                    <td>${String(r.garment_name ?? '')}${lg ? raw(' <span class="small text-muted">(by weight)</span>') : ''}</td>
                    <td class="text-end">${qty(q)}</td>
                    <td>${r.due_date}</td>
                    <td><span class="badge bg-danger">${days} day${days === 1 ? '' : 's'}</span></td>
                    <td class="fw-semibold text-danger">${r.item_status}</td>
                  </tr>`;
                })}
                ${list.length > cap ? html`
                  <tr><td colspan="7" class="text-center text-danger small">&hellip; and ${list.length - cap} more overdue garment line(s) in this store (oldest shown first)</td></tr>` : ''}
                </tbody>
              </table>
            </div>`)}
        </div>
      </div>
    </div>
    `;
}
