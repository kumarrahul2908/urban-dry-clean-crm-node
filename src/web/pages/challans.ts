import type { FastifyInstance } from 'fastify';
import { code128Svg } from '../../lib/barcodeCode128.js';
import { phpEmpty, phpRound } from '../../lib/php.js';
import { generateDocumentNumber } from '../../services/documentNumber.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { httpBuildQuery, int, urlencode, wallDate } from '../format.js';
import { html, jsonEncode, raw } from '../html.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const json = (d: unknown, status = 200) => new WebText(jsonEncode(d), status, 'application/json');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PACKAGING_LABELS: Record<string, string> = { FOLD: 'Fold', HANGER: 'Hanger', HALF_FOLD: 'Half Fold', HANGER_AND_FOLD: 'Hanger + Fold' };
/** date('d M Y', strtotime($v)) for a stored date/datetime string */
const dMY = (v: unknown) => wallDate('d M Y', v);
const t12 = (v: unknown) => wallDate('h:i A', '1970-01-01 ' + str(v));
const pieces = (it: Row) => Math.round((parseFloat(str(it.quantity)) || 0) * (it.pieces_per_unit === null || it.pieces_per_unit === undefined ? 1 : Math.trunc(parseFloat(str(it.pieces_per_unit)) || 0)));
const numTrim = (v: unknown) => (parseFloat(str(v)) || 0).toFixed(2).replace(/0+$/, '').replace(/\.+$/, '');
const savedNumbersOf = (v: unknown): string[] => { try { const d = JSON.parse(str(v) || '[]'); return Array.isArray(d) ? d.map(String) : []; } catch { return []; } };

