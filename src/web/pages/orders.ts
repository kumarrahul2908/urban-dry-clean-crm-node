import type { FastifyInstance } from 'fastify';
import { code128Svg } from '../../lib/barcodeCode128.js';
import { phpEmpty, phpRound } from '../../lib/php.js';
import { WebRedirect, WebText, forbiddenPage, webPage, type WebCtx } from '../context.js';
import { flt, formArray, int, numberFormat, urlencode } from '../format.js';
import { e, html, jsonEncode, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { invoicePdfScriptTag, invoiceScriptBase, invoiceScriptEnd, invoiceScriptPdf, invoiceScriptWhatsapp, invoiceStyle } from './invoice.static.js';
import { orderListStyle, orderPaymentScript, orderRefundScript, orderViewScript, orderViewStyle, receiptStyle } from './orders.static.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const errorList = (errors: string[]) => errors.length ? html`
        <div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html`<li>${er}</li>`)}</ul></div>` : '';
const notFound = (ctx: WebCtx) => { ctx.flashSet('danger', 'Order not found.'); return new WebRedirect('modules/orders/list.php'); };
const orEmpty = (v: unknown, fallback: string) => { const s = e(v === null || v === undefined ? '' : String(v)); return s !== '' && s !== '0' ? s : fallback; };

export function registerOrderPages(app: FastifyInstance) {
  const { db, orders } = app.services;
  const storeDenied = (ctx: WebCtx, what: string) => new WebText(`<h2>403 - Access Denied</h2><p>You are not authorized to ${what} for this order's store.</p><p><a href="${ctx.baseUrl('modules/orders/list.php')}">Back to Orders</a></p>`, 403);
  /** Auth::canActAsStoreForOrder() */
  const canActAsStoreForOrder = (ctx: WebCtx, orderStoreId: number) => {
    const fixed = ctx.fixedStoreId();
    return fixed !== null ? fixed === orderStoreId : ctx.activeStoreId() === orderStoreId;
  };

  // ---- list ------------------------------------------------------------------------------------
  webPage(app, '/modules/orders/list', { auth: 'orders.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const search = clean(q.q), statusFilter = int(q.status_id), dateFrom = clean(q.from), dateTo = clean(q.to);
    const page = Math.max(1, int(q.page) || 1);
    const perPage = 20, offset = (page - 1) * perPage;
    let where = '1=1';
    const params: unknown[] = [];
    if (search !== '') { where += ' AND (o.order_number LIKE ? OR o.invoice_number LIKE ? OR c.full_name LIKE ? OR c.mobile LIKE ?)'; const like = `%${search}%`; params.push(like, like, like, like); }
    if (statusFilter) { where += ' AND o.status_id = ?'; params.push(statusFilter); }
    if (dateFrom !== '') { where += ' AND DATE(o.order_date) >= ?'; params.push(dateFrom); }
    if (dateTo !== '') { where += ' AND DATE(o.order_date) <= ?'; params.push(dateTo); }
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${where}`, params))[0]!.n);
    const rows = await db.query<Row>(
      `SELECT o.*, c.full_name, c.mobile, os.status_label, os.color FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_statuses os ON os.id = o.status_id
       WHERE ${where} ORDER BY o.id DESC LIMIT ${perPage} OFFSET ${offset}`, params);
    const totalPages = Math.ceil(total / perPage);
    const statuses = await db.query<Row>('SELECT id, status_label FROM order_statuses ORDER BY sort_order');
    const hasFilters = search !== '' || !!statusFilter || dateFrom !== '' || dateTo !== '';
    const showingFrom = total ? offset + 1 : 0, showingTo = Math.min(offset + perPage, total);
    const pageUrl = (p: number) => `?q=${urlencode(search)}&status_id=${statusFilter}&from=${urlencode(dateFrom)}&to=${urlencode(dateTo)}&page=${p}`;
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);

    let pager: Raw | string = '';
    if (totalPages > 1) {
      const start = Math.max(1, page - 2), end = Math.min(totalPages, page + 2);
      const nums: Raw[] = [];
      for (let i = start; i <= end; i++) nums.push(html`
            <li><a class="${i === page ? 'is-active' : ''}" href="${pageUrl(i)}">${i}</a></li>`);
      pager = html`
      <nav class="ol-pager">
        <div class="ol-pager-info">Showing ${numberFormat(showingFrom, 0)}–${numberFormat(showingTo, 0)} of ${numberFormat(total, 0)}</div>
        <ul class="ol-pages">
          ${page > 1 ? html`
            <li><a href="${pageUrl(1)}" aria-label="First page"><i class="fa-solid fa-angles-left"></i></a></li>
            <li><a href="${pageUrl(page - 1)}" aria-label="Previous page"><i class="fa-solid fa-angle-left"></i></a></li>` : ''}

          ${start > 1 ? html`<li class="ol-gap">…</li>` : ''}
          ${nums}
          ${end < totalPages ? html`<li class="ol-gap">…</li>` : ''}

          ${page < totalPages ? html`
            <li><a href="${pageUrl(page + 1)}" aria-label="Next page"><i class="fa-solid fa-angle-right"></i></a></li>
            <li><a href="${pageUrl(totalPages)}" aria-label="Last page"><i class="fa-solid fa-angles-right"></i></a></li>` : ''}
        </ul>
      </nav>`;
    }

    return layout(ctx, { title: 'Orders' }, html`
<div class="col-12">

  <div class="ol-toolbar">
    <div class="ol-toolbar-title">
      <h4>Orders</h4>
      <span>${numberFormat(total, 0)} ${total === 1 ? 'order' : 'orders'}${hasFilters ? ' matching filters' : ''}</span>
    </div>
    ${ctx.can('pos.create') ? html`
      <a href="${u('modules/pos/index.php')}" class="ol-new-btn"><i class="fa-solid fa-plus"></i>New Order</a>` : ''}
  </div>

  <div class="card ol-card">
    <div class="card-body">

      <form class="ol-filters" method="GET">
        <div class="ol-field ol-field--grow">
          <i class="fa-solid fa-magnifying-glass ol-field-icon"></i>
          <input type="text" name="q" class="form-control ol-input ol-input--search"
                 placeholder="Order #, invoice #, customer or mobile" value="${search}">
        </div>
        <div class="ol-field">
          <select name="status_id" class="form-select ol-input">
            <option value="0">All status</option>
            ${statuses.map((s) => html`
              <option value="${s.id}" ${sel(statusFilter === Number(s.id))}>${s.status_label}</option>`)}
          </select>
        </div>
        <div class="ol-field ol-field--dates">
          <label>From</label>
          <input type="date" name="from" class="form-control ol-input" value="${dateFrom}">
        </div>
        <div class="ol-field ol-field--dates">
          <label>To</label>
          <input type="date" name="to" class="form-control ol-input" value="${dateTo}">
        </div>
        <button class="ol-apply-btn" type="submit"><i class="fa-solid fa-magnifying-glass"></i><span>Search</span></button>
        ${hasFilters ? html`
          <a href="?" class="ol-clear-btn" title="Clear all filters"><i class="fa-solid fa-xmark"></i><span>Clear</span></a>` : ''}
      </form>

      <div class="table-responsive udc-cards-wrap">
        <table class="table table-hover align-middle udc-cards ol-table">
          <thead><tr><th>Order#</th><th>Customer</th><th>Date</th><th>Due</th><th>Status</th><th class="text-end">Total</th><th class="text-end">Due Amt</th></tr></thead>
          <tbody>
          ${rows.length === 0 ? html`
            <tr><td colspan="7" class="ol-empty">
              <i class="fa-solid fa-inbox"></i>
              <span>${hasFilters ? 'No orders match these filters.' : 'No orders yet.'}</span>
            </td></tr>` : ''}
          ${rows.map((o) => html`
            <tr>
              <td class="udc-card-head udc-card-title"><a href="${u('modules/orders/view.php?id=' + o.id)}">${o.order_number}</a></td>
              <td class="udc-card-head">${o.full_name}<div class="text-muted small">${o.mobile}</div></td>
              <td data-label="Order Date">${raw(ctx.date(o.order_date))}</td>
              <td data-label="Due Date">${raw(ctx.date(o.due_date))}</td>
              <td data-label="Status"><span class="ol-status" style="background:${o.color}">${o.status_label}</span></td>
              <td class="text-end" data-label="Total">${raw(money(o.grand_total))}</td>
              <td class="text-end udc-card-total ol-due${flt(o.current_due) > 0 ? ' ol-due--open' : ''}" data-label="Due Amt">${raw(money(o.current_due))}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>

      ${pager}
    </div>
  </div>
</div>

${raw(orderListStyle(u, jsonEncode, e))}
`);
  });

  // ---- view -----------------------------------------------------------------------------------
  webPage(app, '/modules/orders/view', { auth: 'orders.view' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const order = (await db.query<Row>(
      `SELECT o.*, c.full_name AS customer_name, c.mobile AS customer_mobile, c.address AS customer_address, c.customer_code, os.status_label, os.status_key, os.color,
              ul.level_name AS urgent_level_name, pl.price_list_name, u1.full_name AS created_by_name, u2.full_name AS cancelled_by_name
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_statuses os ON os.id = o.status_id
       LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id LEFT JOIN price_lists pl ON pl.id = o.price_list_id
       LEFT JOIN users u1 ON u1.id = o.created_by LEFT JOIN users u2 ON u2.id = o.cancelled_by WHERE o.id = ?`, [id]))[0];
    if (!order) return notFound(ctx);
    const money = await ctx.loadMoney();
    const weightMode = order.order_mode === 'weight';
    let items: Row[];
    let laundryGarments: Row[] = [];
    if (weightMode) {
      items = await db.query<Row>('SELECT oi.*, s.service_name FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id', [id]);
      laundryGarments = await db.query<Row>(
        `SELECT lg.id, lg.order_item_id, g.garment_name, bc.item_sequence, oi.quantity AS total_garments FROM laundry_garments lg
         JOIN order_items oi ON oi.id = lg.order_item_id JOIN garments g ON g.id = lg.garment_id LEFT JOIN barcodes bc ON bc.laundry_garment_id = lg.id
         WHERE oi.order_id = ? ORDER BY bc.item_sequence`, [id]);
    } else {
      items = (await db.query<Row>(
        `SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, g.sku, COALESCE(s.service_name, 'Unknown Service') AS service_name, b.brand_name, col.color_name
         FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id LEFT JOIN brands b ON b.id = oi.brand_id LEFT JOIN colors col ON col.id = oi.color_id
         WHERE oi.order_id = ? ORDER BY oi.id`, [id]))
        .filter((it) => !phpEmpty(it.garment_id) || !phpEmpty(it.service_id) || flt(it.subtotal) > 0 || flt(it.total) > 0);
    }
    const itemCount = items.length;
    const defectRows = await db.query<Row>('SELECT oid.order_item_id, d.defect_name FROM order_item_defects oid JOIN defects d ON d.id = oid.defect_id WHERE oid.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)', [id]);
    const defectsByItem: Record<string, string[]> = {};
    for (const d of defectRows) (defectsByItem[String(d.order_item_id)] ??= []).push(d.defect_name);
    const payments = await db.query<Row>(
      `SELECT p.*, u.full_name AS created_by_name,
        GROUP_CONCAT(CONCAT(pt.type_name, ': ', ptx.amount, CASE WHEN ptx.reference_no IS NOT NULL THEN CONCAT(' (', ptx.reference_no, ')') ELSE '' END) SEPARATOR ', ') AS breakdown
       FROM payments p JOIN payment_transactions ptx ON ptx.payment_id = p.id JOIN payment_types pt ON pt.id = ptx.payment_type_id LEFT JOIN users u ON u.id = p.created_by
       WHERE p.order_id = ? GROUP BY p.id ORDER BY p.id DESC`, [id]);
    const receivableStatus = (await db.query<Row>('SELECT status FROM accounts_receivable WHERE order_id = ?', [id]))[0]?.status || null;
    const history = await db.query<Row>("SELECT al.*, u.full_name AS user_name FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE al.module = 'orders' AND al.record_id = ? ORDER BY al.created_at DESC LIMIT 50", [String(id)]);
    const isEditable = await orders.isEditable(order as { status_id: number });
    const u = (p: string) => ctx.baseUrl(p);
    const cancelled = order.status_key === 'cancelled';
    const canEditItems = isEditable && ctx.can('orders.edit');
    const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

    return layout(ctx, { title: `Order ${order.short_order_code ?? order.order_number}` }, html`

<div class="col-12">
  <div class="ov-head">
    <div class="ov-head-main">
      <div class="ov-title-row">
        <h4>${order.short_order_code ?? order.order_number}</h4>
        <span class="ov-status" style="background:${order.color}">${order.status_label}</span>
        ${order.urgent_level_name ? html`
          <span class="ov-urgent"><i class="fa-solid fa-bolt"></i>${order.urgent_level_name}</span>` : ''}
      </div>
      <div class="ov-meta">
        <span>Invoice <strong>${String(order.invoice_number ?? '')}</strong></span>
        <span>Placed <strong>${raw(ctx.datetime(order.order_date))}</strong></span>
        <span>by <strong>${String(order.created_by_name ?? '')}</strong></span>
      </div>
    </div>

    <div class="ov-actions udc-action-group">
      ${ctx.can('payments.collect') || ctx.can('payments.create') ? html`
        <a href="${u('modules/orders/payment.php?id=' + id)}" class="ov-btn ov-btn--primary"><i class="fa-solid fa-money-bill-wave"></i>Payment</a>` : ''}
      ${isEditable && ctx.can('orders.edit') ? html`
        <a href="${u('modules/orders/edit.php?id=' + id)}" class="ov-btn"><i class="fa-solid fa-pen"></i>Edit</a>
        ${!weightMode ? html`
        <a href="${u('modules/orders/add_items.php?order_id=' + id)}" class="ov-btn"><i class="fa-solid fa-plus"></i>Add Item</a>` : ''}` : ''}
      ${ctx.can('billing.view') ? html`
        <a href="${u('modules/orders/invoice.php?id=' + id)}" target="_blank" class="ov-btn"><i class="fa-solid fa-file-invoice"></i>Invoice</a>
        ${!phpEmpty(order.customer_mobile) ? html`
        <button type="button" class="ov-btn" id="btnSendInvoiceWhatsapp" style="background:#25D366;color:#fff;border-color:#25D366;"><i class="fa-brands fa-whatsapp"></i>Send Invoice</button>` : ''}
        ${ctx.can('garment_tags.print') || ctx.can('garment_tags.reprint') ? html`
        <a href="${u('modules/barcode/tags_print.php?order_id=' + id)}" target="_blank" class="ov-btn"><i class="fa-solid fa-tag"></i>Tags</a>` : ''}` : ''}
      ${ctx.can('payments.refund') && flt(order.total_paid) > 0 ? html`
        <a href="${u('modules/orders/refund.php?id=' + id)}" class="ov-btn ov-btn--danger"><i class="fa-solid fa-rotate-left"></i>${cancelled ? 'Process Refund' : 'Refund'}</a>` : ''}
      ${isEditable && ctx.can('orders.cancel') ? html`
        <button class="ov-btn ov-btn--danger" id="btnCancelOrder"><i class="fa-solid fa-ban"></i>Cancel</button>` : ''}
    </div>
  </div>
</div>

${cancelled && receivableStatus === 'Refund Due' ? html`
<div class="col-12">
  <div class="ov-alert">
    <span><i class="fa-solid fa-triangle-exclamation"></i>This order is cancelled and has a net effective payment on file — a refund/credit is due to the customer.</span>
    ${ctx.can('payments.refund') ? html`
      <a href="${u('modules/orders/refund.php?id=' + id)}" class="ov-btn ov-btn--solid-danger">Process Refund</a>` : ''}
  </div>
</div>` : ''}

<div class="col-md-4">
  <div class="card ov-card h-100"><div class="card-body">
    <h6 class="ov-card-title"><i class="fa-solid fa-user"></i>Customer</h6>
    <div class="ov-cust-name">${order.customer_name}</div>
    <div class="ov-cust-code">${order.customer_code}</div>
    <div class="ov-cust-line"><i class="fa-solid fa-phone"></i>${order.customer_mobile}</div>
    ${String(order.customer_address ?? '').trim() !== '' ? html`
      <div class="ov-cust-line"><i class="fa-solid fa-location-dot"></i>${String(order.customer_address)}</div>` : ''}
    <a href="${u('modules/customers/view.php?id=' + order.customer_id)}" class="ov-link">View customer profile</a>
  </div></div>
</div>
<div class="col-md-4">
  <div class="card ov-card h-100"><div class="card-body">
    <h6 class="ov-card-title"><i class="fa-solid fa-circle-info"></i>Order Info</h6>
    <dl class="ov-dl">
      <dt>Due</dt><dd>${raw(ctx.date(order.due_date))}${order.due_time ? raw(' ' + ctx.date(order.due_time, 'h:i A')) : ''}</dd>
      <dt>Urgent Level</dt><dd>${raw(orEmpty(order.urgent_level_name, 'Normal'))}</dd>
      <dt>Price List</dt><dd>${String(order.price_list_name ?? '')}</dd>
      <dt>Home Delivery</dt><dd>${order.home_delivery ? 'Yes' : 'No'}</dd>
      ${order.packaging_preference ? html`
      <dt>Packaging</dt><dd>${order.packaging_preference}</dd>` : ''}
    </dl>
  </div></div>
</div>
<div class="col-md-4">
  <div class="card ov-card h-100"><div class="card-body">
    <h6 class="ov-card-title"><i class="fa-solid fa-note-sticky"></i>Notes</h6>
    <p class="ov-notes">${raw(orEmpty(order.notes, '—'))}</p>
    ${cancelled ? html`
      <div class="ov-cancelled">
        <strong>Cancelled</strong> ${raw(ctx.datetime(order.cancelled_at))} by ${String(order.cancelled_by_name ?? '')}<br>
        Reason: ${String(order.cancelled_reason ?? '')}
      </div>` : ''}
  </div></div>
</div>

<div class="col-12">
  <div class="card ov-card">
    <div class="card-body">
      <h6 class="ov-card-title"><i class="fa-solid fa-list"></i>Items<span class="ov-count">${weightMode ? items.length : itemCount}</span></h6>

      ${weightMode ? html`
        <div class="table-responsive udc-cards-wrap mb-3">
          <table class="table table-sm udc-cards ov-table">
            <thead><tr><th>Service</th><th class="text-end">Weight</th><th class="text-end">Rate/KG</th><th class="text-end">Garments</th><th class="text-end">Total</th></tr></thead>
            <tbody>
            ${items.map((it) => html`
              <tr>
                <td class="udc-card-head udc-card-title">${it.service_name}</td>
                <td class="text-end">${String(it.weight)} KG</td>
                <td class="text-end" data-label="Rate/KG">${raw(money(it.weight_rate))}/kg</td>
                <td class="text-end" data-label="Garments">${int(it.quantity)}</td>
                <td class="text-end fw-bold udc-card-total" data-label="Total">${raw(money(it.total))}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <h6 class="ov-card-title ov-card-title--sub"><i class="fa-solid fa-shirt"></i>Garments<span class="ov-count">${laundryGarments.length}</span></h6>
        <ul class="ov-garments">
          ${laundryGarments.map((lg) => html`
            <li>
              <span class="ov-seq">${int(lg.item_sequence)}/${int(lg.total_garments)}</span>
              <span class="ov-gname">${lg.garment_name}</span>
              ${ctx.can('garment_tags.view') ? html`
                <a href="${u('modules/barcode/garment_detail.php?laundry_garment_id=' + lg.id)}" class="ov-link">View Detail</a>` : ''}
            </li>`)}
        </ul>` : html`
      <div class="table-responsive udc-cards-wrap">
        <table class="table table-sm udc-cards ov-table">
          <thead><tr><th>#</th><th>Garment</th><th>Service</th><th>Brand/Color</th><th>Defects/Remarks</th><th class="text-end">Quantity</th><th>Unit</th><th class="text-end">Rate</th><th class="text-end">Subtotal</th><th class="text-end">Discount</th><th class="text-end">Tax</th><th class="text-end">Total</th>${canEditItems ? html`<th></th>` : ''}</tr></thead>
          <tbody>
          ${items.map((it, i) => html`
            <tr>
              <td class="udc-card-head">
                ${ctx.can('garment_tags.view') ? html`
                  <a href="${u('modules/barcode/garment_detail.php?item_id=' + it.id)}" title="View garment tag">${`${i + 1}/${itemCount}`}</a>` : `${i + 1}/${itemCount}`}
              </td>
              <td class="udc-card-head udc-card-title">${it.garment_name}${it.sku ? raw(` <span class="text-muted small">(${e(it.sku)})</span>`) : ''}</td>
              <td class="udc-card-head text-muted">${it.service_name}</td>
              <td data-label="Brand/Color">${raw(orEmpty(it.brand_name, '—'))} / ${raw(orEmpty(it.color_name, '—'))}</td>
              <td class="small" data-label="Remarks">
                ${defectsByItem[String(it.id)]?.length ? defectsByItem[String(it.id)]!.join(', ') : '—'}
                ${it.remarks ? html`<div class="text-muted">${it.remarks}</div>` : ''}
              </td>
              <td class="text-end" data-label="Quantity">${it.weight !== null ? String(it.weight) : String(it.quantity)}</td>
              <td data-label="Unit">${it.weight !== null ? 'KG' : it.unit}</td>
              <td class="text-end" data-label="Rate">${it.weight !== null ? raw(money(it.weight_rate) + '/kg') : raw(money(it.unit_price))}</td>
              <td class="text-end" data-label="Subtotal">${raw(money(it.subtotal))}</td>
              <td class="text-end" data-label="Discount">${raw(money(it.discount))}</td>
              <td class="text-end" data-label="Tax">${raw(money(it.tax))}</td>
              <td class="text-end fw-bold udc-card-total" data-label="Total">${raw(money(it.total))}</td>
              ${canEditItems ? html`
              <td data-label=""><button class="ov-remove-btn btn-remove-item" data-id="${it.id}" title="Remove item"><i class="fa-solid fa-trash"></i></button></td>` : ''}
            </tr>`)}
          </tbody>
        </table>
      </div>`}

      <div class="ov-summary-wrap">
        <div class="ov-summary">
          <div class="ov-sum-row"><span>Subtotal</span><span>${raw(money(order.subtotal))}</span></div>
          <div class="ov-sum-row"><span>Discount (${order.discount_type === 'Percent' ? `${String(order.discount_value)}%` : 'Flat'})</span><span class="ov-neg">- ${raw(money(order.discount_amount))}</span></div>
          <div class="ov-sum-row"><span>Urgent Charge</span><span>${raw(money(order.urgent_charge))}</span></div>
          <div class="ov-sum-row"><span>Delivery Charge</span><span>${raw(money(order.delivery_charge))}</span></div>
          <div class="ov-sum-row"><span>Tax</span><span>${raw(money(order.tax_amount))}</span></div>
          <div class="ov-sum-row ov-sum-row--grand"><span>Grand Total</span><span>${raw(money(order.grand_total))}</span></div>
          <div class="ov-sum-row"><span>Amount Paid</span><span class="ov-paid">${raw(money(order.total_paid))}</span></div>
          <div class="ov-sum-row ov-sum-row--due"><span>Current Due</span><span>${raw(money(order.current_due))}</span></div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="col-12">
  <div class="card ov-card"><div class="card-body">
    <h6 class="ov-card-title"><i class="fa-solid fa-receipt"></i>Payment History<span class="ov-count">${payments.length}</span></h6>
    ${payments.length === 0 ? html`
      <p class="ov-empty">No payments recorded yet.</p>` : html`
    <div class="table-responsive udc-cards-wrap">
    <table class="table table-sm mb-0 udc-cards ov-table">
      <thead><tr><th>Receipt #</th><th>Date</th><th>Method(s) / Reference</th><th>User</th><th>Status</th><th class="text-end">Amount</th><th></th></tr></thead>
      <tbody>
      ${payments.map((p) => html`
        <tr>
          <td class="udc-card-head udc-card-title" data-label="Receipt #">${p.payment_number}</td>
          <td data-label="Date">${raw(ctx.datetime(p.payment_date))}</td>
          <td class="small" data-label="Method(s)">${p.breakdown}</td>
          <td data-label="User">${String(p.created_by_name ?? '')}</td>
          <td data-label="Status">
            ${p.payment_kind === 'Refund' ? html`
              <span class="ov-pill ov-pill--refund">Refund</span>` : html`
              <span class="ov-pill ov-pill--done">Completed</span>`}
          </td>
          <td class="text-end udc-card-total ${p.payment_kind === 'Refund' ? 'ov-neg' : 'ov-paid'}" data-label="Amount">${p.payment_kind === 'Refund' ? '- ' : ''}${raw(money(p.total_amount))}</td>
          <td data-label=""><a href="${u('modules/orders/receipt.php?payment_id=' + p.id)}" target="_blank" class="ov-icon-btn" title="View/Print Receipt"><i class="fa-solid fa-receipt"></i></a></td>
        </tr>`)}
      </tbody>
    </table>
    </div>`}
  </div></div>
</div>

<div class="col-12">
  <div class="card ov-card"><div class="card-body">
    <h6 class="ov-card-title"><i class="fa-solid fa-clock-rotate-left"></i>History<span class="ov-count">${history.length}</span></h6>
    ${history.length === 0 ? html`
      <p class="ov-empty">No history yet.</p>` : html`
    <ul class="ov-history">
      ${history.map((h) => html`
        <li>
          <span class="ov-hist-action">${ucfirst(String(h.action))}</span>
          <span class="ov-hist-meta">by ${String(h.user_name ?? '')} &middot; ${raw(ctx.datetime(h.created_at))}</span>
        </li>`)}
    </ul>`}
  </div></div>
</div>

${raw(orderViewStyle(u, jsonEncode, e))}

${isEditable && (ctx.can('orders.edit') || ctx.can('orders.cancel')) ? html`
<div class="modal fade" id="cancelModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Cancel Order</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div id="cancelError" class="alert alert-danger d-none"></div>
        <label class="form-label small">Reason (required)</label>
        <textarea id="cancelReason" class="form-control" rows="3"></textarea>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Back</button>
        <button type="button" class="btn btn-danger" id="cancelConfirmBtn">Confirm Cancellation</button>
      </div>
    </div>
  </div>
</div>

${raw(orderViewScript(u, jsonEncode, e, { id, csrf: ctx.csrfToken() }))}` : ''}
`);
  });

  // ---- edit -----------------------------------------------------------------------------------
  webPage(app, '/modules/orders/edit', { auth: 'orders.edit' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const order = (await db.query<Row>('SELECT * FROM orders WHERE id = ?', [id]))[0];
    if (!order) return notFound(ctx);
    if (!(await orders.isEditable(order as { status_id: number }))) {
      ctx.flashSet('danger', 'This order can no longer be edited — processing has begun.');
      return new WebRedirect(`modules/orders/view.php?id=${id}`);
    }
    let errors: string[] = [];
    const canOverrideDiscount = ctx.can('pos.override_discount');
    const maxDiscount = flt(await ctx.setting('max_counter_discount_percent', '0'));
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const b = body(ctx);
      const reason = clean(b.reason);
      const hd = 'home_delivery' in b;
      const changes = {
        due_date: clean(b.due_date),
        due_time: clean(b.due_time) || null,
        urgent_level_id: !phpEmpty(b.urgent_level_id) ? int(b.urgent_level_id) : null,
        discount_type: ['Percent', 'Flat'].includes(str(b.discount_type)) ? str(b.discount_type) : 'Percent',
        discount_value: Math.max(0, flt(b.discount_value)),
        notes: clean(b.notes),
        workshop_notes: clean(b.workshop_notes),
        home_delivery: hd ? 1 : 0,
        delivery_charge: hd ? Math.max(0, flt(b.delivery_charge)) : 0,
      };
      if (!canOverrideDiscount && changes.discount_type === 'Percent' && changes.discount_value > maxDiscount + 0.01) errors.push(`Discount exceeds your authorized limit of ${maxDiscount}%.`);
      if (errors.length === 0) {
        const r = await orders.editOrder(id, changes, { userId: ctx.data.user_id!, ip: req.ip }, reason, canOverrideDiscount);
        if (r.success) { ctx.flashSet('success', 'Order updated successfully.'); return new WebRedirect(`modules/orders/view.php?id=${id}`); }
        errors = r.errors ?? [];
      }
    }
    const urgent = await db.query<Row>('SELECT id, level_name FROM urgent_levels WHERE is_active=1 ORDER BY sort_order');
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: `Edit Order ${order.short_order_code ?? order.order_number}` }, html`
<div class="col-md-8">
  <div class="card">
    <div class="card-body">
      ${errorList(errors)}
      <form method="POST">
        ${ctx.csrfField()}
        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label">Due Date</label>
            <input type="date" name="due_date" class="form-control" value="${order.due_date}" required>
          </div>
          <div class="col-md-6">
            <label class="form-label">Due Time</label>
            <input type="time" name="due_time" class="form-control" value="${String(order.due_time ?? '')}">
          </div>
          <div class="col-md-6">
            <label class="form-label">Urgent Level</label>
            <select name="urgent_level_id" class="form-select">
              <option value="">Normal</option>
              ${urgent.map((x) => html`
                <option value="${x.id}" ${sel(order.urgent_level_id !== null && Number(order.urgent_level_id) === Number(x.id))}>${x.level_name}</option>`)}
            </select>
          </div>
          <div class="col-md-6">
            <label class="form-label">Discount</label>
            <div class="input-group">
              <select name="discount_type" class="form-select" style="max-width:100px">
                <option value="Percent" ${sel(order.discount_type === 'Percent')}>%</option>
                <option value="Flat" ${sel(order.discount_type === 'Flat')}>Flat</option>
              </select>
              <input type="number" name="discount_value" class="form-control" value="${String(order.discount_value ?? '')}" min="0" step="0.01">
            </div>
            ${!canOverrideDiscount ? html`<div class="form-text">Max allowed: ${String(maxDiscount)}%</div>` : ''}
          </div>
          <div class="col-md-6 d-flex align-items-end">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" name="home_delivery" id="hd" ${order.home_delivery ? 'checked' : ''}>
              <label class="form-check-label" for="hd">Home Delivery</label>
            </div>
          </div>
          <div class="col-md-6">
            <label class="form-label">Delivery Charge</label>
            <input type="number" name="delivery_charge" class="form-control" value="${String(order.delivery_charge ?? '')}" min="0" step="0.01">
          </div>
          <div class="col-12">
            <label class="form-label">Notes</label>
            <textarea name="notes" class="form-control" rows="2">${String(order.notes ?? '')}</textarea>
          </div>
          <div class="col-12">
            <label class="form-label">Workshop Notes</label>
            <textarea name="workshop_notes" class="form-control" rows="2">${String(order.workshop_notes ?? '')}</textarea>
          </div>
          <div class="col-12">
            <label class="form-label">Reason for Change <span class="text-muted">(required if discount or urgent level changed)</span></label>
            <textarea name="reason" class="form-control" rows="2"></textarea>
          </div>
        </div>
        <div class="mt-4">
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-check me-1"></i>Save Changes</button>
          <a href="${u('modules/orders/view.php?id=' + id)}" class="btn btn-outline-secondary">Cancel</a>
        </div>
      </form>
    </div>
  </div>
</div>
`);
  });

  // ---- payment --------------------------------------------------------------------------------
  webPage(app, '/modules/orders/payment', { auth: 'login' }, async (ctx, req) => {
    if (!ctx.can('payments.collect') && !ctx.can('payments.create')) return forbiddenPage(ctx);
    const id = int((req.query as Record<string, unknown>).id);
    const order = (await db.query<Row>('SELECT o.*, c.full_name, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [id]))[0];
    if (!order) return notFound(ctx);
    const money = await ctx.loadMoney();
    const walletBalance = await ctx.svc.wallet.getBalance(Number(order.customer_id));
    if (!canActAsStoreForOrder(ctx, Number(order.store_id))) return storeDenied(ctx, 'collect payment');
    let errors: string[] = [];
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const b = body(ctx);
      const typeIds = formArray(b, 'payment_type_id'), amounts = formArray(b, 'amount');
      const lines: { payment_type_id: number; amount: number }[] = [];
      typeIds.forEach((typeId, i) => { const amt = flt(amounts[i] ?? 0); if (!phpEmpty(typeId) && amt > 0) lines.push({ payment_type_id: int(typeId), amount: amt }); });
      const walletAmount = Math.max(0, flt(b.wallet_amount));
      if (walletAmount > walletBalance + 0.01) errors.push(`Wallet amount exceeds the customer's available balance of ${money(walletBalance)}.`);
      const collected = lines.reduce((a, l) => a + l.amount, 0) + walletAmount;
      if (collected <= 0) errors.push('Enter at least one payment amount.');
      if (collected > flt(order.current_due) + 0.01) errors.push(`Payment amount (${money(collected)}) exceeds the current due of ${money(order.current_due)}.`);
      if (errors.length === 0) {
        const r = await orders.recordPayment(id, Number(order.customer_id), lines, walletAmount, { userId: ctx.data.user_id!, ip: req.ip });
        if (r.success) {
          ctx.flashSet('success', 'Payment recorded successfully.');
          try {
            if (!phpEmpty(order.mobile)) {
              const paid = lines.reduce((a, l) => a + l.amount, 0) + walletAmount;
              await ctx.svc.whatsapp.enqueue(Number(order.customer_id), id, order.mobile, 'payment_received',
                { customer_name: order.full_name, order_number: (order.short_order_code ?? order.order_number) ?? '', paid_amount: money(paid), business_name: await ctx.setting('business_name', ctx.svc.env.APP_NAME) },
                `payment_received:${r.payment_id ?? `p_${Date.now()}${Math.random().toString(16).slice(2)}`}`);
            }
          } catch (ex) { console.error('WhatsApp payment_received enqueue failed:', (ex as Error).message); }
          if (!phpEmpty(r.payment_id)) return new WebRedirect(`modules/orders/receipt.php?payment_id=${r.payment_id}`);
          return new WebRedirect(`modules/orders/view.php?id=${id}`);
        }
        errors = r.errors ?? [];
      }
    }
    const paymentTypes = await db.query<Row>('SELECT id, type_name FROM payment_types WHERE is_active=1 ORDER BY sort_order');
    const paymentHistory = await db.query<Row>(
      `SELECT p.*, u.full_name AS created_by_name, GROUP_CONCAT(CONCAT(pt.type_name, ': ', ptx.amount) SEPARATOR ', ') AS breakdown
       FROM payments p JOIN payment_transactions ptx ON ptx.payment_id = p.id JOIN payment_types pt ON pt.id = ptx.payment_type_id LEFT JOIN users u ON u.id = p.created_by
       WHERE p.order_id = ? GROUP BY p.id ORDER BY p.id DESC LIMIT 10`, [id]);
    const walletHistory = await db.query<Row>('SELECT * FROM wallet_transactions WHERE customer_id = ? ORDER BY id DESC LIMIT 10', [Number(order.customer_id)]);
    const u = (p: string) => ctx.baseUrl(p);
    const due = flt(order.current_due);
    const maxWallet = flt(order.current_due) < walletBalance ? String(order.current_due) : String(walletBalance);
    return layout(ctx, { title: `Payment: ${order.short_order_code ?? order.order_number}` }, html`
<div class="col-md-6">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold">Order ${order.short_order_code ?? order.order_number}</h6>
      <p class="text-muted mb-1">Invoice: ${String(order.invoice_number ?? '')} &middot; Order Date: ${raw(ctx.date(order.order_date))}</p>
      <p class="text-muted mb-3">${order.full_name} &middot; ${order.mobile}</p>
      <table class="table table-sm mb-3">
        <tr><td>Grand Total</td><td class="text-end">${raw(money(order.grand_total))}</td></tr>
        <tr><td>Already Paid</td><td class="text-end text-success">${raw(money(order.total_paid))}</td></tr>
        <tr class="fw-bold"><td>Current Due</td><td class="text-end text-danger">${raw(money(order.current_due))}</td></tr>
        <tr><td>Customer Wallet / Advance Balance</td><td class="text-end">${raw(money(walletBalance))}</td></tr>
      </table>

      ${errorList(errors)}

      ${due <= 0 ? html`
        <div class="alert alert-success">This order is fully paid.</div>` : html`
      <form method="POST" id="paymentForm">
        ${ctx.csrfField()}
        ${walletBalance > 0 ? html`
        <div class="mb-3">
          <label class="form-label small">Use Advance / Wallet (available ${raw(money(walletBalance))})</label>
          <input type="number" name="wallet_amount" class="form-control" min="0" step="0.01" max="${maxWallet}" value="0">
        </div>` : ''}
        <div id="payRows">
          <div class="row g-2 mb-2 pay-row">
            <div class="col-7">
              <select name="payment_type_id[]" class="form-select">
                ${paymentTypes.map((pt) => html`<option value="${pt.id}">${pt.type_name}</option>`)}
              </select>
            </div>
            <div class="col-5"><input type="number" name="amount[]" class="form-control" min="0" step="0.01"></div>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary mb-3" id="addRow"><i class="fa-solid fa-plus me-1"></i>Add Payment Line</button>
        <div>
          <button class="btn btn-primary" type="submit" id="submitBtn"><i class="fa-solid fa-check me-1"></i>Record Payment</button>
          <a href="${u('modules/orders/view.php?id=' + id)}" class="btn btn-outline-secondary">Cancel</a>
        </div>
      </form>`}
    </div>
  </div>
</div>

<div class="col-md-6">
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-2">Recent Payments (this order)</h6>
      ${paymentHistory.length === 0 ? html`
        <p class="text-muted mb-0 small">No payments yet.</p>` : html`
      <table class="udc-cards table table-sm mb-0">
        <thead><tr><th>Receipt #</th><th>Date</th><th>Method(s)</th><th>Staff</th><th class="text-end">Amount</th></tr></thead>
        <tbody>
        ${paymentHistory.map((p) => html`
          <tr>
            <td data-label="Receipt #"><a href="${u('modules/orders/receipt.php?payment_id=' + p.id)}" target="_blank">${p.payment_number}</a></td>
            <td data-label="Date">${raw(ctx.date(p.payment_date, 'd-M h:i A'))}</td>
            <td class="small" data-label="Method(s)">${p.breakdown}</td>
            <td class="small" data-label="Staff">${String(p.created_by_name ?? '')}</td>
            <td class="text-end ${p.payment_kind === 'Refund' ? 'text-danger' : ''}" data-label="Amount">${p.payment_kind === 'Refund' ? '- ' : ''}${raw(money(p.total_amount))}</td>
          </tr>`)}
        </tbody>
      </table>`}
    </div>
  </div>
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold mb-2">Wallet History (this customer)</h6>
      ${walletHistory.length === 0 ? html`
        <p class="text-muted mb-0 small">No wallet activity yet.</p>` : html`
      <table class="udc-cards table table-sm mb-0">
        <thead><tr><th>Date</th><th>Type</th><th class="text-end">Debit</th><th class="text-end">Credit</th><th class="text-end">Balance</th></tr></thead>
        <tbody>
        ${walletHistory.map((w) => html`
          <tr>
            <td data-label="Date">${raw(ctx.date(w.created_at, 'd-M h:i A'))}</td>
            <td data-label="Type">${w.txn_type}</td>
            <td class="text-end" data-label="Debit">${flt(w.debit) > 0 ? raw(money(w.debit)) : ''}</td>
            <td class="text-end" data-label="Credit">${flt(w.credit) > 0 ? raw(money(w.credit)) : ''}</td>
            <td class="text-end" data-label="Balance">${raw(money(w.balance_after))}</td>
          </tr>`)}
        </tbody>
      </table>`}
    </div>
  </div>
</div>

${raw(orderPaymentScript(u, jsonEncode, e))}
`);
  });

  // ---- refund ---------------------------------------------------------------------------------
  webPage(app, '/modules/orders/refund', { auth: 'payments.refund' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const order = (await db.query<Row>('SELECT o.*, c.full_name, c.mobile, os.status_key, os.status_label FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_statuses os ON os.id = o.status_id WHERE o.id = ?', [id]))[0];
    if (!order) return notFound(ctx);
    if (!canActAsStoreForOrder(ctx, Number(order.store_id))) return storeDenied(ctx, 'process a refund');
    const money = await ctx.loadMoney();
    let netPaid = 0;
    for (const row of await db.query<Row>('SELECT p.payment_kind, COALESCE(SUM(pt.amount),0) AS total FROM payment_transactions pt JOIN payments p ON p.id = pt.payment_id WHERE p.order_id = ? GROUP BY p.payment_kind', [id])) {
      const amt = flt(row.total);
      netPaid += row.payment_kind === 'Refund' ? -amt : amt;
    }
    netPaid = phpRound(Math.max(0, netPaid), 2);
    let errors: string[] = [];
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const b = body(ctx);
      const refundAmount = phpRound(flt(b.refund_amount), 2);
      const toWallet = 'credit_to_wallet' in b;
      const reason = clean(b.reason), remarks = clean(b.remarks);
      const lines: { payment_type_id: number; amount: number }[] = [];
      if (!toWallet) {
        const typeIds = formArray(b, 'payment_type_id'), amounts = formArray(b, 'amount');
        typeIds.forEach((typeId, i) => { const amt = flt(amounts[i] ?? 0); if (!phpEmpty(typeId) && amt > 0) lines.push({ payment_type_id: int(typeId), amount: amt }); });
      }
      const r = await orders.processRefund(id, refundAmount, lines, toWallet, reason, remarks, { userId: ctx.data.user_id!, ip: req.ip });
      if (r.success) { ctx.flashSet('success', `Refund ${r.refund_number} processed successfully.`); return new WebRedirect(`modules/orders/receipt.php?payment_id=${r.payment_id}`); }
      errors = r.errors ?? [];
    }
    const paymentTypes = await db.query<Row>('SELECT id, type_name FROM payment_types WHERE is_active=1 ORDER BY sort_order');
    const u = (p: string) => ctx.baseUrl(p);
    const me = ctx.user;
    return layout(ctx, { title: `Process Refund: ${order.short_order_code ?? order.order_number}` }, html`
<div class="col-md-7">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold">Order ${order.short_order_code ?? order.order_number}</h6>
      <p class="text-muted mb-3">${order.full_name} &middot; ${order.mobile} &middot; Status: ${order.status_label}</p>
      <table class="table table-sm mb-3">
        <tr><td>Grand Total</td><td class="text-end">${raw(money(order.grand_total))}</td></tr>
        <tr><td>Net Amount Paid</td><td class="text-end text-success">${raw(money(netPaid))}</td></tr>
        <tr><td>Current Due</td><td class="text-end text-danger">${raw(money(order.current_due))}</td></tr>
      </table>

      ${errorList(errors)}

      ${netPaid <= 0 ? html`
        <div class="alert alert-warning">No net payment has been recorded on this order — there is nothing to refund.</div>` : html`
      <form method="POST" id="refundForm">
        ${ctx.csrfField()}
        <div class="mb-3">
          <label class="form-label">Refund Amount * (max ${raw(money(netPaid))})</label>
          <input type="number" name="refund_amount" id="refundAmount" class="form-control" min="0.01" max="${String(netPaid)}" step="0.01" required>
          <div class="form-text">Use the full amount for a full refund, or a lesser amount for a partial refund.</div>
        </div>

        <div class="mb-3">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="creditToWallet" name="credit_to_wallet">
            <label class="form-check-label" for="creditToWallet">Credit to customer's wallet instead of refunding via original method</label>
          </div>
        </div>

        <div id="methodRows">
          <label class="form-label small">Refund Method(s)</label>
          <div class="row g-2 mb-2 method-row">
            <div class="col-7">
              <select name="payment_type_id[]" class="form-select">
                ${paymentTypes.filter((pt) => pt.type_name !== 'Wallet').map((pt) => html`
                  <option value="${pt.id}">${pt.type_name}</option>`)}
              </select>
            </div>
            <div class="col-5"><input type="number" name="amount[]" class="form-control" min="0" step="0.01"></div>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary mb-3" id="addMethodRow"><i class="fa-solid fa-plus me-1"></i>Add Method</button>

        <div class="mb-3">
          <label class="form-label">Reason * (required)</label>
          <textarea name="reason" class="form-control" rows="2" required></textarea>
        </div>
        <div class="mb-3">
          <label class="form-label">Remarks</label>
          <textarea name="remarks" class="form-control" rows="2"></textarea>
        </div>

        <div class="alert alert-secondary small">
          Approving user: <strong>${me?.full_name ?? ''}</strong> (${me?.role_name ?? ''}) &middot; ${raw(ctx.date(Math.floor(Date.now() / 1000), 'd-M-Y h:i A'))}
        </div>

        <button class="btn btn-danger" type="submit"><i class="fa-solid fa-rotate-left me-1"></i>Process Refund</button>
        <a href="${u('modules/orders/view.php?id=' + id)}" class="btn btn-outline-secondary">Cancel</a>
      </form>`}
    </div>
  </div>
</div>

${raw(orderRefundScript(u, jsonEncode, e))}
`);
  });

  // ---- receipt --------------------------------------------------------------------------------
  webPage(app, '/modules/orders/receipt', { auth: 'payments.view' }, async (ctx, req) => {
    const paymentId = int((req.query as Record<string, unknown>).payment_id);
    const payment = (await db.query<Row>(
      `SELECT p.*, o.order_number, o.short_order_code, o.grand_total, c.full_name, c.mobile, c.address, u.full_name AS created_by_name
       FROM payments p JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`, [paymentId]))[0];
    if (!payment) { ctx.flashSet('danger', 'Payment/receipt not found.'); return new WebRedirect('modules/orders/list.php'); }
    const money = await ctx.loadMoney();
    const lines = await db.query<Row>('SELECT pt.amount, pt.reference_no, ptype.type_name FROM payment_transactions pt JOIN payment_types ptype ON ptype.id = pt.payment_type_id WHERE pt.payment_id = ?', [paymentId]);
    let paidBefore = 0;
    for (const row of await db.query<Row>('SELECT p2.payment_kind, COALESCE(SUM(pt2.amount),0) AS total FROM payment_transactions pt2 JOIN payments p2 ON p2.id = pt2.payment_id WHERE p2.order_id = ? AND p2.id < ? GROUP BY p2.payment_kind', [payment.order_id, paymentId])) {
      const amt = flt(row.total);
      paidBefore += row.payment_kind === 'Refund' ? -amt : amt;
    }
    const previousDue = phpRound(flt(payment.grand_total) - paidBefore, 2);
    const thisAmount = flt(payment.total_amount);
    const isRefund = payment.payment_kind === 'Refund';
    const remainingDue = isRefund ? phpRound(previousDue + thisAmount, 2) : phpRound(previousDue - thisAmount, 2);
    const totalPaidToDate = phpRound(isRefund ? paidBefore - thisAmount : paidBefore + thisAmount, 2);
    const businessName = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? '';
    const address = (await ctx.setting('address', '')) ?? '', phone = (await ctx.setting('phone', '')) ?? '', whatsapp = (await ctx.setting('whatsapp', '')) ?? '', gstin = (await ctx.setting('gstin', '')) ?? '';
    const u = (p: string) => ctx.baseUrl(p);
    return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${isRefund ? 'Refund' : 'Payment'} Receipt ${payment.payment_number}</title>
${raw(receiptStyle(u, jsonEncode, e))}
</head>
<body>
<div class="receipt">
  <div class="brand">
    <div class="name">${businessName}</div>
    ${!phpEmpty(address) ? html`<div class="sub">${address}</div>` : ''}
    ${!phpEmpty(phone) ? html`<div class="sub">Ph: ${phone}${!phpEmpty(whatsapp) ? raw(' | WhatsApp: ' + e(whatsapp)) : ''}</div>` : ''}
    ${!phpEmpty(gstin) ? html`<div class="sub">GSTIN: ${gstin}</div>` : ''}
  </div>
  <div class="divider"></div>
  <div style="text-align:center;">
    <strong>${isRefund ? 'REFUND RECEIPT' : 'PAYMENT RECEIPT'}</strong>
    ${isRefund ? html`<div class="refund-tag">REFUND</div>` : ''}
  </div>
  <div class="divider"></div>
  <table>
    <tr><td class="label">Receipt #</td><td class="right">${payment.payment_number}</td></tr>
    <tr><td class="label">Order #</td><td class="right">${payment.short_order_code ?? payment.order_number}</td></tr>
    <tr><td class="label">Date/Time</td><td class="right">${raw(ctx.datetime(payment.payment_date))}</td></tr>
    <tr><td class="label">Customer</td><td class="right">${payment.full_name}</td></tr>
    <tr><td class="label">Mobile</td><td class="right">${payment.mobile}</td></tr>
  </table>
  <div class="divider"></div>
  <table>
    <thead><tr><td class="label">Method</td><td class="label right">Amount</td></tr></thead>
    ${lines.map((l) => html`
      <tr><td>${l.type_name}${!phpEmpty(l.reference_no) ? raw('<div style="font-size:11px;color:#888;">Ref: ' + e(l.reference_no) + '</div>') : ''}</td><td class="right">${raw(money(l.amount))}</td></tr>`)}
  </table>
  <div class="divider"></div>
  <table>
    <tr><td class="label">Previous Due</td><td class="right">${raw(money(previousDue))}</td></tr>
    <tr class="total-row"><td>${isRefund ? 'Refund Amount' : 'Amount Paid'}</td><td class="right">${raw(money(thisAmount))}</td></tr>
    <tr><td class="label">Total Paid (to date)</td><td class="right">${raw(money(Math.max(0, totalPaidToDate)))}</td></tr>
    <tr class="total-row"><td>Remaining Due</td><td class="right">${raw(money(Math.max(0, remainingDue)))}</td></tr>
  </table>
  <div class="divider"></div>
  <div style="font-size:11px;color:#888;text-align:center;">
    Processed by ${String(payment.created_by_name ?? '')}<br>
    ${isRefund && !phpEmpty(payment.remarks) ? html`Reason: ${payment.remarks}<br>` : ''}
    Thank you for choosing ${businessName}!
  </div>
  <div class="actions">
    <button onclick="window.print()">Print</button>
    <a href="${u('modules/orders/view.php?id=' + payment.order_id)}">Back to Order</a>
  </div>
</div>
</body>
</html>`;
  });

  // ---- invoice --------------------------------------------------------------------------------
  webPage(app, '/modules/orders/invoice', { auth: 'billing.view' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const order = (await db.query<Row>(
      `SELECT o.*, c.full_name, c.mobile, c.address, c.area, c.city, c.state, c.pincode, c.gstin AS customer_gstin, ul.level_name AS urgent_level_name
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id WHERE o.id = ?`, [id]))[0];
    if (!order) return notFound(ctx);
    const items = order.order_mode === 'weight'
      ? await db.query<Row>("SELECT oi.*, CONCAT('Laundry Batch (', oi.quantity, ' garments)') AS garment_name, s.service_name FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [id])
      : await db.query<Row>("SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, COALESCE(s.service_name, 'Unknown Service') AS service_name FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [id]);
    const money = await ctx.loadMoney();
    const businessName = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? '';
    const address = (await ctx.setting('address', '')) ?? '', phone = (await ctx.setting('phone', '')) ?? '', whatsapp = (await ctx.setting('whatsapp', '')) ?? '', gstin = (await ctx.setting('gstin', '')) ?? '', logoPath = (await ctx.setting('logo_path', '')) ?? '';
    const cfg = await ctx.svc.printConfig.getInvoiceConfig(Number(order.store_id ?? 0));
    const isThermal = cfg.invoice_printer_type === 'thermal';
    const widthMm = phpRound(cfg.invoice_width_mm, 2).toFixed(2);
    const heightMm = cfg.invoice_height_mm !== null ? phpRound(cfg.invoice_height_mm, 2).toFixed(2) : null;
    const isDefaultA4 = !isThermal && cfg.invoice_paper_size === 'a4' && Math.abs(cfg.invoice_width_mm - 210) < 0.01;
    const u = (p: string) => ctx.baseUrl(p);
    const hasMobile = !phpEmpty(order.mobile);

    // Invoice Design (Admin > Invoice Design): header text styling, content toggles, Terms & Conditions. Seeded to the previous
    // hard-coded invoice, so nothing changes until a setting is edited.
    const invFields = new Map<string, Row>();
    for (const r of await db.query<Row>('SELECT * FROM invoice_design_fields')) invFields.set(String(r.field_key), r);
    const invToggles = new Map<string, boolean>();
    for (const r of await db.query<Row>('SELECT toggle_key, is_on FROM invoice_design_toggles')) invToggles.set(String(r.toggle_key), !!Number(r.is_on));
    const invTerms = (await db.query<Row>('SELECT line_text FROM invoice_terms_conditions ORDER BY sort_order')).map((r) => String(r.line_text));
    const invOn = (key: string) => invToggles.get(key) ?? true;
    const fieldShown = (key: string) => !invFields.has(key) || !!Number(invFields.get(key)!.show_field);
    const fieldStyle = (key: string) => {
      const f = invFields.get(key);
      if (!f) return raw('');
      let css = `font-family:'${String(f.font_family).replace(/[\\'"]/g, '\\$&').replace(/\0/g, '\\0')}';font-size:${int(f.font_size)}px;text-align:${e(String(f.text_align))};`;
      css += Number(f.is_bold) ? 'font-weight:700;' : 'font-weight:400;';
      if (Number(f.is_italic)) css += 'font-style:italic;';
      if (Number(f.is_underline)) css += 'text-decoration:underline;';
      return raw(css);
    };
    const shortCode = order.short_order_code ?? order.order_number;
    return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${order.invoice_number}</title>
${raw(invoiceStyle({ isDefaultA4, isThermal, widthMm, heightMm }))}
</head>
<body>
<div class="actions"><button onclick="window.print()">Print Invoice</button>
  <button type="button" id="downloadInvoicePdfBtn">Download PDF</button>
  ${hasMobile ? html`
  <button type="button" id="sendWhatsappInvoiceBtn" style="background:#25D366;">Send via WhatsApp</button>` : ''}
  <span id="localPrintWrap" style="display:none;">
    <select id="localPrintPrinter" style="padding:9px;border-radius:6px;border:1px solid #ccc;"></select>
    <button type="button" id="localPrintBtn">Print via Local Service</button>
  </span>
  <a href="${u('modules/orders/view.php?id=' + id)}">Back to Order</a></div>
<div class="sheet" id="invoiceSheet">
  <div class="header">
    <div>
      ${!phpEmpty(logoPath) && invOn('show_logo') ? html`<img src="${u('uploads/logo/' + logoPath)}" style="max-height:50px;margin-bottom:8px;">` : ''}
      ${fieldShown('store_name') ? html`
      <div class="brand-name" style="${fieldStyle('store_name')}">${businessName}</div>` : ''}
      ${fieldShown('store_address') ? html`
      <div class="brand-sub" style="${fieldStyle('store_address')}">
        ${address}<br>
        ${invOn('show_phone_on_invoice') ? html`
          ${!phpEmpty(phone) ? html`Phone: ${phone}` : ''}
          ${!phpEmpty(whatsapp) ? html` &nbsp;|&nbsp; WhatsApp: ${whatsapp}` : ''}<br>` : ''}
        ${!phpEmpty(gstin) ? html`GSTIN: ${gstin}` : ''}
      </div>` : ''}
    </div>
    <div class="invoice-meta">
      <div class="title">INVOICE</div>
      <div>Invoice #: <strong>${String(order.invoice_number ?? '')}</strong></div>
      <div>Order #: <strong>${shortCode}</strong></div>
      <div>Date: ${raw(ctx.date(order.order_date))}</div>
    </div>
  </div>

  <div class="grid2">
    <div class="box">
      <h4>Billed To</h4>
      <div><strong>${order.full_name}</strong></div>
      <div>${String(order.address ?? '')}${!phpEmpty(order.area) ? raw(', ' + e(order.area)) : ''}</div>
      <div>${String(order.city ?? '')}${!phpEmpty(order.state) ? raw(', ' + e(order.state)) : ''} ${String(order.pincode ?? '')}</div>
      <div>Mobile: ${order.mobile}</div>
      ${!phpEmpty(order.customer_gstin) ? html`<div>GSTIN: ${order.customer_gstin}</div>` : ''}
    </div>
    <div class="box">
      <h4>Order Details</h4>
      ${invOn('show_due_date') ? html`<div>Due Date: ${raw(ctx.date(order.due_date))}${order.due_time ? raw(' at ' + ctx.date(order.due_time, 'h:i A')) : ''}</div>` : ''}
      ${invOn('show_urgent_level') ? html`<div>Urgent Level: ${raw(orEmpty(order.urgent_level_name, 'Normal'))}</div>` : ''}
      ${invOn('show_home_delivery') ? html`<div>Home Delivery: ${order.home_delivery ? 'Yes' : 'No'}</div>` : ''}
      ${!phpEmpty(order.packaging_preference) && invOn('show_packaging') ? html`<div>Packaging: ${order.packaging_preference}</div>` : ''}
      ${invOn('show_order_create_time') && !phpEmpty(order.created_at) ? html`<div>Created: ${raw(ctx.date(order.created_at, 'd M y h:i A'))}</div>` : ''}
    </div>
  </div>

  <div class="items-scroll">
  <table class="items">
    <thead>
      <tr><th>S.No</th><th>Garment</th><th>Service</th><th class="right">Qty</th><th>Unit</th><th class="right">Rate</th><th class="right">Discount</th>${invOn('show_tax_breakdown') ? html`<th class="right">Tax %</th><th class="right">Tax Amt</th>` : ''}<th class="right">Total</th></tr>
    </thead>
    <tbody>
    ${items.map((it, i) => html`
      <tr>
        <td>${i + 1}</td>
        <td>${it.garment_name}</td>
        <td>${it.service_name}</td>
        <td class="right">${it.weight !== null ? String(it.weight) : String(it.quantity)}</td>
        <td>${it.unit}</td>
        <td class="right">${it.weight !== null ? raw(money(it.weight_rate)) : raw(money(it.unit_price))}</td>
        <td class="right">${raw(money(it.discount))}</td>
        ${invOn('show_tax_breakdown') ? html`
        <td class="right">${String(it.tax_percent)}%</td>
        <td class="right">${raw(money(it.tax))}</td>` : ''}
        <td class="right">${raw(money(it.total))}</td>
      </tr>`)}
    </tbody>
  </table>
  </div>

  <table class="summary">
    <tr><td>Subtotal</td><td class="right">${raw(money(order.subtotal))}</td></tr>
    <tr><td>Discount</td><td class="right">- ${raw(money(order.discount_amount))}</td></tr>
    <tr><td>Urgent Charge</td><td class="right">${raw(money(order.urgent_charge))}</td></tr>
    <tr><td>Delivery Charge</td><td class="right">${raw(money(order.delivery_charge))}</td></tr>
    <tr><td>Tax</td><td class="right">${raw(money(order.tax_amount))}</td></tr>
    <tr class="total"><td>Grand Total</td><td class="right">${raw(money(order.grand_total))}</td></tr>
    <tr><td>Paid</td><td class="right text-success">${raw(money(order.total_paid))}</td></tr>
    <tr><td><strong>Due</strong></td><td class="right"><strong>${raw(money(order.current_due))}</strong></td></tr>
  </table>

  ${invOn('show_barcode') ? html`
  <div style="text-align:center;margin-top:16px;">${raw(code128Svg(String(shortCode), 220, 44))}</div>` : ''}

  ${invOn('show_signature_box') ? html`
  <div style="margin-top:40px;display:flex;justify-content:flex-end;">
    <div style="width:220px;text-align:center;">
      <div style="border-top:1px solid #333;padding-top:4px;font-size:11.5px;color:#555;">Customer Signature</div>
    </div>
  </div>` : ''}

  ${invOn('show_terms') && invTerms.length ? html`
  <div style="margin-top:20px;font-size:11px;color:#666;border-top:1px solid #eee;padding-top:10px;">
    <div style="font-weight:700;margin-bottom:4px;">Terms &amp; Conditions</div>
    <ol style="margin:0;padding-left:18px;">
      ${invTerms.map((line) => html`<li style="margin-bottom:2px;">${line}</li>`)}
    </ol>
  </div>` : ''}

  ${fieldShown('footer_note') ? html`
  <div class="footer-note" style="${fieldStyle('footer_note')}">
    This is a system-generated invoice from ${businessName}. For any queries regarding this order, please contact us with your Order/Invoice number.
  </div>` : ''}
</div>
${raw(invoiceScriptBase())}${hasMobile ? raw(invoiceScriptWhatsapp(u, jsonEncode, e, id, ctx.csrfToken())) : ''}${raw(invoiceScriptEnd)}
${raw(invoicePdfScriptTag)}
<script>
${raw(invoiceScriptPdf(String(order.invoice_number ?? '').replace(/[^A-Za-z0-9_-]/g, '_')))}
</script>
</body>
</html>`;
  });

  // ---- JSON actions (modules/orders/add_item.php, remove_item.php, cancel.php) ------------------
  const jsonAction = (name: string, permission: string, run: (ctx: WebCtx, p: Record<string, unknown>) => Promise<Row>) => {
    webPage(app, `/modules/orders/${name}`, { auth: 'login', methods: ['GET', 'POST'] }, async (ctx, req) => {
      if (!ctx.can(permission)) return forbiddenPage(ctx);
      const json = (d: unknown, status = 200) => new WebText(jsonEncode(d), status, 'application/json');
      const p = req.body;
      if (req.method !== 'POST' || !p || typeof p !== 'object' || Array.isArray(p)) return json({ success: false, errors: ['Invalid request payload.'] }, 400);
      const token = (p as Record<string, unknown>).csrf_token;
      if (!ctx.data.csrf_token || typeof token !== 'string' || token !== ctx.data.csrf_token) return json({ success: false, errors: ['Invalid or expired security token.'] }, 419);
      const result = await run(ctx, p as Record<string, unknown>);
      return json(result, result.success ? 200 : 422);
    });
  };
  jsonAction('add_item', 'orders.edit', (ctx, p) => orders.addItem(int(p.order_id), p, { userId: ctx.data.user_id!, ip: ctx.req.ip }, ctx.can('pos.manual_rate_override')));
  jsonAction('remove_item', 'orders.edit', (ctx, p) => orders.removeItem(int(p.order_id), int(p.item_id), { userId: ctx.data.user_id!, ip: ctx.req.ip }));
  jsonAction('cancel', 'orders.cancel', (ctx, p) => orders.cancelOrder(int(p.order_id), clean(p.reason), { userId: ctx.data.user_id!, ip: ctx.req.ip }));
}
