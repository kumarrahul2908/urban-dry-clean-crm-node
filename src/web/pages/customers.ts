import type { FastifyInstance } from 'fastify';
import { checkCustomerDuplicate, CodeCollisionError, type CustomerForm, type DupMatch } from '../../services/customerService.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { int, numberFormat, urlencode } from '../format.js';
import { e, html, jsonEncode, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { customerAddScript, customerEditScript, customerListStyle, customerViewScript, customerViewStyle } from './customers.static.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const clean = (v: unknown) => str(v).trim();
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);

const FORM_KEYS = ['title', 'full_name', 'address', 'area', 'city', 'state', 'pincode', 'mobile', 'alt_mobile', 'email', 'membership_id', 'birthday', 'anniversary', 'remarks', 'marketing_source', 'registration_source', 'discount_percent', 'price_list_id', 'communication_preference', 'gstin', 'referral_code'];

/** The validation block add.php and edit.php share (messages verbatim). */
async function validateForm(ctx: WebCtx, form: Row, excludeId: number | null) {
  const errors: string[] = [];
  const v = await ctx.svc.customers.validate(form.full_name, form.mobile, excludeId, 'confirm_different_person' in body(ctx));
  if (v.status === 'invalid') errors.push(...Object.values(v.fieldErrors));
  else if (v.status === 'duplicate_blocked') {
    const m = v.matched_customer;
    errors.push(`This mobile number is already registered for ${m.full_name} (${m.customer_code}). Please use the existing customer instead of creating a duplicate.`);
  } else if (v.status === 'duplicate_requires_confirmation') {
    const m = v.matched_customer;
    errors.push(`This mobile number is registered for a very similar name: ${m.full_name} (${m.customer_code}). If this is genuinely a different person, check "confirm different person" below and save again.`);
    form._show_override = true;
    form._dup_match = m;
  } else if (v.matches.length > 0) {
    ctx.flashSet('warning', `Note: this mobile number is already used by ${v.matches.map((mm: DupMatch) => `${mm.full_name} (${mm.customer_code})`).join(', ')} — saved as a separate customer.`);
  }
  return { errors, ok: errors.length === 0 && v.status === 'ok' };
}