/** Customer Challans (Rahul, Nov 2026): single-order challan, combined (summary / order-wise) + Delivery formats, list, reports, saved WhatsApp numbers, PDF viewer, delete + send APIs. */
export function registerChallanPages(app: FastifyInstance) {
  const { db, whatsapp, challanPdf } = app.services;
  const sendPdf = (buf: Buffer, filename: string, attachment: boolean) => new WebText(buf, 200, 'application/pdf', { 'Content-Disposition': `${attachment ? 'attachment' : 'inline'}; filename="${filename}"`, 'Content-Length': String(buf.length) });

  // ---- challan_select.php: old bookmark -> challan_combine.php --------------------------------------
  webPage(app, '/modules/orders/challan_select', { auth: 'login' }, async () => new WebRedirect('modules/orders/challan_combine.php'));

  // ---- challan.php: single order, two modes via ?with_amount=0|1 ---------------------------------------
  webPage(app, '/modules/orders/challan', { auth: 'billing.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const id = int(q.id);
    const withAmount = !phpEmpty(q.with_amount);
    const order = (await db.query<Row>('SELECT o.*, c.full_name, c.mobile, c.address, c.area, c.city, c.state, c.pincode FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [id]))[0];
    if (!order) { ctx.flashSet('danger', 'Order not found.'); return new WebRedirect('modules/orders/list.php'); }

    const items = order.order_mode === 'weight'
      ? await db.query<Row>("SELECT oi.*, CONCAT('Laundry Batch (', oi.quantity, ' garments)') AS garment_name, s.service_name FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [id])
      : await db.query<Row>("SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, COALESCE(s.service_name, 'Unknown Service') AS service_name FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [id]);
    const defectsByItem = new Map<number, string[]>();
    if (items.length) {
      for (const r of await db.query<Row>(`SELECT oid.order_item_id, d.defect_name FROM order_item_defects oid JOIN defects d ON d.id = oid.defect_id WHERE oid.order_item_id IN (${items.map(() => '?').join(',')})`, items.map((i) => i.id))) {
        const k = Number(r.order_item_id);
        (defectsByItem.get(k) ?? defectsByItem.set(k, []).get(k)!).push(r.defect_name);
      }
    }
    const businessName = str(await ctx.setting('business_name', ctx.svc.env.APP_NAME));
    const address = str(await ctx.setting('address', ''));
    const phone = str(await ctx.setting('phone', ''));

    // A challan record is saved the first time this page is generated (so it shows on the Challan List); re-opening with &view=1
    // only looks up the existing challan_number for this single order + mode.
    let challanNumber: string;
    if (!phpEmpty(q.view)) {
      const ex = (await db.query<Row>(
        `SELECT ch.challan_number FROM challans ch JOIN challan_orders co ON co.challan_id = ch.id
         WHERE co.order_id = ? AND ch.with_amount = ? AND (SELECT COUNT(*) FROM challan_orders WHERE challan_id = ch.id) = 1 ORDER BY ch.id DESC LIMIT 1`, [id, withAmount ? 1 : 0]))[0]?.challan_number;
      challanNumber = !phpEmpty(ex) ? String(ex) : await generateDocumentNumber(db, 'customer_challan_prefix', 6);
    } else {
      challanNumber = await generateDocumentNumber(db, 'customer_challan_prefix', 6);
      const ins = await db.execute('INSERT INTO challans (challan_number, order_id, with_amount, created_by) VALUES (?, ?, ?, ?)', [challanNumber, id, withAmount ? 1 : 0, ctx.data.user_id ?? null]);
      await db.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?, ?)', [ins.insertId, id]);
    }
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    const code = str(order.short_order_code ?? order.order_number);
    const pageTitle = withAmount ? 'Challan (With Amount)' : 'Challan (Without Amount)';
    const totalGarments = Math.trunc(items.reduce((a, it) => a + pieces(it), 0));
    const fname = code.replace(/[^A-Za-z0-9_-]/g, '_');
    return new WebText(html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle} — ${code}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background:#eef1f6; margin:0; padding:20px; color:#1c2230; }
  .sheet { max-width:800px; margin:0 auto; background:#fff; padding:36px; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #0b3d91; padding-bottom:16px; margin-bottom:16px; }
  .brand-name { font-size:22px; font-weight:800; color:#0b3d91; }
  .brand-sub { font-size:12px; color:#555; margin-top:4px; line-height:1.5; }
  .meta { text-align:right; font-size:13px; }
  .meta .title { font-size:18px; font-weight:700; color:#0b3d91; }
  .grid2 { display:flex; justify-content:space-between; gap:24px; margin-bottom:20px; }
  .box { flex:1; font-size:13px; }
  .box h4 { font-size:12px; text-transform:uppercase; color:#888; margin:0 0 6px; letter-spacing:.05em; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:20px; font-size:12.5px; }
  table.items th { background:#f1f5f9; text-align:left; padding:8px 6px; border-bottom:2px solid #dde3ec; font-size:11px; text-transform:uppercase; color:#556; }
  table.items td { padding:7px 6px; border-bottom:1px solid #eef1f6; vertical-align:top; }
  .right { text-align:right; }
  .extra { color:#b45309; font-size:11.5px; }
  table.summary { width:260px; margin-left:auto; font-size:13px; border-collapse:collapse; }
  table.summary td { padding:5px 0; }
  table.summary tr.total td { font-weight:800; font-size:16px; border-top:2px solid #0b3d91; padding-top:8px; color:#0b3d91; }
  .footer-note { margin-top:30px; font-size:11px; color:#888; border-top:1px solid #eee; padding-top:12px; }
  .actions { text-align:center; margin:20px 0; }
  .actions button, .actions a { border:0; background:#0b3d91; color:#fff; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:13px; margin:0 4px; cursor:pointer; display:inline-block; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { box-shadow:none; padding:10mm; }
    .actions { display:none; }
    @page { size: A4; margin: 12mm; }
  }
  @media screen and (max-width: 480px) {
    body { padding: 8px; }
    .sheet { padding: 14px; }
    .header { flex-direction: column; gap: 10px; }
    .meta { text-align: left; }
    .grid2 { flex-direction: column; gap: 14px; }
    .items-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; margin-bottom: 14px; }
    table.items { min-width: 560px; margin-bottom: 0; }
    table.summary { width: 100%; }
    .actions button, .actions a { display: block; width: 100%; margin: 6px 0; box-sizing: border-box; }
  }
</style>
</head>
<body>
<div class="actions">
  <button onclick="window.print()">Print</button>
  <button type="button" id="downloadChallanPdfBtn">Download PDF</button>
  <a href="${u('modules/orders/challan_select.php')}">New Challan</a>
  <a href="${u('modules/orders/view.php?id=' + id)}">Back to Order</a>
</div>
<div class="sheet" id="challanSheet">
  <div class="header">
    <div>
      <div class="brand-name">${businessName}</div>
      <div class="brand-sub">
        ${address}<br>
        ${phone !== '' && phone !== '0' ? html`Phone: ${phone}` : ''}
      </div>
    </div>
    <div class="meta">
      <div class="title">CHALLAN${withAmount ? '' : ' (Without Amount)'}</div>
      <div>Challan #: <strong>${challanNumber}</strong></div>
      <div>Order #: <strong>${code}</strong></div>
      <div>Date: ${dMY(order.order_date)}</div>
    </div>
  </div>

  <div class="grid2">
    <div class="box">
      <h4>Customer</h4>
      <div><strong>${order.full_name}</strong></div>
      <div>${str(order.address)}${!phpEmpty(order.area) ? ', ' + str(order.area) : ''}</div>
      <div>${str(order.city)}${!phpEmpty(order.state) ? ', ' + str(order.state) : ''} ${str(order.pincode)}</div>
      <div>Mobile: ${order.mobile}</div>
    </div>
    <div class="box">
      <h4>Order Details</h4>
      <div>Due Date: ${dMY(order.due_date)}${!phpEmpty(order.due_time) ? ' at ' + t12(order.due_time) : ''}</div>
      <div>Total Garments: ${totalGarments}</div>
    </div>
  </div>

  <div class="items-scroll">
  <table class="items">
    <thead>
      <tr>
        <th>S.No</th><th>Garment</th><th>Service</th><th>Packaging / Defects</th><th class="right">Qty/Weight</th>
        ${withAmount ? html`<th class="right">Rate</th><th class="right">Amount</th>` : ''}
      </tr>
    </thead>
    <tbody>
    ${items.map((it, i) => {
      const pkg = !phpEmpty(it.packaging_style) && PACKAGING_LABELS[str(it.packaging_style)] !== undefined ? PACKAGING_LABELS[str(it.packaging_style)]! : null;
      const defects = defectsByItem.get(Number(it.id)) ?? [];
      const extraParts = [pkg, defects.length ? defects.join(', ') : null].filter((x): x is string => x !== null && x !== '' && x !== '0');
      return html`
      <tr>
        <td>${i + 1}</td>
        <td>${it.garment_name}</td>
        <td>${it.service_name}</td>
        <td class="extra">${extraParts.length ? extraParts.join(' · ') : '—'}</td>
        <td class="right">${it.weight !== null ? str(it.weight) + ' Kg' : str(it.quantity) + ' Pcs'}</td>
        ${withAmount ? html`
        <td class="right">${money(it.weight !== null ? it.weight_rate : it.unit_price)}</td>
        <td class="right">${money(it.total)}</td>` : ''}
      </tr>`;
    })}
    </tbody>
  </table>
  </div>

  ${withAmount ? html`
  <table class="summary">
    <tr><td>Subtotal</td><td class="right">${money(order.subtotal)}</td></tr>
    <tr><td>Discount</td><td class="right">- ${money(order.discount_amount)}</td></tr>
    <tr><td>Tax</td><td class="right">${money(order.tax_amount)}</td></tr>
    <tr class="total"><td>Grand Total</td><td class="right">${money(order.grand_total)}</td></tr>
  </table>` : ''}

  <div style="text-align:center;margin-top:16px;">${raw(code128Svg(code, 220, 44))}</div>

  <div style="margin-top:40px;display:flex;justify-content:flex-end;">
    <div style="width:220px;text-align:center;">
      <div style="border-top:1px solid #333;padding-top:4px;font-size:11.5px;color:#555;">Received By / Signature</div>
    </div>
  </div>

  <div class="footer-note">This is a system-generated challan from ${businessName}, not a tax invoice.</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>
<script>
document.getElementById('downloadChallanPdfBtn').addEventListener('click', function () {
  const btn = this; const original = btn.textContent;
  btn.textContent = 'Preparing...'; btn.disabled = true;
  html2pdf().set({
    margin: 10,
    filename: 'Challan-${fname}${withAmount ? '' : '-NoAmount'}.pdf',
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(document.getElementById('challanSheet')).save().finally(function () {
    btn.textContent = original; btn.disabled = false;
  });
});
</script>
</body>
</html>
`.toString(), 200);
  });

  // ---- challan_combine.php: create (or edit) a combined challan -------------------------------------
  webPage(app, '/modules/orders/challan_combine', { auth: 'billing.view', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const b = body(ctx);
    const editChallanId = int(q.challan_id ?? b.challan_id);
    let editChallan: Row | undefined;
    let preselected: number[] = [];
    if (editChallanId) {
      editChallan = (await db.query<Row>('SELECT id, challan_number, with_amount, combine_format FROM challans WHERE id = ?', [editChallanId]))[0];
      if (!editChallan) { ctx.flashSet('danger', 'Challan not found.'); return new WebRedirect('modules/orders/challan_list.php'); }
      preselected = (await db.query<Row>('SELECT order_id FROM challan_orders WHERE challan_id = ?', [editChallanId])).map((r) => Number(r.order_id));
    }

    if (req.method === 'POST' && b.order_ids !== undefined || req.method === 'POST' && b['order_ids[]'] !== undefined) {
      if (!ctx.csrfValid()) return csrfFail();
      const rawIds = ([] as unknown[]).concat(b['order_ids[]'] ?? b.order_ids ?? []);
      let orderIds = [...new Set(rawIds.map((x) => int(x)).filter((x) => x !== 0))];
      let withAmount = !phpEmpty(b.with_amount);
      let combineFormat = (b.combine_format ?? 'aggregated') === 'order_wise' ? 'order_wise' : 'aggregated';
      // "Delivery Challan" button: order-wise garments + each order's final amount, always with amount.
      if (!phpEmpty(b.delivery)) { combineFormat = 'delivery'; withAmount = true; }
      if (!orderIds.length) {
        ctx.flashSet('danger', 'Select at least one order.');
        return new WebRedirect(editChallanId ? 'modules/orders/challan_combine.php?challan_id=' + editChallanId : 'modules/orders/challan_combine.php');
      }
      orderIds = [...orderIds].sort((x, y) => x - y);
      const found = await db.query<Row>(`SELECT id FROM orders WHERE id IN (${orderIds.map(() => '?').join(',')})`, orderIds);
      if (found.length !== orderIds.length) { ctx.flashSet('danger', 'One or more selected orders could not be found.'); return new WebRedirect('modules/orders/challan_combine.php'); }

      // Editing replaces THIS challan's orders/mode in place (same challan_number).
      if (editChallanId) {
        try {
          await db.tx(async (t) => {
            await t.execute('UPDATE challans SET with_amount = ?, combine_format = ?, order_id = ? WHERE id = ?', [withAmount ? 1 : 0, combineFormat, orderIds[0], editChallanId]);
            await t.execute('DELETE FROM challan_orders WHERE challan_id = ?', [editChallanId]);
            for (const oid of orderIds) await t.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?, ?)', [editChallanId, oid]);
          });
        } catch {
          ctx.flashSet('danger', 'Could not update the challan.');
          return new WebRedirect('modules/orders/challan_combine.php?challan_id=' + editChallanId);
        }
        return new WebRedirect('modules/orders/challan_pdf.php?challan_id=' + editChallanId);
      }

      // Reuse check: the exact same SET of orders at this with_amount AND combine_format reuses the existing challan.
      let challanId: number | null = null;
      for (const cand of await db.query<Row>('SELECT id, challan_number FROM challans WHERE with_amount = ? AND combine_format = ?', [withAmount ? 1 : 0, combineFormat])) {
        const ex = (await db.query<Row>('SELECT order_id FROM challan_orders WHERE challan_id = ? ORDER BY order_id', [cand.id])).map((r) => Number(r.order_id));
        if (ex.length === orderIds.length && ex.every((v, i) => v === orderIds[i])) { challanId = Number(cand.id); break; }
      }
      if (challanId === null) {
        const challanNumber = await generateDocumentNumber(db, 'customer_challan_prefix', 6);
        try {
          challanId = await db.tx(async (t) => {
            const ins = await t.execute('INSERT INTO challans (challan_number, order_id, with_amount, combine_format, created_by) VALUES (?, ?, ?, ?, ?)', [challanNumber, orderIds[0], withAmount ? 1 : 0, combineFormat, ctx.data.user_id ?? null]);
            for (const oid of orderIds) await t.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?, ?)', [ins.insertId, oid]);
            return ins.insertId;
          });
        } catch {
          ctx.flashSet('danger', 'Could not create the combined challan.');
          return new WebRedirect('modules/orders/challan_combine.php');
        }
      }
      return new WebRedirect('modules/orders/challan_pdf.php?challan_id=' + challanId);
    }

    const search = clean(q.q);
    const baseSql = `SELECT o.id, o.short_order_code, o.order_number, o.order_date, c.full_name,
         (SELECT COALESCE(SUM(quantity * pieces_per_unit), 0) FROM order_items WHERE order_id = o.id) AS garment_count
         FROM orders o JOIN customers c ON c.id = o.customer_id`;
    let orders: Row[];
    if (search !== '') {
      const like = `%${search}%`;
      orders = await db.query<Row>(`${baseSql} WHERE o.order_number LIKE ? OR o.short_order_code LIKE ? OR c.full_name LIKE ? OR c.mobile LIKE ? ORDER BY o.id DESC LIMIT 50`, [like, like, like, like]);
    } else {
      orders = await db.query<Row>(`${baseSql} ORDER BY o.id DESC LIMIT 50`);
    }
    // The challan's CURRENTLY selected orders must always be visible (and pre-checked) in edit mode, even if they scrolled off the latest-50.
    if (editChallanId && preselected.length) {
      const shown = new Set(orders.map((o) => Number(o.id)));
      const missing = preselected.filter((x) => !shown.has(x));
      if (missing.length) orders = [...await db.query<Row>(`${baseSql} WHERE o.id IN (${missing.map(() => '?').join(',')})`, missing), ...orders];
    }
    const u = (p: string) => ctx.baseUrl(p);
    const title = editChallanId ? 'Edit Challan ' + editChallan!.challan_number : 'Create Combined Challan';
    const fmt = editChallan?.combine_format ?? 'aggregated';
    return layout(ctx, { title }, html`
<div class="container-fluid py-3">
  <h4 class="fw-bold mb-3"><i class="fa-solid fa-layer-group me-2"></i>${title}</h4>
  <p class="text-muted small">${editChallanId ? 'Change which orders are on this challan, or switch With/Without Amount -- the challan number stays the same.' : 'Select several orders — their garments will be grouped and summed by name on one combined challan (e.g. 3 Shirt, 2 Pants), with no customer section, just the order numbers covered.'}</p>

  <form method="GET" class="mb-3">
    ${editChallanId ? html`<input type="hidden" name="challan_id" value="${editChallanId}">` : ''}
    <div class="input-group" style="max-width:500px;">
      <input type="text" name="q" class="form-control" placeholder="Order #, customer name or mobile" value="${search}">
      <button class="btn btn-outline-secondary" type="submit"><i class="fa-solid fa-magnifying-glass"></i></button>
    </div>
  </form>

  <form method="POST" id="combineForm">
    ${ctx.csrfField()}
    ${editChallanId ? html`<input type="hidden" name="challan_id" value="${editChallanId}">` : ''}
    <div class="card">
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0">
          <thead><tr><th style="width:40px;"></th><th>Order</th><th>Customer</th><th>Date</th><th class="text-end">Garments</th></tr></thead>
          <tbody>
          ${orders.length === 0 ? html`
            <tr><td colspan="5" class="text-center text-muted py-4">No orders found.</td></tr>` : ''}
          ${orders.map((o) => html`
            <tr>
              <td><input type="checkbox" class="form-check-input order-checkbox" name="order_ids[]" value="${o.id}" ${preselected.includes(Number(o.id)) ? 'checked' : ''}></td>
              <td>${str(o.short_order_code ?? o.order_number)}</td>
              <td>${o.full_name}</td>
              <td>${dMY(o.order_date)}</td>
              <td class="text-end">${int(o.garment_count)}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    </div>

    <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mt-3">
      <span id="selectedCount" class="text-muted small">0 selected</span>
      <div id="formatPicker" class="d-flex align-items-center gap-2" style="display:none;">
        <span class="text-muted small">Format:</span>
        <div class="btn-group" role="group">
          <input type="radio" class="btn-check" name="combine_format" id="fmtAggregated" value="aggregated" ${fmt !== 'order_wise' ? 'checked' : ''}>
          <label class="btn btn-outline-secondary btn-sm" for="fmtAggregated" title="All selected orders' garments grouped and summed by name">Summary</label>

          <input type="radio" class="btn-check" name="combine_format" id="fmtOrderWise" value="order_wise" ${(editChallan?.combine_format ?? '') === 'order_wise' ? 'checked' : ''}>
          <label class="btn btn-outline-secondary btn-sm" for="fmtOrderWise" title="Each order's garments shown in its own section">Order-wise</label>
        </div>
      </div>
      <div>
        ${editChallanId ? html`<span class="text-muted small me-2">Currently: ${(editChallan?.combine_format ?? '') === 'delivery' ? 'Delivery Challan' : (Number(editChallan!.with_amount) ? 'With Amount' : 'Without Amount')}</span>` : ''}
        <button type="submit" name="delivery" value="1" class="btn btn-success" id="btnDelivery" disabled title="Garments order-wise + each order's final amount">Delivery Challan</button>
        <button type="submit" name="with_amount" value="0" class="btn btn-outline-secondary" id="btnWithoutAmount" disabled>${editChallanId ? 'Save as Without Amount' : 'Without Amount'}</button>
        <button type="submit" name="with_amount" value="1" class="btn btn-primary" id="btnWithAmount" disabled>${editChallanId ? 'Save as With Amount' : 'With Amount'}</button>
      </div>
    </div>
  </form>
</div>
<script>
function updateSelectedCount() {
  const count = document.querySelectorAll('.order-checkbox:checked').length;
  document.getElementById('selectedCount').textContent = count + ' selected';
  document.getElementById('btnWithoutAmount').disabled = count === 0;
  document.getElementById('btnWithAmount').disabled = count === 0;
  document.getElementById('btnDelivery').disabled = count === 0;
  // Rahul: "ye bhi dono tarike se ho" -- the format choice (Summary vs Order-wise) only means
  // anything once 2+ orders are picked; a single order is already "order-wise" trivially, so
  // the picker only shows up when it's actually a choice.
  document.getElementById('formatPicker').style.display = count > 1 ? 'flex' : 'none';
}
document.querySelectorAll('.order-checkbox').forEach(cb => cb.addEventListener('change', updateSelectedCount));
updateSelectedCount(); // Rahul: edit mode starts with pre-checked boxes -- buttons must not start disabled.
</script>
`);
    void u;
  });

  // ---- challan_list.php ---------------------------------------------------------------------------
  webPage(app, '/modules/orders/challan_list', { auth: 'billing.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const search = clean(q.q);
    // Matching CHALLAN ids first (via any linked order/customer), then each challan's full set of orders/garments separately.
    let whereIds = '1=1';
    const idParams: unknown[] = [];
    if (search !== '') {
      whereIds += ' AND (ch.challan_number LIKE ? OR o.order_number LIKE ? OR o.short_order_code LIKE ? OR c.full_name LIKE ?)';
      const like = `%${search}%`;
      idParams.push(like, like, like, like);
    }
    const page = Math.max(1, int(q.page));
    const perPage = 50;
    const offset = (page - 1) * perPage;
    const total = int((await db.query<Row>(
      `SELECT COUNT(DISTINCT ch.id) AS n FROM challans ch JOIN challan_orders co ON co.challan_id = ch.id JOIN orders o ON o.id = co.order_id JOIN customers c ON c.id = o.customer_id WHERE ${whereIds}`, idParams))[0]!.n);
    const challanIds = (await db.query<Row>(
      `SELECT DISTINCT ch.id FROM challans ch JOIN challan_orders co ON co.challan_id = ch.id JOIN orders o ON o.id = co.order_id JOIN customers c ON c.id = o.customer_id
       WHERE ${whereIds} ORDER BY ch.id DESC LIMIT ${perPage} OFFSET ${offset}`, idParams)).map((r) => Number(r.id));
    let rows: Row[] = [];
    if (challanIds.length) {
      rows = await db.query<Row>(
        `SELECT ch.id, ch.challan_number, ch.with_amount, ch.combine_format, ch.created_at, u.full_name AS created_by_name,
         COUNT(DISTINCT co.order_id) AS order_count,
         GROUP_CONCAT(DISTINCT COALESCE(o.short_order_code, o.order_number) ORDER BY o.id SEPARATOR ', ') AS order_numbers,
         MIN(o.id) AS first_order_id, MIN(c.full_name) AS first_customer_name,
         MIN(c.mobile) AS first_customer_mobile, MIN(c.address) AS first_customer_address,
         MIN(c.area) AS first_customer_area, MIN(c.city) AS first_customer_city,
         SUM((SELECT COALESCE(SUM(quantity * pieces_per_unit), 0) FROM order_items WHERE order_items.order_id = o.id)) AS garment_count
         FROM challans ch
         JOIN challan_orders co ON co.challan_id = ch.id
         JOIN orders o ON o.id = co.order_id
         JOIN customers c ON c.id = o.customer_id
         LEFT JOIN users u ON u.id = ch.created_by
         WHERE ch.id IN (${challanIds.map(() => '?').join(',')})
         GROUP BY ch.id ORDER BY ch.id DESC`, challanIds);
    }
    const totalPages = Math.ceil(total / perPage);
    const savedNumbers = savedNumbersOf(await ctx.setting('challan_whatsapp_numbers', '[]'));
    const u = (p: string) => ctx.baseUrl(p);
    const csrf = ctx.csrfToken();
    const pagination = totalPages > 1 ? html`
    <nav class="mt-3"><ul class="pagination pagination-sm">
      ${Array.from({ length: totalPages }, (_, k) => k + 1).map((i) => html`
        <li class="page-item ${i === page ? 'active' : ''}"><a class="page-link" href="?q=${urlencode(search)}&page=${i}">${i}</a></li>`)}
    </ul></nav>` : '';
    return layout(ctx, { title: 'Challans' }, html`
<div class="container-fluid py-3">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h4 class="fw-bold mb-0"><i class="fa-solid fa-file-lines me-2"></i>Challans</h4>
    <div>
      <a href="${u('modules/orders/challan_reports.php')}" class="btn btn-outline-secondary btn-sm"><i class="fa-solid fa-chart-column me-1"></i>Reports</a>
      <a href="${u('modules/orders/challan_whatsapp_settings.php')}" class="btn btn-outline-secondary btn-sm" title="Saved WhatsApp numbers"><i class="fa-brands fa-whatsapp me-1"></i>Numbers</a>
      <a href="${u('modules/orders/challan_combine.php')}" class="btn btn-outline-primary btn-sm"><i class="fa-solid fa-layer-group me-1"></i>Combine Orders</a>
      <a href="${u('modules/orders/challan_combine.php')}" class="btn btn-primary btn-sm"><i class="fa-solid fa-plus me-1"></i>New Challan</a>
    </div>
  </div>

  <form method="GET" class="mb-3">
    <div class="input-group" style="max-width:500px;">
      <input type="text" name="q" class="form-control" placeholder="Challan #, order # or customer" value="${search}">
      <button class="btn btn-outline-secondary" type="submit"><i class="fa-solid fa-magnifying-glass"></i></button>
    </div>
  </form>

  ${rows.length === 0 ? html`
    <div class="card"><div class="card-body text-center text-muted py-5"><i class="fa-solid fa-inbox fa-2x mb-2"></i><p class="mb-0">No challans generated yet.</p></div></div>` : html`
    <div class="card">
      <div class="table-responsive">
        <table class="table table-sm align-middle mb-0">
          <thead><tr><th>Challan #</th><th>Order(s)</th><th>Customer</th><th>Address</th><th class="text-end">Garments</th><th>Type</th><th>Generated</th><th>By</th><th style="width:220px;"></th></tr></thead>
          <tbody>
          ${rows.map((r) => {
            const isCombined = int(r.order_count) > 1;
            const isDelivery = (r.combine_format ?? '') === 'delivery';
            const addr = [r.first_customer_address, r.first_customer_area, r.first_customer_city].filter((x) => !phpEmpty(x)).join(', ').trim();
            return html`
            <tr>
              <td>${r.challan_number}</td>
              <td>
                ${isDelivery ? html`<span class="badge bg-success me-1">Delivery</span>` : ''}
                ${isCombined ? html`
                  <span class="badge bg-info text-dark me-1">${int(r.order_count)} orders</span>
                  ${(r.combine_format ?? 'aggregated') === 'order_wise' ? html`
                    <span class="badge bg-warning text-dark me-1" title="Each order's garments shown separately">Order-wise</span>` : ''}
                  <span class="small">${r.order_numbers}</span>` : html`
                  <a href="${u('modules/orders/view.php?id=' + r.first_order_id)}">${r.order_numbers}</a>`}
              </td>
              <td>
                ${isCombined ? html`
                  <span class="text-muted">—</span>` : html`
                  ${r.first_customer_name}<div class="text-muted small">${r.first_customer_mobile}</div>`}
              </td>
              <td class="small text-muted">
                ${isCombined ? raw('—') : (addr !== '' ? addr : '—')}
              </td>
              <td class="text-end">${int(r.garment_count)}</td>
              <td><span class="badge ${Number(r.with_amount) ? 'bg-primary' : 'bg-secondary'}">${Number(r.with_amount) ? 'With Amount' : 'Without Amount'}</span></td>
              <td>${wallDate('d M Y, h:i A', r.created_at)}</td>
              <td>${r.created_by_name ?? '—'}</td>
              <td>
                <a class="btn btn-sm btn-outline-primary" target="_blank" href="${u('modules/orders/challan_pdf.php?challan_id=' + r.id)}">View</a>
                <button type="button" class="btn btn-sm btn-outline-success btn-send-wa" data-challan-id="${r.id}" title="Send on WhatsApp"><i class="fa-brands fa-whatsapp"></i></button>
                <a class="btn btn-sm btn-outline-secondary" href="${u('modules/orders/challan_combine.php?challan_id=' + r.id)}" title="Edit"><i class="fa-solid fa-pen"></i></a>
                <button type="button" class="btn btn-sm btn-outline-danger btn-delete-challan" data-challan-id="${r.id}" data-challan-number="${r.challan_number}" title="Delete"><i class="fa-solid fa-trash"></i></button>
              </td>
            </tr>`; })}
          </tbody>
        </table>
      </div>
    </div>
    ${pagination}`}
</div>

<!-- Rahul: "koi bhi number dale uspe" -- custom number field, plus one-click quick-pick buttons
     for the up to 5 saved numbers from challan_whatsapp_settings.php. -->
<div class="modal fade" id="sendWaModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">Send Challan on WhatsApp</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body">
        ${savedNumbers.length ? html`
        <label class="form-label small">Saved numbers</label>
        <div class="d-flex flex-wrap gap-2 mb-3">
          ${savedNumbers.map((n) => html`
          <button type="button" class="btn btn-sm btn-outline-secondary wa-saved-number" data-number="${n}">${n}</button>`)}
        </div>` : ''}
        <label class="form-label">Mobile Number</label>
        <input type="text" class="form-control" id="waNumberInput" placeholder="e.g. 9876543210">
        <div class="alert alert-danger d-none mt-2" id="waSendError"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
        <button type="button" class="btn btn-success" id="waSendConfirmBtn">Send</button>
      </div>
    </div>
  </div>
</div>

<script>
let waModalInstance = null;
function getWaModal() { if (!waModalInstance) waModalInstance = new bootstrap.Modal(document.getElementById('sendWaModal')); return waModalInstance; }
let waTargetChallanId = null;

document.querySelectorAll('.btn-send-wa').forEach(function (btn) {
  btn.addEventListener('click', function () {
    waTargetChallanId = this.dataset.challanId;
    document.getElementById('waNumberInput').value = '';
    document.getElementById('waSendError').classList.add('d-none');
    getWaModal().show();
  });
});
document.querySelectorAll('.wa-saved-number').forEach(function (btn) {
  btn.addEventListener('click', function () { document.getElementById('waNumberInput').value = this.dataset.number; });
});
document.getElementById('waSendConfirmBtn').addEventListener('click', function () {
  const btn = this;
  const number = document.getElementById('waNumberInput').value.trim();
  const errBox = document.getElementById('waSendError');
  errBox.classList.add('d-none');
  if (!number) { errBox.textContent = 'Enter a mobile number.'; errBox.classList.remove('d-none'); return; }
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sending...';
  const formData = new FormData();
  formData.append('challan_id', waTargetChallanId);
  formData.append('number', number);
  formData.append('csrf_token', ${raw(jsonEncode(csrf))});
  fetch(${raw(jsonEncode(u('api/challan_send_whatsapp.php')))}, { method: 'POST', body: formData })
    .then(r => r.json())
    .then(function (result) {
      btn.disabled = false; btn.textContent = original;
      if (result.success) {
        getWaModal().hide();
        alert('Challan sent on WhatsApp.');
      } else {
        errBox.textContent = result.error || 'Something went wrong.';
        errBox.classList.remove('d-none');
      }
    })
    .catch(function () {
      btn.disabled = false; btn.textContent = original;
      errBox.textContent = 'Could not reach the server. Please try again.';
      errBox.classList.remove('d-none');
    });
});

// Rahul: "delete ka bhi agar galat ban gaya hai to" -- confirm, then remove the challan + its
// order links entirely; the row itself disappears on success rather than a full page reload.
document.querySelectorAll('.btn-delete-challan').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const challanId = this.dataset.challanId;
    const challanNumber = this.dataset.challanNumber;
    if (!confirm('Delete challan ' + challanNumber + '? This cannot be undone.')) return;
    const row = this.closest('tr');
    const original = this.innerHTML;
    this.disabled = true;
    const formData = new FormData();
    formData.append('challan_id', challanId);
    formData.append('csrf_token', ${raw(jsonEncode(csrf))});
    fetch(${raw(jsonEncode(u('api/challan_delete.php')))}, { method: 'POST', body: formData })
      .then(r => r.json())
      .then(function (result) {
        if (result.success) {
          row.remove();
        } else {
          alert(result.error || 'Could not delete the challan.');
          btn.disabled = false; btn.innerHTML = original;
        }
      })
      .catch(function () {
        alert('Could not reach the server. Please try again.');
        btn.disabled = false; btn.innerHTML = original;
      });
  });
});
</script>
`);
  });

  // ---- challan_pdf.php: the unified way to VIEW a generated challan ----------------------------------------
  webPage(app, '/modules/orders/challan_pdf', { auth: 'billing.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const challanId = int(q.challan_id);
    if (!challanId) { ctx.flashSet('danger', 'No challan specified.'); return new WebRedirect('modules/orders/challan_list.php'); }
    const challan = (await db.query<Row>('SELECT with_amount, combine_format, challan_number FROM challans WHERE id = ?', [challanId]))[0];
    if (!challan) { ctx.flashSet('danger', 'Challan not found.'); return new WebRedirect('modules/orders/challan_list.php'); }
    const orderIds = (await db.query<Row>('SELECT order_id FROM challan_orders WHERE challan_id = ? ORDER BY order_id', [challanId])).map((r) => Number(r.order_id));
    if (!orderIds.length) { ctx.flashSet('danger', 'This challan has no orders linked to it.'); return new WebRedirect('modules/orders/challan_list.php'); }
    const result = await challanPdf.generate(orderIds, !!Number(challan.with_amount), String(challan.challan_number), challan.combine_format ?? 'aggregated');
    if (!result.success || !result.file_path) { ctx.flashSet('danger', result.error ?? 'Could not generate the PDF.'); return new WebRedirect('modules/orders/challan_list.php'); }
    const { readFile, unlink } = await import('node:fs/promises');
    const bytes = await readFile(result.file_path);
    await unlink(result.file_path).catch(() => {});
    const filename = 'Challan-' + String(challan.challan_number).replace(/[^A-Za-z0-9_-]+/g, '-') + '.pdf';
    if (!phpEmpty(q.raw)) return sendPdf(bytes, filename, !phpEmpty(q.download));
    const u = (p: string) => ctx.baseUrl(p);
    const rawUrl = u('modules/orders/challan_pdf.php?challan_id=' + challanId + '&raw=1');
    return new WebText(html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Challan ${challan.challan_number}</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; background:#eef1f6; margin:0; padding:0; height:100vh; display:flex; flex-direction:column; }
  .toolbar { background:#0b3d91; padding:10px 16px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .toolbar .title { color:#fff; font-weight:600; margin-right:auto; }
  .toolbar button, .toolbar a { border:0; background:#fff; color:#0b3d91; padding:8px 16px; border-radius:6px; font-size:13px; font-weight:600; text-decoration:none; cursor:pointer; }
  .toolbar a.secondary, .toolbar button.secondary { background:rgba(255,255,255,.15); color:#fff; }
  .frame-wrap { flex:1; }
  #pdfFrame { width:100%; height:100%; border:0; }
  @media (max-width:480px) { .toolbar .title { display:none; } }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="title">Challan ${challan.challan_number}</span>
    <button type="button" onclick="printChallan()">🖨️ Print</button>
    <a href="${u('modules/orders/challan_pdf.php?challan_id=' + challanId + '&raw=1&download=1')}">⬇️ Download</a>
    <a class="secondary" href="${u('modules/orders/challan_list.php')}">Back to Challans</a>
  </div>
  <div class="frame-wrap">
    <iframe id="pdfFrame" src="${rawUrl}"></iframe>
  </div>
<script>
function printChallan() {
  try {
    document.getElementById('pdfFrame').contentWindow.focus();
    document.getElementById('pdfFrame').contentWindow.print();
  } catch (e) {
    // Rahul: some browsers block same-origin PDF iframe printing silently -- open the raw
    // PDF in its own tab as a fallback, where the browser's native PDF viewer prints reliably.
    window.open('${rawUrl}', '_blank');
  }
}
</script>
</body>
</html>
`.toString(), 200);
  });

  // ---- challan_reports.php -----------------------------------------------------------------------------
  webPage(app, '/modules/orders/challan_reports', { auth: 'reports.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const today = ctx.today;
    const monthStart = today.slice(0, 8) + '01';
    let dateFrom = 'date_from' in q ? clean(q.date_from) : monthStart;
    let dateTo = 'date_to' in q ? clean(q.date_to) : today;
    if (!DATE_RE.test(dateFrom)) dateFrom = monthStart;
    if (!DATE_RE.test(dateTo)) dateTo = today;
    const dateWise = await db.query<Row>(
      `SELECT DATE(ch.created_at) AS d, SUM(ch.with_amount = 1) AS with_amount_count, SUM(ch.with_amount = 0) AS without_amount_count, COUNT(*) AS total_count
       FROM challans ch WHERE DATE(ch.created_at) BETWEEN ? AND ? GROUP BY DATE(ch.created_at) ORDER BY d DESC`, [dateFrom, dateTo]);
    const tot = { w: 0, wo: 0, t: 0 };
    for (const r of dateWise) { tot.w += int(r.with_amount_count); tot.wo += int(r.without_amount_count); tot.t += int(r.total_count); }
    const garmentWise = await db.query<Row>(
      `SELECT COALESCE(g.garment_name, CONCAT('Laundry: ', s.service_name)) AS garment_name, COUNT(DISTINCT ch.id) AS challan_count, SUM(oi.quantity) AS total_quantity
       FROM challans ch JOIN order_items oi ON oi.order_id = ch.order_id LEFT JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
       WHERE DATE(ch.created_at) BETWEEN ? AND ? GROUP BY garment_name ORDER BY total_quantity DESC`, [dateFrom, dateTo]);
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Challan Reports' }, html`
<div class="container-fluid py-3">
  <h4 class="fw-bold mb-3"><i class="fa-solid fa-chart-column me-2"></i>Challan Reports</h4>

  <form method="GET" class="d-flex flex-wrap gap-2 align-items-end mb-4">
    <div>
      <label class="form-label small mb-1">From</label>
      <input type="date" name="date_from" class="form-control form-control-sm" value="${dateFrom}">
    </div>
    <div>
      <label class="form-label small mb-1">To</label>
      <input type="date" name="date_to" class="form-control form-control-sm" value="${dateTo}">
    </div>
    <button class="btn btn-primary btn-sm" type="submit">Apply</button>
    <a class="btn btn-outline-secondary btn-sm" href="${u('modules/orders/challan_list.php')}">Back to Challans</a>
  </form>

  <div class="row g-4">
    <div class="col-lg-6">
      <h6 class="fw-bold mb-2">Date-wise</h6>
      <div class="card">
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead><tr><th>Date</th><th class="text-end">With Amount</th><th class="text-end">Without Amount</th><th class="text-end">Total</th></tr></thead>
            <tbody>
            ${dateWise.length === 0 ? html`
              <tr><td colspan="4" class="text-center text-muted py-4">No challans in this range.</td></tr>` : ''}
            ${dateWise.map((r) => html`
              <tr>
                <td>${dMY(r.d)}</td>
                <td class="text-end">${int(r.with_amount_count)}</td>
                <td class="text-end">${int(r.without_amount_count)}</td>
                <td class="text-end fw-bold">${int(r.total_count)}</td>
              </tr>`)}
            </tbody>
            ${dateWise.length ? html`
            <tfoot>
              <tr class="fw-bold" style="background:#f8fafc;">
                <td>Total</td>
                <td class="text-end">${tot.w}</td>
                <td class="text-end">${tot.wo}</td>
                <td class="text-end">${tot.t}</td>
              </tr>
            </tfoot>` : ''}
          </table>
        </div>
      </div>
    </div>

    <div class="col-lg-6">
      <h6 class="fw-bold mb-2">Garments-wise</h6>
      <div class="card">
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead><tr><th>Garment</th><th class="text-end">Challans</th><th class="text-end">Total Qty</th></tr></thead>
            <tbody>
            ${garmentWise.length === 0 ? html`
              <tr><td colspan="3" class="text-center text-muted py-4">No garments on any challan in this range.</td></tr>` : ''}
            ${garmentWise.map((r) => html`
              <tr>
                <td>${r.garment_name}</td>
                <td class="text-end">${int(r.challan_count)}</td>
                <td class="text-end">${numTrim(phpRound(parseFloat(str(r.total_quantity)) || 0, 2).toFixed(2))}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>
`);
  });

  // ---- challan_whatsapp_settings.php: up to 5 saved numbers ---------------------------------------------------
  webPage(app, '/modules/orders/challan_whatsapp_settings', { auth: 'admin.settings', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const errors: string[] = [];
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const b = body(ctx);
      const numbers: string[] = [];
      for (let i = 0; i < 5; i++) {
        const rawNum = clean(b['number_' + i]);
        if (rawNum === '') continue;
        const digits = rawNum.replace(/\D+/g, '');
        if (digits.length < 10) { errors.push(`Number ${i + 1} ("${rawNum}") doesn't look like a valid mobile number.`); continue; }
        numbers.push(digits);
      }
      if (numbers.length > 5) errors.push('Maximum 5 numbers allowed.');
      if (!errors.length) {
        const enc = JSON.stringify(numbers);
        await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('challan_whatsapp_numbers', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [enc, enc]);
        ctx.flashSet('success', 'Saved numbers updated.');
        return new WebRedirect('modules/orders/challan_whatsapp_settings.php');
      }
    }
    const saved = savedNumbersOf(await ctx.setting('challan_whatsapp_numbers', '[]'));
    return layout(ctx, { title: 'Challan WhatsApp Numbers' }, html`
<div class="container-fluid py-3">
  <h4 class="fw-bold mb-3"><i class="fa-brands fa-whatsapp me-2"></i>Challan WhatsApp Numbers</h4>
  <p class="text-muted small">Up to 5 saved numbers that show as quick-pick options when sending a challan on WhatsApp — e.g. an accountant, a branch, or a regular driver, so the number doesn't need retyping each time.</p>

  ${errors.length ? html`
  <div class="alert alert-danger"><ul class="mb-0">${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}

  <form method="POST" class="card" style="max-width:480px;">
    <div class="card-body">
      ${ctx.csrfField()}
      ${[0, 1, 2, 3, 4].map((i) => html`
      <div class="mb-3">
        <label class="form-label small">Number ${i + 1}</label>
        <input type="text" name="number_${i}" class="form-control" placeholder="e.g. 9876543210" value="${saved[i] ?? ''}">
      </div>`)}
      <button class="btn btn-primary" type="submit">Save</button>
    </div>
  </form>
</div>
`);
  });

  // ---- api/challan_delete.php + api/challan_send_whatsapp.php -------------------------------------------------
  webPage(app, '/api/challan_delete', { auth: 'billing.view', methods: ['GET', 'POST'] }, async (ctx, req) => {
    if (req.method !== 'POST') return json({ success: false, error: 'Invalid request method.' }, 405);
    if (!ctx.csrfValid()) return csrfFail();
    const challanId = int(body(ctx).challan_id);
    if (!challanId) return json({ success: false, error: 'Missing challan id.' }, 422);
    if (!(await db.query('SELECT id FROM challans WHERE id = ?', [challanId])).length) return json({ success: false, error: 'Challan not found.' }, 404);
    try {
      await db.tx(async (t) => { await t.execute('DELETE FROM challan_orders WHERE challan_id = ?', [challanId]); await t.execute('DELETE FROM challans WHERE id = ?', [challanId]); });
    } catch { return json({ success: false, error: 'Could not delete the challan.' }, 500); }
    return json({ success: true });
  });

  webPage(app, '/api/challan_send_whatsapp', { auth: 'billing.view', methods: ['GET', 'POST'] }, async (ctx, req) => {
    if (req.method !== 'POST') return json({ success: false, error: 'Invalid request method.' }, 405);
    if (!ctx.csrfValid()) return csrfFail();
    const b = body(ctx);
    const challanId = int(b.challan_id);
    const toNumber = str(b.number).trim();
    if (!challanId || toNumber === '') return json({ success: false, error: 'Missing challan or number.' }, 422);
    const challan = (await db.query<Row>('SELECT with_amount, combine_format, challan_number FROM challans WHERE id = ?', [challanId]))[0];
    if (!challan) return json({ success: false, error: 'Challan not found.' }, 404);
    const orderIds = (await db.query<Row>('SELECT order_id FROM challan_orders WHERE challan_id = ? ORDER BY order_id', [challanId])).map((r) => Number(r.order_id));
    if (!orderIds.length) return json({ success: false, error: 'This challan has no orders linked to it.' }, 404);
    const result = await whatsapp.sendChallan(orderIds, toNumber, !!Number(challan.with_amount), String(challan.challan_number), ctx.data.user_id ?? null, challan.combine_format ?? 'aggregated');
    return json({ success: result.success, error: result.error ?? null, mode: result.mode ?? null });
  });
  void httpBuildQuery;
}
