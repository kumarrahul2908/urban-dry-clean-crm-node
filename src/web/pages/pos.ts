import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { webPage } from '../context.js';
import { flt, int } from '../format.js';
import { html, jsonEncode, raw } from '../html.js';
import { layout } from '../layout.js';
import { laundryPickerScript, laundryScript, laundryStyle, posScript, posStyle } from './pos.static.js';

type Row = Record<string, any>;
const h = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

export function registerPosPages(app: FastifyInstance) {
  const { db, pricing } = app.services;

  // ---- New Order (Dry Cleaning, per piece) ------------------------------------------------------
  webPage(app, '/modules/pos/index', { auth: 'pos.create' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const services = await db.query<Row>("SELECT id, service_name FROM services WHERE is_active=1 AND billing_unit='piece' ORDER BY sort_order");
    const categories = await db.query<Row>('SELECT id, category_name FROM categories WHERE is_active=1 ORDER BY sort_order');
    const urgentLevels = await db.query<Row>('SELECT id, level_name, surcharge_percent, day_offset FROM urgent_levels WHERE is_active=1 ORDER BY sort_order');
    const paymentTypes = await db.query<Row>('SELECT id, type_name FROM payment_types WHERE is_active=1 ORDER BY sort_order');
    const brands = await db.query<Row>('SELECT id, brand_name FROM brands WHERE is_active=1 ORDER BY sort_order');
    const colors = await db.query<Row>('SELECT id, color_name FROM colors WHERE is_active=1 ORDER BY sort_order');
    const defects = await db.query<Row>('SELECT id, defect_name FROM defects WHERE is_active=1 ORDER BY sort_order');
    const canOverrideDiscount = ctx.can('pos.override_discount');
    const canManual = ctx.can('pos.manual_rate_override');
    const maxDiscount = flt(await ctx.setting('max_counter_discount_percent', '0'));
    const defaultDeliveryCharge = flt(await ctx.setting('delivery_charge_default', '0'));
    const defaultDueDays = int(await ctx.setting('default_due_days', '2'));
    let defaultPriceListId: number | null = null;
    try { defaultPriceListId = await pricing.resolvePriceListId(null); } catch { defaultPriceListId = null; }
    const orderToken = randomBytes(16).toString('hex');
    ctx.data.pos_order_token = orderToken;
    const preselect = int(q.customer_id);
    const u = (p: string) => ctx.baseUrl(p);
    const x = [canOverrideDiscount ? 'true' : 'false', canManual ? 'true' : 'false', jsonEncode(maxDiscount), jsonEncode(defaultPriceListId), jsonEncode(preselect || null), jsonEncode(paymentTypes),
      services.length ? String(int(services[0]!.id)) : 'null', jsonEncode(orderToken), categories.length ? String(int(categories[0]!.id)) : 'null'];
    return layout(ctx, { title: 'New Order (Dry Cleaning)' }, html`
${raw(posStyle(u, jsonEncode, h))}

<div class="col-12 pos-grid">
  <div>
    <!-- CUSTOMER SECTION -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="row g-2 align-items-end">
          <div class="col-md-6 position-relative">
            <label class="form-label small">Search Customer (name / address / mobile / code / barcode)</label>
            <input type="text" id="customerSearch" class="form-control" placeholder="Type to search...">
            <div id="customerResults" class="d-none"></div>
          </div>
          <div class="col-md-3">
            <a href="${u('modules/customers/add.php')}" target="_blank" class="btn btn-outline-secondary w-100"><i class="fa-solid fa-user-plus me-1"></i>Add New Customer</a>
          </div>
          <div class="col-md-3">
            <button type="button" class="btn btn-outline-secondary w-100" id="clearCustomerBtn"><i class="fa-solid fa-xmark me-1"></i>Clear</button>
          </div>
        </div>
        <div id="customerDetails" class="mt-3 d-none">
          <div class="row g-3">
            <div class="col-md-3"><div class="text-muted small">Customer</div><div class="fw-bold" id="cdName"></div><div class="small" id="cdMobile"></div></div>
            <div class="col-md-3"><div class="text-muted small">Address</div><div id="cdAddress">—</div></div>
            <div class="col-md-2"><div class="text-muted small">Price List</div><div id="cdPriceList">—</div></div>
            <div class="col-md-2"><div class="text-muted small">Outstanding</div><div class="text-danger fw-bold" id="cdOutstanding">—</div></div>
            <div class="col-md-2"><div class="text-muted small">Advance / Wallet</div><div class="text-success fw-bold" id="cdWallet">—</div></div>
          </div>
        </div>
      </div>
    </div>

    <!-- SERVICE + CATEGORY TABS -->
    <div class="card mb-3">
      <div class="card-body">
        <div class="svc-tabs mb-2">
          ${services.map((s) => html`
            <button type="button" class="btn btn-sm btn-outline-primary svc-tab" data-id="${s.id}">${s.service_name}</button>`)}
        </div>
        <div class="cat-tabs mb-2">
          ${categories.map((c) => html`
            <button type="button" class="btn btn-sm btn-outline-secondary cat-tab" data-id="${c.id}">${c.category_name}</button>`)}
        </div>
        <input type="text" id="garmentSearch" class="form-control mb-3" placeholder="Search garment by name or SKU">
        <div id="garmentGrid"><p class="text-muted">Select a service and category to view garments.</p></div>
      </div>
    </div>
  </div>

  <!-- CART / SUMMARY PANEL -->
  <div class="cart-panel">
    <div class="card mb-3">
      <div class="card-body">
        <h6 class="fw-bold mb-2">Order Items</h6>
        <div class="table-responsive" style="max-height:260px;overflow-y:auto;">
          <table class="table table-sm">
            <thead><tr><th>#</th><th>Item</th><th class="text-end">Total</th><th></th></tr></thead>
            <tbody id="cartBody"><tr><td colspan="4" class="text-muted text-center py-3">No items added yet.</td></tr></tbody>
          </table>
        </div>

        <hr>
        <div class="row g-2">
          <div class="col-6">
            <label class="form-label small">Urgent Level</label>
            <select id="urgentLevel" class="form-select form-select-sm">
              <option value="" data-day-offset="${String(defaultDueDays)}">Normal</option>
              ${urgentLevels.map((l) => html`
                <option value="${l.id}" data-surcharge="${String(l.surcharge_percent)}" data-day-offset="${String(l.day_offset)}">${l.level_name} (+${String(l.surcharge_percent)}%)</option>`)}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label small">Discount</label>
            <div class="input-group input-group-sm">
              <select id="discountType" class="form-select" style="max-width:80px">
                <option value="Percent">%</option>
                <option value="Flat">Flat</option>
              </select>
              <input type="number" id="discountValue" class="form-control" value="0" min="0" step="0.01">
            </div>
            ${!canOverrideDiscount ? html`
              <div class="form-text">Max allowed: ${String(maxDiscount)}%</div>` : ''}
          </div>
          <div class="col-6">
            <label class="form-label small">Due Date *</label>
            <input type="date" id="dueDate" class="form-control form-control-sm" required>
            <div class="form-text" id="dueDateHint"></div>
          </div>
          <div class="col-6">
            <label class="form-label small">Packaging</label>
            <select id="packagingPreference" class="form-select form-select-sm">
              <option value="">Not specified</option>
              <option value="HANGER">Hanger</option>
              <option value="FOLD">Fold</option>
            </select>
          </div>
          <div class="col-6">
            <label class="form-label small">Due Time</label>
            <input type="time" id="dueTime" class="form-control form-control-sm">
          </div>
          <div class="col-12">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" id="homeDelivery">
              <label class="form-check-label small" for="homeDelivery">Home Delivery</label>
            </div>
          </div>
          <div class="col-12 d-none" id="deliveryChargeWrap">
            <label class="form-label small">Delivery Charge</label>
            <input type="number" id="deliveryCharge" class="form-control form-control-sm" value="${String(defaultDeliveryCharge)}" min="0" step="0.01">
          </div>
          <div class="col-12">
            <label class="form-label small">Order Notes</label>
            <textarea id="orderNotes" class="form-control form-control-sm" rows="2"></textarea>
          </div>
        </div>

        <hr>
        <table class="table table-sm mb-0">
          <!-- Rahul: Quantity = bill lines/units ordered, Pieces = physical garments (a 2-piece
               Suit or a pair of Socks is 1 ordered unit but 2 physical pieces). -->
          <tr><td>Quantity</td><td class="text-end" id="sumQuantity">0</td></tr>
          <tr><td>Pieces</td><td class="text-end" id="sumPieces">0</td></tr>
          <tr><td>Subtotal</td><td class="text-end" id="sumSubtotal">Rs. 0.00</td></tr>
          <tr><td>Discount</td><td class="text-end" id="sumDiscount">Rs. 0.00</td></tr>
          <tr><td>Urgent Charge</td><td class="text-end" id="sumUrgent">Rs. 0.00</td></tr>
          <tr><td>Delivery Charge</td><td class="text-end" id="sumDelivery">Rs. 0.00</td></tr>
          <tr><td>Tax</td><td class="text-end" id="sumTax">Rs. 0.00</td></tr>
          <tr class="fw-bold"><td>Grand Total</td><td class="text-end" id="sumGrandTotal">Rs. 0.00</td></tr>
        </table>
      </div>
    </div>

    <!-- PAYMENT -->
    <div class="card mb-3">
      <div class="card-body">
        <h6 class="fw-bold mb-2">Payment</h6>
        <div class="form-check mb-2">
          <input class="form-check-input" type="checkbox" id="useWallet">
          <label class="form-check-label small" for="useWallet">Use Advance / Wallet (available: <span id="walletAvailable">Rs. 0.00</span>)</label>
        </div>
        <input type="number" id="walletAmount" class="form-control form-control-sm mb-2 d-none" min="0" step="0.01" placeholder="Wallet amount to use">

        <div id="paymentRows"></div>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="addPaymentRow"><i class="fa-solid fa-plus me-1"></i>Add Payment Line</button>

        <hr>
        <div class="d-flex justify-content-between small"><span>Amount Paid</span><strong id="sumPaid">Rs. 0.00</strong></div>
        <div class="d-flex justify-content-between small text-danger"><span>Current Due</span><strong id="sumDue">Rs. 0.00</strong></div>

        <button type="button" class="btn btn-primary w-100 mt-3" id="placeOrderBtn"><i class="fa-solid fa-check me-1"></i>Place Order</button>
      </div>
    </div>
  </div>
</div>

<!-- ADD GARMENT MODAL -->
<div class="modal fade" id="addGarmentModal" tabindex="-1">
  <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">Add Garment</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body">
        <div id="agError" class="alert alert-danger d-none"></div>
        <div class="row g-2">
          <div class="col-6">
            <label class="form-label small">Service *</label>
            <select id="agService" class="form-select form-select-sm">
              ${services.map((s) => html`<option value="${s.id}">${s.service_name}</option>`)}
            </select>
          </div>
          <div class="col-6">
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
            <label class="form-label small">Final Rate (editable)</label>
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
          <!-- hidden for now -- with the garment photo already documenting its own look, typing
               Brand/Color felt redundant at order-creation time. Fields themselves (and their
               JS/submit wiring) are untouched, just not shown. -->
          <div class="col-6" style="display:none;">
            <label class="form-label small">Brand</label>
            <select id="agBrand" class="form-select form-select-sm">
              <option value="">None</option>
              ${brands.map((b) => html`<option value="${b.id}">${b.brand_name}</option>`)}
            </select>
          </div>
          <div class="col-6" style="display:none;">
            <label class="form-label small">Color</label>
            <select id="agColor" class="form-select form-select-sm">
              <option value="">None</option>
              ${colors.map((c) => html`<option value="${c.id}">${c.color_name}</option>`)}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label small">Estimated Line Total</label>
            <input type="text" id="agLineTotalDisplay" class="form-control form-control-sm fw-bold" readonly>
          </div>
          <div class="col-12">
            <label class="form-label small">Packaging</label>
            <div class="d-flex flex-wrap gap-2">
              ${[['', 'None'], ['FOLD', 'Fold'], ['HANGER', 'Hanger'], ['HALF_FOLD', 'Half Fold'], ['HANGER_AND_FOLD', 'Hanger and Fold']].map(([val, label], i) => html`
                <div class="form-check form-check-inline">
                  <input class="form-check-input" type="radio" name="agPackaging" value="${val}" id="agPackaging${i}" ${i === 0 ? 'checked' : ''}>
                  <label class="form-check-label small" for="agPackaging${i}">${label}</label>
                </div>`)}
            </div>
          </div>
          <div class="col-12">
            <label class="form-label small">Defects (select any that apply)</label>
            <div class="d-flex flex-wrap gap-2">
              ${defects.map((d) => html`
                <div class="form-check">
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
        <button type="button" class="btn btn-primary" id="agAddBtn">Add to Order</button>
      </div>
    </div>
  </div>
</div>

<!-- CONFIRMATION MODAL -->
<div class="modal fade" id="confirmModal" tabindex="-1">
  <div class="modal-dialog modal-lg">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">Confirm Order</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body" id="confirmBody"></div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Back</button>
        <button type="button" class="btn btn-primary" id="confirmSaveBtn"><i class="fa-solid fa-check me-1"></i>Confirm & Save</button>
      </div>
    </div>
  </div>
</div>

${raw(posScript(u, jsonEncode, h, {}, x))}
`);
  });

  // ---- New Order (Laundry, per weight) ----------------------------------------------------------
  webPage(app, '/modules/laundry/index', { auth: 'pos.create' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const u = (p: string) => ctx.baseUrl(p);
    const customerId = int(q.customer_id);
    const customer = customerId
      ? (await db.query<Row>('SELECT c.*, pl.price_list_name FROM customers c LEFT JOIN price_lists pl ON pl.id = c.price_list_id WHERE c.id = ? AND c.is_active = 1', [customerId]))[0] ?? null
      : null;
    if (!customer) {
      return layout(ctx, { title: 'New Order (Laundry)' }, html`
    <div class="card">
      <div class="card-body">
        <div class="row g-2 align-items-end">
          <div class="col-md-6 position-relative">
            <label class="form-label small">Search Customer (name / address / mobile / code / barcode)</label>
            <input type="text" id="lwCustomerSearch" class="form-control" placeholder="Type to search...">
            <div id="lwCustomerResults" class="d-none" style="position:absolute;z-index:10;background:#fff;border:1px solid #dee2e6;border-radius:6px;width:100%;max-height:260px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);"></div>
          </div>
          <div class="col-md-3">
            <a href="${u('modules/customers/add.php')}" target="_blank" class="btn btn-outline-secondary w-100"><i class="fa-solid fa-user-plus me-1"></i>Add New Customer</a>
          </div>
        </div>
        <p class="text-muted small mt-3 mb-0">Select a customer above to start a Per-Weight (Laundry) order, or use <a href="${u('modules/customers/list.php')}">the Customers list</a>.</p>
      </div>
    </div>
${raw(laundryPickerScript(u, jsonEncode, h))}
    `);
    }
    const laundryServices = await db.query<Row>("SELECT id, service_name FROM services WHERE is_active=1 AND billing_unit='weight' AND pricing_scope='universal' ORDER BY sort_order");
    // usort with the Wash N Iron comparator (stable in PHP 8, same as Array.prototype.sort)
    laundryServices.sort((a, b) => (a.service_name === 'Wash N Iron' ? -1 : b.service_name === 'Wash N Iron' ? 1 : 0));
    const priceListId = await pricing.resolvePriceListId(Number(customer.id));
    const categories = await db.query<Row>('SELECT id, category_name FROM categories WHERE is_active=1 ORDER BY sort_order');
    const urgentLevels = await db.query<Row>('SELECT id, level_name, surcharge_percent, day_offset FROM urgent_levels WHERE is_active=1 ORDER BY sort_order');
    const paymentTypes = await db.query<Row>('SELECT id, type_name FROM payment_types WHERE is_active=1 ORDER BY sort_order');
    const token = randomBytes(16).toString('hex');
    ctx.data.laundry_order_token = token;
    const firstCat = categories.length ? jsonEncode(categories[0]!.id) : 'null';
    const x = [jsonEncode(token), laundryServices.length ? String(int(laundryServices[0]!.id)) : 'null', firstCat, firstCat, String(int(customer.id))];
    const body = laundryServices.length === 0
      ? html`
  <div class="alert alert-danger">No universal weight-based service (Wash N Fold / Wash N Iron) is currently active and configured.</div>`
      : html`

<div class="row g-3">
  <div class="col-lg-8">
    <div class="laundry-svc-tabs">
      ${laundryServices.map((svc, i) => html`
        <button type="button" class="btn btn-outline-primary laundry-svc-tab${i === 0 ? ' active btn-primary' : ''}" data-id="${svc.id}">${svc.service_name}</button>`)}
    </div>
    <hr>

    <div class="row g-3">
      <div class="col-6">
        <label class="form-label">Weight (KG) *</label>
        <input type="number" id="lbWeight" class="form-control" min="0.01" step="0.01">
      </div>
      <div class="col-6">
        <label class="form-label">Rate / KG (₹) *</label>
        <input type="number" id="lbRate" class="form-control" min="0.01" step="0.01">
      </div>
      <div class="col-6">
        <label class="form-label">No. of Garments *</label>
        <input type="number" id="lbGarmentCount" class="form-control" min="1" step="1">
      </div>
      <div class="col-6">
        <label class="form-label">Estimated Amount</label>
        <input type="text" id="lbEstimate" class="form-control" readonly>
      </div>
    </div>

    <div class="mt-3">
      <button type="button" class="btn btn-outline-secondary" id="lbGarmentDetailsBtn">Garment Details</button>
      <div class="small text-muted mt-1" id="lbGarmentSummary">No garments identified yet.</div>
    </div>

    <button type="button" class="btn btn-primary w-100 mt-3" id="lbAddToCartBtn">Add to Cart</button>
  </div>

  <div class="col-lg-4">
    <div class="card laundry-cart-panel">
      <div class="card-body">
        <h6>Selected Batches</h6>
        <div id="cartList"><p class="text-muted small">No batches added yet.</p></div>
        <hr>
        <div class="d-flex justify-content-between"><span>Total Weight</span><strong id="cartTotalWeight">0.00 KG</strong></div>
        <div class="d-flex justify-content-between"><span>Total Garments</span><strong id="cartTotalGarments">0</strong></div>
        <div class="d-flex justify-content-between"><span>Grand Total</span><strong id="cartTotalAmount">₹0.00</strong></div>
        <button type="button" class="btn btn-primary w-100 mt-3" id="checkoutBtn" disabled>Checkout</button>
      </div>
    </div>
  </div>
</div>

<!-- Garment Details Modal -->
<div class="modal fade" id="garmentDetailsModal" tabindex="-1">
  <div class="modal-dialog modal-lg modal-dialog-scrollable">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Garment Details</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <input type="text" id="lgSearch" class="form-control mb-2" placeholder="Search garment to add">
        <div id="lgSelected"></div>
        <div class="lg-cat-tabs mb-2">
          ${categories.map((c) => html`
            <button type="button" class="btn btn-sm btn-outline-secondary lg-cat-tab" data-id="${c.id}">${c.category_name}</button>`)}
        </div>
        <div id="lgGrid"></div>
        <div class="mt-2 text-end"><strong id="lgTotalSelected">0</strong> garment(s) selected</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
        <button type="button" class="btn btn-primary" id="lgContinueBtn">Continue</button>
      </div>
    </div>
  </div>
</div>

<!-- Quantity Mismatch Modal -->
<div class="modal fade" id="qtyMismatchModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Garments information and quantity mismatch</h5></div>
      <div class="modal-body">
        <p id="qtyMismatchText"></p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" id="qtyMismatchVerify">Verify Garments Quantity</button>
      </div>
    </div>
  </div>
</div>

<!-- Checkout Modal -->
<div class="modal fade" id="checkoutModal" tabindex="-1">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header"><h5 class="modal-title">Checkout</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
      <div class="modal-body">
        <div class="row g-2">
          <div class="col-6">
            <label class="form-label small">Urgent Level</label>
            <select id="coUrgent" class="form-select form-select-sm">
              <option value="">Normal</option>
              ${urgentLevels.map((l) => html`<option value="${l.id}">${l.level_name}</option>`)}
            </select>
          </div>
          <div class="col-6">
            <label class="form-label small">Due Date</label>
            <input type="date" id="coDueDate" class="form-control form-control-sm">
          </div>
          <div class="col-6">
            <label class="form-label small">Discount Type</label>
            <select id="coDiscountType" class="form-select form-select-sm"><option value="Percent">%</option><option value="Flat">Flat</option></select>
          </div>
          <div class="col-6">
            <label class="form-label small">Discount Value</label>
            <input type="number" id="coDiscountValue" class="form-control form-control-sm" min="0" step="0.01" value="0">
          </div>
          <div class="col-6">
            <label class="form-label small">Home Delivery</label>
            <div><input type="checkbox" id="coHomeDelivery"></div>
          </div>
          <div class="col-6">
            <label class="form-label small">Delivery Charge</label>
            <input type="number" id="coDeliveryCharge" class="form-control form-control-sm" min="0" step="0.01" value="0">
          </div>
        </div>
        <hr>
        <div id="coSummary"></div>
        <hr>
        <label class="form-label small">Advance / Payment</label>
        <div class="row g-2">
          <div class="col-6"><select id="coPaymentType" class="form-select form-select-sm">${paymentTypes.map((pt) => html`<option value="${pt.id}">${pt.type_name}</option>`)}</select></div>
          <div class="col-6"><input type="number" id="coAdvanceAmount" class="form-control form-control-sm" min="0" step="0.01" value="0" placeholder="Amount"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Back</button>
        <button type="button" class="btn btn-primary" id="saveOrderBtn">Save Order</button>
      </div>
    </div>
  </div>
</div>
`;
    return layout(ctx, { title: 'New Order (Laundry)' }, html`

${raw(laundryStyle(u, jsonEncode, h))}

<div class="d-flex justify-content-between align-items-center mb-3">
  <h4 class="mb-0">New Order — Laundry</h4>
  <a href="${u('modules/customers/view.php?id=' + customer.id)}" class="btn btn-outline-secondary btn-sm">
    <i class="fa-solid fa-arrow-left me-1"></i>Back to Customer
  </a>
</div>

<div class="card mb-3">
  <div class="card-body py-2">
    <strong>${customer.full_name}</strong>
    <span class="text-muted ms-2">${String(customer.mobile ?? '')}</span>
  </div>
</div>

${body}

${raw(laundryScript(u, jsonEncode, h, { priceListId }, x))}
`);
  });
}
