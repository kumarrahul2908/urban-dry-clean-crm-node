import type { FastifyInstance } from 'fastify';
import { isNumeric, phpRound } from '../../lib/php.js';
import { PACKAGING_STYLES } from '../../services/orderService.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { flt, int } from '../format.js';
import { e, html, jsonEncode } from '../html.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
/** number_format($v, 2, '.', '') */
const fixed2 = (n: number) => phpRound(n, 2).toFixed(2);
const json = (d: unknown, status = 200) => new WebText(jsonEncode(d), status, 'application/json');

/**
 * Edit one garment line of an order that is still editable (status "Order Created"): the garment itself, service, quantity, rate,
 * packaging (Fold / Hanger / ...), defects and remarks, through the same OrderService.updateItem() the Android app uses, so pricing
 * rules, totals and tags are handled in exactly one place. When the change affects the tags, the order page shows a notice to print
 * them again.
 */
export function registerOrderEditItemPage(app: FastifyInstance) {
  const { db, orders, pricing } = app.services;

  webPage(app, '/modules/orders/edit_item', { auth: 'orders.edit', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const orderId = int(q.order_id), itemId = int(q.item_id);
    const u = (p: string) => ctx.baseUrl(p);
    const order = (await db.query<Row>('SELECT * FROM orders WHERE id = ?', [orderId]))[0];

    // Small JSON helper for this page's own script: the price-list rate for a garment + service on THIS order's price list.
    if ('rate_for' in q) {
      if (!order) return json({ success: false }, 404);
      const rate = await pricing.getRate(Number(order.price_list_id), int(q.garment_id), int(q.service_id));
      return json({ success: true, configured: rate !== null, piece_rate: rate !== null ? flt(rate.piece_rate) : null });
    }

    if (!order) { ctx.flashSet('danger', 'Order not found.'); return new WebRedirect('modules/orders/list.php'); }
    const backToOrder = 'modules/orders/view.php?id=' + orderId;
    if (!(await orders.isEditable(order as { status_id: number }))) {
      ctx.flashSet('danger', 'This order can no longer be edited — processing has begun.');
      return new WebRedirect(backToOrder);
    }
    const item = (await db.query<Row>(
      `SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name
       FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id
       WHERE oi.id = ? AND oi.order_id = ?`, [itemId, orderId]))[0];
    if (!item) { ctx.flashSet('danger', 'That garment is not on this order.'); return new WebRedirect(backToOrder); }
    if (item.weight !== null) {
      ctx.flashSet('danger', 'This is a Per-Weight (Laundry) line and cannot be edited on this screen.');
      return new WebRedirect(backToOrder);
    }

    const canManualOverrideRate = ctx.can('pos.manual_rate_override');
    // Once a piece has left "Pending" (sent to the workshop, packed, ...) its physical tag is in use, so the garment / service /
    // quantity are locked -- OrderService.updateItem() enforces the same.
    const identityLocked = String(item.item_status) !== 'Pending';
    const currentDefectIds = (await db.query<Row>('SELECT defect_id FROM order_item_defects WHERE order_item_id = ?', [itemId])).map((r) => int(r.defect_id));

    const form = {
      garment_id: int(item.garment_id),
      service_id: int(item.service_id),
      quantity: fixed2(flt(item.quantity)).replace(/0+$/, '').replace(/\.$/, ''),
      rate: fixed2(flt(item.unit_price)),
      packaging_style: String(item.packaging_style ?? ''),
      defect_ids: currentDefectIds,
      remarks: String(item.remarks ?? ''),
    };
    let errors: string[] = [];

    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      form.packaging_style = String(p.packaging_style ?? '');
      const rawDefects = p['defect_ids[]'] ?? p.defect_ids ?? [];
      form.defect_ids = (Array.isArray(rawDefects) ? rawDefects : [rawDefects]).map((x) => int(x)).filter((n) => n !== 0);
      form.remarks = String(p.remarks ?? '');
      form.rate = String(p.rate ?? '').trim();
      if (!identityLocked) {
        form.garment_id = int(p.garment_id);
        form.service_id = int(p.service_id);
        form.quantity = String(p.quantity ?? '').trim();
      }

      if (!identityLocked && (!isNumeric(form.quantity) || flt(form.quantity) <= 0 || Math.floor(flt(form.quantity)) !== flt(form.quantity))) {
        errors.push('Quantity must be a whole number greater than zero.');
      }
      if (form.rate === '' || !isNumeric(form.rate) || flt(form.rate) < 0) errors.push('Rate must be a number, zero or more.');

      if (errors.length === 0) {
        const lineUnchanged = form.garment_id === int(item.garment_id) && form.service_id === int(item.service_id);
        const rateUnchanged = Math.abs(flt(form.rate) - flt(item.unit_price)) < 0.005;
        const configured = await pricing.getRate(Number(order.price_list_id), form.garment_id, form.service_id);
        // Manual Rate Override is only claimed when it is really needed: there is no price-list rate for this garment + service, or the
        // line already was an authorised override and neither the line nor its rate is being changed. OrderService re-checks the permission.
        const manualOverride = configured === null || (lineUnchanged && rateUnchanged && Number(item.is_manual_override) === 1);

        // Brand and colour are not on this form (hidden on the New Order and Add Item forms too), so updateItem() leaves whatever the line has.
        const raw: Row = { rate_override: form.rate, manual_override: manualOverride, packaging_style: form.packaging_style, defect_ids: form.defect_ids, remarks: form.remarks };
        if (!identityLocked) {
          raw.garment_id = form.garment_id;
          raw.service_id = form.service_id;
          raw.quantity = flt(form.quantity);
        }
        const result = await orders.updateItem(orderId, itemId, raw, { userId: ctx.data.user_id!, ip: req.ip }, canManualOverrideRate);
        if (result.success) {
          ctx.flashSet('success', 'Garment updated.');
          if (result.tags_notice) ctx.flashSet('warning', String(result.tags_notice));
          return new WebRedirect(backToOrder);
        }
        errors = result.errors ?? [];
      }
    }

    // The line's own garment/service stay selectable even if they were deactivated since.
    const garments = await db.query<Row>('SELECT id, garment_name, sku, pieces_per_unit FROM garments WHERE is_active = 1 OR id = ? ORDER BY garment_name', [int(item.garment_id)]);
    const services = await db.query<Row>("SELECT id, service_name FROM services WHERE (is_active = 1 AND billing_unit <> 'weight') OR id = ? ORDER BY sort_order", [int(item.service_id)]);
    const defects = await db.query<Row>('SELECT id, defect_name FROM defects WHERE is_active=1 ORDER BY defect_name');
    const currency = String((await ctx.setting('currency_symbol', 'Rs.')) ?? '');

    const orderCode = order.short_order_code ?? order.order_number;
    return layout(ctx, { title: 'Edit Garment — Order ' + orderCode }, html`
<div class="col-md-8">
  <div class="card">
    <div class="card-body">
      <h6 class="mb-3">Order ${orderCode} — ${item.garment_name}</h6>
      ${errors.length ? html`
        <div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html`<li>${er}</li>`)}</ul></div>` : ''}
      ${identityLocked ? html`
        <div class="alert alert-warning">This garment has already moved on (status: ${String(item.item_status)}), so its garment, service and quantity can no longer be changed. Rate, packaging and the details below can still be edited.</div>` : html`
        <div class="alert alert-info py-2">If you change the garment or the quantity, this order's tags change too — you will be asked to print the tags again.</div>`}
      <form method="POST" id="editItemForm">
        ${ctx.csrfField()}
        <div class="row g-3">
          <div class="col-md-6">
            <label class="form-label">Garment</label>
            <select name="garment_id" id="eiGarment" class="form-select" ${identityLocked ? 'disabled' : 'required'}>
              ${garments.map((g) => html`
                <option value="${int(g.id)}" ${int(g.id) === form.garment_id ? 'selected' : ''}>${g.garment_name}${int(g.pieces_per_unit) > 1 ? ' (' + int(g.pieces_per_unit) + ' pieces)' : ''}${g.sku ? ' — ' + g.sku : ''}</option>`)}
            </select>
          </div>
          <div class="col-md-6">
            <label class="form-label">Service</label>
            <select name="service_id" id="eiService" class="form-select" ${identityLocked ? 'disabled' : 'required'}>
              ${services.map((s) => html`
                <option value="${int(s.id)}" ${int(s.id) === form.service_id ? 'selected' : ''}>${s.service_name}</option>`)}
            </select>
          </div>
          <div class="col-md-4">
            <label class="form-label">Quantity</label>
            <input type="number" name="quantity" id="eiQuantity" class="form-control" min="1" step="1" value="${form.quantity}" ${identityLocked ? 'disabled' : 'required'}>
          </div>
          <div class="col-md-4">
            <label class="form-label">Rate (per unit)</label>
            <input type="number" name="rate" id="eiRate" class="form-control" min="0" step="0.01" value="${form.rate}" required>
            <div class="form-text" id="eiRateHint"></div>
          </div>
          <div class="col-md-4">
            <label class="form-label">Line Total</label>
            <input type="text" id="eiLineTotal" class="form-control fw-bold" readonly>
          </div>
          <div class="col-md-4">
            <label class="form-label">Packaging</label>
            <select name="packaging_style" class="form-select">
              <option value="">None</option>
              ${Object.entries(PACKAGING_STYLES).map(([value, label]) => html`
                <option value="${value}" ${form.packaging_style === value ? 'selected' : ''}>${label}</option>`)}
            </select>
          </div>
          <div class="col-12">
            <label class="form-label">Defects</label>
            <div class="d-flex flex-wrap gap-3">
              ${defects.map((d) => html`
                <div class="form-check">
                  <input class="form-check-input" type="checkbox" name="defect_ids[]" value="${int(d.id)}" id="eiDefect${int(d.id)}" ${form.defect_ids.includes(int(d.id)) ? 'checked' : ''}>
                  <label class="form-check-label" for="eiDefect${int(d.id)}">${d.defect_name}</label>
                </div>`)}
            </div>
          </div>
          <div class="col-12">
            <label class="form-label">Remarks</label>
            <input type="text" name="remarks" class="form-control" value="${form.remarks}">
          </div>
        </div>
        <div class="mt-3">
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-check me-1"></i>Save Garment</button>
          <a href="${u(backToOrder)}" class="btn btn-outline-secondary">Cancel</a>
        </div>
      </form>
    </div>
  </div>
</div>

<script>
(function () {
  var garment = document.getElementById('eiGarment'), service = document.getElementById('eiService');
  var qty = document.getElementById('eiQuantity'), rate = document.getElementById('eiRate');
  var hint = document.getElementById('eiRateHint'), total = document.getElementById('eiLineTotal');
  var RATE_URL = ${jsonEncode(u('modules/orders/edit_item.php?order_id=' + orderId + '&item_id=' + itemId + '&rate_for=1'))};
  var CAN_MANUAL = ${canManualOverrideRate ? 'true' : 'false'};
  var CURRENCY = ${jsonEncode(currency)};

  function showTotal() {
    var q = parseFloat(qty.value), r = parseFloat(rate.value);
    total.value = (isFinite(q) && isFinite(r)) ? CURRENCY + ' ' + (q * r).toFixed(2) : '';
  }
  // setRate=true when the garment or service was just changed: the new line's price-list rate
  // replaces whatever was typed (it can then be edited again). On first load only the hint shows,
  // so a rate that was deliberately changed on this line is left as it is.
  function loadRate(setRate) {
    fetch(RATE_URL + '&garment_id=' + encodeURIComponent(garment.value) + '&service_id=' + encodeURIComponent(service.value), { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.configured) {
          hint.className = 'form-text';
          hint.textContent = 'Price list rate: ' + CURRENCY + ' ' + Number(data.piece_rate).toFixed(2);
          if (setRate) rate.value = Number(data.piece_rate).toFixed(2);
        } else {
          hint.className = 'form-text text-danger';
          hint.textContent = CAN_MANUAL
            ? 'No price is set for this garment and service. The rate you enter will be saved as a Manual Rate Override.'
            : 'No price is set for this garment and service, and you are not authorized to use Manual Rate Override.';
          if (setRate) rate.value = '';
        }
        showTotal();
      })
      .catch(function () { hint.className = 'form-text'; hint.textContent = ''; });
  }
  garment.addEventListener('change', function () { loadRate(true); });
  service.addEventListener('change', function () { loadRate(true); });
  qty.addEventListener('input', showTotal);
  rate.addEventListener('input', showTotal);
  loadRate(false);
  showTotal();
})();
</script>
`);
  });
}
