import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { WebText, forbiddenPage, webPage, type WebCtx } from '../context.js';
import { flt, httpBuildQuery, int, numberFormat } from '../format.js';
import { e, html, jsonEncode, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const sel = (c: boolean) => (c ? 'selected' : '');
const rawurlencode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function pager(query: Record<string, unknown>, page: number, totalPages: number): Raw | string {
  if (totalPages <= 1) return '';
  const qs: Record<string, unknown> = { ...query };
  delete qs.page;
  const items: Raw[] = [];
  for (let i = 1; i <= totalPages; i++) {
    qs.page = i;
    items.push(html`
        <li class="page-item ${i === page ? 'active' : ''}"><a class="page-link" href="?${raw(httpBuildQuery(qs))}">${i}</a></li>`);
  }
  return html`
    <nav><ul class="pagination">
      ${items}
    </ul></nav>`;
}

export function registerPaymentPages(app: FastifyInstance) {
  const { db, orders } = app.services;

  // ---- Payments list -----------------------------------------------------------------------------
  webPage(app, '/modules/payments/list', { auth: 'public' }, async (ctx, req) => {
    if (!ctx.can('payments.view') && !ctx.can('payments.collect')) return new WebText('You do not have permission to view payments.', 403);
    const q = req.query as Record<string, unknown>;
    const dateFrom = clean(q.date_from), dateTo = clean(q.date_to), paymentTypeId = int(q.payment_type_id), search = clean(q.q);
    const page = Math.max(1, int(q.page) || 1), perPage = 30;
    const where = ['1=1'];
    const params: unknown[] = [];
    if (dateFrom !== '') { where.push('p.payment_date >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo !== '') { where.push('p.payment_date <= ?'); params.push(`${dateTo} 23:59:59`); }
    if (search !== '') {
      where.push('(o.order_number LIKE ? OR c.full_name LIKE ? OR pt.reference_no LIKE ? OR p.payment_number LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (paymentTypeId) { where.push('EXISTS (SELECT 1 FROM payment_transactions ptf WHERE ptf.payment_id = p.id AND ptf.payment_type_id = ?)'); params.push(paymentTypeId); }
    const whereSql = where.join(' AND ');
    const total = int((await db.query<Row>(
      `SELECT COUNT(DISTINCT p.id) AS n FROM payments p LEFT JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = p.customer_id LEFT JOIN payment_transactions pt ON pt.payment_id = p.id WHERE ${whereSql}`, params))[0]!.n);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const offset = (page - 1) * perPage;
    const payments = await db.query<Row>(
      `SELECT DISTINCT p.id, p.payment_number, p.order_id, o.order_number, c.full_name AS customer_name,
       p.payment_date, p.total_amount, p.payment_kind, p.remarks, u.full_name AS created_by_name
       FROM payments p LEFT JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = p.customer_id
       LEFT JOIN payment_transactions pt ON pt.payment_id = p.id LEFT JOIN users u ON u.id = p.created_by
       WHERE ${whereSql} ORDER BY p.payment_date DESC, p.id DESC LIMIT ${perPage} OFFSET ${offset}`, params);
    const lines = new Map<number, Row[]>();
    if (payments.length) {
      const ids = payments.map((p) => Number(p.id));
      const ls = await db.query<Row>(
        `SELECT pt.payment_id, pty.type_name, pt.amount, pt.reference_no FROM payment_transactions pt JOIN payment_types pty ON pty.id = pt.payment_type_id
         WHERE pt.payment_id IN (${ids.map(() => '?').join(',')}) ORDER BY pt.id`, ids);
      for (const l of ls) (lines.get(Number(l.payment_id)) ?? lines.set(Number(l.payment_id), []).get(Number(l.payment_id))!).push(l);
    }
    const paymentTypes = await db.query<Row>('SELECT id, type_name FROM payment_types WHERE is_active=1 ORDER BY sort_order');
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Payments' }, html`
<h4 class="mb-3">Payments</h4>

<div class="card mb-3">
  <div class="card-body">
    <form method="GET" class="row g-2 align-items-end">
      <div class="col-md-3">
        <label class="form-label small">Search (order / customer / reference)</label>
        <input type="text" name="q" class="form-control form-control-sm" value="${search}">
      </div>
      <div class="col-md-2">
        <label class="form-label small">From</label>
        <input type="date" name="date_from" class="form-control form-control-sm" value="${dateFrom}">
      </div>
      <div class="col-md-2">
        <label class="form-label small">To</label>
        <input type="date" name="date_to" class="form-control form-control-sm" value="${dateTo}">
      </div>
      <div class="col-md-3">
        <label class="form-label small">Payment Method</label>
        <select name="payment_type_id" class="form-select form-select-sm">
          <option value="">All</option>
          ${paymentTypes.map((pt) => html`
            <option value="${pt.id}" ${sel(paymentTypeId === Number(pt.id))}>${pt.type_name}</option>`)}
        </select>
      </div>
      <div class="col-md-2">
        <button type="submit" class="btn btn-primary btn-sm w-100"><i class="fa-solid fa-filter me-1"></i>Filter</button>
      </div>
    </form>
  </div>
</div>

<div class="card">
  <div class="card-body">
    <div class="table-responsive udc-cards-wrap">
      <table class="udc-cards table table-hover table-sm">
        <thead><tr><th>Payment #</th><th>Order</th><th>Customer</th><th>Date</th><th>Kind</th><th>Method(s)</th><th class="text-end">Amount</th><th>Created By</th></tr></thead>
        <tbody>
        ${payments.length === 0 ? html`<tr><td colspan="8" class="text-center text-muted py-4">No payments found.</td></tr>` : ''}
        ${payments.map((p) => html`
          <tr>
            <td data-label="Payment #">${p.payment_number}</td>
            <td data-label="Order">${p.order_id ? html`<a href="${u('modules/orders/view.php?id=' + p.order_id)}">${p.order_number}</a>` : raw('<span class="text-muted">—</span>')}</td>
            <td data-label="Customer">${p.customer_name}</td>
            <td data-label="Date">${raw(ctx.datetime(p.payment_date))}</td>
            <td data-label="Kind"><span class="badge bg-${p.payment_kind === 'Refund' ? 'danger' : 'secondary'}">${p.payment_kind}</span></td>
            <td class="small" data-label="Method(s)">
              ${(lines.get(Number(p.id)) ?? []).map((l) => html`
                <div>${l.type_name}: ${raw(money(l.amount))}${l.reference_no ? ' (' + l.reference_no + ')' : ''}</div>`)}
            </td>
            <td class="text-end fw-bold" data-label="Amount">${raw(money(p.total_amount))}</td>
            <td data-label="Created By">${p.created_by_name === null || p.created_by_name === '' ? '—' : String(p.created_by_name)}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>
    ${pager(q, page, totalPages)}
  </div>
</div>
`);
  });

  // ---- Wallet history ----------------------------------------------------------------------------
  webPage(app, '/modules/payments/wallet', { auth: 'wallet.manage' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const search = clean(q.q), txnType = clean(q.txn_type), dateFrom = clean(q.date_from), dateTo = clean(q.date_to);
    const page = Math.max(1, int(q.page) || 1), perPage = 30;
    const where = ['1=1'];
    const params: unknown[] = [];
    if (search !== '') { where.push('(c.full_name LIKE ? OR c.mobile LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (txnType !== '') { where.push('wt.txn_type = ?'); params.push(txnType); }
    if (dateFrom !== '') { where.push('wt.created_at >= ?'); params.push(`${dateFrom} 00:00:00`); }
    if (dateTo !== '') { where.push('wt.created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const whereSql = where.join(' AND ');
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n FROM wallet_transactions wt JOIN customers c ON c.id = wt.customer_id WHERE ${whereSql}`, params))[0]!.n);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const offset = (page - 1) * perPage;
    const txns = await db.query<Row>(
      `SELECT wt.id, wt.customer_id, c.full_name AS customer_name, c.mobile, wt.order_id, o.order_number,
       wt.txn_type, wt.debit, wt.credit, wt.balance_after, wt.remarks, wt.payment_mode, wt.created_at, u.full_name AS created_by_name
       FROM wallet_transactions wt JOIN customers c ON c.id = wt.customer_id LEFT JOIN orders o ON o.id = wt.order_id LEFT JOIN users u ON u.id = wt.created_by
       WHERE ${whereSql} ORDER BY wt.created_at DESC, wt.id DESC LIMIT ${perPage} OFFSET ${offset}`, params);
    const sums = (await db.query<Row>(`SELECT COALESCE(SUM(debit),0) AS total_debit, COALESCE(SUM(credit),0) AS total_credit FROM wallet_transactions wt JOIN customers c ON c.id = wt.customer_id WHERE ${whereSql}`, params))[0]!;
    const money = await ctx.loadMoney();
    const u = (p: string) => ctx.baseUrl(p);
    return layout(ctx, { title: 'Customer Wallet' }, html`
<h4 class="mb-3">Customer Wallet — Transaction History</h4>

<div class="row g-3 mb-3">
  <div class="col-md-4"><div class="stat-card" style="background:#20c997;"><div class="stat-value">${raw(money(sums.total_credit))}</div><div class="stat-label">Total Credits (filtered)</div></div></div>
  <div class="col-md-4"><div class="stat-card" style="background:#dc3545;"><div class="stat-value">${raw(money(sums.total_debit))}</div><div class="stat-label">Total Debits (filtered)</div></div></div>
  <div class="col-md-4"><div class="stat-card" style="background:#0b3d91;"><div class="stat-value">${total}</div><div class="stat-label">Transactions (filtered)</div></div></div>
</div>

<div class="card mb-3">
  <div class="card-body">
    <form method="GET" class="row g-2 align-items-end">
      <div class="col-md-3">
        <label class="form-label small">Customer (name / mobile)</label>
        <input type="text" name="q" class="form-control form-control-sm" value="${search}">
      </div>
      <div class="col-md-2">
        <label class="form-label small">Type</label>
        <select name="txn_type" class="form-select form-select-sm">
          <option value="">All</option>
          ${['Deposit', 'Redeem', 'Refund', 'Adjustment'].map((t) => html`
            <option value="${t}" ${sel(txnType === t)}>${t}</option>`)}
        </select>
      </div>
      <div class="col-md-2">
        <label class="form-label small">From</label>
        <input type="date" name="date_from" class="form-control form-control-sm" value="${dateFrom}">
      </div>
      <div class="col-md-2">
        <label class="form-label small">To</label>
        <input type="date" name="date_to" class="form-control form-control-sm" value="${dateTo}">
      </div>
      <div class="col-md-3 d-flex gap-2">
        <button type="submit" class="btn btn-primary btn-sm w-100"><i class="fa-solid fa-filter me-1"></i>Filter</button>
        ${ctx.can('payments.adjust') ? html`
          <a href="${u('modules/accounts/wallet-adjustment.php')}" class="btn btn-outline-secondary btn-sm text-nowrap"><i class="fa-solid fa-plus me-1"></i>Adjust</a>` : ''}
      </div>
    </form>
  </div>
</div>

<div class="card">
  <div class="card-body">
    <div class="table-responsive udc-cards-wrap">
      <table class="udc-cards table table-hover table-sm">
        <thead><tr><th>Date</th><th>Customer</th><th>Type</th><th class="text-end">Debit</th><th class="text-end">Credit</th><th class="text-end">Balance After</th><th>Order</th><th>Remarks</th><th>By</th></tr></thead>
        <tbody>
        ${txns.length === 0 ? html`<tr><td colspan="9" class="text-center text-muted py-4">No wallet transactions found.</td></tr>` : ''}
        ${txns.map((t) => html`
          <tr>
            <td data-label="Date">${raw(ctx.datetime(t.created_at))}</td>
            <td data-label="Customer"><a href="${u('modules/customers/view.php?id=' + t.customer_id)}">${t.customer_name}</a><div class="text-muted small">${String(t.mobile ?? '')}</div></td>
            <td data-label="Type"><span class="badge bg-${t.txn_type === 'Redeem' ? 'danger' : (t.txn_type === 'Adjustment' ? 'warning text-dark' : 'success')}">${t.txn_type}</span></td>
            <td class="text-end" data-label="Debit">${flt(t.debit) > 0 ? raw(money(t.debit)) : '—'}</td>
            <td class="text-end" data-label="Credit">${flt(t.credit) > 0 ? raw(money(t.credit)) : '—'}</td>
            <td class="text-end fw-bold" data-label="Balance After">${raw(money(t.balance_after))}</td>
            <td data-label="Order">${t.order_id ? html`<a href="${u('modules/orders/view.php?id=' + t.order_id)}">${t.order_number}</a>` : '—'}</td>
            <td class="small" data-label="Remarks">${String(t.remarks ?? '')}</td>
            <td data-label="By">${t.created_by_name === null || t.created_by_name === '' ? '—' : String(t.created_by_name)}</td>
          </tr>`)}
        </tbody>
      </table>
    </div>
    ${pager(q, page, totalPages)}
  </div>
</div>
`);
  });

  // ---- POS: fresh single-use order token + order submission ---------------------------------------
  const json = (d: unknown, status = 200) => new WebText(jsonEncode(d), status, 'application/json');

  webPage(app, '/api/pos_new_token', { auth: 'pos.create' }, async (ctx) => {
    const token = randomBytes(16).toString('hex');
    ctx.data.pos_order_token = token;
    return json({ success: true, order_token: token });
  });

  /** Active-store resolution of includes/auth.php (Auth::resolveAuthorizedStoreId): session-based, not request-based. */
  const resolveStore = async (ctx: WebCtx): Promise<{ success: true; store_id: number } | { success: false; error: string }> => {
    const fixed = ctx.fixedStoreId();
    const active = async (id: number) => (await db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [id])).length > 0;
    if (fixed !== null) {
      return (await active(fixed)) ? { success: true, store_id: fixed } : { success: false, error: 'Your assigned store is inactive or invalid. Please contact an administrator.' };
    }
    const a = ctx.activeStoreId();
    if (a === null) return { success: false, error: 'No store is selected. Please choose a store from the store selector before creating an order.' };
    return (await active(a)) ? { success: true, store_id: a } : { success: false, error: 'The selected store is no longer valid or active. Please choose a store again.' };
  };

  const submit = (name: string, tokenKey: string, dupMsg: string, laundry: boolean) => {
    webPage(app, `/modules/${name}/submit`, { auth: 'pos.create', methods: ['GET', 'POST'] }, async (ctx, req) => {
      const p = req.body;
      if (req.method !== 'POST' || !p || typeof p !== 'object' || Array.isArray(p)) return json({ success: false, errors: ['Invalid request payload.'] }, 400);
      const body = p as Record<string, unknown>;
      if (!ctx.data.csrf_token || !same(ctx.data.csrf_token, body.csrf_token ?? '')) return json({ success: false, errors: ['Invalid or expired security token. Please refresh the page.'] }, 419);
      const sessionToken = ctx.data[tokenKey];
      if (!sessionToken || !same(sessionToken, body.order_token ?? '')) return json({ success: false, errors: [dupMsg] }, 409);
      delete ctx.data[tokenKey]; // single use — consumed before any DB work

      const canOverrideDiscount = ctx.can('pos.override_discount');
      const store = await resolveStore(ctx);
      if (!store.success) return json({ success: false, errors: [store.error] }, 422);
      const actor = { userId: ctx.data.user_id!, ip: req.ip };
      const result = laundry
        ? await orders.createLaundryOrder(body, actor, canOverrideDiscount, store.store_id)
        : await orders.createOrder(body, actor, canOverrideDiscount, store.store_id, ctx.can('pos.manual_rate_override'));
      if (!result.success) return json({ success: false, errors: result.errors }, 422);

      const info = (await db.query<Row>(
        `SELECT o.order_number, o.grand_total, o.due_date, c.full_name, c.mobile,
         (SELECT COALESCE(SUM(weight), 0) FROM order_items WHERE order_id = o.id) AS total_weight
         FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, [result.order_id]))[0];
      let whatsappUrl: string | null = null;
      if (info && info.mobile) {
        const shop = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? ctx.svc.env.APP_NAME;
        const amount = numberFormat(flt(info.grand_total), 2);
        const weight = laundry ? `Weight ${numberFormat(flt(info.total_weight), 2).replace(/0+$/, '').replace(/\.+$/, '')} KG, ` : '';
        const message = `Dear ${info.full_name}, thank you for your order. Your order number ${info.order_number} with ${weight}Amount ${amount}, is expected to be ready on ${ctx.date(info.due_date)}. Thanks ${shop}.`;
        whatsappUrl = `https://wa.me/${String(info.mobile).replace(/\D+/g, '')}?text=${rawurlencode(message)}`;
      }
      const out: Row = { success: true, order_id: result.order_id, order_number: result.order_number };
      if (!laundry) out.invoice_number = result.invoice_number;
      out.grand_total = result.grand_total;
      out.whatsapp_url = whatsappUrl;
      out.warnings = result.warnings;
      return json(out);
    });
  };
  submit('pos', 'pos_order_token', 'This order may have already been submitted (duplicate submission blocked). Please check the order list before retrying, or reload the New Order screen.', false);
  submit('laundry', 'laundry_order_token', 'This order may have already been submitted (duplicate submission blocked). Please check the order list before retrying, or reload the New Order (Per Weight) screen.', true);
}