export function registerCustomerPages(app: FastifyInstance) {
  const { db, customers } = app.services;

  // ---- list ------------------------------------------------------------------------------------
  webPage(app, '/modules/customers/list', { auth: 'customers.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const search = clean(q.q);
    const page = Math.max(1, int(q.page) || 1);
    const perPage = 20;
    const offset = (page - 1) * perPage;
    let where = '1=1';
    const params: unknown[] = [];
    if (search !== '') {
      where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ? OR c.customer_code LIKE ? OR c.barcode LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n FROM customers c WHERE ${where}`, params))[0]!.n);
    const rows = await db.query<Row>(
      `SELECT c.*, pl.price_list_name FROM customers c LEFT JOIN price_lists pl ON pl.id = c.price_list_id WHERE ${where} ORDER BY c.id DESC LIMIT ${perPage} OFFSET ${offset}`, params);
    const totalPages = Math.ceil(total / perPage);
    const showingFrom = total ? offset + 1 : 0;
    const showingTo = Math.min(offset + perPage, total);
    const u = (p: string) => ctx.baseUrl(p);

    let pager: Raw | string = '';
    if (totalPages > 1) {
      const start = Math.max(1, page - 2), end = Math.min(totalPages, page + 2);
      const pUrl = (p: number) => `?q=${urlencode(search)}&page=${p}`;
      const nums: Raw[] = [];
      for (let i = start; i <= end; i++) nums.push(html`
            <li><a class="${i === page ? 'is-active' : ''}" href="${pUrl(i)}">${i}</a></li>`);
      pager = html`
      <nav class="cl-pager">
        <div class="cl-pager-info">Showing ${numberFormat(showingFrom, 0)}–${numberFormat(showingTo, 0)} of ${numberFormat(total, 0)}</div>
        <ul class="cl-pages">
          ${page > 1 ? html`
            <li><a href="${pUrl(1)}" aria-label="First page"><i class="fa-solid fa-angles-left"></i></a></li>
            <li><a href="${pUrl(page - 1)}" aria-label="Previous page"><i class="fa-solid fa-angle-left"></i></a></li>` : ''}
          ${start > 1 ? html`<li class="cl-gap">…</li>` : ''}
          ${nums}
          ${end < totalPages ? html`<li class="cl-gap">…</li>` : ''}
          ${page < totalPages ? html`
            <li><a href="${pUrl(page + 1)}" aria-label="Next page"><i class="fa-solid fa-angle-right"></i></a></li>
            <li><a href="${pUrl(totalPages)}" aria-label="Last page"><i class="fa-solid fa-angles-right"></i></a></li>` : ''}
        </ul>
      </nav>`;
    }

    return layout(ctx, { title: 'Customers' }, html`
<div class="col-12">

  <div class="cl-toolbar">
    <div class="cl-toolbar-title">
      <h4>Customers</h4>
      <span>${numberFormat(total, 0)} ${total === 1 ? 'customer' : 'customers'}${search !== '' ? ' matching search' : ''}</span>
    </div>
    ${ctx.can('customers.create') ? html`
      <a href="${u('modules/customers/add.php')}" class="cl-new-btn"><i class="fa-solid fa-plus"></i>Add Customer</a>` : ''}
  </div>

  <div class="card cl-card">
    <div class="card-body">

      <form class="cl-filters" method="GET">
        <div class="cl-field">
          <i class="fa-solid fa-magnifying-glass cl-field-icon"></i>
          <input type="text" name="q" class="form-control cl-input cl-input--search"
                 placeholder="Search by name, mobile, code or barcode" value="${search}">
        </div>
        <button class="cl-apply-btn" type="submit"><i class="fa-solid fa-magnifying-glass"></i><span>Search</span></button>
        ${search !== '' ? html`
          <a href="?" class="cl-clear-btn" title="Clear search"><i class="fa-solid fa-xmark"></i><span>Clear</span></a>` : ''}
      </form>

      <div class="table-responsive udc-cards-wrap">
        <table class="udc-cards table table-hover align-middle cl-table">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Mobile</th><th>Area</th><th>Price List</th><th class="text-end">Discount%</th><th>Home Delivery</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
          ${rows.length === 0 ? html`
            <tr><td colspan="9" class="cl-empty">
              <i class="fa-solid fa-user-slash"></i>
              <span>${search !== '' ? 'No customers match this search.' : 'No customers yet.'}</span>
            </td></tr>` : ''}
          ${rows.map((c) => html`
            <tr>
              <td data-label="Code"><span class="cl-code">${c.customer_code}</span></td>
              <td class="udc-card-head udc-card-title" data-label="Name"><a href="${u('modules/customers/view.php?id=' + c.id)}">${`${c.title ?? ''} ${c.full_name ?? ''}`.trim()}</a></td>
              <td data-label="Mobile">${c.mobile}</td>
              <td data-label="Area">${c.area}</td>
              <td data-label="Price List">${c.price_list_name ?? 'Default'}</td>
              <td class="text-end" data-label="Discount%">${String(c.discount_percent)}%</td>
              <td data-label="Home Delivery">${c.home_delivery ? raw('<span class="cl-pill cl-pill--yes">Yes</span>') : raw('<span class="cl-pill cl-pill--no">No</span>')}</td>
              <td data-label="Status">${c.is_active ? raw('<span class="cl-pill cl-pill--active">Active</span>') : raw('<span class="cl-pill cl-pill--inactive">Inactive</span>')}</td>
              <td class="text-end cl-actions" data-label="">
                <a class="cl-icon-btn" href="${u('modules/customers/view.php?id=' + c.id)}" title="View"><i class="fa-solid fa-eye"></i></a>
                ${ctx.can('customers.edit') ? html`
                <a class="cl-icon-btn cl-icon-btn--edit" href="${u('modules/customers/edit.php?id=' + c.id)}" title="Edit"><i class="fa-solid fa-pen"></i></a>` : ''}
              </td>
            </tr>`)}
          </tbody>
        </table>
      </div>

      ${pager}
    </div>
  </div>
</div>

${raw(customerListStyle(u, jsonEncode, e))}
`);
  });

  // ---- add / edit shared form --------------------------------------------------------------
  const sel = (cond: boolean) => (cond ? 'selected' : '');
  const text = (col: string, label: string, name: string, form: Row, type = 'text') => html`<div class="${col}"><label class="form-label">${label}</label>
            <input type="${type}" name="${name}" class="form-control" value="${form[name]}"></div>`;
  const options = (list: string[], cur: unknown) => list.map((t) => html`
                <option ${sel(cur === t)}>${t}</option>`);
  const priceListOptions = (priceLists: Row[], cur: unknown) => priceLists.map((pl) => html`
                <option value="${pl.id}" ${sel(cur !== '' && cur !== null && cur !== undefined && String(cur) === String(pl.id))}>${pl.price_list_name}</option>`);
  const errorBlock = (errors: string[]) => errors.length ? html`
        <div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html`<li>${er}</li>`)}</ul></div>` : '';
  const overrideBlock = (form: Row, formId: string) => form._show_override ? html`
        <div class="alert alert-warning">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" name="confirm_different_person" id="confirmDiffPerson" form="${formId}">
            <label class="form-check-label" for="confirmDiffPerson">I confirm this is genuinely a different person from ${form._dup_match.full_name} (${form._dup_match.customer_code}), sharing the same mobile number.</label>
          </div>
        </div>` : '';
  const toInput = (form: Row, isEdit: boolean): CustomerForm => ({
    ...(form as unknown as CustomerForm),
    home_delivery: form.home_delivery ? 1 : 0,
    ...(isEdit ? { is_active: form.is_active ? 1 : 0 } : {}),
  });

  // ---- add ------------------------------------------------------------------------------------
  webPage(app, '/modules/customers/add', { auth: 'customers.create' }, async (ctx, req) => {
    let errors: string[] = [];
    const form: Row = {
      title: 'Mr', full_name: '', address: '', area: '', city: '', state: '', pincode: '', mobile: '', alt_mobile: '', email: '', membership_id: '',
      birthday: '', anniversary: '', remarks: '', home_delivery: 0, marketing_source: '', registration_source: 'Counter', discount_percent: 0,
      price_list_id: '', communication_preference: 'SMS', gstin: '', referral_code: '',
    };
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      for (const k of Object.keys(form)) form[k] = clean(body(ctx)[k]);
      form.home_delivery = 'home_delivery' in body(ctx) ? 1 : 0;
      const r = await validateForm(ctx, form, null);
      errors = r.errors;
      if (r.ok) {
        try {
          const created = await customers.create(toInput(form, false), ctx.data.user_id!, req.ip);
          ctx.flashSet('success', `Customer ${form.full_name} added successfully (Code: ${created.customer_code}).`);
          return new WebRedirect(`modules/customers/view.php?id=${created.id}`);
        } catch (ex) {
          if (ex instanceof CodeCollisionError) errors.push(ex.message); else throw ex;
        }
      }
    }
    const priceLists = await db.query<Row>('SELECT id, price_list_name FROM price_lists WHERE is_active=1');
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Add Customer' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      ${errorBlock(errors)}
      ${overrideBlock(form, 'addCustomerForm')}
      <form method="POST" id="addCustomerForm">
        ${ctx.csrfField()}
        <div class="row g-3">
          <div class="col-md-2">
            <label class="form-label">Title</label>
            <select name="title" class="form-select">
              ${options(['Mr', 'Mrs', 'Ms', 'M/s'], form.title)}
            </select>
          </div>
          <div class="col-md-6">
            <label class="form-label">Full Name *</label>
            <input type="text" name="full_name" class="form-control" value="${form.full_name}" required>
          </div>
          <div class="col-md-4">
            <label class="form-label">Mobile *</label>
            <input type="text" name="mobile" id="mobileInput" class="form-control" value="${form.mobile}" required>
            <div id="mobileWarning" class="form-text text-warning d-none"></div>
          </div>

          <div class="col-md-4">
            <label class="form-label">Alt Mobile</label>
            <input type="text" name="alt_mobile" class="form-control" value="${form.alt_mobile}">
          </div>
          <div class="col-md-4">
            <label class="form-label">Email</label>
            <input type="email" name="email" class="form-control" value="${form.email}">
          </div>
          <div class="col-md-4">
            <label class="form-label">Membership ID</label>
            <input type="text" name="membership_id" class="form-control" value="${form.membership_id}">
          </div>

          <div class="col-12"><label class="form-label">Address</label>
            <input type="text" name="address" class="form-control" value="${form.address}"></div>
          ${text('col-md-3', 'Area', 'area', form)}
          ${text('col-md-3', 'City', 'city', form)}
          ${text('col-md-3', 'State', 'state', form)}
          ${text('col-md-3', 'PIN Code', 'pincode', form)}

          ${text('col-md-3', 'Birthday', 'birthday', form, 'date')}
          ${text('col-md-3', 'Anniversary', 'anniversary', form, 'date')}
          <div class="col-md-3">
            <label class="form-label">Price List</label>
            <select name="price_list_id" class="form-select">
              <option value="">Default</option>
              ${priceListOptions(priceLists, form.price_list_id)}
            </select>
          </div>
          <div class="col-md-3"><label class="form-label">Discount %</label>
            <input type="number" step="0.01" min="0" max="100" name="discount_percent" class="form-control" value="${String(form.discount_percent)}"></div>

          <div class="col-md-3">
            <label class="form-label">Communication Pref.</label>
            <select name="communication_preference" class="form-select">
              ${options(['SMS', 'WhatsApp', 'Email', 'None'], form.communication_preference)}
            </select>
          </div>
          <div class="col-md-3">
            <label class="form-label">Registration Source</label>
            <select name="registration_source" class="form-select">
              ${options(['Counter', 'Website', 'App', 'Referral'], form.registration_source)}
            </select>
          </div>
          ${text('col-md-3', 'Marketing Source', 'marketing_source', form)}
          ${text('col-md-3', 'Referral Code', 'referral_code', form)}

          ${text('col-md-4', 'GSTIN', 'gstin', form)}
          <div class="col-md-4 d-flex align-items-end">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" name="home_delivery" id="hd" ${form.home_delivery ? 'checked' : ''}>
              <label class="form-check-label" for="hd">Home Delivery Preferred</label>
            </div>
          </div>

          <div class="col-12"><label class="form-label">Remarks</label>
            <textarea name="remarks" class="form-control" rows="2">${form.remarks}</textarea></div>
        </div>

        <div class="mt-4">
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-check me-1"></i>Save Customer</button>
          <a href="${u('modules/customers/list.php')}" class="btn btn-outline-secondary">Cancel</a>
        </div>
      </form>
    </div>
  </div>
</div>
${raw(customerAddScript(u, jsonEncode, e))}
`);
  });

  // ---- edit -----------------------------------------------------------------------------------
  webPage(app, '/modules/customers/edit', { auth: 'customers.edit' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const customer = (await db.query<Row>('SELECT * FROM customers WHERE id = ?', [id]))[0];
    if (!customer) { ctx.flashSet('danger', 'Customer not found.'); return new WebRedirect('modules/customers/list.php'); }
    let errors: string[] = [];
    const form: Row = { ...customer };
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      for (const k of FORM_KEYS) form[k] = clean(body(ctx)[k]);
      form.home_delivery = 'home_delivery' in body(ctx) ? 1 : 0;
      form.is_active = 'is_active' in body(ctx) ? 1 : 0;
      const r = await validateForm(ctx, form, id);
      errors = r.errors;
      if (r.ok) {
        await customers.update(id, customer, toInput(form, true), ctx.data.user_id!, req.ip);
        ctx.flashSet('success', 'Customer updated successfully.');
        return new WebRedirect(`modules/customers/view.php?id=${id}`);
      }
    }
    const priceLists = await db.query<Row>('SELECT id, price_list_name FROM price_lists WHERE is_active=1');
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Edit Customer' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      ${errorBlock(errors)}
      ${overrideBlock(form, 'editCustomerForm')}
      <form method="POST" id="editCustomerForm">
        ${ctx.csrfField()}
        <div class="row g-3">
          <div class="col-md-2">
            <label class="form-label">Title</label>
            <select name="title" class="form-select">
              ${options(['Mr', 'Mrs', 'Ms', 'M/s'], form.title)}
            </select>
          </div>
          <div class="col-md-6">
            <label class="form-label">Full Name *</label>
            <input type="text" name="full_name" class="form-control" value="${form.full_name}" required>
          </div>
          <div class="col-md-4">
            <label class="form-label">Mobile *</label>
            <input type="text" name="mobile" id="mobileInput" class="form-control" value="${form.mobile}" required>
            <div id="mobileWarning" class="form-text text-warning d-none"></div>
          </div>

          ${text('col-md-4', 'Alt Mobile', 'alt_mobile', form)}
          ${text('col-md-4', 'Email', 'email', form, 'email')}
          ${text('col-md-4', 'Membership ID', 'membership_id', form)}

          <div class="col-12"><label class="form-label">Address</label>
            <input type="text" name="address" class="form-control" value="${form.address}"></div>
          ${text('col-md-3', 'Area', 'area', form)}
          ${text('col-md-3', 'City', 'city', form)}
          ${text('col-md-3', 'State', 'state', form)}
          ${text('col-md-3', 'PIN Code', 'pincode', form)}

          ${text('col-md-3', 'Birthday', 'birthday', form, 'date')}
          ${text('col-md-3', 'Anniversary', 'anniversary', form, 'date')}
          <div class="col-md-3">
            <label class="form-label">Price List</label>
            <select name="price_list_id" class="form-select">
              <option value="">Default</option>
              ${priceListOptions(priceLists, form.price_list_id)}
            </select>
          </div>
          <div class="col-md-3"><label class="form-label">Discount %</label>
            <input type="number" step="0.01" min="0" max="100" name="discount_percent" class="form-control" value="${String(form.discount_percent)}"></div>

          <div class="col-md-3">
            <label class="form-label">Communication Pref.</label>
            <select name="communication_preference" class="form-select">
              ${options(['SMS', 'WhatsApp', 'Email', 'None'], form.communication_preference)}
            </select>
          </div>
          <div class="col-md-3">
            <label class="form-label">Registration Source</label>
            <select name="registration_source" class="form-select">
              ${options(['Counter', 'Website', 'App', 'Referral'], form.registration_source)}
            </select>
          </div>
          ${text('col-md-3', 'Referral Code', 'referral_code', form)}

          ${text('col-md-3', 'GSTIN', 'gstin', form)}
          ${text('col-md-3', 'Marketing Source', 'marketing_source', form)}
          <div class="col-md-3 d-flex align-items-end">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" name="home_delivery" id="hd" ${form.home_delivery ? 'checked' : ''}>
              <label class="form-check-label" for="hd">Home Delivery Preferred</label>
            </div>
          </div>
          <div class="col-md-3 d-flex align-items-end">
            <div class="form-check">
              <input class="form-check-input" type="checkbox" name="is_active" id="ia" ${form.is_active ? 'checked' : ''}>
              <label class="form-check-label" for="ia">Active</label>
            </div>
          </div>

          <div class="col-12"><label class="form-label">Remarks</label>
            <textarea name="remarks" class="form-control" rows="2">${form.remarks}</textarea></div>
        </div>

        <div class="mt-4">
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-check me-1"></i>Update Customer</button>
          <a href="${u('modules/customers/view.php?id=' + id)}" class="btn btn-outline-secondary">Cancel</a>
        </div>
      </form>
    </div>
  </div>
</div>
${raw(customerEditScript(u, jsonEncode, e, { id }))}
`);
  });

  // ---- view -----------------------------------------------------------------------------------
  webPage(app, '/modules/customers/view', { auth: 'customers.view' }, async (ctx, req) => {
    const id = int((req.query as Record<string, unknown>).id);
    const customer = (await db.query<Row>('SELECT c.*, pl.price_list_name FROM customers c LEFT JOIN price_lists pl ON pl.id=c.price_list_id WHERE c.id=?', [id]))[0];
    if (!customer) { ctx.flashSet('danger', 'Customer not found.'); return new WebRedirect('modules/customers/list.php'); }
    const money = await ctx.loadMoney();
    const orders = await db.query<Row>('SELECT o.*, os.status_label, os.color FROM orders o JOIN order_statuses os ON os.id=o.status_id WHERE o.customer_id=? ORDER BY o.order_date DESC LIMIT 50', [id]);
    const payments = await db.query<Row>('SELECT * FROM payments WHERE customer_id=? ORDER BY payment_date DESC LIMIT 50', [id]);
    const outstandingTotal = (await db.query<Row>('SELECT COALESCE(SUM(due_amount),0) AS v FROM accounts_receivable WHERE customer_id=? AND due_amount>0', [id]))[0]!.v;
    const wb = (await db.query<Row>('SELECT balance FROM customer_wallet WHERE customer_id=?', [id]))[0]?.balance;
    const walletBalance = wb === undefined || wb === null || wb === '' || wb === '0' || wb === 0 ? 0 : wb;
    const walletTxns = await db.query<Row>('SELECT * FROM wallet_transactions WHERE customer_id=? ORDER BY created_at DESC LIMIT 30', [id]);
    const garments = await db.query<Row>(
      `SELECT garment_name, service_name, quantity, rate, weight, order_date, order_number FROM (
         SELECT g.garment_name, s.service_name, oi.quantity, CASE WHEN oi.weight IS NOT NULL THEN oi.weight_rate ELSE oi.unit_price END AS rate, oi.weight, o.order_date, o.order_number
         FROM order_items oi JOIN garments g ON g.id=oi.garment_id JOIN services s ON s.id=oi.service_id JOIN orders o ON o.id=oi.order_id
         WHERE o.customer_id=? AND o.order_mode = 'piece'
         UNION ALL
         SELECT g.garment_name, s.service_name, 1 AS quantity, NULL AS rate, NULL AS weight, o.order_date, o.order_number
         FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = oi.order_id
         WHERE o.customer_id=?
       ) combined ORDER BY order_date DESC LIMIT 50`, [id, id]);
    const deliveries = await db.query<Row>('SELECT * FROM delivery_orders WHERE customer_id=? ORDER BY delivery_date DESC LIMIT 30', [id]);
    const feedback = await db.query<Row>('SELECT * FROM feedback WHERE customer_id=? ORDER BY created_at DESC LIMIT 20', [id]);

    const ledger: { date: string; type: string; debit: unknown; credit: unknown }[] = [];
    for (const o of orders) ledger.push({ date: o.order_date, type: `Order ${o.order_number}`, debit: o.grand_total, credit: 0 });
    for (const p of payments) ledger.push({ date: p.payment_date, type: `Payment ${p.payment_number}`, debit: 0, credit: p.total_amount });
    ledger.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const displayName = `${customer.title ?? ''} ${customer.full_name ?? ''}`.trim();
    const nm = String(customer.full_name ?? '').trim();
    const avatar = Array.from(nm !== '' ? nm : '?')[0]!.toUpperCase();
    const addressParts = [customer.address, customer.area, customer.city, customer.state, customer.pincode].filter((p) => p !== null && p !== undefined && String(p).trim() !== '');
    const u = (p: string) => ctx.baseUrl(p);
    const out = parseFloat(String(outstandingTotal)) || 0;
    const stars = (n: number) => '★'.repeat(Math.max(0, n));
    const emptyStars = (n: number) => '☆'.repeat(Math.max(0, 5 - n));

    return layout(ctx, { title: 'Customer Profile' }, html`

<div class="col-12">
  <div class="card cv-header">
    <div class="card-body">
      <div class="cv-head-row">
        <div class="cv-identity">
          <span class="cv-avatar" aria-hidden="true">${avatar}</span>
          <div class="cv-identity-text">
            <h4>${displayName}</h4>
            <div class="cv-codes">
              <span>Code <strong>${customer.customer_code}</strong></span>
              ${customer.barcode ? html`<span>Barcode <strong>${customer.barcode}</strong></span>` : ''}
              ${customer.is_active ? html`
                <span class="cv-pill cv-pill--active">Active</span>` : html`
                <span class="cv-pill cv-pill--inactive">Inactive</span>`}
            </div>
          </div>
        </div>

        <div class="cv-actions">
          ${ctx.can('customers.edit') ? html`
            <a href="${u('modules/customers/edit.php?id=' + id)}" class="cv-btn cv-btn--ghost"><i class="fa-solid fa-pen"></i>Edit</a>` : ''}
          ${ctx.can('pos.create') ? html`
            <a href="${u('modules/pos/index.php?customer_id=' + id)}" class="cv-btn cv-btn--primary"><i class="fa-solid fa-plus"></i>Order — Dry Cleaning</a>
            <a href="${u('modules/laundry/index.php?customer_id=' + id)}" class="cv-btn cv-btn--ghost"><i class="fa-solid fa-weight-scale"></i>Order — Laundry</a>` : ''}
        </div>
      </div>

      <div class="cv-contact">
        <div class="cv-contact-item">
          <i class="fa-solid fa-phone"></i>
          <div><span>Mobile</span><strong>${customer.mobile}${customer.alt_mobile ? raw(' / ' + e(customer.alt_mobile)) : ''}</strong></div>
        </div>
        <div class="cv-contact-item">
          <i class="fa-solid fa-location-dot"></i>
          <div><span>Address</span>
            ${addressParts.length > 0 ? html`
              <strong>${addressParts.join(', ')}</strong>` : html`
              <strong class="cv-muted">No address on file</strong>`}
          </div>
        </div>
        ${customer.price_list_name ? html`
        <div class="cv-contact-item">
          <i class="fa-solid fa-tags"></i>
          <div><span>Price list</span><strong>${customer.price_list_name}</strong></div>
        </div>` : ''}
        <div class="cv-contact-item">
          <i class="fa-solid fa-truck"></i>
          <div><span>Home delivery</span><strong>${customer.home_delivery ? 'Yes' : 'No'}</strong></div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="col-12">
  <div class="cv-stats">
    <div class="cv-stat cv-stat--orders">
      <span class="cv-stat-icon"><i class="fa-solid fa-receipt"></i></span>
      <span class="cv-stat-body"><span class="cv-stat-value">${orders.length}</span><span class="cv-stat-label">Orders (shown)</span></span>
    </div>
    <div class="cv-stat cv-stat--out">
      <span class="cv-stat-icon"><i class="fa-solid fa-circle-exclamation"></i></span>
      <span class="cv-stat-body"><span class="cv-stat-value cv-stat-value--money">${money(outstandingTotal)}</span><span class="cv-stat-label">Outstanding</span></span>
      ${out > 0 && customer.mobile ? html`
      <button type="button" id="sendDueReminderBtn" style="margin-left:10px;background:#25D366;color:#fff;border:0;border-radius:6px;padding:6px 12px;font-size:12.5px;cursor:pointer;">Send Due Reminder</button>` : ''}
    </div>
    <div class="cv-stat cv-stat--wallet">
      <span class="cv-stat-icon"><i class="fa-solid fa-wallet"></i></span>
      <span class="cv-stat-body"><span class="cv-stat-value cv-stat-value--money">${money(walletBalance)}</span><span class="cv-stat-label">Wallet / Advance</span></span>
    </div>
    <div class="cv-stat cv-stat--disc">
      <span class="cv-stat-icon"><i class="fa-solid fa-percent"></i></span>
      <span class="cv-stat-body"><span class="cv-stat-value">${customer.discount_percent}%</span><span class="cv-stat-label">Standing discount</span></span>
    </div>
  </div>
</div>

<div class="col-12">
  <div class="card cv-card">
    <div class="card-body">

      <div class="cv-tabs-wrap">
        <ul class="nav nav-tabs cv-tabs" role="tablist">
          <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#tab-orders">Orders<span>${orders.length}</span></button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-payments">Payments<span>${payments.length}</span></button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-garments">Garments<span>${garments.length}</span></button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-wallet">Wallet<span>${walletTxns.length}</span></button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-delivery">Delivery<span>${deliveries.length}</span></button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-feedback">Feedback<span>${feedback.length}</span></button></li>
          <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#tab-ledger">Ledger<span>${ledger.length}</span></button></li>
        </ul>
      </div>

      <div class="tab-content pt-3">

        <div class="tab-pane fade show active" id="tab-orders">
          <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-sm cv-table">
            <thead><tr><th>Order#</th><th>Date</th><th>Due</th><th>Status</th><th class="text-end">Total</th><th class="text-end">Due Amt</th></tr></thead>
            <tbody>
            ${orders.length === 0 ? html`<tr><td colspan="6" class="cv-empty">No orders yet.</td></tr>` : ''}
            ${orders.map((o) => html`
              <tr>
                <td data-label="Order#"><a href="${u('modules/orders/view.php?id=' + o.id)}">${o.order_number}</a></td>
                <td data-label="Date">${raw(ctx.date(o.order_date))}</td>
                <td data-label="Due">${raw(ctx.date(o.due_date))}</td>
                <td data-label="Status"><span class="cv-status" style="background:${o.color}">${o.status_label}</span></td>
                <td class="text-end" data-label="Total">${raw(money(o.grand_total))}</td>
                <td class="text-end cv-due${(parseFloat(String(o.current_due)) || 0) > 0 ? ' cv-due--open' : ''}" data-label="Due Amt">${raw(money(o.current_due))}</td>
              </tr>`)}
            </tbody>
          </table>
          </div>
        </div>

        <div class="tab-pane fade" id="tab-payments">
          <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-sm cv-table">
            <thead><tr><th>Payment#</th><th>Date</th><th>Kind</th><th class="text-end">Amount</th></tr></thead>
            <tbody>
            ${payments.length === 0 ? html`<tr><td colspan="4" class="cv-empty">No payments yet.</td></tr>` : ''}
            ${payments.map((p) => html`
              <tr><td data-label="Payment#">${p.payment_number}</td><td data-label="Date">${raw(ctx.datetime(p.payment_date))}</td><td data-label="Kind"><span class="cv-chip">${p.payment_kind}</span></td><td class="text-end cv-credit" data-label="Amount">${raw(money(p.total_amount))}</td></tr>`)}
            </tbody>
          </table>
          </div>
        </div>

        <div class="tab-pane fade" id="tab-garments">
          <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-sm cv-table">
            <thead><tr><th>Garment</th><th>Service</th><th>Order#</th><th>Date</th><th class="text-end">Qty</th><th class="text-end">Rate</th></tr></thead>
            <tbody>
            ${garments.length === 0 ? html`<tr><td colspan="6" class="cv-empty">No garment history yet.</td></tr>` : ''}
            ${garments.map((g) => html`
              <tr><td data-label="Garment">${g.garment_name}</td><td data-label="Service"><span class="cv-chip">${g.service_name}</span></td><td data-label="Order#">${g.order_number}</td><td data-label="Date">${raw(ctx.date(g.order_date))}</td><td class="text-end" data-label="Qty">${g.weight !== null ? raw(e(String(g.weight)) + ' kg') : e(String(g.quantity))}</td><td class="text-end" data-label="Rate">${raw(money(g.rate))}${g.weight !== null ? '/kg' : ''}</td></tr>`)}
            </tbody>
          </table>
          </div>
        </div>

        <div class="tab-pane fade" id="tab-wallet">
          <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-sm cv-table">
            <thead><tr><th>Date</th><th>Type</th><th class="text-end">Debit</th><th class="text-end">Credit</th><th class="text-end">Balance</th><th>Remarks</th></tr></thead>
            <tbody>
            ${walletTxns.length === 0 ? html`<tr><td colspan="6" class="cv-empty">No wallet activity yet.</td></tr>` : ''}
            ${walletTxns.map((w) => html`
              <tr><td data-label="Date">${raw(ctx.datetime(w.created_at))}</td><td data-label="Type"><span class="cv-chip">${w.txn_type}</span></td><td class="text-end cv-debit" data-label="Debit">${raw(money(w.debit))}</td><td class="text-end cv-credit" data-label="Credit">${raw(money(w.credit))}</td><td class="text-end fw-bold" data-label="Balance">${raw(money(w.balance_after))}</td><td data-label="Remarks">${w.remarks}</td></tr>`)}
            </tbody>
          </table>
          </div>
        </div>

        <div class="tab-pane fade" id="tab-delivery">
          <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-sm cv-table">
            <thead><tr><th>Delivery#</th><th>Date</th><th>Status</th><th class="text-end">Amount Due</th></tr></thead>
            <tbody>
            ${deliveries.length === 0 ? html`<tr><td colspan="4" class="cv-empty">No deliveries yet.</td></tr>` : ''}
            ${deliveries.map((d) => html`
              <tr><td data-label="Delivery#">${d.delivery_number}</td><td data-label="Date">${raw(ctx.date(d.delivery_date))}</td><td data-label="Status"><span class="cv-chip">${d.status}</span></td><td class="text-end" data-label="Amount Due">${raw(money(d.amount_due))}</td></tr>`)}
            </tbody>
          </table>
          </div>
        </div>

        <div class="tab-pane fade" id="tab-feedback">
          ${feedback.length === 0 ? html`<p class="cv-empty">No feedback yet.</p>` : ''}
          ${feedback.map((f) => html`
            <div class="cv-feedback">
              <div class="cv-stars">${stars(int(f.rating))}<span>${emptyStars(int(f.rating))}</span></div>
              <div class="cv-feedback-date">${raw(ctx.datetime(f.created_at))}</div>
              <div class="cv-feedback-text">${f.comments}</div>
            </div>`)}
        </div>

        <div class="tab-pane fade" id="tab-ledger">
          <div class="table-responsive udc-cards-wrap">
          <table class="udc-cards table table-sm cv-table">
            <thead><tr><th>Date</th><th>Description</th><th class="text-end">Debit</th><th class="text-end">Credit</th></tr></thead>
            <tbody>
            ${ledger.length === 0 ? html`<tr><td colspan="4" class="cv-empty">No transactions yet.</td></tr>` : ''}
            ${ledger.map((l) => html`
              <tr><td data-label="Date">${raw(ctx.datetime(l.date))}</td><td data-label="Description">${l.type}</td><td class="text-end cv-debit" data-label="Debit">${phpTruthy(l.debit) ? raw(money(l.debit)) : ''}</td><td class="text-end cv-credit" data-label="Credit">${phpTruthy(l.credit) ? raw(money(l.credit)) : ''}</td></tr>`)}
            </tbody>
          </table>
          </div>
        </div>

      </div>
    </div>
  </div>
</div>
${raw(customerViewStyle(u, jsonEncode, e))}
${out > 0 && customer.mobile ? raw(customerViewScript(u, jsonEncode, e, { id, csrf: ctx.csrfToken() })) : ''}
`);
  });

  // ---- api/customers_check_mobile.php ---------------------------------------------------------
  webPage(app, '/api/customers_check_mobile', { auth: 'login', methods: ['GET'] }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const mobile = clean(q.mobile), name = clean(q.name);
    const exclude = int(q.exclude_id);
    const json = (d: unknown) => new WebText(jsonEncode(d), 200, 'application/json');
    if (mobile === '' || !/^[0-9+ -]{7,15}$/.test(mobile)) return json({ action: 'allow', matches: [] });
    return json(await checkCustomerDuplicate(db, mobile, name, exclude > 0 ? exclude : null));
  });
}

/** PHP truthiness of a DB numeric/string value (0, 0.0, "0", "0.00"? — "0.00" is truthy as a string, 0.00 float is not). */
function phpTruthy(v: unknown): boolean {
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '');
  return s !== '' && s !== '0';
}
