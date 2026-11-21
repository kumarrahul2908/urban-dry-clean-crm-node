import type { FastifyInstance } from 'fastify';
import { phpEmpty } from '../../lib/php.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { formArray, int } from '../format.js';
import { e, html, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { barcodeSearchScript, packingScript } from './barcode.static.js';
import { pager } from './payments.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const orDash = (v: unknown) => { const s = String(v ?? ''); return s === '' || s === '0' ? '—' : s; };

export function registerBarcodePages(app: FastifyInstance) {
  const { db, packing, audit } = app.services;

  // ---- Barcode search (calls api/barcode_lookup) -----------------------------------------------
  webPage(app, '/modules/barcode/search', { auth: 'garment_tags.view' }, async (ctx) => {
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Barcode Search' }, html`
<div class="col-md-6">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold">Search by Barcode</h6>
      <div class="input-group mb-3">
        <input type="text" id="barcodeInput" class="form-control" placeholder="Scan or type barcode..." autofocus>
        <button class="btn btn-primary" id="searchBtn"><i class="fa-solid fa-magnifying-glass"></i></button>
      </div>
      <div id="result" class="d-none">
        <table class="table table-sm">
          <tr><th style="width:150px">Order Number</th><td id="rOrder"></td></tr>
          <tr><th>Customer</th><td id="rCustomer"></td></tr>
          <tr><th>Garment</th><td id="rGarment"></td></tr>
          <tr><th>Service</th><td id="rService"></td></tr>
          <tr><th>Status</th><td id="rStatus"></td></tr>
          <tr><th>Due Date</th><td id="rDue"></td></tr>
        </table>
        <a href="#" id="openOrderBtn" class="btn btn-outline-primary btn-sm" target="_blank">Open Order</a>
        <a href="#" id="openGarmentBtn" class="btn btn-outline-secondary btn-sm">Garment Detail</a>
      </div>
      <div id="notFound" class="alert alert-warning d-none mt-3">No garment found for this barcode.</div>
    </div>
  </div>
</div>
${raw(barcodeSearchScript(u, JSON.stringify, e))}
`);
  });

  // ---- Package QR scan ---------------------------------------------------------------------------
  webPage(app, '/modules/barcode/packing_scan', { auth: 'packing.manage' }, async (ctx, req) => {
    const token = clean((req.query as Record<string, unknown>).token);
    let pkg: Row | null = null;
    if (token !== '') {
      pkg = (await db.query<Row>(
        `SELECT p.*, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile AS customer_mobile
         FROM packing p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id WHERE p.qr_token = ?`, [token]))[0] ?? null;
      await audit.record({ action: 'lookup', module: 'packing', recordId: pkg ? String(pkg.order_id) : 'qr:' + token.slice(0, 8), newValue: { via: 'qr_token', found: !!pkg }, userId: ctx.data.user_id ?? null, ip: req.ip });
    }
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Package Detail' }, html`
<div class="col-md-6">
  <div class="card">
    <div class="card-body">
      ${!token ? html`
        <div class="alert alert-info">Scan a packing sticker's QR code, or enter a token manually.</div>
        <form method="GET" class="d-flex gap-2">
          <input type="text" name="token" class="form-control" placeholder="Paste secure token...">
          <button class="btn btn-primary">Look Up</button>
        </form>` : !pkg ? html`
        <div class="alert alert-warning">No package found for this token.</div>
        <a href="${u('modules/barcode/packing.php')}" class="btn btn-outline-secondary btn-sm">Back to Packing</a>` : html`
        <h6 class="fw-bold">Package ${int(pkg.package_number)} / ${int(pkg.total_packages)}</h6>
        <table class="table table-sm">
          <tr><th style="width:150px">Order</th><td>${pkg.order_number}</td></tr>
          <tr><th>Customer</th><td>${pkg.customer_name} (${pkg.customer_mobile})</td></tr>
          <tr><th>Garment Count</th><td>${int(pkg.garment_count)}</td></tr>
          <tr><th>Status</th><td>${pkg.status}</td></tr>
          <tr><th>Due Date</th><td>${raw(ctx.date(pkg.due_date))}</td></tr>
          <tr><th>Print Count</th><td>${int(pkg.printed_count)}</td></tr>
        </table>
        <a href="${u('modules/orders/view.php?id=' + pkg.order_id)}" class="btn btn-outline-primary btn-sm">Open Order</a>
        <a href="${u('modules/barcode/packing.php?order_id=' + pkg.order_id)}" class="btn btn-outline-secondary btn-sm">All Packages for this Order</a>`}
    </div>
  </div>
</div>
`);
  });

  // ---- Package stickers: create + list ------------------------------------------------------------
  webPage(app, '/modules/barcode/packing', { auth: 'packing.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const post = req.method === 'POST' ? body(ctx) : null;
    const orderId = int(q.order_id ?? post?.order_id ?? 0);
    let errors: string[] = [];
    if (post && 'create_packages' in post) {
      if (!ctx.csrfValid()) return csrfFail();
      const additional = int(post.additional_packages), garmentCount = int(post.garment_count);
      const r = await packing.createPackages(orderId, additional, garmentCount, ctx.data.user_id!, req.ip);
      if (r.success) { ctx.flashSet('success', `${additional} package(s) created.`); return new WebRedirect('modules/barcode/packing.php?order_id=' + orderId); }
      errors = r.errors;
    }
    let order: Row | null = null, packages: Row[] = [], itemCount = 0;
    if (orderId) {
      order = (await db.query<Row>('SELECT o.*, c.full_name, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]))[0] ?? null;
      if (order) {
        packages = await db.query<Row>('SELECT * FROM packing WHERE order_id = ? ORDER BY package_number', [orderId]);
        itemCount = int((await db.query<Row>('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [orderId]))[0]!.n);
      }
    }
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Print Packing Stickers' }, html`
<div class="col-12">
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-2">Find Order</h6>
      <div class="position-relative">
        <input type="text" id="orderSearch" class="form-control" placeholder="Search order by number, invoice, or customer...">
        <div id="orderResults" class="d-none" style="position:absolute;z-index:1050;background:#fff;border:1px solid #dee2e6;border-radius:8px;width:100%;max-height:260px;overflow-y:auto;box-shadow:0 6px 20px rgba(0,0,0,.1);"></div>
      </div>
    </div>
  </div>

  ${order ? html`
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold">Order ${order.short_order_code ?? order.order_number}</h6>
      <p class="text-muted">Customer: ${order.full_name} (${order.mobile}) &middot; Items: ${itemCount} &middot; Due: ${raw(ctx.date(order.due_date))}</p>

      ${errors.length ? html`<div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html`<li>${er}</li>`)}</ul></div>` : ''}

      <form method="POST" class="row g-2 align-items-end mb-3">
        ${ctx.csrfField()}
        <input type="hidden" name="order_id" value="${orderId}">
        <input type="hidden" name="create_packages" value="1">
        <div class="col-md-3">
          <label class="form-label small">Packages to Add</label>
          <input type="number" name="additional_packages" class="form-control" min="1" value="1" required>
        </div>
        <div class="col-md-3">
          <label class="form-label small">Garment Count (per package)</label>
          <input type="number" name="garment_count" class="form-control" min="0" value="${itemCount}">
        </div>
        <div class="col-md-3"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-plus me-1"></i>Create Package(s)</button></div>
      </form>

      ${packages.length ? html`
      <form method="POST" action="${u('modules/barcode/packing_print.php')}" target="_blank" id="pkgPrintForm">
        ${ctx.csrfField()}
        <div class="d-flex justify-content-between mb-2">
          <div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="selectAllPkg">Select All</button>
          </div>
          <button type="submit" class="btn btn-primary btn-sm"><i class="fa-solid fa-print me-1"></i>Print Selected Packages</button>
        </div>
        <table class="udc-cards table table-sm">
          <thead><tr><th></th><th>Package</th><th>Barcode</th><th>Status</th><th>Print Count</th></tr></thead>
          <tbody>
          ${packages.map((p) => html`
            <tr>
              <td data-label=""><input type="checkbox" name="package_ids[]" value="${p.id}" class="pkg-check"></td>
              <td data-label="Package">${p.package_number} / ${p.total_packages}</td>
              <td data-label="Barcode"><code>${p.barcode_value}</code></td>
              <td data-label="Status"><span class="badge bg-${p.status === 'Printed' ? 'success' : 'secondary'}">${p.status}</span></td>
              <td data-label="Print Count">${int(p.printed_count)}</td>
            </tr>`)}
          </tbody>
        </table>
      </form>` : ''}
    </div>
  </div>` : ''}
</div>
${raw(packingScript(u, JSON.stringify, e))}
`);
  });

  // ---- Package sticker print page ----------------------------------------------------------------
  webPage(app, '/modules/barcode/packing_print', { auth: 'packing.manage' }, async (ctx, req) => {
    const p = req.method === 'POST' ? body(ctx) : {};
    if (req.method === 'POST' && !ctx.csrfValid()) return csrfFail();
    if (req.method !== 'POST') return csrfFail(); // verify_csrf() on a GET (no token) fails the same way
    const u = (path: string) => ctx.baseUrl(path);
    const ids = formArray(p, 'package_ids').map((x) => int(x)).filter((x) => x !== 0);
    if (!ids.length) return new WebText(`<p style="font-family:sans-serif;padding:20px;">No packages were selected. <a href="${e(u('modules/barcode/packing.php'))}">Go back</a></p>`, 200);
    const packages = await db.query<Row>(
      `SELECT p.*, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile AS customer_mobile
       FROM packing p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ids);
    if (!packages.length) return new WebText(`<p style="font-family:sans-serif;padding:20px;">Selected packages were not found. <a href="${e(u('modules/barcode/packing.php'))}">Go back</a></p>`, 200);
    for (const pk of packages) await packing.recordPrint(Number(pk.id), ctx.data.user_id!, req.ip);
    const businessName = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? '';
    const logoPath = (await ctx.setting('logo_path', '')) ?? '';
    return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Packing Stickers</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; margin:0; padding:16px; background:#eef1f6; }
  .actions { text-align:center; margin-bottom:16px; }
  .actions button, .actions a { border:0; background:#0b3d91; color:#fff; padding:8px 16px; border-radius:6px; text-decoration:none; font-size:13px; margin:0 4px; cursor:pointer; }
  .stickers { display:flex; flex-wrap:wrap; gap:14px; justify-content:center; }
  .sticker { width:320px; background:#fff; border:2px solid #0b3d91; border-radius:8px; padding:14px; page-break-after:always; }
  .sticker .brand { font-weight:800; font-size:16px; color:#0b3d91; text-align:center; }
  .sticker .pkg-no { text-align:center; font-weight:800; font-size:22px; margin:6px 0; }
  .sticker table { width:100%; font-size:12.5px; border-collapse:collapse; margin-top:6px; }
  .sticker table td { padding:2px 0; }
  .sticker .label { color:#666; width:90px; }
  .sticker .codes { display:flex; justify-content:space-between; align-items:center; margin-top:8px; }
  @media print {
    body { background:#fff; padding:0; }
    .actions { display:none; }
    @page { margin: 6mm; }
  }
</style>
</head>
<body>
<div class="actions"><button onclick="window.print()">Print</button> <a href="${u('modules/barcode/packing.php?order_id=' + packages[0]!.order_id)}">Back</a></div>
<div class="stickers">
${packages.map((pk) => html`
  <div class="sticker">
    <div class="brand">${businessName}</div>
    ${!phpEmpty(logoPath) ? html`<div style="text-align:center;"><img src="${u('uploads/logo/' + logoPath)}" style="max-height:28px;"></div>` : ''}
    <div class="pkg-no">Package ${int(pk.package_number)} / ${int(pk.total_packages)}</div>
    <table>
      <tr><td class="label">Order</td><td>${pk.order_number}</td></tr>
      <tr><td class="label">Customer</td><td>${pk.customer_name}</td></tr>
      <tr><td class="label">Garments</td><td>${int(pk.garment_count)}</td></tr>
      <tr><td class="label">Due Date</td><td>${raw(ctx.date(pk.due_date))}${!phpEmpty(pk.due_time) ? raw(' ' + ctx.date(pk.due_time, 'h:i A')) : ''}</td></tr>
    </table>
    <div class="codes">
      <svg class="barcode-svg" data-value="${pk.barcode_value}"></svg>
      <div class="qr" data-content="${u('modules/barcode/packing_scan.php?token=' + pk.qr_token)}" style="width:70px;height:70px;"></div>
    </div>
  </div>`)}
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/JsBarcode/3.11.5/JsBarcode.all.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
document.querySelectorAll('.barcode-svg').forEach(function (el) {
  JsBarcode(el, el.dataset.value, { format: "CODE128", width: 1.6, height: 40, fontSize: 11, margin: 2 });
});
document.querySelectorAll('.qr').forEach(function (el) {
  new QRCode(el, { text: el.dataset.content, width: 70, height: 70 });
});
</script>
</body>
</html>`;
  });

  // ---- Garment tags list (print selector) --------------------------------------------------------
  webPage(app, '/modules/barcode/tags', { auth: 'garment_tags.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const dateFrom = clean(q.date_from), dateTo = clean(q.date_to), orderNumber = clean(q.order_number), invoiceNumber = clean(q.invoice_number), customerSearch = clean(q.customer);
    const serviceId = int(q.service_id), garmentId = int(q.garment_id), barcode = clean(q.barcode), printedFilter = clean(q.printed);
    const page = Math.max(1, int(q.page) || 1), perPage = 25, offset = (page - 1) * perPage;
    let where = '1=1';
    const params: unknown[] = [];
    if (dateFrom !== '') { where += ' AND DATE(o.order_date) >= ?'; params.push(dateFrom); }
    if (dateTo !== '') { where += ' AND DATE(o.order_date) <= ?'; params.push(dateTo); }
    if (orderNumber !== '') { where += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; params.push(`%${orderNumber}%`, `%${orderNumber}%`); }
    if (invoiceNumber !== '') { where += ' AND o.invoice_number LIKE ?'; params.push(`%${invoiceNumber}%`); }
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    if (serviceId) { where += ' AND oi.service_id = ?'; params.push(serviceId); }
    if (garmentId) { where += ' AND oi.garment_id = ?'; params.push(garmentId); }
    if (barcode !== '') { where += ' AND bc.barcode_value LIKE ?'; params.push(`%${barcode}%`); }
    if (printedFilter === 'printed') where += ' AND gt.printed_count > 0';
    if (printedFilter === 'not_printed') where += ' AND (gt.printed_count = 0 OR gt.printed_count IS NULL)';
    const baseSql = `FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
      LEFT JOIN colors col ON col.id = oi.color_id LEFT JOIN barcodes bc ON bc.order_item_id = oi.id LEFT JOIN garment_tags gt ON gt.barcode_id = bc.id WHERE ${where}`;
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n ${baseSql}`, params))[0]!.n);
    const rows = await db.query<Row>(
      `SELECT oi.id AS order_item_id, oi.remarks, oi.item_status, bc.id AS barcode_id, bc.barcode_value, bc.item_sequence, g.garment_name, s.service_name, col.color_name, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date,
       c.full_name AS customer_name, COALESCE(gt.printed_count, 0) AS printed_count ${baseSql} ORDER BY o.id DESC, bc.item_sequence ASC LIMIT ${perPage} OFFSET ${offset}`, params);
    const totalPages = Math.ceil(total / perPage);
    const services = await db.query<Row>('SELECT id, service_name FROM services WHERE is_active=1 ORDER BY sort_order');
    const garments = await db.query<Row>('SELECT id, garment_name FROM garments WHERE is_active=1 ORDER BY garment_name');
    let lw = '1=1';
    const lp: unknown[] = [];
    if (dateFrom !== '') { lw += ' AND DATE(o.order_date) >= ?'; lp.push(dateFrom); }
    if (dateTo !== '') { lw += ' AND DATE(o.order_date) <= ?'; lp.push(dateTo); }
    if (orderNumber !== '') { lw += ' AND (o.order_number LIKE ? OR o.short_order_code LIKE ?)'; lp.push(`%${orderNumber}%`, `%${orderNumber}%`); }
    if (customerSearch !== '') { lw += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; lp.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    if (serviceId) { lw += ' AND oi.service_id = ?'; lp.push(serviceId); }
    if (garmentId) { lw += ' AND lg.garment_id = ?'; lp.push(garmentId); }
    if (barcode !== '') { lw += ' AND bc.barcode_value LIKE ?'; lp.push(`%${barcode}%`); }
    if (printedFilter === 'printed') lw += ' AND gt.printed_count > 0';
    if (printedFilter === 'not_printed') lw += ' AND (gt.printed_count = 0 OR gt.printed_count IS NULL)';
    const laundryRows = await db.query<Row>(
      `SELECT lg.id AS laundry_garment_id, lg.sequence, bc.id AS barcode_id, bc.barcode_value, g.garment_name, s.service_name, COALESCE(o.short_order_code, o.order_number) AS order_number, o.due_date, c.full_name AS customer_name,
       oi.quantity AS total_garments, COALESCE(gt.printed_count, 0) AS printed_count
       FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = lg.garment_id
       JOIN services s ON s.id = oi.service_id LEFT JOIN barcodes bc ON bc.laundry_garment_id = lg.id LEFT JOIN garment_tags gt ON gt.barcode_id = bc.id
       WHERE ${lw} ORDER BY o.id DESC, lg.sequence ASC LIMIT 100`, lp);
    const u = (p: string) => ctx.baseUrl(p);
    const canPrint = ctx.can('garment_tags.print') || ctx.can('garment_tags.reprint');
    const fmtSelect = html`<select name="format" class="form-select form-select-sm" style="width:auto">
              <option value="thermal">Thermal Label</option>
              <option value="label">Small Adhesive Label</option>
              <option value="a4">A4 Multi-Label Sheet</option>
            </select>`;
    const status = (n: unknown) => (flt0(n) > 0 ? html`<span class="badge bg-success">Printed (${int(n)})</span>` : html`<span class="badge bg-secondary">Not Printed</span>`);
    const flt0 = (v: unknown) => parseFloat(String(v ?? '')) || 0;
    return layout(ctx, { title: 'Print Garment Tags' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      <form class="row g-2 mb-3" method="GET">
        <div class="col-md-2"><input type="date" name="date_from" class="form-control form-control-sm" value="${dateFrom}" placeholder="Date From"></div>
        <div class="col-md-2"><input type="date" name="date_to" class="form-control form-control-sm" value="${dateTo}" placeholder="Date To"></div>
        <div class="col-md-2"><input type="text" name="order_number" class="form-control form-control-sm" value="${orderNumber}" placeholder="Order Number"></div>
        <div class="col-md-2"><input type="text" name="invoice_number" class="form-control form-control-sm" value="${invoiceNumber}" placeholder="Invoice Number"></div>
        <div class="col-md-2"><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}" placeholder="Customer name/mobile"></div>
        <div class="col-md-2"><input type="text" name="barcode" class="form-control form-control-sm" value="${barcode}" placeholder="Barcode"></div>
        <div class="col-md-2">
          <select name="service_id" class="form-select form-select-sm">
            <option value="0">All Services</option>
            ${services.map((s) => html`<option value="${s.id}" ${sel(serviceId === Number(s.id))}>${s.service_name}</option>`)}
          </select>
        </div>
        <div class="col-md-2">
          <select name="garment_id" class="form-select form-select-sm">
            <option value="0">All Garments</option>
            ${garments.map((g) => html`<option value="${g.id}" ${sel(garmentId === Number(g.id))}>${g.garment_name}</option>`)}
          </select>
        </div>
        <div class="col-md-2">
          <select name="printed" class="form-select form-select-sm">
            <option value="">Printed/Not Printed</option>
            <option value="printed" ${sel(printedFilter === 'printed')}>Printed</option>
            <option value="not_printed" ${sel(printedFilter === 'not_printed')}>Not Printed</option>
          </select>
        </div>
        <div class="col-md-2"><button class="btn btn-outline-primary btn-sm w-100"><i class="fa-solid fa-filter me-1"></i>Filter</button></div>
      </form>

      <form method="POST" action="${u('modules/barcode/tags_print.php')}" target="_blank" id="printForm">
        ${ctx.csrfField()}
        <div class="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
          <div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="selectAllBtn">Select All Visible</button>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="clearSelectionBtn">Clear</button>
          </div>
          <div class="d-flex gap-2 align-items-center">
            ${fmtSelect}
            ${canPrint ? html`
            <button type="submit" class="btn btn-primary btn-sm"><i class="fa-solid fa-print me-1"></i>Print Selected</button>` : ''}
          </div>
        </div>

        <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-hover table-sm">
            <thead><tr><th></th><th>S.No</th><th>Barcode</th><th>Order</th><th>Garment</th><th>Remark</th><th>Color</th><th>Service</th><th>Customer</th><th>Due Date</th><th>Tag Status</th></tr></thead>
            <tbody>
            ${rows.length === 0 ? html`<tr><td colspan="11" class="text-center text-muted py-4">No garments found.</td></tr>` : ''}
            ${rows.map((r, i) => html`
              <tr>
                <td data-label=""><input type="checkbox" name="barcode_ids[]" value="${r.barcode_id ?? ''}" class="row-check" ${!r.barcode_id ? 'disabled' : ''}></td>
                <td data-label="S.No">${offset + i + 1}</td>
                <td data-label="Barcode"><a href="${u('modules/barcode/garment_detail.php?item_id=' + r.order_item_id)}">${orDash(r.barcode_value)}</a></td>
                <td data-label="Order">${r.order_number}</td>
                <td data-label="Garment">${r.garment_name} <span class="text-muted small">${r.item_sequence ? '(' + r.item_sequence + ')' : ''}</span></td>
                <td class="small" data-label="Remark">${String(r.remarks ?? '')}</td>
                <td data-label="Color">${orDash(r.color_name)}</td>
                <td data-label="Service">${r.service_name}</td>
                <td data-label="Customer">${r.customer_name}</td>
                <td data-label="Due Date">${raw(ctx.date(r.due_date))}</td>
                <td data-label="Tag Status">
                  ${status(r.printed_count)}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
      </form>

      <hr class="my-4">
      <h6 class="fw-bold">Laundry Garment Tags</h6>
      <p class="text-muted small">Uses the same filters above. Showing up to 100 most recent — no separate pagination built for this section yet.</p>
      ${laundryRows.length === 0 ? html`
        <p class="text-muted small">No Laundry garment tags found.</p>` : html`
      <form method="POST" action="${u('modules/barcode/tags_print.php')}" target="_blank" id="lgPrintForm">
        ${ctx.csrfField()}
        <div class="d-flex flex-wrap justify-content-between align-items-center mb-2 gap-2">
          <div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="lgSelectAllBtn">Select All Visible</button>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="lgClearSelectionBtn">Clear</button>
          </div>
          <div class="d-flex gap-2 align-items-center">
            ${fmtSelect}
            ${canPrint ? html`
            <button type="submit" class="btn btn-primary btn-sm"><i class="fa-solid fa-print me-1"></i>Print Selected</button>` : ''}
          </div>
        </div>
        <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-hover table-sm">
            <thead><tr><th></th><th>Barcode</th><th>Order</th><th>Sequence</th><th>Garment</th><th>Service</th><th>Customer</th><th>Due Date</th><th>Tag Status</th></tr></thead>
            <tbody>
            ${laundryRows.map((r) => html`
              <tr>
                <td data-label=""><input type="checkbox" name="barcode_ids[]" value="${r.barcode_id ?? ''}" class="lg-row-check" ${!r.barcode_id ? 'disabled' : ''}></td>
                <td data-label="Barcode"><a href="${u('modules/barcode/garment_detail.php?laundry_garment_id=' + r.laundry_garment_id)}">${orDash(r.barcode_value)}</a></td>
                <td data-label="Order">${r.order_number}</td>
                <td data-label="Sequence">${int(r.sequence)} / ${int(r.total_garments)}</td>
                <td data-label="Garment">${r.garment_name}</td>
                <td data-label="Service">${r.service_name}</td>
                <td data-label="Customer">${r.customer_name}</td>
                <td data-label="Due Date">${raw(ctx.date(r.due_date))}</td>
                <td data-label="Tag Status">
                  ${status(r.printed_count)}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
      </form>`}

      ${pager(q, page, totalPages)}
    </div>
  </div>
</div>
${raw(`<script>
document.getElementById('selectAllBtn').addEventListener('click', function () {
  document.querySelectorAll('.row-check').forEach(cb => cb.checked = true);
});
document.getElementById('clearSelectionBtn').addEventListener('click', function () {
  document.querySelectorAll('.row-check').forEach(cb => cb.checked = false);
});
document.getElementById('printForm').addEventListener('submit', function (e) {
  const checked = document.querySelectorAll('.row-check:checked');
  if (checked.length === 0) { e.preventDefault(); alert('Select at least one garment tag to print.'); }
});
${laundryRows.length ? `document.getElementById('lgSelectAllBtn').addEventListener('click', function () {
  document.querySelectorAll('.lg-row-check').forEach(cb => cb.checked = true);
});
document.getElementById('lgClearSelectionBtn').addEventListener('click', function () {
  document.querySelectorAll('.lg-row-check').forEach(cb => cb.checked = false);
});
document.getElementById('lgPrintForm').addEventListener('submit', function (e) {
  const checked = document.querySelectorAll('.lg-row-check:checked');
  if (checked.length === 0) { e.preventDefault(); alert('Select at least one Laundry garment tag to print.'); }
});
` : ''}</script>`)}
`);
  });
}
