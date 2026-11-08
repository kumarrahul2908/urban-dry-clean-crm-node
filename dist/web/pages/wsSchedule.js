import { dMY, qty } from '../format.js';
import { html } from '../html.js';
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
/** ws_schedule_render(): the Workshop Staff dashboard (also the schedule screen of the workshop module). */
export function wsScheduleRender(s, money) {
    return html `${dueSection('Going out today', dMY(s.today_date), s.today, 'No garments at the workshop are due back today.', 'primary', money)}${dueSection('Going out tomorrow', dMY(s.tomorrow_date), s.tomorrow, 'No garments at the workshop are due back tomorrow.', 'info', money)}${overdueSection(s.overdue)}`;
}
function dueSection(title, dateLabel, byStore, emptyText, border, money) {
    let orders = 0, garments = 0, value = 0;
    for (const list of Object.values(byStore))
        for (const o of Object.values(list)) {
            orders++;
            garments += o.garments;
            value += sum(o.items);
        }
    const stores = Object.entries(byStore);
    return html `
    <div class="col-12">
      <div class="card border-${border}">
        <div class="card-header bg-${border} bg-opacity-10 d-flex justify-content-between align-items-center flex-wrap gap-2">
          <strong>${title} <span class="text-muted fw-normal small">&middot; ${dateLabel} &middot; garments due back to their store</span></strong>
          <span>
            <span class="badge bg-secondary">${orders} order${orders === 1 ? '' : 's'}</span>
            <span class="badge bg-primary">${qty(garments)} garment${garments === 1 ? '' : 's'}</span>
            <span class="badge bg-success">${money(value)}</span>
          </span>
        </div>
        <div class="card-body">
          ${stores.length === 0 ? html `
            <p class="text-muted small mb-0">${emptyText}</p>` : stores.map(([storeName, byOrder]) => {
        const list = Object.values(byOrder);
        const sg = list.reduce((a, o) => a + o.garments, 0), sv = list.reduce((a, o) => a + sum(o.items), 0);
        return html `
            <h6 class="mt-2 mb-1">${storeName} <span class="text-muted small fw-normal">&mdash; ${list.length} order${list.length === 1 ? '' : 's'} &middot; ${qty(sg)} garments &middot; ${money(sv)}</span></h6>
            <div class="table-responsive mb-2">
              <table class="table table-sm table-hover mb-0">
                <thead><tr><th>Order</th><th>Customer</th><th>Due time</th><th class="text-end">Garments</th><th class="text-end">Bill value</th><th>Workshop status</th></tr></thead>
                <tbody>
                ${list.map((o) => html `
                  <tr>
                    <td>${String(o.order_number)}</td>
                    <td>${String(o.customer)}</td>
                    <td>${o.due_time ? String(o.due_time).slice(0, 5) : '—'}</td>
                    <td class="text-end">${qty(o.garments)}</td>
                    <td class="text-end">${money(sum(o.items))}</td>
                    <td>${Object.keys(o.statuses).map((st) => html `<span class="badge bg-light text-dark border me-1">${st}</span>`)}</td>
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
function overdueSection(byStore) {
    const cap = 50;
    const orders = new Set();
    let garments = 0;
    for (const rows of Object.values(byStore))
        for (const r of rows) {
            orders.add(r.order_id);
            garments += r.qty;
        }
    const stores = Object.entries(byStore);
    return html `
    <div class="col-12">
      <div class="card border-danger">
        <div class="card-header bg-danger text-white d-flex justify-content-between align-items-center flex-wrap gap-2">
          <strong><i class="fa-solid fa-triangle-exclamation me-1"></i>Overdue Garments <span class="fw-normal small">&middot; still at the workshop, due date already passed</span></strong>
          <span>
            <span class="badge bg-light text-danger">${orders.size} order${orders.size === 1 ? '' : 's'}</span>
            <span class="badge bg-light text-danger">${qty(garments)} garment${garments === 1 ? '' : 's'}</span>
          </span>
        </div>
        <div class="card-body">
          ${stores.length === 0 ? html `
            <p class="text-muted small mb-0">Nothing at the workshop is overdue.</p>` : stores.map(([storeName, rows]) => html `
            <h6 class="mt-2 mb-1 text-danger">${storeName} <span class="small fw-normal">&mdash; ${rows.length} garment line${rows.length === 1 ? '' : 's'} overdue</span></h6>
            <div class="table-responsive mb-2">
              <table class="table table-sm mb-0">
                <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th class="text-end">Qty</th><th>Due date</th><th>Overdue by</th><th>Status</th></tr></thead>
                <tbody>
                ${rows.slice(0, cap).map((r) => html `
                  <tr class="table-danger">
                    <td class="fw-bold text-danger">${String(r.order_number)}</td>
                    <td>${String(r.customer)}</td>
                    <td>${String(r.garment)}</td>
                    <td class="text-end">${qty(r.qty)}</td>
                    <td>${r.due_date}</td>
                    <td><span class="badge bg-danger">${Number(r.days)} day${Number(r.days) === 1 ? '' : 's'}</span></td>
                    <td class="fw-semibold text-danger">${r.status}</td>
                  </tr>`)}
                ${rows.length > cap ? html `
                  <tr><td colspan="7" class="text-center text-danger small">&hellip; and ${rows.length - cap} more overdue garment line(s) for this store (oldest first)</td></tr>` : ''}
                </tbody>
              </table>
            </div>`)}
        </div>
      </div>
    </div>
    `;
}
