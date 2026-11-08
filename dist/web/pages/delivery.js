import { DELIVERY_MANAGER_ROLES } from '../../auth/authService.js';
import { phpEmpty } from '../../lib/php.js';
import { WebRedirect, WebText, webPage } from '../context.js';
import { flt, int, numberFormat } from '../format.js';
import { e, html, raw } from '../html.js';
import { layout } from '../layout.js';
import { driversScript, slipScript } from './delivery.static.js';
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => str(v).trim();
const body = (ctx) => (ctx.req.body ?? {});
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c) => (c ? 'selected' : '');
const orDash = (v) => { const s = String(v ?? ''); return s === '' || s === '0' ? '—' : s; };
const urgentBadge = (name) => (name ? html `<span class="badge bg-danger">${String(name)}</span>` : '—');
const flash = (ctx, r, ok) => ctx.flashSet(r.success ? 'success' : 'danger', r.success ? ok : (r.errors ?? []).join(' '));
const nl2br = (s) => s.replace(/(\r\n|\n\r|\n|\r)/g, '<br />$1');
export function registerDeliveryPages(app) {
    const { db, fulfillment, whatsapp, printConfig, audit } = app.services;
    const isManager = (ctx) => DELIVERY_MANAGER_ROLES.includes(ctx.roleName());
    const actor = (ctx) => ({ userId: ctx.data.user_id, ip: ctx.req.ip });
    /** Auth::canActAsDelivery() */
    const canActAsDelivery = async (ctx, deliveryId) => {
        if (isManager(ctx))
            return (await db.query('SELECT id FROM delivery_orders WHERE id = ?', [deliveryId])).length > 0;
        const uid = ctx.data.user?.id ?? ctx.data.user_id;
        if (uid === undefined || uid === null)
            return false;
        return (await db.query('SELECT dl.id FROM delivery_orders dl JOIN drivers d ON d.id = dl.driver_id WHERE dl.id = ? AND d.user_id = ?', [deliveryId, uid])).length > 0;
    };
    const notify = async (ctx, deliveryId, eventKey) => {
        try {
            const row = (await db.query('SELECT o.id AS order_id, o.order_number, c.id AS customer_id, c.full_name, c.mobile FROM delivery_orders d JOIN orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id WHERE d.id = ?', [deliveryId]))[0];
            if (!row || phpEmpty(row.mobile))
                return;
            await whatsapp.enqueue(Number(row.customer_id), Number(row.order_id), String(row.mobile), eventKey, { customer_name: row.full_name, order_number: row.order_number, business_name: (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? ctx.svc.env.APP_NAME }, `${eventKey}:${deliveryId}`);
        }
        catch (ex) {
            console.error(`WhatsApp ${eventKey} enqueue failed:`, ex.message);
        }
    };
    // ---- Home delivery ---------------------------------------------------------------------------
    webPage(app, '/modules/delivery/index', { auth: 'delivery.manage' }, async (ctx, req) => {
        const q = req.query;
        const manager = isManager(ctx);
        if (req.method === 'POST') {
            const p = body(ctx);
            if (!ctx.csrfValid())
                return csrfFail();
            const action = clean(p.action);
            const deliveryId = int(p.delivery_id);
            if (['create', 'assign_driver'].includes(action) && !manager) {
                ctx.flashSet('danger', 'Only delivery managers can schedule deliveries and assign drivers.');
                return new WebRedirect('modules/delivery/index.php');
            }
            if (['out_for_delivery', 'delivered'].includes(action) && !(await canActAsDelivery(ctx, deliveryId))) {
                ctx.flashSet('danger', 'You can only update deliveries assigned to you.');
                return new WebRedirect('modules/delivery/index.php');
            }
            const a = actor(ctx);
            if (action === 'create')
                flash(ctx, await fulfillment.createDelivery(int(p.order_id), 'delivery_date' in p ? clean(p.delivery_date) : ctx.today, clean(p.time_slot), clean(p.remarks), a), 'Delivery scheduled.');
            else if (action === 'assign_driver')
                flash(ctx, await fulfillment.assignDeliveryDriver(deliveryId, int(p.driver_id), a), 'Driver assigned.');
            else if (action === 'out_for_delivery') {
                const r = await fulfillment.markOutForDelivery(deliveryId, a);
                flash(ctx, r, 'Marked Out for Delivery.');
                if (r.success)
                    await notify(ctx, deliveryId, 'out_for_delivery');
            }
            else if (action === 'delivered') {
                const r = await fulfillment.markDelivered(deliveryId, a);
                flash(ctx, r, 'Marked Delivered.');
                if (r.success)
                    await notify(ctx, deliveryId, 'delivered');
            }
            return new WebRedirect('modules/delivery/index.php');
        }
        const orderSearch = clean(q.order), customerSearch = clean(q.customer), statusFilter = clean(q.status);
        let ew = `os.status_key != 'cancelled'
       AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.item_status != 'Packed')
       AND EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM pickup_orders p WHERE p.order_id = o.id AND p.status NOT IN ('Picked Up','Cancelled','Completed'))
       AND NOT EXISTS (SELECT 1 FROM delivery_orders d WHERE d.order_id = o.id AND d.status NOT IN ('Delivered','Cancelled'))`;
        const ep = [];
        if (orderSearch !== '') {
            ew += ' AND o.order_number LIKE ?';
            ep.push(`%${orderSearch}%`);
        }
        if (customerSearch !== '') {
            ew += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)';
            ep.push(`%${customerSearch}%`, `%${customerSearch}%`);
        }
        const eligible = statusFilter === '' || statusFilter === 'eligible' ? await db.query(`SELECT o.id, o.order_number, o.due_date, o.due_time, o.grand_total, o.total_paid, o.current_due, c.full_name AS customer_name, c.mobile, ul.level_name AS urgent_level_name,
       (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count
       FROM orders o JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id
       WHERE ${ew} ORDER BY (o.urgent_level_id IS NULL), o.due_date`, ep) : [];
        let where = '1=1';
        const params = [];
        if (!manager) {
            where += ' AND drv.user_id = ?';
            params.push(ctx.data.user_id ?? 0);
        }
        if (statusFilter !== '' && statusFilter !== 'eligible') {
            where += ' AND dl.status = ?';
            params.push(statusFilter);
        }
        if (orderSearch !== '') {
            where += ' AND o.order_number LIKE ?';
            params.push(`%${orderSearch}%`);
        }
        if (customerSearch !== '') {
            where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)';
            params.push(`%${customerSearch}%`, `%${customerSearch}%`);
        }
        const active = await db.query(`SELECT dl.*, o.order_number, o.grand_total, o.total_paid, ul.level_name AS urgent_level_name, c.full_name AS customer_name, drv.driver_name,
       (SELECT COUNT(*) FROM order_items WHERE order_id = dl.order_id) AS item_count
       FROM delivery_orders dl JOIN orders o ON o.id = dl.order_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id JOIN customers c ON c.id = dl.customer_id LEFT JOIN drivers drv ON drv.id = dl.driver_id
       WHERE ${where} AND dl.status NOT IN ('Delivered','Cancelled') ORDER BY dl.delivery_date`, params);
        const drivers = await db.query('SELECT id, driver_name FROM drivers WHERE is_active=1 ORDER BY driver_name');
        const money = await ctx.loadMoney();
        const u = (p) => ctx.baseUrl(p);
        return layout(ctx, { title: 'Home Delivery' }, html `
<div class="col-12">
  <div class="d-flex justify-content-between align-items-center mb-2">
    <div></div>
    ${ctx.can('drivers.manage') ? html `<a href="${u('modules/delivery/drivers.php')}" class="btn btn-outline-secondary btn-sm"><i class="fa-solid fa-id-card me-1"></i>Manage Drivers</a>` : ''}
    <a href="${u('modules/delivery/my_deliveries.php')}" class="btn btn-outline-secondary btn-sm"><i class="fa-solid fa-route me-1"></i>My Deliveries</a>
  </div>
  <div class="card mb-3">
    <div class="card-body">
      <form class="row g-2" method="GET">
        <div class="col-md-3"><input type="text" name="order" class="form-control form-control-sm" value="${orderSearch}" placeholder="Order Number"></div>
        <div class="col-md-3"><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}" placeholder="Customer/Mobile"></div>
        <div class="col-md-3">
          <select name="status" class="form-select form-select-sm">
            <option value="">All</option>
            <option value="eligible" ${sel(statusFilter === 'eligible')}>Eligible (not yet scheduled)</option>
            <option value="Pending" ${sel(statusFilter === 'Pending')}>Pending</option>
            <option value="Assigned" ${sel(statusFilter === 'Assigned')}>Assigned</option>
            <option value="Out for Delivery" ${sel(statusFilter === 'Out for Delivery')}>Out for Delivery</option>
          </select>
        </div>
        <div class="col-md-3"><button class="btn btn-outline-primary btn-sm w-100">Filter</button></div>
      </form>
    </div>
  </div>

  ${eligible.length && manager ? html `
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold">Eligible for Delivery (fully packed, not yet scheduled)</h6>
      <table class="udc-cards table table-sm">
        <thead><tr><th>Order</th><th>Customer</th><th>Mobile</th><th>Items</th><th>Total</th><th>Paid</th><th>Due</th><th>Due Date</th><th>Urgent</th><th></th></tr></thead>
        <tbody>
        ${eligible.map((o) => html `
          <tr>
            <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + o.id)}">${o.order_number}</a></td>
            <td data-label="Customer">${o.customer_name}</td>
            <td data-label="Mobile">${o.mobile}</td>
            <td data-label="Items">${int(o.item_count)}</td>
            <td data-label="Total">${raw(money(o.grand_total))}</td>
            <td data-label="Paid">${raw(money(o.total_paid))}</td>
            <td class="${flt(o.current_due) > 0 ? 'text-danger fw-bold' : ''}" data-label="Due">${raw(money(o.current_due))}</td>
            <td data-label="Due Date">${raw(ctx.date(o.due_date))}</td>
            <td data-label="Urgent">${urgentBadge(o.urgent_level_name)}</td>
            <td data-label="">
              <form method="POST" class="d-flex gap-1">
                ${ctx.csrfField()}
                <input type="hidden" name="action" value="create">
                <input type="hidden" name="order_id" value="${o.id}">
                <input type="date" name="delivery_date" class="form-control form-control-sm" value="${ctx.today}" style="width:130px">
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
      <h6 class="fw-bold">Pending / Assigned / Out for Delivery</h6>
      <table class="udc-cards table table-sm">
        <thead><tr><th>Delivery #</th><th>Order</th><th>Customer</th><th>Mobile</th><th>Address</th><th>Items</th><th>Due</th><th>Date</th><th>Status</th><th>Driver</th><th>Urgent</th><th>Actions</th></tr></thead>
        <tbody>
        ${active.length === 0 ? html `<tr><td colspan="12" class="text-center text-muted py-3">No active deliveries.</td></tr>` : ''}
        ${active.map((d) => html `
          <tr>
            <td data-label="Delivery #">${d.delivery_number}</td>
            <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + d.order_id)}">${d.order_number}</a></td>
            <td data-label="Customer">${d.customer_name}</td>
            <td data-label="Mobile">${String(d.phone ?? '')}</td>
            <td class="small" data-label="Address">${String(d.address ?? '')}</td>
            <td data-label="Items">${int(d.item_count)}</td>
            <td class="${flt(d.amount_due) > 0 ? 'text-danger fw-bold' : ''}" data-label="Due">${raw(money(d.amount_due))}</td>
            <td data-label="Date">${raw(ctx.date(d.delivery_date))}</td>
            <td data-label="Status"><span class="badge bg-info text-dark">${d.status}</span></td>
            <td data-label="Driver">${orDash(d.driver_name)}</td>
            <td data-label="Urgent">${urgentBadge(d.urgent_level_name)}</td>
            <td class="text-nowrap" data-label="Actions">
              ${!d.driver_id && manager ? html `
                <form method="POST" class="d-inline mb-1">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="assign_driver">
                  <input type="hidden" name="delivery_id" value="${d.id}">
                  <select name="driver_id" class="form-select form-select-sm d-inline" style="width:auto;display:inline-block;">
                    ${drivers.map((dr) => html `<option value="${dr.id}">${dr.driver_name}</option>`)}
                  </select>
                  <button type="submit" class="btn btn-sm btn-outline-primary">Assign</button>
                </form>` : ''}
              ${['Pending', 'Assigned'].includes(d.status) ? html `
                <form method="POST" class="d-inline">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="out_for_delivery">
                  <input type="hidden" name="delivery_id" value="${d.id}">
                  <button type="submit" class="btn btn-sm btn-outline-warning">Out for Delivery</button>
                </form>` : html `
                <form method="POST" class="d-inline">
                  ${ctx.csrfField()}
                  <input type="hidden" name="action" value="delivered">
                  <input type="hidden" name="delivery_id" value="${d.id}">
                  <button type="submit" class="btn btn-sm btn-outline-success">Delivered</button>
                </form>`}
              <a class="btn btn-sm btn-outline-secondary" target="_blank" href="${u('modules/delivery/slip_print.php?delivery_id=' + d.id)}" title="Print Delivery Slip"><i class="fa-solid fa-print"></i></a>
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>
</div>
`);
    });
    // ---- Drivers ---------------------------------------------------------------------------------
    webPage(app, '/modules/delivery/drivers', { auth: 'drivers.manage' }, async (ctx, req) => {
        const errors = [];
        if (req.method === 'POST') {
            const p = body(ctx);
            if (!ctx.csrfValid())
                return csrfFail();
            const action = clean(p.action), id = int(p.id), name = clean(p.driver_name), mobile = clean(p.mobile), vehicle = clean(p.vehicle_number), area = clean(p.area_assigned);
            const isActive = 'is_active' in p ? 1 : 0;
            if (action === 'save') {
                if (name === '')
                    errors.push('Driver name is required.');
                else {
                    if (id) {
                        await db.execute('UPDATE drivers SET driver_name=?, mobile=?, vehicle_number=?, area_assigned=?, is_active=? WHERE id=?', [name, mobile, vehicle, area, isActive, id]);
                        await audit.record({ action: 'edit', module: 'drivers', recordId: String(id), newValue: { driver_name: name }, userId: ctx.data.user_id, ip: req.ip });
                        ctx.flashSet('success', 'Driver updated.');
                    }
                    else {
                        const n = int((await db.query('SELECT COUNT(*)+1 AS n FROM drivers'))[0].n);
                        const code = 'DRV-' + String(n).padStart(4, '0');
                        const ins = await db.execute('INSERT INTO drivers (driver_name, driver_code, mobile, vehicle_number, area_assigned, is_active) VALUES (?,?,?,?,?,?)', [name, code, mobile, vehicle, area, isActive]);
                        await audit.record({ action: 'create', module: 'drivers', recordId: String(ins.insertId), newValue: { driver_name: name }, userId: ctx.data.user_id, ip: req.ip });
                        ctx.flashSet('success', 'Driver added.');
                    }
                    return new WebRedirect('modules/delivery/drivers.php');
                }
            }
        }
        const drivers = await db.query(`SELECT d.*, (SELECT COUNT(*) FROM delivery_orders WHERE driver_id = d.id AND status NOT IN ('Delivered','Cancelled')) AS active_deliveries,
       (SELECT COUNT(*) FROM pickup_orders WHERE driver_id = d.id AND status NOT IN ('Picked Up','Cancelled','Completed')) AS active_pickups FROM drivers d ORDER BY d.driver_name`);
        const u = (p) => ctx.baseUrl(p);
        return layout(ctx, { title: 'Drivers' }, html `
${errors.length ? html `
  <div class="col-12"><div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html `<li>${er}</li>`)}</ul></div></div>` : ''}
<div class="col-12">
  <div class="card mb-3">
    <div class="card-body">
      <button type="button" class="btn btn-primary btn-sm" data-bs-toggle="modal" data-bs-target="#driverModal" id="addDriverBtn"><i class="fa-solid fa-plus me-1"></i>Add Driver</button>
    </div>
  </div>
  <div class="card">
    <div class="card-body">
      <table class="udc-cards table table-sm">
        <thead><tr><th>Code</th><th>Name</th><th>Mobile</th><th>Vehicle</th><th>Area</th><th>Status</th><th>Active Deliveries</th><th>Active Pickups</th><th>Active</th><th></th></tr></thead>
        <tbody>
        ${drivers.map((d) => html `
          <tr>
            <td data-label="Code">${d.driver_code}</td>
            <td data-label="Name">${d.driver_name}</td>
            <td data-label="Mobile">${String(d.mobile ?? '')}</td>
            <td data-label="Vehicle">${String(d.vehicle_number ?? '')}</td>
            <td data-label="Area">${String(d.area_assigned ?? '')}</td>
            <td data-label="Status"><span class="badge bg-secondary">${d.status}</span></td>
            <td data-label="Active Deliveries">${int(d.active_deliveries)}</td>
            <td data-label="Active Pickups">${int(d.active_pickups)}</td>
            <td data-label="Active">${d.is_active ? raw('<span class="badge bg-success">Active</span>') : raw('<span class="badge bg-secondary">Inactive</span>')}</td>
            <td data-label="">
              <button type="button" class="btn btn-sm btn-outline-primary edit-driver-btn"
                data-id="${d.id}" data-name="${d.driver_name}" data-mobile="${String(d.mobile ?? '')}"
                data-vehicle="${String(d.vehicle_number ?? '')}" data-area="${String(d.area_assigned ?? '')}"
                data-active="${d.is_active}" data-bs-toggle="modal" data-bs-target="#driverModal">Edit</button>
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="modal fade" id="driverModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <form method="POST">
        ${ctx.csrfField()}
        <input type="hidden" name="action" value="save">
        <input type="hidden" name="id" id="driverId">
        <div class="modal-header"><h5 class="modal-title" id="driverModalTitle">Add Driver</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
        <div class="modal-body row g-2">
          <div class="col-12"><label class="form-label small">Name *</label><input type="text" name="driver_name" id="driverName" class="form-control" required></div>
          <div class="col-6"><label class="form-label small">Mobile</label><input type="text" name="mobile" id="driverMobile" class="form-control"></div>
          <div class="col-6"><label class="form-label small">Vehicle Number</label><input type="text" name="vehicle_number" id="driverVehicle" class="form-control"></div>
          <div class="col-12"><label class="form-label small">Area Assigned</label><input type="text" name="area_assigned" id="driverArea" class="form-control"></div>
          <div class="col-12">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" name="is_active" id="driverActive" checked>
              <label class="form-check-label" for="driverActive">Active</label>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    </div>
  </div>
</div>
${raw(driversScript(u, JSON.stringify, e))}
`);
    });
    // ---- My deliveries ---------------------------------------------------------------------------
    webPage(app, '/modules/delivery/my_deliveries', { auth: 'delivery.manage' }, async (ctx, req) => {
        if (req.method === 'POST') {
            const p = body(ctx);
            if (!ctx.csrfValid())
                return csrfFail();
            const action = clean(p.action), deliveryId = int(p.delivery_id);
            if (!deliveryId || !(await canActAsDelivery(ctx, deliveryId))) {
                ctx.flashSet('danger', 'You are not authorized to update this delivery.');
                return new WebRedirect('modules/delivery/my_deliveries.php'); // PHP turns the preceding 403 into 302 when a Location header is sent
            }
            const a = actor(ctx);
            const r = action === 'out_for_delivery' ? await fulfillment.markOutForDelivery(deliveryId, a) : action === 'delivered' ? await fulfillment.markDelivered(deliveryId, a) : { success: false, errors: ['Unknown action.'] };
            flash(ctx, r, 'Updated.');
            return new WebRedirect('modules/delivery/my_deliveries.php');
        }
        const myDriver = (await db.query('SELECT id FROM drivers WHERE user_id = ?', [ctx.data.user_id]))[0];
        let where = "dl.status NOT IN ('Delivered','Cancelled')";
        const params = [];
        if (myDriver) {
            where += ' AND dl.driver_id = ?';
            params.push(myDriver.id);
        }
        else if (isManager(ctx))
            where += ' AND dl.driver_id IS NOT NULL';
        else
            where += ' AND 1 = 0';
        const rows = await db.query(`SELECT dl.*, o.order_number, ul.level_name AS urgent_level_name, c.full_name AS customer_name, (SELECT COUNT(*) FROM order_items WHERE order_id = dl.order_id) AS item_count
       FROM delivery_orders dl JOIN orders o ON o.id = dl.order_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id JOIN customers c ON c.id = dl.customer_id
       WHERE ${where} ORDER BY (o.urgent_level_id IS NULL), dl.delivery_date`, params);
        const money = await ctx.loadMoney();
        return layout(ctx, { title: 'My Deliveries' }, html `
<div class="col-12">
  ${rows.length === 0 ? html `
    <p class="text-muted text-center py-4">No deliveries currently assigned to you.</p>` : ''}
  ${rows.map((d) => html `
    <div class="card mb-2">
      <div class="card-body">
        <div class="d-flex justify-content-between">
          <strong>${d.order_number}</strong>
          ${d.urgent_level_name ? html `<span class="badge bg-danger">${d.urgent_level_name}</span>` : ''}
        </div>
        <div>${d.customer_name} &middot; ${String(d.phone ?? '')}</div>
        <div class="text-muted small">${String(d.address ?? '')}</div>
        <div class="small mt-1">${int(d.item_count)} item(s) &middot; Due amount: <span class="${flt(d.amount_due) > 0 ? 'text-danger fw-bold' : ''}">${raw(money(d.amount_due))}</span></div>
        <div class="mt-2">
          <span class="badge bg-info text-dark mb-2">${d.status}</span>
          ${['Pending', 'Assigned'].includes(d.status) ? html `
            <form method="POST" class="d-inline">
              ${ctx.csrfField()}
              <input type="hidden" name="action" value="out_for_delivery">
              <input type="hidden" name="delivery_id" value="${d.id}">
              <button type="submit" class="btn btn-warning btn-sm w-100">Start — Out for Delivery</button>
            </form>` : html `
            <form method="POST" class="d-inline">
              ${ctx.csrfField()}
              <input type="hidden" name="action" value="delivered">
              <input type="hidden" name="delivery_id" value="${d.id}">
              <button type="submit" class="btn btn-success btn-sm w-100">Mark Delivered</button>
            </form>`}
        </div>
      </div>
    </div>`)}
</div>
`);
    });
    // ---- Delivery slip (standalone print page) ---------------------------------------------------
    webPage(app, '/modules/delivery/slip_print', { auth: 'delivery.manage' }, async (ctx, req) => {
        const deliveryId = int(req.query.delivery_id);
        if (!(await canActAsDelivery(ctx, deliveryId)))
            return new WebText('<h2>403 - Access Denied</h2><p>You can only open delivery slips for deliveries assigned to you.</p>', 403);
        const d = (await db.query(`SELECT dl.*, o.order_number, o.invoice_number, o.order_mode, o.grand_total, o.total_paid, o.current_due, o.store_id, c.full_name AS customer_name, c.mobile AS customer_mobile, drv.driver_name
       FROM delivery_orders dl JOIN orders o ON o.id = dl.order_id JOIN customers c ON c.id = dl.customer_id LEFT JOIN drivers drv ON drv.id = dl.driver_id WHERE dl.id = ?`, [deliveryId]))[0];
        if (!d) {
            ctx.flashSet('danger', 'Delivery not found.');
            return new WebRedirect('modules/delivery/index.php');
        }
        const items = d.order_mode === 'weight'
            ? await db.query("SELECT oi.*, CONCAT('Laundry Batch (', oi.quantity, ' garments)') AS garment_name, s.service_name FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [d.order_id])
            : await db.query("SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, COALESCE(s.service_name, 'Unknown Service') AS service_name FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [d.order_id]);
        const businessName = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? '';
        const phone = (await ctx.setting('phone', '')) ?? '';
        const logoPath = (await ctx.setting('logo_path', '')) ?? '';
        const cfg = await printConfig.getDeliveryConfig(int(d.store_id));
        const isThermal = cfg.delivery_printer_type === 'thermal';
        const widthMm = numberFormat(cfg.delivery_width_mm, 2).replace(/,/g, '');
        const heightMm = cfg.delivery_height_mm !== null ? numberFormat(cfg.delivery_height_mm, 2).replace(/,/g, '') : '297.00';
        const money = await ctx.loadMoney();
        const u = (p) => ctx.baseUrl(p);
        const truthy = (s) => s !== '' && s !== '0';
        return html `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Delivery Slip ${d.delivery_number}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background:#eef1f6; margin:0; padding:20px; color:#1c2230; }
  .sheet { max-width:${isThermal ? widthMm + 'mm' : '600px'}; margin:0 auto; background:#fff; padding:20px; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .brand { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #0b3d91; padding-bottom:12px; margin-bottom:12px; }
  .brand-name { font-size:20px; font-weight:800; color:#0b3d91; }
  .slip-title { font-size:16px; font-weight:700; color:#0b3d91; text-align:right; }
  .box { font-size:13px; margin-bottom:14px; }
  .box h4 { font-size:11px; text-transform:uppercase; color:#888; margin:0 0 4px; letter-spacing:.05em; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:14px; font-size:12.5px; }
  table.items th { background:#f1f5f9; text-align:left; padding:6px; border-bottom:2px solid #dde3ec; font-size:10.5px; text-transform:uppercase; color:#556; }
  table.items td { padding:6px; border-bottom:1px solid #eef1f6; }
  .right { text-align:right; }
  .due-box { background:#fff3f3; border:1px solid #f3c9c9; border-radius:6px; padding:10px 14px; text-align:center; margin-bottom:16px; }
  .due-box .amount { font-size:22px; font-weight:800; color:#b02a2a; }
  .signature-row { display:flex; justify-content:space-between; margin-top:28px; }
  .signature-box { width:45%; border-top:1px solid #999; padding-top:6px; font-size:11px; color:#666; text-align:center; }
  .actions { text-align:center; margin:20px 0; }
  .actions button, .actions a { border:0; background:#0b3d91; color:#fff; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:13px; margin:0 4px; cursor:pointer; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { box-shadow:none; padding:8mm; }
    .actions { display:none; }
    ${isThermal ? html `
    @page { size: ${widthMm}mm auto; margin: 3mm; }` : html `
    @page { size: ${widthMm}mm ${heightMm}mm; margin: 10mm; }`}
  }
</style>
</head>
<body>
<div class="actions"><button onclick="window.print()">Print Delivery Slip</button>
  <span id="localPrintWrap" style="display:none;">
    <select id="localPrintPrinter" style="padding:9px;border-radius:6px;border:1px solid #ccc;"></select>
    <button type="button" id="localPrintBtn">Print via Local Service</button>
  </span>
  <a href="${u('modules/delivery/index.php')}">Back to Deliveries</a></div>
<div class="sheet">
  <div class="brand">
    <div>
      ${truthy(logoPath) ? html `<img src="${u('uploads/logo/' + logoPath)}" style="max-height:40px;margin-bottom:6px;">` : ''}
      <div class="brand-name">${businessName}</div>
      ${truthy(phone) ? html `<div style="font-size:11.5px;color:#555;">Ph: ${phone}</div>` : ''}
    </div>
    <div class="slip-title">DELIVERY SLIP<br><span style="font-size:12px;color:#555;font-weight:400;">${d.delivery_number}</span></div>
  </div>

  <div class="box">
    <h4>Deliver To</h4>
    <div><strong>${d.customer_name}</strong></div>
    <div>${raw(nl2br(e(String(d.address ?? ''))))}</div>
    <div>Mobile: ${String(d.phone ?? '')}</div>
  </div>

  <div class="box">
    <h4>Order Details</h4>
    <div>Order #: <strong>${d.order_number}</strong> &nbsp;&middot;&nbsp; Invoice #: ${String(d.invoice_number ?? '')}</div>
    <div>Delivery Date: ${raw(ctx.date(d.delivery_date))}</div>
    ${d.driver_name ? html `<div>Driver: ${d.driver_name}</div>` : ''}
  </div>

  <table class="items">
    <thead><tr><th>S.No</th><th>Garment</th><th>Service</th><th class="right">Qty</th></tr></thead>
    <tbody>
    ${items.map((it, i) => html `
      <tr>
        <td>${i + 1}</td>
        <td>${it.garment_name}</td>
        <td>${it.service_name}</td>
        <td class="right">${it.weight !== null ? String(it.weight) + ' ' + String(it.unit ?? '') : String(it.quantity) + ' ' + String(it.unit ?? '')}</td>
      </tr>`)}
    </tbody>
  </table>

  ${flt(d.amount_due) > 0 ? html `
  <div class="due-box">
    <div style="font-size:11px;color:#888;text-transform:uppercase;">Amount to Collect (COD)</div>
    <div class="amount">${raw(money(d.amount_due))}</div>
  </div>` : html `
  <div class="box" style="text-align:center;color:#2e7d32;font-weight:700;">No amount due &mdash; fully paid.</div>`}

  <div class="signature-row">
    <div class="signature-box">Customer Signature</div>
    <div class="signature-box">Delivery Executive Signature</div>
  </div>
</div>
${raw(slipScript(u, JSON.stringify, e))}
</body>
</html>`;
    });
}
