import type { FastifyInstance } from 'fastify';
import { yearIn } from '../../lib/dates.js';
import { isNumeric, phpEmpty, phpRound } from '../../lib/php.js';
import { checkCustomerDuplicate } from '../../services/customerService.js';
import { generateCustomerCode, generateDocumentNumber, generateInvoiceNumber, generateOrderNumber } from '../../services/documentNumber.js';
import { GarmentTagService } from '../../services/garmentTagService.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { csvBody } from '../csv.js';
import { flt, httpBuildQuery, int } from '../format.js';
import { e, html, jsonEncode, raw, type Raw } from '../html.js';
import { importCleanupTemp, importStoreTempUpload, importTempPath, parseCsvFile } from '../importTemp.js';
import { layout } from '../layout.js';
import { orderAddItemsScript } from './orders.static.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const csv = (filename: string, headers: string[], rows: unknown[][]) =>
  new WebText(csvBody(headers, rows), 200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${filename}"` });
const strtotimeOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) ? !Number.isNaN(Date.parse(s)) && Number(s.slice(0, 4)) >= 1970 : s !== '' && !Number.isNaN(Date.parse(s));
const truthyStr = (s: string) => s !== '' && s !== '0';

export function registerOrderPortPages(app: FastifyInstance) {
  const { db, orders } = app.services;

  // ---- add_items ------------------------------------------------------------------------------
  webPage(app, '/modules/orders/add_items', { auth: 'orders.edit' }, async (ctx, req) => {
    const orderId = int((req.query as Record<string, unknown>).order_id);
    const order = (await db.query<Row>('SELECT o.*, c.full_name AS customer_name, c.mobile AS customer_mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]))[0];
    if (!order) { ctx.flashSet('danger', 'Order not found.'); return new WebRedirect('modules/orders/list.php'); }
    if (!(await orders.isEditable(order as { status_id: number }))) {
      ctx.flashSet('danger', 'This order can no longer be edited (processing has begun).');
      return new WebRedirect(`modules/orders/view.php?id=${orderId}`);
    }
    if (order.order_mode === 'weight') {
      ctx.flashSet('danger', 'This is a Per-Weight (Laundry) order and cannot use the Add Item screen.');
      return new WebRedirect(`modules/orders/view.php?id=${orderId}`);
    }
    const canManual = ctx.can('pos.manual_rate_override');
    const services = await db.query<Row>('SELECT id, service_name, billing_unit FROM services WHERE is_active=1 ORDER BY sort_order');
    const categories = await db.query<Row>('SELECT id, category_name FROM categories WHERE is_active=1 ORDER BY sort_order');
    const brands = await db.query<Row>('SELECT id, brand_name FROM brands WHERE is_active=1 ORDER BY brand_name');
    const colors = await db.query<Row>('SELECT id, color_name FROM colors WHERE is_active=1 ORDER BY color_name');
    const defects = await db.query<Row>('SELECT id, defect_name FROM defects WHERE is_active=1 ORDER BY defect_name');
    const u = (p: string) => ctx.baseUrl(p);
    const x = [jsonEncode(int(order.price_list_id)), canManual ? 'true' : 'false', services.length ? String(int(services[0]!.id)) : 'null'];
    return layout(ctx, { title: `Add Items to Order ${order.order_number}` }, html`
<div class="col-12 mb-2">
  <div class="alert alert-info d-flex justify-content-between align-items-center">
    <div>
      <strong>Adding items to Order ${order.order_number}</strong>
      — ${order.customer_name} (${order.customer_mobile})
    </div>
    <a href="${u('modules/orders/view.php?id=' + orderId)}" class="btn btn-sm btn-outline-secondary">Back to Order</a>
  </div>
</div>

<div class="col-md-8">
  <div class="card mb-3">
    <div class="card-body">
      <div class="d-flex flex-wrap gap-2 mb-2">
        ${services.map((s, i) => html`
          <button type="button" class="btn btn-sm svc-tab ${i === 0 ? 'btn-primary' : 'btn-outline-primary'}" data-id="${s.id}">${s.service_name}</button>`)}
      </div>
      <div class="d-flex flex-wrap gap-2 mb-3">
        ${categories.map((c) => html`
          <button type="button" class="btn btn-sm btn-outline-secondary cat-tab" data-id="${c.id}">${c.category_name}</button>`)}
      </div>
      <input type="text" id="garmentSearch" class="form-control form-control-sm mb-3" placeholder="Search garment...">
      <div id="garmentGrid" class="garment-grid"><p class="text-muted">Select a category to view garments.</p></div>
    </div>
  </div>
</div>

<div class="col-md-4">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold">New Items to Add</h6>
      <table class="table table-sm">
        <tbody id="cartBody"><tr><td class="text-muted text-center py-3">No items added yet.</td></tr></tbody>
      </table>
      <button type="button" class="btn btn-primary w-100" id="saveItemsBtn" disabled><i class="fa-solid fa-check me-1"></i>Save Items to Order</button>
      <div id="saveError" class="alert alert-danger d-none mt-2"></div>
    </div>
  </div>
</div>

<div class="modal fade" id="addGarmentModal" tabindex="-1">
  <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Add Garment</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div id="agError" class="alert alert-danger d-none"></div>
        <div class="row g-2">
          <div class="col-12">
            <label class="form-label small">Billing Unit</label>
            <input type="text" id="agBillingUnitDisplay" class="form-control form-control-sm" readonly>
          </div>
          <div class="col-6" id="agQtyWrap">
            <label class="form-label small">Quantity (Pieces) *</label>
            <div class="input-group input-group-sm">
              <button type="button" class="btn btn-outline-secondary" id="agQtyMinus">−</button>
              <input type="number" id="agQuantity" class="form-control text-center" value="1" min="1" step="1">
              <button type="button" class="btn btn-outline-secondary" id="agQtyPlus">+</button>
            </div>
          </div>
          <div class="col-6 d-none" id="agWeightWrap">
            <label class="form-label small">Weight (KG) *</label>
            <input type="number" id="agWeight" class="form-control form-control-sm" min="0.01" step="0.01">
          </div>
          <div class="col-6">
            <label class="form-label small">Configured Rate</label>
            <input type="text" id="agConfiguredRate" class="form-control form-control-sm" readonly>
          </div>
          <div class="col-6">
            <label class="form-label small">Final Rate (editable) *</label>
            <input type="number" id="agRateOverride" class="form-control form-control-sm" min="0" step="0.01">
          </div>
          <div class="col-12 d-none" id="agManualOverrideSection">
            <div id="agManualOverrideOfferRow" class="d-none">
              <button type="button" class="btn btn-outline-warning btn-sm" id="agEnableManualOverrideBtn">Enable Manual Rate Override</button>
            </div>
            <div id="agManualOverrideUnauthorized" class="alert alert-warning py-1 px-2 small d-none mb-0 mt-1">
              You are not authorized to use Manual Rate Override. Contact an authorized user.
            </div>
            <div id="agManualOverrideActive" class="border border-warning rounded p-2 mt-1 d-none">
              <div class="fw-bold text-warning-emphasis small mb-1">MANUAL RATE OVERRIDE — AUTHORIZED</div>
              <div class="small text-muted" id="agManualOverrideConfiguredNote"></div>
              <div class="form-text small">Enter the authorized unit rate in the Final Rate field above. This will be recorded as a manual override with the original configured rate (if any) preserved for audit.</div>
              <button type="button" class="btn btn-link btn-sm p-0 mt-1" id="agCancelManualOverrideBtn">Cancel override, use normal pricing</button>
            </div>
          </div>
          <div class="col-6">
            <label class="form-label small">Tax</label>
            <input type="text" id="agTaxDisplay" class="form-control form-control-sm" readonly>
          </div>
          <div class="col-6">
            <label class="form-label small">Estimated Line Total</label>
            <input type="text" id="agLineTotalDisplay" class="form-control form-control-sm fw-bold" readonly>
          </div>
          <div class="col-6">
            <label class="form-label small">Brand</label>
            <select id="agBrand" class="form-select form-select-sm">
              <option value="">None</option>
              ${brands.map((b) => html`<option value="${b.id}">${b.brand_name}</option>`)}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label small">Color</label>
            <select id="agColor" class="form-select form-select-sm">
              <option value="">None</option>
              ${colors.map((c) => html`<option value="${c.id}">${c.color_name}</option>`)}
            </select>
          </div>
          <div class="col-12">
            <label class="form-label small">Defects</label>
            <div class="d-flex flex-wrap gap-2">
              ${defects.map((d) => html`
                <div class="form-check form-check-inline">
                  <input class="form-check-input ag-defect" type="checkbox" value="${d.id}" id="agDefect${d.id}">
                  <label class="form-check-label small" for="agDefect${d.id}">${d.defect_name}</label>
                </div>`)}
            </div>
          </div>
          <div class="col-12">
            <label class="form-label small">Remarks</label>
            <input type="text" id="agRemarks" class="form-control form-control-sm">
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
        <button type="button" class="btn btn-primary" id="agAddBtn">Add to List</button>
      </div>
    </div>
  </div>
</div>

${raw(orderAddItemsScript(u, jsonEncode, e, { orderId }, x))}
`);
  });

  // ---- export ---------------------------------------------------------------------------------
  webPage(app, '/modules/orders/export', { auth: 'order.export' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const dateFrom = clean(q.date_from), dateTo = clean(q.date_to), customerSearch = clean(q.customer), serviceId = int(q.service_id), statusId = int(q.status_id), dueDate = clean(q.due_date);
    let where = '1=1';
    const params: unknown[] = [];
    if (dateFrom !== '') { where += ' AND DATE(o.order_date) >= ?'; params.push(dateFrom); }
    if (dateTo !== '') { where += ' AND DATE(o.order_date) <= ?'; params.push(dateTo); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; const like = `%${customerSearch}%`; params.push(like, like); }
    if (serviceId) { where += ' AND oi.service_id = ?'; params.push(serviceId); }
    if (statusId) { where += ' AND o.status_id = ?'; params.push(statusId); }
    if (dueDate !== '') { where += ' AND o.due_date = ?'; params.push(dueDate); }

    if ('export' in q) {
      const data = await db.query<Row>(
        `SELECT o.order_number, o.invoice_number, o.order_date, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile, g.garment_name, s.service_name, oi.quantity, oi.weight, oi.unit_price, oi.weight_rate,
                oi.subtotal, oi.discount, oi.tax, oi.total, oi.item_status, os.status_label, o.grand_total, o.total_paid, o.current_due, o.home_delivery, o.id AS oid, oi.id AS oiid
         FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_statuses os ON os.id = o.status_id JOIN order_items oi ON oi.order_id = o.id JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
         WHERE ${where} AND o.order_mode = 'piece'
         UNION ALL
         SELECT o.order_number, o.invoice_number, o.order_date, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile, CONCAT('Laundry Batch (', oi.quantity, ' garments)') AS garment_name,
                s.service_name, oi.quantity, oi.weight, oi.unit_price, oi.weight_rate, oi.subtotal, oi.discount, oi.tax, oi.total, oi.item_status, os.status_label, o.grand_total, o.total_paid, o.current_due,
                o.home_delivery, o.id AS oid, oi.id AS oiid
         FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_statuses os ON os.id = o.status_id JOIN order_items oi ON oi.order_id = o.id JOIN services s ON s.id = oi.service_id
         WHERE ${where} AND o.order_mode = 'weight'
         ORDER BY oid, oiid`, [...params, ...params]);
      const rows = data.map((r) => [r.order_number, r.invoice_number, r.order_date, r.due_date, r.due_time, r.customer_name, r.mobile, r.garment_name, r.service_name, r.quantity, r.weight, r.unit_price, r.weight_rate,
        r.subtotal, r.discount, r.tax, r.total, r.item_status, r.status_label, r.grand_total, r.total_paid, r.current_due, r.home_delivery ? 'Yes' : 'No']);
      await ctx.svc.audit.record({ action: 'export', module: 'orders', recordId: 'export', newValue: { count: rows.length }, userId: ctx.data.user_id, ip: req.ip });
      return csv(`urban_dry_clean_orders_${ctx.today}.csv`,
        ['Order #', 'Invoice #', 'Order Date', 'Due Date', 'Due Time', 'Customer', 'Mobile', 'Garment', 'Service', 'Qty', 'Weight', 'Unit Price', 'Weight Rate', 'Item Subtotal', 'Item Discount', 'Item Tax', 'Item Total',
          'Item Status', 'Order Status', 'Grand Total', 'Total Paid', 'Current Due', 'Home Delivery'], rows);
    }
    const services = await db.query<Row>('SELECT id, service_name FROM services WHERE is_active=1 ORDER BY sort_order');
    const statuses = await db.query<Row>('SELECT id, status_label FROM order_statuses ORDER BY sort_order');
    const matchCount = int((await db.query<Row>(`SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN customers c ON c.id=o.customer_id JOIN order_items oi ON oi.order_id=o.id WHERE ${where}`, params))[0]!.n);
    const qs = httpBuildQuery({ ...(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? '' : v])) as Record<string, unknown>), export: 1 });
    return layout(ctx, { title: 'Export Orders' }, html`
<div class="col-md-9">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold mb-3">Export Orders</h6>
      <p class="text-muted small">Exports one row per order item (order-level fields repeated) — the cleanest structure for spreadsheet analysis of a multi-item order system.</p>
      <form method="GET" class="row g-2">
        <div class="col-md-3"><label class="form-label small">Date From</label><input type="date" name="date_from" class="form-control form-control-sm" value="${dateFrom}"></div>
        <div class="col-md-3"><label class="form-label small">Date To</label><input type="date" name="date_to" class="form-control form-control-sm" value="${dateTo}"></div>
        <div class="col-md-3"><label class="form-label small">Customer</label><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}"></div>
        <div class="col-md-3"><label class="form-label small">Due Date</label><input type="date" name="due_date" class="form-control form-control-sm" value="${dueDate}"></div>
        <div class="col-md-3">
          <label class="form-label small">Service</label>
          <select name="service_id" class="form-select form-select-sm">
            <option value="0">Any</option>
            ${services.map((s) => html`<option value="${s.id}" ${sel(serviceId === Number(s.id))}>${s.service_name}</option>`)}
          </select>
        </div>
        <div class="col-md-3">
          <label class="form-label small">Status</label>
          <select name="status_id" class="form-select form-select-sm">
            <option value="0">Any</option>
            ${statuses.map((s) => html`<option value="${s.id}" ${sel(statusId === Number(s.id))}>${s.status_label}</option>`)}
          </select>
        </div>
        <div class="col-md-3 d-flex align-items-end"><button class="btn btn-outline-primary btn-sm w-100" type="submit"><i class="fa-solid fa-filter me-1"></i>Apply Filters</button></div>
      </form>
      <hr>
      <p>${matchCount} order(s) match the current filters.</p>
      <a href="?${raw(qs)}" class="btn btn-primary"><i class="fa-solid fa-download me-1"></i>Download CSV</a>
    </div>
  </div>
</div>
`);
  });

  // ---- historical import ----------------------------------------------------------------------
  type Group = Row;
  async function validateGroups(rows: Record<string, string>[]): Promise<Group[]> {
    const groups = new Map<string, { line: number; data: Record<string, string> }[]>();
    rows.forEach((row, i) => {
      let ref = (row.order_ref ?? '').trim();
      if (ref === '') ref = `__ungrouped_row_${i}`;
      (groups.get(ref) ?? groups.set(ref, []).get(ref)!).push({ line: i + 2, data: row });
    });
    const statusKeys = (await db.query<Row>('SELECT status_key FROM order_statuses')).map((r) => String(r.status_key));
    const results: Group[] = [];
    for (const [ref, lines] of groups) {
      const first = lines[0]!.data;
      const errs: string[] = [];
      const mobile = (first.customer_mobile ?? '').trim(), customerName = (first.customer_name ?? '').trim(), orderDate = (first.order_date ?? '').trim(), dueDate = (first.due_date ?? '').trim();
      const mobileOk = /^[0-9+ -]{7,15}$/.test(mobile);
      if (mobile === '' || !mobileOk) errs.push('Valid customer_mobile is required.');
      if (orderDate === '' || !strtotimeOk(orderDate)) errs.push('Valid order_date is required.');
      if (dueDate === '' || !strtotimeOk(dueDate)) errs.push('Valid due_date is required.');
      let customerId: number | null = null, customerWarning: string | null = null;
      if (mobile !== '' && mobileOk) {
        const dup = await checkCustomerDuplicate(db, mobile, customerName, null);
        if (dup.action === 'block') customerId = Number(dup.matched_customer.id);
        else if (dup.action === 'warn') customerWarning = `Mobile ${mobile} is already used by ${dup.matches[0]!.full_name} (${dup.matches[0]!.customer_code}) — creating a separate customer for "${customerName}" (shared family/business number). If this was meant to be the same person, fix customer_name in the CSV to match exactly and re-import.`;
        if (!customerId && customerName === '') errs.push('Customer not found by mobile, and customer_name is blank so a new one cannot be created.');
      }
      let statusKey = (first.status ?? '').trim();
      if (!truthyStr(statusKey)) statusKey = 'delivered';
      if (!statusKeys.includes(statusKey)) { errs.push(`Status "${statusKey}" is not a recognized order status — will default to "delivered".`); statusKey = 'delivered'; }

      const items: Row[] = [];
      let subtotal = 0;
      for (const ln of lines) {
        const d = ln.data;
        const garmentName = (d.garment ?? '').trim(), serviceName = (d.service ?? '').trim(), qty = (d.quantity ?? '').trim(), weight = (d.weight ?? '').trim(), rate = (d.rate ?? '').trim();
        if (garmentName === '') { errs.push(`Line ${ln.line}: garment is required.`); continue; }
        if (serviceName === '') { errs.push(`Line ${ln.line}: service is required.`); continue; }
        if (rate === '' || !isNumeric(rate) || flt(rate) < 0) { errs.push(`Line ${ln.line}: rate must be a non-negative number.`); continue; }
        const isWeight = weight !== '' && isNumeric(weight) && flt(weight) > 0;
        if (!isWeight && (!isNumeric(qty) || flt(qty) <= 0)) { errs.push(`Line ${ln.line}: quantity or weight must be a positive number.`); continue; }
        const g = (await db.query<Row>('SELECT id FROM garments WHERE sku = ? OR garment_name = ? LIMIT 1', [garmentName, garmentName]))[0];
        if (!g) { errs.push(`Line ${ln.line}: garment "${garmentName}" not found.`); continue; }
        const s = (await db.query<Row>('SELECT id FROM services WHERE service_name = ? LIMIT 1', [serviceName]))[0];
        if (!s) { errs.push(`Line ${ln.line}: service "${serviceName}" not found.`); continue; }
        const lineTotal = isWeight ? phpRound(flt(weight) * flt(rate), 2) : phpRound(flt(qty) * flt(rate), 2);
        subtotal += lineTotal;
        items.push({ garment_id: Number(g.id), service_id: Number(s.id), garment_name: garmentName, service_name: serviceName, quantity: isWeight ? 1 : flt(qty), weight: isWeight ? flt(weight) : null, unit_price: isWeight ? 0 : flt(rate), weight_rate: isWeight ? flt(rate) : null, line_total: lineTotal });
      }
      const discount = flt(first.order_discount), tax = flt(first.order_tax), urgent = flt(first.order_urgent_charge), delivery = flt(first.order_delivery_charge);
      const grandTotal = phpRound(subtotal - discount + urgent + tax + delivery, 2);
      const amountPaid = flt(first.amount_paid);
      if (amountPaid > grandTotal + 0.01) errs.push('amount_paid cannot exceed the computed grand total.');
      let ptName = (first.payment_type ?? '').trim();
      if (!truthyStr(ptName)) ptName = 'Cash';
      let paymentTypeId: number | null = null;
      if (amountPaid > 0) {
        const pt = (await db.query<Row>('SELECT id FROM payment_types WHERE type_name = ? AND is_active = 1 LIMIT 1', [ptName]))[0];
        paymentTypeId = pt ? Number(pt.id) : null;
        if (!paymentTypeId) errs.push(`Payment type "${ptName}" not found/active.`);
      }
      const dt = (first.due_time ?? '').trim();
      results.push({ ref, lines: lines.map((l) => l.line), errors: errs, mobile, customer_name: customerName, customer_id: customerId, order_date: orderDate, due_date: dueDate, due_time: truthyStr(dt) ? dt : null,
        status_key: statusKey, items, subtotal: phpRound(subtotal, 2), discount, tax, urgent, delivery, grand_total: grandTotal, amount_paid: amountPaid, payment_type_id: paymentTypeId,
        notes: (first.notes ?? '').trim(), customer_warning: customerWarning });
    }
    return results;
  }

  webPage(app, '/modules/orders/import', { auth: 'order.import' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    if ('template' in q) {
      return csv('urban_dry_clean_historical_order_template.csv',
        ['order_ref', 'customer_mobile', 'customer_name', 'order_date', 'due_date', 'due_time', 'garment', 'service', 'quantity', 'weight', 'rate', 'order_discount', 'order_tax', 'order_urgent_charge', 'order_delivery_charge', 'amount_paid', 'payment_type', 'status', 'notes'],
        [['QDC-E101', '9999096552', 'Rahul Singh', '2026-01-05', '2026-01-07', '17:00', 'T Shirt', 'Dry Cleaning', '2', '', '100', '0', '10', '0', '0', '210', 'Cash', 'delivered', 'Migrated from QDC'],
          ['QDC-E101', '9999096552', 'Rahul Singh', '2026-01-05', '2026-01-07', '17:00', 'Pants', 'Dry Cleaning', '1', '', '120', '0', '10', '0', '0', '0', '', 'delivered', '']]);
    }
    let step = clean(body(ctx).step ?? q.step ?? 'upload') || 'upload';
    const errors: string[] = [];
    let token = clean(body(ctx).import_token);
    let report: Row | null = null;
    let groups: Group[] | undefined;
    const userId = ctx.data.user_id!;

    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      if (step === 'upload') {
        try {
          token = await importStoreTempUpload(ctx, 'file');
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          const missing = ['customer_mobile', 'order_date', 'due_date', 'garment', 'service', 'rate'].filter((c) => !parsed.headers.includes(c));
          if (missing.length) { await importCleanupTemp(ctx, token); errors.push(`Missing required column(s): ${missing.join(', ')}. Use the provided template.`); step = 'upload'; }
          else if (parsed.rows.length === 0) { await importCleanupTemp(ctx, token); errors.push('The file has no data rows.'); step = 'upload'; }
          else step = 'preview';
        } catch (ex) { errors.push((ex as Error).message); step = 'upload'; }
      } else if (step === 'confirm') {
        try {
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          const all = await validateGroups(parsed.rows);
          let ordersCreated = 0, customersCreated = 0, skipped = 0;
          const year = yearIn(ctx.svc.env.APP_TIMEZONE);
          await db.tx(async (t) => {
            const audit = ctx.svc.audit.using(t);
            const finance = ctx.svc.finance.using(t);
            const tags = new GarmentTagService(t);
            for (const g of all) {
              if (g.errors.length) { skipped++; continue; }
              let customerId: number | null = g.customer_id;
              if (!customerId) {
                const code = await generateCustomerCode(t);
                const barcode = `${(await ctx.setting('barcode_prefix', 'UDC')) ?? 'UDC'}-CUST-${code.slice(-6)}`;
                const ins = await t.execute("INSERT INTO customers (customer_code, full_name, mobile, barcode, registration_source, created_by) VALUES (?,?,?,?, 'Import', ?)", [code, g.customer_name, g.mobile, barcode, userId]);
                customerId = ins.insertId;
                await t.execute('INSERT INTO customer_wallet (customer_id, balance) VALUES (?, 0)', [customerId]);
                await audit.record({ action: 'create', module: 'customers', recordId: String(customerId), newValue: { imported_via_order_import: true }, userId, ip: req.ip });
                customersCreated++;
              }
              const statusId = Number((await t.query<Row>('SELECT id FROM order_statuses WHERE status_key = ?', [g.status_key]))[0]?.id) || null;
              let priceListId: number | null = null;
              try { priceListId = await ctx.svc.pricing.resolvePriceListId(customerId); } catch { /* fall back below */ }
              if (!priceListId) priceListId = Number((await t.query<Row>("SELECT id FROM price_lists WHERE list_type='Default' ORDER BY id LIMIT 1"))[0]?.id) || 0;
              const orderNumber = await generateOrderNumber(t, year);
              const invoiceNumber = await generateInvoiceNumber(t);
              const o = await t.execute(
                `INSERT INTO orders (order_number, invoice_number, customer_id, store_id, price_list_id, order_date, due_date, due_time, notes, subtotal, discount_type, discount_value, discount_amount, urgent_charge, tax_amount, delivery_charge, grand_total, status_id, order_type, created_by)
                 VALUES (?,?,?,1,?,?,?,?,?,?, 'Flat', ?, ?, ?, ?, ?, ?, ?, 'Historical Import', ?)`,
                [orderNumber, invoiceNumber, customerId, priceListId, g.order_date, g.due_date, g.due_time, `Imported from historical data. ${g.notes}`.trim(), g.subtotal, g.discount, g.discount, g.urgent, g.tax, g.delivery, g.grand_total, statusId, userId]);
              const orderId = o.insertId;
              let seq = 0;
              for (const it of g.items) {
                seq++;
                const r = await t.execute(
                  'INSERT INTO order_items (order_id, garment_id, service_id, quantity, unit, unit_price, weight, weight_rate, subtotal, discount, tax_percent, tax, total, item_status) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,?,?)',
                  [orderId, it.garment_id, it.service_id, it.quantity, it.weight !== null ? 'Kg' : 'Pcs', it.unit_price, it.weight, it.weight_rate, it.line_total, 0, it.line_total, g.status_key === 'delivered' ? 'Delivered' : 'Pending']);
                await tags.generateForItem(orderId, orderNumber, r.insertId, seq);
              }
              if (g.amount_paid > 0 && g.payment_type_id) {
                const paymentNumber = await generateDocumentNumber(t, 'payment_prefix', 6);
                const p = await t.execute("INSERT INTO payments (payment_number, order_id, customer_id, payment_date, total_amount, payment_kind, remarks, created_by) VALUES (?,?,?,?,?, 'Full', 'Historical import', ?)", [paymentNumber, orderId, customerId, g.order_date, g.amount_paid, userId]);
                await t.execute('INSERT INTO payment_transactions (payment_id, payment_type_id, amount) VALUES (?,?,?)', [p.insertId, g.payment_type_id, g.amount_paid]);
              }
              await finance.recalculatePayments(orderId, userId, req.ip);
              await audit.record({ action: 'create', module: 'orders', recordId: String(orderId), newValue: { imported: true, ref: g.ref }, userId, ip: req.ip });
              ordersCreated++;
            }
          });
          await importCleanupTemp(ctx, token);
          report = { orders: ordersCreated, customers_created: customersCreated, skipped };
          step = 'done';
        } catch (ex) { errors.push(`Import failed, no changes were made: ${(ex as Error).message}`); step = 'upload'; }
      } else if (step === 'cancel') { await importCleanupTemp(ctx, token); step = 'upload'; }
    }
    if (step === 'preview') {
      try { groups = await validateGroups((await parseCsvFile(importTempPath(ctx, token))).rows); }
      catch (ex) { errors.push((ex as Error).message); step = 'upload'; }
    }

    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    let content: Raw | string = '';
    if (step === 'upload') {
      content = html`
        <h6 class="fw-bold">Bulk Order Import</h6>
        <a href="?template=1" class="btn btn-outline-secondary btn-sm mb-3"><i class="fa-solid fa-download me-1"></i>Download Template</a>
        <p class="text-muted small">Multiple garment lines with the same <code>order_ref</code> are combined into one order. Order-level fields (discount, tax, urgent charge, delivery, amount paid) are read from the first line of each group.</p>
        <form method="POST" enctype="multipart/form-data">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="upload">
          <div class="mb-3"><input type="file" name="file" class="form-control" accept=".csv" required></div>
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-upload me-1"></i>Upload & Preview</button>
        </form>`;
    } else if (step === 'preview' && groups) {
      let ok = 0, bad = 0;
      for (const g of groups) { if (g.errors.length) bad++; else ok++; }
      content = html`
        <h6 class="fw-bold">Preview</h6>
        <p><span class="badge bg-success">Ready to import: ${ok}</span> <span class="badge bg-danger">Errors (will be skipped): ${bad}</span></p>
        <div class="table-responsive udc-cards-wrap" style="max-height:420px;overflow-y:auto;">
          <table class="udc-cards table table-sm">
            <thead><tr><th>Ref</th><th>Customer</th><th>Order Date</th><th>Items</th><th class="text-end">Grand Total</th><th class="text-end">Paid</th><th>Status</th></tr></thead>
            <tbody>
            ${groups.map((g) => html`
              <tr class="${g.errors.length ? 'table-danger' : (g.customer_warning ? 'table-warning' : '')}">
                <td data-label="Ref">${g.ref}</td>
                <td data-label="Customer">${g.customer_name !== '' && g.customer_name !== '0' ? g.customer_name : g.mobile} ${g.customer_id ? '(existing)' : '(new)'}</td>
                <td data-label="Order Date">${g.order_date}</td>
                <td data-label="Items">${g.items.length}</td>
                <td class="text-end" data-label="Grand Total">${raw(money(g.grand_total))}</td>
                <td class="text-end" data-label="Paid">${raw(money(g.amount_paid))}</td>
                <td data-label="Status">
                  ${g.errors.length ? html`<span class="text-danger small">${g.errors.join(' ')}</span>` : 'OK'}
                  ${g.customer_warning ? html`<br><span class="text-warning small">${g.customer_warning}</span>` : ''}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <form method="POST">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="confirm">
          <input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-primary" type="submit" ${ok === 0 ? 'disabled' : ''}><i class="fa-solid fa-check me-1"></i>Confirm Import (${ok} order(s))</button>
        </form>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}<input type="hidden" name="step" value="cancel"><input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-outline-secondary" type="submit">Cancel</button>
        </form>`;
    } else if (step === 'done' && report) {
      content = html`
        <div class="alert alert-success">
          <h6 class="fw-bold">Import Complete</h6>
          ${report.orders} order(s) created (${report.customers_created} new customer(s) created along the way),
          ${report.skipped} group(s) skipped due to errors.
        </div>
        <a href="${u('modules/orders/import.php')}" class="btn btn-primary btn-sm">Import Another File</a>
        <a href="${u('modules/orders/list.php')}" class="btn btn-outline-secondary btn-sm">Back to Orders</a>`;
    }
    return layout(ctx, { title: 'Bulk Order Import (Historical)' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      <div class="alert alert-warning small">
        <strong>Historical import mode.</strong> This creates orders directly from supplied historical rates/totals —
        it does NOT go through the live PricingEngine, and is intended only for migrating already-completed orders
        from another system (e.g. QDC). Normal counter sales must always use the New Order / POS screen.
      </div>
      ${errors.length ? html`
        <div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html`<li>${er}</li>`)}</ul></div>` : ''}

      ${content}
    </div>
  </div>
</div>
`);
  });
}
