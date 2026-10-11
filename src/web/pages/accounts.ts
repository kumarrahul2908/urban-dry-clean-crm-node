import type { FastifyInstance } from 'fastify';
import { isNumeric, phpEmpty, phpRound } from '../../lib/php.js';
import { EXPENSE_TYPES, type EntryType } from '../../services/expenseService.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { csvBody, fputcsv } from '../csv.js';
import { flt, httpBuildQuery, int, urlencode } from '../format.js';
import { html, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';
import { walletAdjustScript } from './accounts.static.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const orDash = (v: unknown) => (v === null || v === undefined || v === '' || v === '0' ? '—' : String(v));

export function registerAccountPages(app: FastifyInstance) {
  const { db, expenses, wallet, whatsapp } = app.services;

  // ---- Expenses / Income (shared body of _entries_page.php) -----------------------------------
  const entries = (type: EntryType) => {
    const isExpense = type === 'expense';
    const selfPath = isExpense ? 'modules/accounts/expenses.php' : 'modules/accounts/income.php';
    webPage(app, `/modules/accounts/${isExpense ? 'expenses' : 'income'}`, { auth: 'expenses.manage' }, async (ctx, req) => {
      const userId = ctx.data.user_id!;
      const q = req.query as Record<string, unknown>;
      let errors: string[] = [];
      const post = req.method === 'POST' ? body(ctx) : null;
      if (post) {
        if (!ctx.csrfValid()) return csrfFail();
        const action = str(post.action);
        if (action === 'save') {
          const editId = !phpEmpty(post.id) ? int(post.id) : null;
          const r = await expenses.save(type, editId, post, userId, req.ip) as Row;
          if (r.success) {
            ctx.flashSet('success', r.duplicate ? 'This entry was already saved a moment ago.' : (editId ? (r.changed ? 'Entry updated.' : 'Nothing changed.') : 'Entry added.'));
            return new WebRedirect(ctx.baseUrl(selfPath));
          }
          errors = r.errors;
        } else if (isExpense && action === 'category') {
          const cid = !phpEmpty(post.category_id) ? int(post.category_id) : null;
          const active = 'set_active' in post ? post.set_active === '1' : null;
          const r = await expenses.saveCategory(cid, str(post.category_name), active, userId, req.ip);
          if (r.success) { ctx.flashSet('success', 'Category saved.'); return new WebRedirect(ctx.baseUrl(`${selfPath}#categories`)); }
          errors = r.errors;
        }
      }

      const filters = { from: q.from ?? null, to: q.to ?? null, category_id: q.category_id ?? null, q: q.q ?? '', page: q.page ?? 1, per_page: 25 };
      const data = await expenses.listEntries(type, filters) as Omit<Awaited<ReturnType<typeof expenses.listEntries>>, "entries"> & { entries: Row[] };
      const modes = await expenses.paymentModes();
      const categories = isExpense ? await expenses.categories() : [];
      const editing = !phpEmpty(q.edit) ? await expenses.find(type, int(q.edit)) : null;
      const form: Row = post && str(post.action) === 'save' ? post : (editing ?? {});
      const fv = (k: string, d = '') => String(form[k] ?? d);
      const dateKey = isExpense ? 'expense_date' : 'income_date';
      const totalPages = Math.max(1, Math.ceil(data.total_count / data.per_page));
      const qs = (over: Record<string, unknown>) => {
        const base: Record<string, unknown> = { from: data.from, to: data.to, category_id: filters.category_id, q: filters.q, ...over };
        for (const k of Object.keys(base)) if (base[k] === null || base[k] === undefined) delete base[k]; // http_build_query skips nulls
        return httpBuildQuery(base);
      };
      const formCat = int(form.category_id);
      const u = (p: string) => ctx.baseUrl(p);
      const money = await ctx.loadMoney();
      return layout(ctx, { title: isExpense ? 'Expenses' : 'Income' }, html`
<div class="col-12">
  ${errors.map((er) => html`<div class="alert alert-danger">${er}</div>`)}
  <div class="row g-3">
    <div class="col-lg-4">
      <div class="card mb-3">
        <div class="card-body">
          <h6 class="fw-bold mb-3">${editing ? 'Edit entry #' + int(editing.id) : (isExpense ? 'Add expense' : 'Add income')}</h6>
          <form method="POST">
            ${ctx.csrfField()}
            <input type="hidden" name="action" value="save">
            ${editing ? html`<input type="hidden" name="id" value="${int(editing.id)}">` : ''}
            <div class="mb-2"><label class="form-label small">Date *</label>
              <input type="date" name="${dateKey}" class="form-control" required value="${fv(dateKey, ctx.today)}"></div>
            ${isExpense ? html`
            <div class="mb-2"><label class="form-label small">Category *</label>
              <select name="category_id" class="form-select" required>
                <option value="">Choose…</option>
                ${categories.filter((c) => c.is_active || formCat === c.id).map((c) => html`
                  <option value="${c.id}" ${sel(formCat === c.id)}>${c.category_name}${c.is_active ? '' : ' (inactive)'}</option>`)}
              </select></div>` : html`
            <div class="mb-2"><label class="form-label small">Source *</label>
              <input type="text" name="source" maxlength="120" class="form-control" required value="${fv('source')}" placeholder="e.g. Scrap sale, Rent received"></div>`}
            <div class="mb-2"><label class="form-label small">Amount (₹) *</label>
              <input type="number" name="amount" step="0.01" min="0.01" class="form-control" required value="${fv('amount')}"></div>
            <div class="mb-2"><label class="form-label small">Payment mode</label>
              <select name="payment_mode" class="form-select">
                <option value="">—</option>
                ${modes.map((m) => html`<option ${sel(String(form.payment_mode ?? '') === m)}>${m}</option>`)}
              </select></div>
            ${isExpense ? html`
            <div class="mb-2"><label class="form-label small">Vendor / paid to</label>
              <input type="text" name="vendor" maxlength="120" class="form-control" value="${fv('vendor')}"></div>` : ''}
            <div class="mb-2"><label class="form-label small">Description</label>
              <input type="text" name="description" maxlength="255" class="form-control" value="${fv('description')}"></div>
            <div class="mb-3"><label class="form-label small">Remarks</label>
              <input type="text" name="remarks" maxlength="255" class="form-control" value="${fv('remarks')}"></div>
            <button class="btn btn-primary w-100" type="submit"><i class="fa-solid fa-check me-1"></i>${editing ? 'Save changes' : 'Add'}</button>
            ${editing ? html`<a href="${u(selfPath)}" class="btn btn-outline-secondary w-100 mt-2">Cancel edit</a>` : ''}
            <p class="text-muted small mt-2 mb-0">Entries can be edited but not deleted; every edit is recorded in the Audit Log.</p>
          </form>
        </div>
      </div>
      ${isExpense ? html`
      <div class="card" id="categories">
        <div class="card-body">
          <h6 class="fw-bold mb-3">Categories</h6>
          <form method="POST" class="d-flex gap-2 mb-3">
            ${ctx.csrfField()}<input type="hidden" name="action" value="category">
            <input type="text" name="category_name" maxlength="100" class="form-control form-control-sm" placeholder="New category" required>
            <button class="btn btn-sm btn-outline-primary" type="submit">Add</button>
          </form>
          ${categories.map((c) => html`
            <form method="POST" class="d-flex gap-2 align-items-center mb-2">
              ${ctx.csrfField()}<input type="hidden" name="action" value="category"><input type="hidden" name="category_id" value="${c.id}">
              <input type="text" name="category_name" maxlength="100" class="form-control form-control-sm" value="${c.category_name}">
              <button class="btn btn-sm btn-outline-secondary" type="submit" title="Rename">Save</button>
              <button class="btn btn-sm ${c.is_active ? 'btn-outline-danger' : 'btn-outline-success'}" type="submit" name="set_active" value="${c.is_active ? '0' : '1'}">${c.is_active ? 'Deactivate' : 'Activate'}</button>
            </form>`)}
        </div>
      </div>` : ''}
    </div>
    <div class="col-lg-8">
      <div class="card mb-3">
        <div class="card-body">
          <form class="row g-2 align-items-end" method="GET">
            <div class="col-6 col-md-3"><label class="form-label small">From</label><input type="date" name="from" class="form-control form-control-sm" value="${data.from}"></div>
            <div class="col-6 col-md-3"><label class="form-label small">To</label><input type="date" name="to" class="form-control form-control-sm" value="${data.to}"></div>
            ${isExpense ? html`
            <div class="col-6 col-md-3"><label class="form-label small">Category</label>
              <select name="category_id" class="form-select form-select-sm"><option value="">All</option>
                ${categories.map((c) => html`<option value="${c.id}" ${sel(int(filters.category_id) === c.id)}>${c.category_name}</option>`)}
              </select></div>` : ''}
            <div class="col-6 col-md-3"><label class="form-label small">Search</label><input type="text" name="q" class="form-control form-control-sm" value="${String(filters.q)}"></div>
            <div class="col-12"><button class="btn btn-sm btn-primary">Filter</button></div>
          </form>
          <div class="d-flex flex-wrap gap-3 mt-3">
            <div class="p-3 rounded bg-light"><div class="small text-muted">${isExpense ? 'Total expenses' : 'Total income'}</div><div class="fs-5 fw-bold">${raw(money(data.total_amount))}</div><div class="small text-muted">${data.total_count} entries</div></div>
            ${data.by_group.map((g) => html`
              <div class="p-3 rounded border"><div class="small text-muted">${g.label}</div><div class="fw-semibold">${raw(money(g.total))}</div></div>`)}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <div class="table-responsive udc-cards-wrap">
            <table class="udc-cards table table-sm table-hover align-middle">
              <thead><tr><th>Date</th><th>${isExpense ? 'Category' : 'Source'}</th><th>Description</th>${isExpense ? html`<th>Vendor</th>` : ''}<th>Mode</th><th class="text-end">Amount</th><th>By</th><th></th></tr></thead>
              <tbody>
              ${data.entries.length === 0 ? html`<tr><td colspan="8" class="text-center text-muted py-4">No entries in this range.</td></tr>` : ''}
              ${data.entries.map((r) => html`
                <tr>
                  <td data-label="Date">${r.entry_date}</td>
                  <td data-label="${isExpense ? 'Category' : 'Source'}">${isExpense ? r.category_name : r.source}</td>
                  <td data-label="Description">${String(r.description ?? '')}${!phpEmpty(r.remarks) ? html`<div class="small text-muted">${r.remarks}</div>` : ''}</td>
                  ${isExpense ? html`<td data-label="Vendor">${String(r.vendor ?? '')}</td>` : ''}
                  <td data-label="Mode">${String(r.payment_mode ?? '')}</td>
                  <td class="text-end fw-semibold" data-label="Amount">${raw(money(r.amount))}</td>
                  <td class="small" data-label="By">${String(r.created_by_name ?? '')}</td>
                  <td data-label=""><a class="btn btn-sm btn-outline-primary" href="${u(selfPath + '?' + qs({ edit: r.id, page: data.page }))}"><i class="fa-solid fa-pen"></i></a></td>
                </tr>`)}
              </tbody>
            </table>
          </div>
          ${totalPages > 1 ? html`
          <nav><ul class="pagination pagination-sm">
            ${Array.from({ length: totalPages }, (_, k) => k + 1).map((i) => html`
              <li class="page-item ${i === data.page ? 'active' : ''}"><a class="page-link" href="?${qs({ page: i })}">${i}</a></li>`)}
          </ul></nav>` : ''}
        </div>
      </div>
    </div>
  </div>
</div>
`);
    });
  };
  for (const t of EXPENSE_TYPES) entries(t);

  // ---- Wallet adjustment -----------------------------------------------------------------------
  webPage(app, '/modules/accounts/wallet-adjustment', { auth: 'payments.adjust' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const post = req.method === 'POST' ? body(ctx) : null;
    const errors: string[] = [];
    let success: string | null = null;
    const customerId = int(q.customer_id ?? post?.customer_id ?? 0);
    const customer = customerId ? (await db.query<Row>('SELECT id, customer_code, full_name, mobile FROM customers WHERE id = ?', [customerId]))[0] ?? null : null;
    const money = await ctx.loadMoney();

    if (post) {
      if (!ctx.csrfValid()) return csrfFail();
      const delta = flt(post.delta);
      const reason = clean(post.reason);
      if (!customer) errors.push('Select a valid customer first.');
      if (delta === 0) errors.push('Adjustment amount must not be zero.');
      if (reason.trim() === '') errors.push('A reason is required for a manual wallet adjustment.');
      if (errors.length === 0) {
        try {
          const result = await wallet.adjust(Number(customer!.id), delta, reason, { actor: ctx.data.user_id!, ip: req.ip });
          success = 'Wallet adjusted. New balance: ' + money(result.balance);
          if (customer!.mobile) {
            try {
              await whatsapp.enqueue(Number(customer!.id), null, String(customer!.mobile), delta > 0 ? 'wallet_credit' : 'wallet_debit',
                { customer_name: customer!.full_name, wallet_balance: money(result.balance), business_name: (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? ctx.svc.env.APP_NAME },
                `wallet_adjust:${customer!.id}:${Math.floor(Date.now() / 1000)}`);
            } catch (ex) { console.error('WhatsApp wallet_adjust enqueue failed:', (ex as Error).message); }
          }
        } catch (ex) { errors.push('Could not adjust wallet: ' + (ex as Error).message); }
      }
    }
    const walletBalance = customer ? await wallet.getBalance(Number(customer.id)) : null;
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Wallet Adjustment' }, html`
<div class="col-md-6">
  <div class="card">
    <div class="card-body">
      <div class="mb-3 position-relative">
        <label class="form-label small">Customer (search by name / mobile / code)</label>
        <input type="text" id="customerSearch" class="form-control" placeholder="Type to search..." value="${customer ? customer.full_name + ' (' + customer.customer_code + ')' : ''}">
        <div id="customerResults" class="d-none" style="position:absolute;z-index:1050;background:#fff;border:1px solid #dee2e6;border-radius:8px;width:100%;max-height:220px;overflow-y:auto;box-shadow:0 6px 20px rgba(0,0,0,.1);"></div>
      </div>

      ${customer ? html`
        <p class="text-muted">Current wallet balance: <strong>${raw(money(walletBalance))}</strong></p>` : ''}

      ${success ? html`<div class="alert alert-success">${success}</div>` : ''}
      ${errors.length ? html`<div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html`<li>${er}</li>`)}</ul></div>` : ''}

      <form method="POST">
        ${ctx.csrfField()}
        <input type="hidden" name="customer_id" id="customerIdInput" value="${customer ? String(customer.id) : ''}">
        <div class="mb-3">
          <label class="form-label">Adjustment Amount * (positive to credit, negative to debit)</label>
          <input type="number" name="delta" class="form-control" step="0.01" required>
        </div>
        <div class="mb-3">
          <label class="form-label">Reason *</label>
          <textarea name="reason" class="form-control" rows="2" required></textarea>
        </div>
        <button class="btn btn-primary" type="submit" ${customer ? '' : 'disabled'}><i class="fa-solid fa-check me-1"></i>Apply Adjustment</button>
      </form>
    </div>
  </div>
</div>
${raw(walletAdjustScript(u, (v) => JSON.stringify(v), (v) => String(v)))}
`);
  });

  // ---- Daily collection ------------------------------------------------------------------------
  webPage(app, '/modules/accounts/daily-collection', { auth: 'payments.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    let date = clean(q.date ?? ctx.today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = ctx.today;
    const methodFilter = int(q.payment_type_id), staffFilter = int(q.staff_id), orderSearch = clean(q.order), customerSearch = clean(q.customer);
    let fw = 'DATE(p.payment_date) = ?';
    const fp: unknown[] = [date];
    if (methodFilter) { fw += ' AND ptx.payment_type_id = ?'; fp.push(methodFilter); }
    if (staffFilter) { fw += ' AND p.created_by = ?'; fp.push(staffFilter); }
    if (orderSearch !== '') { fw += ' AND o.order_number LIKE ?'; fp.push(`%${orderSearch}%`); }
    if (customerSearch !== '') { fw += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; fp.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    const byType = (refund: boolean) => db.query<Row>(
      `SELECT pt.type_name, COALESCE(SUM(ptx.amount),0) AS total FROM payment_transactions ptx
       JOIN payments p ON p.id = ptx.payment_id JOIN payment_types pt ON pt.id = ptx.payment_type_id JOIN customers c ON c.id = p.customer_id LEFT JOIN orders o ON o.id = p.order_id
       WHERE ${fw} AND p.payment_kind ${refund ? '=' : '!='} 'Refund' GROUP BY pt.id ORDER BY pt.sort_order`, fp);
    const collections = await byType(false), refunds = await byType(true);
    const sum = (rows: Row[]) => phpRound(rows.reduce((a, r) => a + flt(r.total), 0), 2);
    const totalCollections = sum(collections), totalRefunds = sum(refunds);
    const netCollection = phpRound(totalCollections - totalRefunds, 2);
    const advanceReceived = phpRound(flt((await db.query<Row>("SELECT COALESCE(SUM(credit),0) AS s FROM wallet_transactions WHERE DATE(created_at) = ? AND txn_type = 'Deposit'", [date]))[0]!.s), 2);
    const oc = (await db.query<Row>(
      `SELECT SUM(due_amount <= 0.01) AS paid_count, SUM(due_amount > 0.01 AND paid_amount > 0.01) AS partial_count,
       SUM(due_amount > 0.01 AND paid_amount <= 0.01) AS unpaid_count, COALESCE(SUM(due_amount), 0) AS total_outstanding FROM accounts_receivable WHERE status = 'Open'`))[0]!;
    const paymentTypes = await db.query<Row>('SELECT id, type_name FROM payment_types ORDER BY sort_order');
    const staff = await db.query<Row>('SELECT DISTINCT u.id, u.full_name FROM payments p JOIN users u ON u.id = p.created_by ORDER BY u.full_name');
    const details = await db.query<Row>(
      `SELECT p.payment_number, p.payment_date, p.payment_kind, p.total_amount, c.full_name, c.mobile, o.order_number, u.full_name AS created_by_name,
       GROUP_CONCAT(CONCAT(pt.type_name, ': ', ptx.amount) SEPARATOR ', ') AS breakdown
       FROM payments p JOIN customers c ON c.id = p.customer_id LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.created_by
       JOIN payment_transactions ptx ON ptx.payment_id = p.id JOIN payment_types pt ON pt.id = ptx.payment_type_id
       WHERE ${fw} GROUP BY p.id ORDER BY p.payment_date DESC`, fp);

    if ('export' in q && ctx.can('payments.export')) {
      let out = fputcsv(['Receipt #', 'Date/Time', 'Kind', 'Order #', 'Customer', 'Mobile', 'Method(s)', 'Amount', 'User']);
      for (const d of details) out += fputcsv([d.payment_number, d.payment_date, d.payment_kind, d.order_number, d.full_name, d.mobile, d.breakdown, d.total_amount, d.created_by_name]);
      return new WebText(out, 200, 'text/csv', { 'Content-Disposition': `attachment; filename="daily-collection-${date}.csv"` });
    }
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    const exportQs = httpBuildQuery({ ...(q as Record<string, unknown>), export: 1 });
    const stat = (bg: string, value: string, label: Raw | string) => html`
        <div class="col-md-3">
          <div class="stat-card" style="background:${bg};"><div class="stat-value">${raw(value)}</div><div class="stat-label">${label}</div></div>
        </div>`;
    return layout(ctx, { title: 'Daily Collection' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      <div class="d-flex flex-wrap justify-content-between align-items-center mb-3 gap-2">
        <form class="row g-2" method="GET">
          <div class="col-auto"><input type="date" name="date" class="form-control form-control-sm" value="${date}"></div>
          <div class="col-auto">
            <select name="payment_type_id" class="form-select form-select-sm">
              <option value="0">All Methods</option>
              ${paymentTypes.map((pt) => html`<option value="${pt.id}" ${sel(methodFilter === Number(pt.id))}>${pt.type_name}</option>`)}
            </select>
          </div>
          <div class="col-auto">
            <select name="staff_id" class="form-select form-select-sm">
              <option value="0">All Staff</option>
              ${staff.map((s) => html`<option value="${s.id}" ${sel(staffFilter === Number(s.id))}>${s.full_name}</option>`)}
            </select>
          </div>
          <div class="col-auto"><input type="text" name="order" class="form-control form-control-sm" value="${orderSearch}" placeholder="Order #"></div>
          <div class="col-auto"><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}" placeholder="Customer/Mobile"></div>
          <div class="col-auto"><button class="btn btn-outline-primary btn-sm">Filter</button></div>
        </form>
        ${ctx.can('payments.export') ? html`
          <a href="?${raw(exportQs)}" class="btn btn-outline-secondary btn-sm"><i class="fa-solid fa-download me-1"></i>Export CSV</a>` : ''}
      </div>

      <div class="row g-3 mb-3">
        ${stat('#198754', money(totalCollections), 'Collections (filtered)')}
        ${stat('#dc3545', money(totalRefunds), 'Refunds')}
        ${stat('#0b3d91', money(netCollection), 'Net Collection')}
        ${stat('#6610f2', money(advanceReceived), 'Advance/Wallet Deposits Today')}
      </div>

      <div class="row g-3 mb-3">
        ${stat('#20c997', String(int(oc.paid_count)), 'Fully Paid Orders')}
        ${stat('#ffc107', String(int(oc.partial_count)), 'Partially Paid Orders')}
        ${stat('#fd7e14', String(int(oc.unpaid_count)), 'Unpaid Orders')}
        ${stat('#6c757d', money(oc.total_outstanding ?? 0), html`Total Outstanding <a href="${u('modules/accounts/outstanding.php')}" class="text-white">(view)</a>`)}
      </div>

      <div class="row g-3 mb-3">
        <div class="col-md-6">
          <h6 class="fw-bold">Collections by Method</h6>
          <table class="table table-sm">
            ${collections.length === 0 ? html`<tr><td class="text-muted">No collections recorded for this date.</td></tr>` : ''}
            ${collections.map((c) => html`
              <tr><td>${c.type_name}</td><td class="text-end">${raw(money(c.total))}</td></tr>`)}
          </table>
        </div>
        <div class="col-md-6">
          <h6 class="fw-bold">Refunds by Method</h6>
          <table class="table table-sm">
            ${refunds.length === 0 ? html`<tr><td class="text-muted">No refunds recorded for this date.</td></tr>` : ''}
            ${refunds.map((r) => html`
              <tr><td>${r.type_name}</td><td class="text-end text-danger">${raw(money(r.total))}</td></tr>`)}
          </table>
        </div>
      </div>

      <h6 class="fw-bold">Transaction Detail</h6>
      <div class="table-responsive udc-cards-wrap">
        <table class="udc-cards table table-sm">
          <thead><tr><th>Receipt #</th><th>Time</th><th>Order #</th><th>Customer</th><th>Method(s)</th><th>User</th><th class="text-end">Amount</th></tr></thead>
          <tbody>
          ${details.length === 0 ? html`<tr><td colspan="7" class="text-center text-muted py-3">No transactions for this date.</td></tr>` : ''}
          ${details.map((d) => html`
            <tr>
              <td data-label="Receipt #">${d.payment_number}</td>
              <td data-label="Time">${raw(ctx.date(d.payment_date, 'h:i A'))}</td>
              <td data-label="Order #">${String(d.order_number ?? '')}</td>
              <td data-label="Customer">${d.full_name}</td>
              <td class="small" data-label="Method(s)">${d.breakdown}</td>
              <td data-label="User">${String(d.created_by_name ?? '')}</td>
              <td class="text-end ${d.payment_kind === 'Refund' ? 'text-danger' : ''}" data-label="Amount">${d.payment_kind === 'Refund' ? '- ' : ''}${raw(money(d.total_amount))}</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>
`);
  });

  // ---- Receivables / outstanding ---------------------------------------------------------------
  webPage(app, '/modules/accounts/outstanding', { auth: 'accounts.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const customerSearch = clean(q.customer), orderSearch = clean(q.order), dueDate = clean(q.due_date), ageingBucket = clean(q.ageing), minAmount = clean(q.min_amount);
    let where = "ar.status = 'Open' AND ar.due_amount > 0.01";
    const params: unknown[] = [];
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    if (orderSearch !== '') { where += ' AND o.order_number LIKE ?'; params.push(`%${orderSearch}%`); }
    if (dueDate !== '') { where += ' AND ar.due_date = ?'; params.push(dueDate); }
    if (minAmount !== '' && isNumeric(minAmount)) { where += ' AND ar.due_amount >= ?'; params.push(flt(minAmount)); }
    const ageingCase = `
  CASE
    WHEN DATEDIFF(CURDATE(), ar.due_date) <= 0 THEN 'Current'
    WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 1 AND 7 THEN '1-7 days'
    WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 8 AND 30 THEN '8-30 days'
    WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 31 AND 60 THEN '31-60 days'
    WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 61 AND 90 THEN '61-90 days'
    ELSE '90+ days'
  END`;
    if (ageingBucket !== '') { where += ` AND (${ageingCase}) = ?`; params.push(ageingBucket); }
    const rows = await db.query<Row>(
      `SELECT ar.order_id, ar.total_amount, ar.paid_amount, ar.due_amount, ar.due_date, c.full_name AS customer_name, c.mobile, o.order_number, o.order_date,
       ${ageingCase} AS ageing_bucket,
       (SELECT MAX(p.payment_date) FROM payments p WHERE p.order_id = ar.order_id AND p.payment_kind != 'Refund') AS last_payment_date
       FROM accounts_receivable ar JOIN orders o ON o.id = ar.order_id JOIN customers c ON c.id = ar.customer_id WHERE ${where} ORDER BY ar.due_date`, params);
    const bucketTotals: Record<string, number> = { Current: 0, '1-7 days': 0, '8-30 days': 0, '31-60 days': 0, '61-90 days': 0, '90+ days': 0 };
    let grand = 0;
    const byCust = new Map<string, { name: string; mobile: string; orders: number; total_due: number }>();
    for (const r of rows) {
      bucketTotals[r.ageing_bucket] = (bucketTotals[r.ageing_bucket] ?? 0) + flt(r.due_amount);
      grand += flt(r.due_amount);
      const key = `${r.customer_name}|${r.mobile}`;
      const c = byCust.get(key) ?? byCust.set(key, { name: r.customer_name, mobile: r.mobile, orders: 0, total_due: 0 }).get(key)!;
      c.orders++; c.total_due += flt(r.due_amount);
    }
    const customers = [...byCust.values()].sort((a, b) => b.total_due - a.total_due);

    if ('export' in q && ctx.can('payments.export')) {
      return new WebText(csvBody(['Order #', 'Order Date', 'Customer', 'Mobile', 'Grand Total', 'Paid', 'Due', 'Due Date', 'Ageing', 'Last Payment'],
        rows.map((r) => [r.order_number, r.order_date, r.customer_name, r.mobile, r.total_amount, r.paid_amount, r.due_amount, r.due_date, r.ageing_bucket, orDash(r.last_payment_date)])),
        200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="urban_dry_clean_receivables_${ctx.today}.csv"` });
    }
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    const exportQs = httpBuildQuery({ ...(q as Record<string, unknown>), export: 1 });
    return layout(ctx, { title: 'Receivables / Outstanding' }, html`
<div class="col-12">
  <div class="card mb-3">
    <div class="card-body">
      <div class="row g-2 mb-3">
        ${Object.entries(bucketTotals).map(([bucket, amt]) => html`
          <div class="col-md-2">
            <a href="?ageing=${urlencode(bucket)}" class="text-decoration-none">
              <div class="stat-card" style="background:${bucket === 'Current' ? '#20c997' : (bucket === '90+ days' ? '#dc3545' : '#fd7e14')};">
                <div class="stat-value" style="font-size:16px;">${raw(money(amt))}</div>
                <div class="stat-label">${bucket}</div>
              </div>
            </a>
          </div>`)}
      </div>
      <p class="fw-bold">Total Outstanding: ${raw(money(grand))} across ${rows.length} order(s)</p>

      <form class="row g-2 mb-3" method="GET">
        <div class="col-md-2"><input type="text" name="customer" class="form-control form-control-sm" value="${customerSearch}" placeholder="Customer/Mobile"></div>
        <div class="col-md-2"><input type="text" name="order" class="form-control form-control-sm" value="${orderSearch}" placeholder="Order Number"></div>
        <div class="col-md-2"><input type="date" name="due_date" class="form-control form-control-sm" value="${dueDate}"></div>
        <div class="col-md-2"><input type="number" name="min_amount" class="form-control form-control-sm" value="${minAmount}" placeholder="Min Amount"></div>
        <div class="col-md-2">
          <select name="ageing" class="form-select form-select-sm">
            <option value="">All Ageing</option>
            ${Object.keys(bucketTotals).map((b) => html`<option value="${b}" ${sel(ageingBucket === b)}>${b}</option>`)}
          </select>
        </div>
        <div class="col-md-2">
          <button class="btn btn-outline-primary btn-sm">Filter</button>
          ${ctx.can('payments.export') ? html`<a href="?${raw(exportQs)}" class="btn btn-outline-secondary btn-sm">Export</a>` : ''}
        </div>
      </form>

      <table class="udc-cards table table-sm">
        <thead><tr><th>Order</th><th>Order Date</th><th>Customer</th><th>Mobile</th><th class="text-end">Grand Total</th><th class="text-end">Paid</th><th class="text-end">Due</th><th>Due Date</th><th>Ageing</th><th>Last Payment</th></tr></thead>
        <tbody>
        ${rows.length === 0 ? html`<tr><td colspan="10" class="text-center text-muted py-4">No outstanding balances found.</td></tr>` : ''}
        ${rows.map((r) => html`
          <tr>
            <td data-label="Order"><a href="${u('modules/orders/view.php?id=' + r.order_id)}">${r.order_number}</a></td>
            <td data-label="Order Date">${raw(ctx.date(r.order_date))}</td>
            <td data-label="Customer">${r.customer_name}</td>
            <td data-label="Mobile">${r.mobile}</td>
            <td class="text-end" data-label="Grand Total">${raw(money(r.total_amount))}</td>
            <td class="text-end" data-label="Paid">${raw(money(r.paid_amount))}</td>
            <td class="text-end fw-bold text-danger" data-label="Due">${raw(money(r.due_amount))}</td>
            <td data-label="Due Date">${raw(ctx.date(r.due_date))}</td>
            <td data-label="Ageing"><span class="badge bg-${r.ageing_bucket === 'Current' ? 'success' : (r.ageing_bucket === '90+ days' ? 'danger' : 'warning text-dark')}">${r.ageing_bucket}</span></td>
            <td data-label="Last Payment">${r.last_payment_date ? raw(ctx.date(r.last_payment_date)) : '—'}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold">Outstanding by Customer</h6>
      <table class="udc-cards table table-sm">
        <thead><tr><th>Customer</th><th>Mobile</th><th class="text-end">Orders Outstanding</th><th class="text-end">Total Due</th></tr></thead>
        <tbody>
        ${customers.length === 0 ? html`<tr><td colspan="4" class="text-center text-muted py-3">No outstanding customers.</td></tr>` : ''}
        ${customers.map((c) => html`
          <tr>
            <td data-label="Customer">${c.name}</td>
            <td data-label="Mobile">${c.mobile}</td>
            <td class="text-end" data-label="Orders Outstanding">${c.orders}</td>
            <td class="text-end fw-bold" data-label="Total Due">${raw(money(c.total_due))}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>
</div>
`);
  });
}
