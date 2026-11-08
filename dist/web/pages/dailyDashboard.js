import { addDays, isStrtotimeDate } from '../../lib/dates.js';
import { WebRedirect, webPage } from '../context.js';
import { dMY } from '../format.js';
import { html, raw } from '../html.js';
import { layout } from '../layout.js';
import { dailyScript, dailyStyle } from './daily.static.js';
import { e as esc } from '../html.js';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** date('d M', strtotime($d)) — a missing date renders as the Unix epoch (01 Jan), as PHP did. */
const dMon = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? '')); return m ? `${m[3]} ${MON[Number(m[2]) - 1]}` : '01 Jan'; };
const intOf = (v) => Math.trunc(parseFloat(String(v ?? '')) || 0);
const fl = (v) => parseFloat(String(v ?? '')) || 0;
export function registerDailyDashboard(app) {
    const { db } = app.services;
    webPage(app, '/modules/daily_dashboard/index', { auth: 'dashboard.view' }, async (ctx, req) => {
        if (ctx.roleName() === 'Workshop Staff')
            return new WebRedirect('modules/dashboard/index.php');
        const money = await ctx.loadMoney();
        const today = ctx.today;
        const rawDate = req.query.date;
        let selected = (typeof rawDate === 'string' ? rawDate : today).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(selected) || !isStrtotimeDate(selected))
            selected = today;
        const prev = addDays(selected, -1), next = addDays(selected, 1);
        const fixed = ctx.fixedStoreId();
        const sf = fixed !== null ? ' AND o.store_id IN (?)' : '';
        const sfp = fixed !== null ? [fixed] : [];
        const fetchOrderRows = (where, params) => db.query(`SELECT o.id, o.order_number, o.due_time, o.due_date, c.full_name AS customer_name, c.mobile, o.grand_total, o.total_paid, o.current_due,
              COALESCE(SUM(oi.quantity),0) AS pcs, COUNT(DISTINCT oi.garment_id) AS garment_types
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE ${where} GROUP BY o.id ORDER BY o.due_time IS NULL, o.due_time`, params);
        const notDone = "o.id IN (SELECT o2.id FROM orders o2 JOIN order_statuses os ON os.id=o2.status_id WHERE os.status_key NOT IN ('delivered','cancelled'))";
        const pickupRows = await db.query(`SELECT po.id, po.pickup_number, po.pickup_date, po.pickup_time, po.status, po.garment_count, c.full_name AS customer_name, c.mobile, po.address, po.order_id
       FROM pickup_orders po JOIN customers c ON c.id = po.customer_id WHERE po.pickup_date = ? ORDER BY po.pickup_time IS NULL, po.pickup_time`, [selected]);
        const urgentRows = await fetchOrderRows(`o.urgent_level_id IS NOT NULL AND o.due_date = ? AND ${notDone}${sf}`, [selected, ...sfp]);
        const deliveryRows = await fetchOrderRows(`o.due_date = ? AND ${notDone}${sf}`, [selected, ...sfp]);
        const workshopRows = await db.query(`SELECT g.garment_name, s.service_name, COUNT(oi.id) AS item_count, oi.item_status
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
       WHERE oi.item_status IN ('Workshop','Processing')${sf} GROUP BY g.id, s.id, oi.item_status ORDER BY item_count DESC LIMIT 15`, sfp);
        const readyRows = await db.query(`SELECT os.status_label, COUNT(DISTINCT o.id) AS order_count FROM orders o JOIN order_statuses os ON os.id = o.status_id
       WHERE os.status_key IN ('ready','packed','out_for_delivery','delivered')${sf} AND DATE(o.updated_at) = ? GROUP BY os.id ORDER BY os.sort_order`, [...sfp, selected]);
        const pendingWork = await db.query(`SELECT o.id, o.order_number, o.due_date, c.full_name AS customer_name, c.mobile, COALESCE(SUM(oi.quantity),0) AS pcs
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items oi ON oi.order_id = o.id JOIN order_statuses os ON os.id = o.status_id
       WHERE oi.item_status NOT IN ('Ready','Packed','Delivered','Damaged','Missing') AND os.status_key NOT IN ('delivered','cancelled')${sf}
       GROUP BY o.id ORDER BY o.due_date`, sfp);
        const due = (r) => String(r.due_date ?? '');
        const pendingOverdue = pendingWork.filter((r) => due(r) < selected);
        const pendingToday = pendingWork.filter((r) => due(r) === selected);
        const pendingFuture = pendingWork.filter((r) => due(r) > selected);
        const upcoming = (column) => db.query(`SELECT id, full_name, mobile, ${column} AS the_date FROM customers
       WHERE is_active = 1 AND ${column} IS NOT NULL AND DATE_FORMAT(${column}, '%m-%d') BETWEEN DATE_FORMAT(?, '%m-%d') AND DATE_FORMAT(DATE_ADD(?, INTERVAL 7 DAY), '%m-%d')
       ORDER BY DATE_FORMAT(${column}, '%m-%d') LIMIT 20`, [selected, selected]);
        const birthdays = await upcoming('birthday');
        const anniversaries = await upcoming('anniversary');
        const balanceDue = deliveryRows.reduce((a, r) => a + fl(r.current_due), 0);
        const u = (p) => ctx.baseUrl(p);
        const e = esc;
        const sectionHead = (icon, title, count, tone = '') => html `
    <div class="dd-sec-head">
      <h6><i class="fa-solid ${icon}"></i>${title}</h6>
      ${count > 0 ? html `<span class="dd-count ${tone}">${count}</span>` : ''}
    </div>
    `;
        const orderTable = (rows, emptyMessage) => {
            if (rows.length === 0)
                return raw(`<p class="dd-empty">${e(emptyMessage)}</p>`);
            return html `
    <div class="table-responsive udc-cards-wrap">
      <table class="udc-cards table table-sm mb-0 dd-table">
        <thead><tr><th>Order No.</th><th>Delivery Time</th><th>Customer Details</th><th class="text-end">Pcs</th><th class="text-end">Garments</th><th class="text-end">Net Amount</th><th class="text-end">Paid</th><th class="text-end">Balance</th></tr></thead>
        <tbody>
        ${rows.map((r) => html `
          <tr>
            <td data-label="Order No."><a href="${u('modules/orders/view.php?id=' + r.id)}">${r.order_number}</a></td>
            <td data-label="Delivery Time">${r.due_time ? r.due_time : '—'}</td>
            <td data-label="Customer Details">${r.customer_name}<br><span class="text-muted small">${r.mobile}</span></td>
            <td class="text-end" data-label="Pcs">${String(intOf(r.pcs))}</td>
            <td class="text-end" data-label="Garments">${String(intOf(r.garment_types))}</td>
            <td class="text-end" data-label="Net Amount">${money(r.grand_total)}</td>
            <td class="text-end" data-label="Paid">${money(r.total_paid)}</td>
            <td class="text-end dd-balance" data-label="Balance">${money(r.current_due)}</td>
          </tr>`)}
        </tbody>
        <tfoot>
          <tr class="fw-bold">
            <td colspan="3">Total (${rows.length} orders)</td>
            <td class="text-end">${String(rows.reduce((a, r) => a + intOf(r.pcs), 0))}</td>
            <td></td>
            <td class="text-end">${money(rows.reduce((a, r) => a + fl(r.grand_total), 0))}</td>
            <td class="text-end">${money(rows.reduce((a, r) => a + fl(r.total_paid), 0))}</td>
            <td class="text-end">${money(rows.reduce((a, r) => a + fl(r.current_due), 0))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    `;
        };
        const pendingList = (rows, emptyMessage) => {
            if (rows.length === 0)
                return raw(`<p class="dd-empty">${e(emptyMessage)}</p>`);
            return html `
    <table class="udc-cards table table-sm mb-0 dd-table">
      <thead><tr><th>Order No.</th><th>Due Date</th><th>Customer</th><th class="text-end">Pcs</th></tr></thead>
      <tbody>
      ${rows.map((r) => html `
        <tr>
          <td data-label="Order No."><a href="${u('modules/orders/view.php?id=' + r.id)}">${r.order_number}</a></td>
          <td data-label="Due Date">${dMon(r.due_date)}</td>
          <td data-label="Customer">${r.customer_name}</td>
          <td class="text-end" data-label="Pcs">${intOf(r.pcs)}</td>
        </tr>`)}
      </tbody>
    </table>
    `;
        };
        const occasion = (rows) => html `
        <table class="table table-sm mb-0 dd-table dd-table--plain">
          <thead><tr><th>Customer</th><th>Mobile</th><th class="text-end">Date</th></tr></thead>
          <tbody>
          ${rows.map((b) => html `
            <tr><td><a href="${u('modules/customers/view.php?id=' + b.id)}">${b.full_name}</a></td><td>${b.mobile}</td><td class="text-end">${dMon(b.the_date)}</td></tr>`)}
          </tbody>
        </table>`;
        const J = (v) => JSON.stringify(v);
        return layout(ctx, { title: 'Daily Dashboard' }, html `

<div class="col-12">
  <div class="dd-head">
    <div class="dd-head-title">
      <h4>Daily Dashboard</h4>
      <span>Operational view for one day &middot; <a href="${u('modules/dashboard/index.php')}">business dashboard</a></span>
    </div>

    <form method="get" class="dd-datenav" id="ddDateForm">
      <a href="?date=${prev}" class="dd-nav-btn" aria-label="Previous day"><i class="fa-solid fa-chevron-left"></i></a>
      <div class="dd-date-display">
        <input type="date" name="date" id="ddDateInput" value="${selected}" class="dd-date-input">
        <span class="dd-date-label">
          ${dMY(selected)}
          ${selected === today ? html `<em>Today</em>` : ''}
        </span>
      </div>
      <a href="?date=${next}" class="dd-nav-btn" aria-label="Next day"><i class="fa-solid fa-chevron-right"></i></a>
      ${selected !== today ? html `
        <a href="?date=${today}" class="dd-today-btn">Today</a>` : ''}
    </form>
  </div>
</div>

<div class="col-12">
  <div class="dd-kpis">
    <div class="dd-kpi dd-kpi--urgent">
      <span class="dd-kpi-icon"><i class="fa-solid fa-bolt"></i></span>
      <span class="dd-kpi-body"><span class="dd-kpi-value">${urgentRows.length}</span><span class="dd-kpi-label">Urgent due</span></span>
    </div>
    <div class="dd-kpi dd-kpi--delivery">
      <span class="dd-kpi-icon"><i class="fa-solid fa-truck"></i></span>
      <span class="dd-kpi-body"><span class="dd-kpi-value">${deliveryRows.length}</span><span class="dd-kpi-label">Deliveries due</span></span>
    </div>
    <div class="dd-kpi dd-kpi--pickup">
      <span class="dd-kpi-icon"><i class="fa-solid fa-house-signal"></i></span>
      <span class="dd-kpi-body"><span class="dd-kpi-value">${pickupRows.length}</span><span class="dd-kpi-label">Pickups</span></span>
    </div>
    <div class="dd-kpi dd-kpi--overdue">
      <span class="dd-kpi-icon"><i class="fa-solid fa-triangle-exclamation"></i></span>
      <span class="dd-kpi-body"><span class="dd-kpi-value">${pendingOverdue.length}</span><span class="dd-kpi-label">Overdue orders</span></span>
    </div>
    <div class="dd-kpi dd-kpi--money">
      <span class="dd-kpi-icon"><i class="fa-solid fa-indian-rupee-sign"></i></span>
      <span class="dd-kpi-body"><span class="dd-kpi-value dd-kpi-value--money">${money(balanceDue)}</span><span class="dd-kpi-label">Balance on today's deliveries</span></span>
    </div>
  </div>
</div>

<div class="col-12">
  <div class="card dd-card dd-card--urgent">
    <div class="card-body">
      ${sectionHead('fa-bolt', 'Urgent Order Status', urgentRows.length, 'dd-count--urgent')}
      ${orderTable(urgentRows, 'No urgent orders due on this date.')}
    </div>
  </div>
</div>

<div class="col-12">
  <div class="card dd-card dd-card--delivery">
    <div class="card-body">
      ${sectionHead('fa-truck', 'Delivery Status', deliveryRows.length, 'dd-count--delivery')}
      ${orderTable(deliveryRows, 'No orders due for delivery on this date.')}
    </div>
  </div>
</div>

<div class="col-12">
  <div class="card dd-card dd-card--pickup">
    <div class="card-body">
      ${sectionHead('fa-house-signal', 'Home Pick Up Scheduler', pickupRows.length, 'dd-count--pickup')}
      ${pickupRows.length === 0 ? html `
        <p class="dd-empty">No pickups scheduled for this date.</p>` : html `
        <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-sm mb-0 dd-table">
            <thead><tr><th>Pickup No.</th><th>Time</th><th>Customer</th><th>Address</th><th class="text-end">Garments</th><th>Status</th></tr></thead>
            <tbody>
            ${pickupRows.map((p) => html `
              <tr>
                <td data-label="Pickup No.">${p.pickup_number}</td>
                <td data-label="Time">${p.pickup_time ? p.pickup_time : '—'}</td>
                <td data-label="Customer">${p.customer_name}<br><span class="text-muted small">${p.mobile}</span></td>
                <td class="small" data-label="Address">${p.address}</td>
                <td class="text-end" data-label="Garments">${p.garment_count !== null ? intOf(p.garment_count) : '—'}</td>
                <td data-label="Status"><span class="badge bg-secondary">${p.status}</span></td>
              </tr>`)}
            </tbody>
          </table>
        </div>`}
    </div>
  </div>
</div>

<div class="col-12">
  <div class="card dd-card">
    <div class="card-body">
      ${sectionHead('fa-shirt', 'Pending for Pressing', pendingWork.length)}

      <p class="dd-note">
        <i class="fa-solid fa-circle-info"></i>
        No distinct <strong>Pressing</strong> stage exists in the current data model. This shows
        <strong>all items not yet Ready/Packed/Delivered</strong> — general pending work — bucketed by due date.
      </p>

      <div class="row g-3 dd-buckets">
        <div class="col-md-4">
          <div class="dd-bucket dd-bucket--over">
            <div class="dd-bucket-head">Over Due <span>${pendingOverdue.length}</span></div>
            ${pendingList(pendingOverdue, 'None overdue.')}
          </div>
        </div>
        <div class="col-md-4">
          <div class="dd-bucket dd-bucket--today">
            <div class="dd-bucket-head">Today's Due <span>${pendingToday.length}</span></div>
            ${pendingList(pendingToday, 'None due today.')}
          </div>
        </div>
        <div class="col-md-4">
          <div class="dd-bucket dd-bucket--future">
            <div class="dd-bucket-head">Future Due <span>${pendingFuture.length}</span></div>
            ${pendingList(pendingFuture, 'None due in future.')}
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="col-lg-6">
  <div class="card dd-card h-100">
    <div class="card-body">
      ${sectionHead('fa-industry', 'Workshop Workload', workshopRows.length)}
      ${workshopRows.length === 0 ? html `
        <p class="dd-empty">No items currently in Workshop/Processing.</p>` : html `
        <table class="udc-cards table table-sm mb-0 dd-table">
          <thead><tr><th>Garment</th><th>Service</th><th>Status</th><th class="text-end">Items</th></tr></thead>
          <tbody>
          ${workshopRows.map((w) => html `
            <tr><td data-label="Garment">${w.garment_name}</td><td data-label="Service">${w.service_name}</td><td data-label="Status"><span class="dd-chip">${w.item_status}</span></td><td class="text-end" data-label="Items">${intOf(w.item_count)}</td></tr>`)}
          </tbody>
        </table>`}
    </div>
  </div>
</div>
<div class="col-lg-6">
  <div class="card dd-card h-100">
    <div class="card-body">
      ${sectionHead('fa-box-open', 'Ready and Delivery Status', readyRows.length)}
      ${readyRows.length === 0 ? html `
        <p class="dd-empty">No orders reached Ready/Packed/Delivered on this date.</p>` : html `
        <table class="table table-sm mb-0 dd-table dd-table--plain">
          <thead><tr><th>Status</th><th class="text-end">Orders</th></tr></thead>
          <tbody>
          ${readyRows.map((r) => html `
            <tr><td>${r.status_label}</td><td class="text-end fw-bold">${intOf(r.order_count)}</td></tr>`)}
          </tbody>
        </table>`}
    </div>
  </div>
</div>

<div class="col-lg-6">
  <div class="card dd-card h-100">
    <div class="card-body">
      ${sectionHead('fa-cake-candles', 'Upcoming Birthdays', birthdays.length)}
      <p class="dd-sub">Next 7 days</p>
      ${birthdays.length === 0 ? html `
        <p class="dd-empty">No upcoming birthdays in this window.</p>` : occasion(birthdays)}
    </div>
  </div>
</div>
<div class="col-lg-6">
  <div class="card dd-card h-100">
    <div class="card-body">
      ${sectionHead('fa-heart', 'Upcoming Anniversaries', anniversaries.length)}
      <p class="dd-sub">Next 7 days</p>
      ${anniversaries.length === 0 ? html `
        <p class="dd-empty">No upcoming anniversaries in this window.</p>` : occasion(anniversaries)}
    </div>
  </div>
</div>

${raw(dailyStyle(u, J, esc))}

${raw(dailyScript(u, J, esc))}
`);
    });
}
