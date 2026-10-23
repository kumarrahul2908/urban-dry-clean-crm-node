import type { FastifyInstance } from 'fastify';
import { addDays } from '../../lib/dates.js';
import { isNumeric, phpEmpty, phpRound } from '../../lib/php.js';
import { wiPeriodLabel, wiSubject, wiSplit, wiTerms } from '../../services/workshopInvoice.js';
import { wsBillingScope, wsItemBelongs } from '../../services/workshopScope.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { flt, int, numberFormat, urlencode } from '../format.js';
import { e, html, raw, type Raw } from '../html.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const sel = (c: boolean) => (c ? 'selected' : '');
const plural = (n: number, w: string) => w + (n === 1 ? '' : 's');
const GST_MODES: Record<string, string> = { none: 'GST Not Applicable', inclusive: 'Amount Already Includes GST', exclusive: 'Add GST On Top' };
/** wb_dmy(): d/m/Y of a DATE */
const dmy = (d: unknown) => { const s = String(d ?? ''); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };
const displayStatus = (b: Row, today: string) => (b.status === 'Void' || b.status === 'Paid' ? b.status : (!phpEmpty(b.due_date) && String(b.due_date) < today ? 'Overdue' : b.status));
const badge = (d: string) => ({ Paid: 'bg-success', 'Partially Paid': 'bg-info text-dark', Overdue: 'bg-danger', Void: 'bg-secondary', Unpaid: 'bg-warning text-dark' } as Record<string, string>)[d] ?? 'bg-secondary';
const phpFloatStr = (n: number) => String(n);

function groupByStore(items: Row[]) {
  const groups = new Map<string, { items: Row[]; total: number }>();
  for (const it of items) {
    const k = it.store_name ?? 'Unassigned';
    const g = groups.get(k) ?? groups.set(k, { items: [], total: 0 }).get(k)!;
    g.items.push(it); g.total += flt(it.item_value);
  }
  return groups;
}

export function registerWorkshopBillingPage(app: FastifyInstance) {
  const { db, workshop, workshopInvoice } = app.services;

  webPage(app, '/modules/workshop/billing', { auth: 'login' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    if (!ctx.can('workshop.billing') && !ctx.can('billing.view')) {
      return new WebText(`<h2>403 - Access Denied</h2><p>You do not have permission to access this page.</p><p><a href="${ctx.baseUrl('modules/dashboard/index.php')}">Back to Dashboard</a></p>`, 403);
    }
    const userId = ctx.data.user_id ?? 0;
    const scope = await wsBillingScope(db, userId, ctx.data.user?.role_name ?? '');
    const canManage = scope.can_manage, myWorkshopId = scope.workshop_id, blocked = scope.blocked;
    const today = ctx.today;
    const u = (p: string) => ctx.baseUrl(p);
    const parseStore = (r: string): [boolean, number] => (r === 'all' ? [true, 0] : [false, int(r)]);
    const resolvePeriod = (period: string, cf: string, ct: string): [string, string | null, string | null] => {
      if (period === '15days') return ['15days', addDays(today, -14), today];
      if (period === '30days') return ['30days', addDays(today, -29), today];
      if (period === 'custom') {
        const ok = /^\d{4}-\d{2}-\d{2}$/.test(cf) && /^\d{4}-\d{2}-\d{2}$/.test(ct) && !Number.isNaN(Date.parse(cf)) && !Number.isNaN(Date.parse(ct)) && cf <= ct;
        return ok ? ['custom', cf, ct] : ['custom', null, null];
      }
      return ['week', addDays(today, -6), today];
    };

    let errors: string[] = [];
    let success: string | null = null;
    const stores = await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
    let workshops = await db.query<Row>('SELECT id, workshop_name, commission_workshop_percent FROM workshops WHERE is_active = 1 ORDER BY workshop_name');
    if (myWorkshopId !== null) workshops = workshops.filter((w) => Number(w.id) === myWorkshopId);
    const paymentTypes = await db.query<Row>('SELECT id, type_name FROM payment_types WHERE is_active = 1 ORDER BY sort_order');
    const storeById = new Map(stores.map((s) => [Number(s.id), s]));
    const workshopById = new Map(workshops.map((w) => [Number(w.id), w]));

    if (req.method === 'POST') {
      const p = body(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      const action = str(p.action);
      if (action === 'generate') {
        if (!canManage) errors.push('You do not have permission to generate bills.');
        else {
          const [combined, storeId] = parseStore(str(p.store_id));
          const workshopId = int(p.workshop_id);
          const from = str(p.from), to = str(p.to);
          if ((!combined && !storeById.has(storeId)) || !workshopById.has(workshopId)) errors.push('Select a store and a workshop.');
          else {
            let gstMode = str(p.gst_mode) || 'none';
            if (!(gstMode in GST_MODES)) gstMode = 'none';
            let basis = 'basis' in p ? str(p.basis) : 'whole';
            if (!['whole', 'sent_only'].includes(basis)) basis = 'whole';
            const res = await workshopInvoice.createInvoice(combined ? null : storeId, workshopId, from, to, 'invoice_date' in p ? str(p.invoice_date) : today, str(p.subject), userId,
              'expected_total' in p ? flt(p.expected_total) : -1, 'expected_count' in p ? int(p.expected_count) : -1, gstMode, 18.0, req.ip, basis);
            if (res.ok) return new WebRedirect(u(`modules/workshop/billing.php?id=${res.bill_id}&created=1`));
            if (res.code === 'changed') return new WebRedirect(u(`modules/workshop/billing.php?preview=1&store_id=${combined ? 'all' : storeId}&workshop_id=${workshopId}&period=custom&custom_from=${urlencode(from)}&custom_to=${urlencode(to)}&basis=${basis}&changed=1`));
            errors.push(res.error);
          }
        }
      } else if (action === 'record_payment') {
        if (!canManage) errors.push('You do not have permission to record payments.');
        else {
          const res = await workshopInvoice.recordPayment(int(p.bill_id), flt(p.amount), int(p.payment_type_id), str(p.reference_no), 'paid_on' in p ? str(p.paid_on) : today, str(p.notes), userId, myWorkshopId, req.ip);
          if (res.ok) success = res.status === 'Paid' ? 'Payment recorded. The bill is now fully paid.' : 'Payment recorded. Balance due: Rs. ' + numberFormat(res.balance, 2) + '.';
          else errors.push(res.error);
        }
      } else if (action === 'mark_unprocessed') {
        if (!canManage) errors.push('You do not have permission to mark items unprocessed.');
        else {
          const wiId = int(p.workshop_item_id);
          if (myWorkshopId !== null && !(await wsItemBelongs(db, wiId, myWorkshopId))) errors.push('Item not found.');
          else {
            const r = await workshop.markUnprocessed(wiId, { userId, ip: req.ip }, str(p.reason));
            if (r.success) success = 'Item marked Unprocessed. It is excluded from billing until resolved.'; else errors = r.errors ?? [];
          }
          const backTo = str(p.redirect_to);
          if (backTo !== '' && backTo.startsWith(u('modules/workshop/'))) return new WebRedirect(backTo);
        }
      } else if (action === 'resolve_unprocessed') {
        if (!canManage) errors.push('You do not have permission to resolve items.');
        else {
          const wiId = int(p.workshop_item_id);
          if (myWorkshopId !== null && !(await wsItemBelongs(db, wiId, myWorkshopId))) errors.push('Item not found.');
          else {
            const r = await workshop.resolveUnprocessed(wiId, { userId, ip: req.ip });
            if (r.success) success = 'Item resolved and returned to the active queue.'; else errors = r.errors ?? [];
          }
        }
      } else if (action === 'void') {
        if (!canManage) errors.push('You do not have permission to void bills.');
        else {
          const res = await workshopInvoice.voidInvoice(int(p.bill_id), str(p.reason), userId, myWorkshopId, req.ip);
          if (res.ok) success = 'Bill voided. Its garments can be invoiced again.'; else errors.push(res.error);
        }
      }
    }

    const viewId = int(q.id);
    let mode: 'list' | 'detail' | 'review' | 'new' = 'list';
    if (viewId) mode = 'detail'; else if ('preview' in q) mode = 'review'; else if ('new' in q) mode = 'new';
    if ((mode === 'new' || mode === 'review') && !canManage) { errors.push('You do not have permission to generate bills.'); mode = 'list'; }
    if (blocked) { errors = ['This login is not linked to a workshop yet, so billing is unavailable. Ask the administrator to link it to your workshop.']; success = null; mode = 'list'; }

    const [selCombined, selStore] = parseStore(str(q.store_id));
    const selWorkshop = 'workshop_id' in q ? int(q.workshop_id) : (workshops.length === 1 ? Number(workshops[0]!.id) : 0);
    let selPeriod = 'period' in q ? str(q.period) : 'week';
    const selCustomFrom = str(q.custom_from), selCustomTo = str(q.custom_to);
    // "Whole Bill" (every order from the store in the period) is the default: garments are often processed without a formal challan
    let selBasis = 'basis' in q ? str(q.basis) : 'whole';
    if (!['whole', 'sent_only'].includes(selBasis)) selBasis = 'whole';

    let review: Row | null = null;
    if (mode === 'review') {
      const [resolvedPeriod, rFrom, rTo] = resolvePeriod(selPeriod, selCustomFrom, selCustomTo);
      if (!selCombined && !storeById.has(selStore)) errors.push('Select a store, or choose All stores for a combined bill.');
      if (!workshopById.has(selWorkshop)) errors.push('Select a workshop.');
      if (rFrom === null) errors.push('Enter a valid date range.');
      if (errors.length) mode = 'new';
      else {
        const items = selBasis === 'whole'
          ? await workshopInvoice.billableItemsWhole(selCombined ? null : selStore, rFrom!, rTo!)
          : await workshopInvoice.billableItems(selCombined ? null : selStore, selWorkshop, rFrom!, rTo!);
        const total = phpRound(items.reduce((a, i) => a + flt(i.item_value), 0), 2);
        const issuer = (await workshopInvoice.issuer(selWorkshop))!;
        const [wShare, sShare] = wiSplit(total, issuer.commission);
        review = {
          items, total, pct: issuer.commission, workshop_share: wShare, store_share: sShare, from: rFrom, to: rTo,
          store: selCombined ? 'All stores (combined)' : storeById.get(selStore)!.store_name, groups: groupByStore(items), issuer,
          next_number: (issuer.prefix !== '' ? issuer.prefix : 'INV') + '-' + String(Math.max(1, issuer.next_number)).padStart(5, '0'),
          terms: (wiTerms as Record<number, string>)[issuer.terms_days] ?? ('Net ' + issuer.terms_days), subject: wiSubject(rFrom!, rTo!),
          incomplete: issuer.address.trim() === '' || issuer.gstin.trim() === '',
          basis: selBasis,
        };
        selPeriod = resolvedPeriod;
      }
    }

    let viewBill: Row | null = null, viewItems: Row[] = [], viewGroups = new Map<string, { items: Row[]; total: number }>(), viewPayments: Row[] = [], viewSnap: Row = {};
    if (mode === 'detail') {
      viewBill = (await db.query<Row>(
        `SELECT wb.*, CASE WHEN wb.is_combined = 1 THEN 'All stores (combined)' ELSE s.store_name END AS store_name, w.workshop_name FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id JOIN workshops w ON w.id = wb.workshop_id WHERE wb.id = ?`, [viewId]))[0] ?? null;
      if (viewBill && myWorkshopId !== null && Number(viewBill.workshop_id) !== myWorkshopId) viewBill = null;
      if (viewBill) {
        try { viewSnap = JSON.parse(String(viewBill.snapshot_json ?? '')) || {}; } catch { viewSnap = {}; }
        viewItems = await db.query<Row>(
          `SELECT wbi.order_item_id, wbi.item_value, o.id AS order_id, o.order_number, g.garment_name, c.full_name AS customer_name, COALESCE(s2.store_name, 'Unassigned') AS store_name
           FROM workshop_bill_items wbi JOIN order_items oi ON oi.id = wbi.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
           LEFT JOIN stores s2 ON s2.id = o.store_id LEFT JOIN garments g ON g.id = oi.garment_id WHERE wbi.bill_id = ? ORDER BY store_name, o.order_number`, [viewId]);
        viewGroups = groupByStore(viewItems);
        viewPayments = await db.query<Row>(
          `SELECT p.*, pt.type_name, u.full_name AS received_by_name FROM workshop_bill_payments p JOIN payment_types pt ON pt.id = p.payment_type_id LEFT JOIN users u ON u.id = p.received_by WHERE p.bill_id = ? ORDER BY p.paid_on, p.id`, [viewId]);
      }
    }

    let statusFilter = str(q.status);
    if (!['Unpaid', 'Partially Paid', 'Paid', 'Overdue', 'Void'].includes(statusFilter)) statusFilter = '';
    let billList: Row[] = [], summary: Row = { bills: 0, billed: 0, received: 0, balance: 0, overdue: 0 }, byStore: Row[] = [];
    if (mode === 'list') {
      const scopeSql = (myWorkshopId !== null ? ' AND wb.workshop_id = ' + myWorkshopId : '') + (blocked ? ' AND 1 = 0' : '');
      summary = (await db.query<Row>(
        `SELECT COUNT(*) bills, COALESCE(SUM(wb.grand_total),0) billed, COALESCE(SUM(wb.amount_paid),0) received, COALESCE(SUM(wb.grand_total - wb.amount_paid),0) balance,
         COALESCE(SUM(CASE WHEN wb.due_date < ? AND wb.status IN ('Unpaid','Partially Paid') THEN wb.grand_total - wb.amount_paid ELSE 0 END),0) overdue FROM workshop_bills wb WHERE wb.status <> 'Void'${scopeSql}`, [today]))[0]!;
      byStore = await db.query<Row>(
        `SELECT CASE WHEN wb.is_combined = 1 THEN 'All stores (combined)' ELSE s.store_name END AS store_name, SUM(wb.grand_total - wb.amount_paid) AS balance, COUNT(*) AS bills
         FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id WHERE wb.status IN ('Unpaid','Partially Paid')${scopeSql} GROUP BY store_name HAVING balance > 0 ORDER BY balance DESC`);
      let lw = '1=1';
      const lp: unknown[] = [];
      if (statusFilter === 'Overdue') { lw += " AND wb.status IN ('Unpaid','Partially Paid') AND wb.due_date < ?"; lp.push(today); }
      else if (statusFilter !== '') { lw += ' AND wb.status = ?'; lp.push(statusFilter); }
      billList = await db.query<Row>(
        `SELECT wb.id, wb.bill_number, wb.invoice_date, wb.due_date, wb.workshop_share, wb.grand_total, wb.gst_mode, wb.amount_paid, wb.status, wb.is_combined,
         CASE WHEN wb.is_combined = 1 THEN 'All stores (combined)' ELSE s.store_name END AS store_name, w.workshop_name
         FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id JOIN workshops w ON w.id = wb.workshop_id WHERE ${lw}${scopeSql} ORDER BY wb.id DESC LIMIT 200`, lp);
    }

    const money = await ctx.loadMoney();
    const billingUrl = u('modules/workshop/billing.php');
    const stepper = (active: number) => html`<div class="d-flex flex-wrap gap-2 mb-3">${[1, 2, 3].map((n) => html`<span class="badge ${n === active ? 'bg-primary' : (n < active ? 'bg-success' : 'bg-secondary')} fs-6 fw-normal">${n}. ${({ 1: 'Select store & dates', 2: 'Review', 3: 'Generate invoice' } as Record<number, string>)[n]}</span>`)}</div>`;

    let content: Raw | string = '';
    if (mode === 'new') {
      content = html`
  ${stepper(1)}
  <div class="card">
    <div class="card-header"><strong>Select store, workshop and dates</strong></div>
    <div class="card-body">
      <form method="get" class="row g-3 align-items-end" id="wbSelectForm">
        <input type="hidden" name="preview" value="1">
        <div class="col-md-4">
          <label class="form-label small mb-1">Invoice to</label>
          <select name="store_id" class="form-select" required>
            <option value="">Select store...</option>
            <option value="all" ${selCombined ? 'selected' : ''}>All stores &mdash; one combined invoice</option>
            ${stores.map((s) => html`<option value="${s.id}" ${!selCombined && selStore === Number(s.id) ? 'selected' : ''}>${s.store_name}</option>`)}
          </select>
        </div>
        <div class="col-md-4">
          <label class="form-label small mb-1">Workshop</label>
          <select name="workshop_id" class="form-select" required>
            <option value="">Select workshop...</option>
            ${workshops.map((w) => html`<option value="${w.id}" ${selWorkshop === Number(w.id) ? 'selected' : ''}>${w.workshop_name} (${String(w.commission_workshop_percent)}% workshop)</option>`)}
          </select>
        </div>
        <div class="col-md-4">
          <label class="form-label small mb-1">Period</label>
          <select name="period" class="form-select" id="wbPeriod">
            <option value="week" ${sel(selPeriod === 'week')}>This Week (last 7 days)</option>
            <option value="15days" ${sel(selPeriod === '15days')}>Last 15 Days</option>
            <option value="30days" ${sel(selPeriod === '30days')}>Last 30 Days</option>
            <option value="custom" ${sel(selPeriod === 'custom')}>Custom dates</option>
          </select>
        </div>
        <div class="col-md-4 wb-custom" style="display:none;">
          <label class="form-label small mb-1">From</label>
          <input type="date" name="custom_from" value="${selCustomFrom}" class="form-control">
        </div>
        <div class="col-md-4 wb-custom" style="display:none;">
          <label class="form-label small mb-1">To</label>
          <input type="date" name="custom_to" value="${selCustomTo}" class="form-control">
        </div>
        <div class="col-12">
          <label class="form-label small mb-1 d-block">What to bill</label>
          <div class="form-check form-check-inline">
            <input class="form-check-input" type="radio" name="basis" id="basis_whole" value="whole" ${selBasis === 'whole' ? 'checked' : ''}>
            <label class="form-check-label" for="basis_whole">Whole Bill &mdash; every order from the store in this period</label>
          </div>
          <div class="form-check form-check-inline">
            <input class="form-check-input" type="radio" name="basis" id="basis_sent" value="sent_only" ${selBasis === 'sent_only' ? 'checked' : ''}>
            <label class="form-check-label" for="basis_sent">Sent to Workshop Only &mdash; only garments formally sent via a challan</label>
          </div>
          <div class="small text-muted">Default is Whole Bill, since a garment is often processed at the workshop without a formal challan being created for it.</div>
        </div>
        <div class="col-12">
          <button class="btn btn-primary" type="submit">Review &rarr;</button>
          <span class="small text-muted ms-2">Nothing is saved until you click Generate on the next screen.</span>
        </div>
      </form>
    </div>
  </div>
  ${raw(`<script>
    (function () {
      var sel = document.getElementById('wbPeriod');
      function sync() {
        document.querySelectorAll('.wb-custom').forEach(function (el) { el.style.display = sel.value === 'custom' ? '' : 'none'; });
      }
      sel.addEventListener('change', sync); sync();
    })();
  </script>`)}
`;
    } else if (mode === 'review' && review) {
      const r = review;
      const storePart = selCombined ? 'all' : String(selStore);
      const periodTail = selPeriod === 'custom' ? '&custom_from=' + urlencode(r.from) + '&custom_to=' + urlencode(r.to) : '';
      const changeUrl = `${billingUrl}?new=1&store_id=${storePart}&workshop_id=${selWorkshop}&period=${urlencode(selPeriod)}&basis=${selBasis}${periodTail}`;
      const reviewUrl = `${billingUrl}?preview=1&store_id=${storePart}&workshop_id=${selWorkshop}&period=${urlencode(selPeriod)}&basis=${selBasis}${periodTail}`;
      const items = r.items as Row[];
      content = html`
  ${stepper(2)}
  ${'changed' in q ? html`
    <div class="alert alert-warning">The garments changed since you last reviewed (one was sent or invoiced in the meantime). Please check the figures below again before generating.</div>` : ''}
  ${r.incomplete ? html`
    <div class="alert alert-warning">
      The company details for <strong>${r.issuer.workshop_name}</strong> are incomplete (address or GSTIN missing), so they will be blank on the invoice.
      <a href="${u('modules/workshop/settings.php?workshop_id=' + selWorkshop)}">Update them in Workshop Settings</a> first if you want them printed.
    </div>` : ''}
  <div class="card mb-3">
    <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
      <strong>Review before generating the invoice</strong>
      <a href="${changeUrl}" class="btn btn-sm btn-outline-secondary">&larr; Change selection</a>
    </div>
    <div class="card-body">
      <div class="row mb-3">
        <div class="col-md-6">
          <strong>Invoice from:</strong> ${r.issuer.company_name}<br>
          <strong>Bill To:</strong> ${r.store}<br>
          <strong>Period:</strong> ${wiPeriodLabel(r.from, r.to)} (${dmy(r.from)} to ${dmy(r.to)})<br>
          <strong>Invoice no.:</strong> ${r.next_number} &middot; <strong>Terms:</strong> ${r.terms}<br>
          <strong>Billing basis:</strong> ${r.basis === 'whole' ? 'Whole Bill (every order from the store)' : 'Sent to Workshop Only (formally challaned garments)'}
        </div>
        <div class="col-md-6 text-md-end">
          <strong>Garments:</strong> ${items.length} ${plural(items.length, 'item')}<br>
          <strong>Bill value of those garments:</strong> ${raw(money(r.total))}<br>
          <strong>Split:</strong> Workshop ${phpFloatStr(r.pct)}% / Store ${numberFormat(100 - r.pct, 2)}%<br>
          <strong>Invoice total (workshop share):</strong> <span class="fs-5 fw-bold">${raw(money(r.workshop_share))}</span>
        </div>
      </div>

      ${items.length === 0 ? html`
        <div class="alert alert-info mb-0">${r.basis === 'whole' ? 'No unbilled orders were found for this store in this period.' : 'No unbilled garments were sent to this workshop from this store in this period.'} Try a different period, store, or billing basis.</div>` : html`
        <div class="table-responsive mb-3">
          <table class="table table-sm">
            <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th class="text-end">Bill value</th><th></th></tr></thead>
            <tbody>
              ${[...(r.groups as Map<string, { items: Row[]; total: number }>)].map(([storeName, grp]) => html`
                ${selCombined ? html`
                <tr class="table-light">
                  <td colspan="4"><strong>${storeName}</strong> <span class="text-muted small">(${grp.items.length} ${plural(grp.items.length, 'item')})</span></td>
                  <td class="text-end fw-bold">${raw(money(grp.total))}</td>
                </tr>` : ''}
                ${grp.items.map((it) => html`
                <tr>
                  <td><a href="${u('modules/orders/view.php?id=' + it.order_id)}" target="_blank">${it.order_number}</a></td>
                  <td>${it.customer_name}</td>
                  <td>${String(it.garment_name ?? '')}
                    ${r.basis === 'whole' && phpEmpty(it.was_sent) ? html`
                      <span class="badge bg-light text-muted border ms-1" title="Billed from the order directly -- no challan was ever created for this garment">Not sent to workshop</span>` : ''}
                  </td>
                  <td class="text-end">${raw(money(it.item_value))}</td>
                  <td>
                    ${!phpEmpty(it.workshop_item_id) ? html`
                    <form method="post" action="${billingUrl}" class="d-inline" onsubmit="var r=prompt('Reason this garment is unprocessed:'); if(!r){return false;} this.querySelector('[name=reason]').value=r; return true;">
                      <input type="hidden" name="csrf_token" value="${ctx.data.csrf_token ?? ''}">
                      <input type="hidden" name="action" value="mark_unprocessed">
                      <input type="hidden" name="workshop_item_id" value="${int(it.workshop_item_id)}">
                      <input type="hidden" name="reason" value="">
                      <input type="hidden" name="redirect_to" value="${reviewUrl}">
                      <button type="submit" class="btn btn-sm btn-outline-danger py-0 px-2" title="Click to mark this garment unprocessed and exclude it from this bill">Mark Unprocessed</button>
                    </form>` : ''}
                  </td>
                </tr>`)}`)}
            </tbody>
            <tfoot>
              <tr class="fw-bold"><td colspan="4" class="text-end">${selCombined ? 'Combined total (all stores)' : 'Total'}</td><td class="text-end">${raw(money(r.total))}</td></tr>
              <tr><td colspan="4" class="text-end">Invoice total &mdash; workshop share (${phpFloatStr(r.pct)}%)</td><td class="text-end fw-bold">${raw(money(r.workshop_share))}</td></tr>
              <tr><td colspan="4" class="text-end text-muted">Store keeps</td><td class="text-end text-muted">${raw(money(r.store_share))}</td></tr>
            </tfoot>
          </table>
        </div>
        <form method="post" action="${billingUrl}" class="border-top pt-3">
          <input type="hidden" name="csrf_token" value="${ctx.data.csrf_token ?? ''}">
          <input type="hidden" name="action" value="generate">
          <input type="hidden" name="store_id" value="${storePart}">
          <input type="hidden" name="workshop_id" value="${selWorkshop}">
          <input type="hidden" name="basis" value="${r.basis}">
          <input type="hidden" name="from" value="${r.from}">
          <input type="hidden" name="to" value="${r.to}">
          <input type="hidden" name="expected_total" value="${phpFloatStr(r.total)}">
          <input type="hidden" name="expected_count" value="${items.length}">

          <div class="mb-3">
            <label class="form-label small mb-1 d-block">GST</label>
            ${Object.entries(GST_MODES).map(([k, label]) => html`
              <div class="form-check form-check-inline">
                <input class="form-check-input" type="radio" name="gst_mode" id="gst_${k}" value="${k}" ${k === 'none' ? 'checked' : ''}>
                <label class="form-check-label small" for="gst_${k}">${label}${k === 'none' ? '' : ' (18%)'}</label>
              </div>`)}
            <div class="small text-muted">"Amount Already Includes GST" keeps the invoice total at ${raw(money(r.workshop_share))} and shows the GST portion already inside it. "Add GST On Top" adds 18% to that amount, so the invoice total becomes more than ${raw(money(r.workshop_share))}.</div>
          </div>

          <div class="row g-3 align-items-end">
            <div class="col-md-3">
              <label class="form-label small mb-1">Invoice date</label>
              <input type="date" name="invoice_date" class="form-control" value="${today}" required>
            </div>
            <div class="col-md-5">
              <label class="form-label small mb-1">Subject</label>
              <input type="text" name="subject" class="form-control" maxlength="150" value="${r.subject}">
            </div>
            <div class="col-md-4">
              <button class="btn btn-success w-100" type="submit" onclick="this.disabled=true; this.form.submit();">Generate Invoice</button>
            </div>
          </div>
          <div class="small text-muted mt-2">Creates a numbered, unpaid invoice for these ${items.length} item(s) in ${r.issuer.company_name}'s name. The due date is the invoice date plus the ${r.terms} terms. The garments cannot be invoiced again unless this invoice is voided.</div>
        </form>`}
    </div>
  </div>
`;
    } else if (mode === 'detail') {
      if (!viewBill) content = html`
    <div class="alert alert-danger">Bill not found.</div>`;
      else {
        const b = viewBill;
        const display = displayStatus(b, today);
        const balance = phpRound(flt(b.grand_total) - flt(b.amount_paid), 2);
        const isVoid = b.status === 'Void';
        const canPay = canManage && ['Unpaid', 'Partially Paid'].includes(b.status);
        const canVoid = canManage && b.status === 'Unpaid' && flt(b.amount_paid) === 0;
        const gstRate = phpFloatStr(flt(b.gst_rate));
        content = html`
  <div class="card mb-3">
    <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
      <strong>Invoice ${b.bill_number}</strong>
      <span>
        <span class="badge ${badge(display)} me-2">${display}</span>
        <a class="btn btn-sm btn-primary" target="_blank" href="${u('modules/workshop/bill_print.php?id=' + b.id)}">View / Print Invoice</a>
      </span>
    </div>
    <div class="card-body">
      <div class="row mb-3">
        <div class="col-md-6">
          <strong>From:</strong> ${String(viewSnap.issuer?.company_name ?? b.workshop_name)}<br>
          <strong>Bill To:</strong> ${String(viewSnap.bill_to ?? b.store_name)}<br>
          <strong>Subject:</strong> ${String(b.subject ?? '')}<br>
          <strong>Period:</strong> ${wiPeriodLabel(b.period_start, b.period_end)}
        </div>
        <div class="col-md-6 text-md-end">
          <strong>Invoice date:</strong> ${dmy(b.invoice_date)}<br>
          <strong>Terms:</strong> ${String(b.terms_label ?? '')} &middot; <strong>Due date:</strong> ${dmy(b.due_date)}<br>
          <strong>Garment bill value:</strong> ${raw(money(b.total_value))}
            &middot; Workshop ${String(b.share_percent)}% / Store ${numberFormat(100 - flt(b.share_percent), 2)}%
          <br><strong>Billing basis:</strong> ${(b.billing_basis ?? 'sent_only') === 'whole' ? 'Whole Bill (every order from the store)' : 'Sent to Workshop Only (formally challaned garments)'}
          ${b.gst_mode !== 'none' ? html`
            <br><strong>GST:</strong> ${b.gst_mode === 'inclusive' ? 'Included in the invoice total' : 'Added on top of the workshop share'} (${gstRate}%)` : ''}
        </div>
      </div>

      ${b.gst_mode !== 'none' ? html`
      <div class="row mb-3">
        <div class="col-md-6 offset-md-6">
          <table class="table table-sm mb-0">
            <tr><td>Sub Total</td><td class="text-end">${raw(money(flt(b.grand_total) - flt(b.gst_amount)))}</td></tr>
            <tr><td>GST (${gstRate}%)</td><td class="text-end">${raw(money(b.gst_amount))}</td></tr>
            <tr class="fw-bold border-top"><td>Total</td><td class="text-end">${raw(money(b.grand_total))}</td></tr>
          </table>
        </div>
      </div>` : ''}

      <div class="row g-2 mb-3 text-center">
        <div class="col-4"><div class="border rounded p-2"><div class="small text-muted">Invoice total</div><div class="fs-5 fw-bold">${raw(money(b.grand_total))}</div></div></div>
        <div class="col-4"><div class="border rounded p-2"><div class="small text-muted">Received</div><div class="fs-5 fw-bold text-success">${raw(money(b.amount_paid))}</div></div></div>
        <div class="col-4"><div class="border rounded p-2 ${display === 'Overdue' ? 'border-danger' : ''}"><div class="small text-muted">Balance due</div><div class="fs-5 fw-bold ${balance > 0 && display === 'Overdue' ? 'text-danger' : ''}">${raw(money(isVoid ? 0 : balance))}</div></div></div>
      </div>

      ${isVoid ? html`
        <div class="alert alert-secondary">
          <strong>Void</strong> &mdash; ${String(b.void_reason ?? '')} (${String(b.voided_at ?? '')}).
          The garments on this bill were released and can be invoiced again; this invoice number stays on record.
        </div>` : html`
        <h6 class="text-muted small text-uppercase">Garments covered (${viewItems.length})</h6>
        <div class="table-responsive mb-3">
          <table class="table table-sm">
            <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th class="text-end">Bill value</th></tr></thead>
            <tbody>
              ${[...viewGroups].map(([storeName, grp]) => html`
                ${b.is_combined ? html`
                <tr class="table-light">
                  <td colspan="3"><strong>${storeName}</strong> <span class="text-muted small">(${grp.items.length} ${plural(grp.items.length, 'item')})</span></td>
                  <td class="text-end fw-bold">${raw(money(grp.total))}</td>
                </tr>` : ''}
                ${grp.items.map((it) => html`
                <tr>
                  <td><a href="${u('modules/orders/view.php?id=' + it.order_id)}">${it.order_number}</a></td>
                  <td>${it.customer_name}</td>
                  <td>${String(it.garment_name ?? '')}</td>
                  <td class="text-end">${raw(money(it.item_value))}</td>
                </tr>`)}`)}
            </tbody>
          </table>
        </div>`}

      <h6 class="text-muted small text-uppercase">Payments received (${viewPayments.length})</h6>
      ${viewPayments.length === 0 ? html`
        <p class="text-muted small">No payment recorded yet.</p>` : html`
        <div class="table-responsive mb-3">
          <table class="table table-sm">
            <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Notes</th><th>Recorded by</th><th class="text-end">Amount</th></tr></thead>
            <tbody>
              ${viewPayments.map((p) => html`
              <tr>
                <td>${dmy(p.paid_on)}</td>
                <td>${p.type_name}</td>
                <td>${String(p.reference_no ?? '')}</td>
                <td>${String(p.notes ?? '')}</td>
                <td>${String(p.received_by_name ?? '')}</td>
                <td class="text-end">${raw(money(p.amount))}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>`}

      ${canPay ? html`
        <form method="post" class="row g-2 align-items-end border-top pt-3">
          <input type="hidden" name="csrf_token" value="${ctx.data.csrf_token ?? ''}">
          <input type="hidden" name="action" value="record_payment">
          <input type="hidden" name="bill_id" value="${b.id}">
          <div class="col-md-2">
            <label class="form-label small mb-1">Amount received</label>
            <input type="number" step="0.01" min="0.01" max="${phpFloatStr(balance)}" name="amount" class="form-control form-control-sm" value="${numberFormat(balance, 2).replace(/,/g, '')}" required>
          </div>
          <div class="col-md-2">
            <label class="form-label small mb-1">Payment method</label>
            <select name="payment_type_id" class="form-select form-select-sm" required>
              <option value="">Select...</option>
              ${paymentTypes.map((pt) => html`<option value="${pt.id}">${pt.type_name}</option>`)}
            </select>
          </div>
          <div class="col-md-3">
            <label class="form-label small mb-1">Reference no. (UPI / Cheque / NEFT)</label>
            <input type="text" name="reference_no" class="form-control form-control-sm" maxlength="100" placeholder="Optional for Cash">
          </div>
          <div class="col-md-2">
            <label class="form-label small mb-1">Received on</label>
            <input type="date" name="paid_on" class="form-control form-control-sm" max="${today}" value="${today}" required>
          </div>
          <div class="col-md-2">
            <label class="form-label small mb-1">Notes</label>
            <input type="text" name="notes" class="form-control form-control-sm" maxlength="255">
          </div>
          <div class="col-md-1"><button class="btn btn-sm btn-success w-100" type="submit">Record</button></div>
        </form>
        <div class="small text-muted mt-1">The amount is pre-filled with the full balance; change it to record a part payment.</div>` : ''}

      ${canVoid ? html`
        <form method="post" class="row g-2 align-items-end border-top mt-3 pt-3" onsubmit="return confirm('Void invoice ${b.bill_number}? Its garments will be released so they can be invoiced again.');">
          <input type="hidden" name="csrf_token" value="${ctx.data.csrf_token ?? ''}">
          <input type="hidden" name="action" value="void">
          <input type="hidden" name="bill_id" value="${b.id}">
          <div class="col-md-8">
            <label class="form-label small mb-1 text-danger">Void this bill (only possible while nothing has been received)</label>
            <input type="text" name="reason" class="form-control form-control-sm" maxlength="255" placeholder="Reason, e.g. wrong period selected" required>
          </div>
          <div class="col-md-2"><button class="btn btn-sm btn-outline-danger w-100" type="submit">Void bill</button></div>
        </form>` : ''}
    </div>
  </div>
`;
      }
    } else {
      content = html`
  <div class="row g-2 mb-3 text-center">
    <div class="col-6 col-md-3"><div class="border rounded p-2 bg-white"><div class="small text-muted">Billed</div><div class="fs-5 fw-bold">${raw(money(summary.billed))}</div><div class="small text-muted">${int(summary.bills)} ${plural(int(summary.bills), 'bill')}</div></div></div>
    <div class="col-6 col-md-3"><div class="border rounded p-2 bg-white"><div class="small text-muted">Received</div><div class="fs-5 fw-bold text-success">${raw(money(summary.received))}</div></div></div>
    <div class="col-6 col-md-3"><div class="border rounded p-2 bg-white"><div class="small text-muted">Balance due</div><div class="fs-5 fw-bold">${raw(money(summary.balance))}</div></div></div>
    <div class="col-6 col-md-3"><div class="border rounded p-2 bg-white ${flt(summary.overdue) > 0 ? 'border-danger' : ''}"><div class="small text-muted">Overdue</div><div class="fs-5 fw-bold ${flt(summary.overdue) > 0 ? 'text-danger' : ''}">${raw(money(summary.overdue))}</div></div></div>
  </div>
  ${byStore.length ? html`
  <div class="card mb-3">
    <div class="card-header py-2"><strong>Outstanding by store</strong></div>
    <div class="table-responsive">
      <table class="table table-sm mb-0">
        <tbody>
          ${byStore.map((r) => html`
            <tr><td>${r.store_name} <span class="text-muted small">(${int(r.bills)} unpaid ${plural(int(r.bills), 'bill')})</span></td><td class="text-end fw-bold">${raw(money(r.balance))}</td></tr>`)}
        </tbody>
      </table>
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-header d-flex justify-content-between align-items-center flex-wrap gap-2">
      <div class="d-flex align-items-center gap-2 flex-wrap">
        <strong>All Bills</strong>
        <div class="btn-group btn-group-sm">
          <a href="?" class="btn btn-outline-secondary ${statusFilter === '' ? 'active' : ''}">All</a>
          <a href="?status=Unpaid" class="btn btn-outline-secondary ${statusFilter === 'Unpaid' ? 'active' : ''}">Unpaid</a>
          <a href="?status=Partially%20Paid" class="btn btn-outline-secondary ${statusFilter === 'Partially Paid' ? 'active' : ''}">Partially Paid</a>
          <a href="?status=Overdue" class="btn btn-outline-secondary ${statusFilter === 'Overdue' ? 'active' : ''}">Overdue</a>
          <a href="?status=Paid" class="btn btn-outline-secondary ${statusFilter === 'Paid' ? 'active' : ''}">Paid</a>
          <a href="?status=Void" class="btn btn-outline-secondary ${statusFilter === 'Void' ? 'active' : ''}">Void</a>
        </div>
      </div>
      ${canManage ? html`<a href="?new=1" class="btn btn-sm btn-primary">+ New Bill</a>` : ''}
    </div>
    <div class="table-responsive">
      <table class="table table-sm table-hover mb-0">
        <thead><tr><th>Invoice #</th><th>Bill To</th><th>Workshop</th><th>Invoice date</th><th>Due date</th><th class="text-end">Total</th><th class="text-end">Paid</th><th class="text-end">Balance</th><th>Status</th></tr></thead>
        <tbody>
          ${billList.length === 0 ? html`
            <tr><td colspan="9" class="text-center text-muted py-3">No bills yet.</td></tr>` : ''}
          ${billList.map((b) => { const disp = displayStatus(b, today); const bal = b.status === 'Void' ? 0 : phpRound(flt(b.grand_total) - flt(b.amount_paid), 2); return html`
          <tr style="cursor:pointer" onclick="window.location='${u('modules/workshop/billing.php?id=' + b.id)}'">
            <td>${b.bill_number}</td>
            <td>${b.store_name}${b.is_combined ? raw(' <span class="badge bg-info text-dark">Combined</span>') : ''}</td>
            <td>${b.workshop_name}</td>
            <td class="small">${dmy(b.invoice_date)}</td>
            <td class="small ${disp === 'Overdue' ? 'text-danger fw-bold' : ''}">${dmy(b.due_date)}</td>
            <td class="text-end">${raw(money(b.grand_total))}${b.gst_mode !== 'none' ? raw(' <span class="badge bg-light text-dark border" title="Includes GST">GST</span>') : ''}</td>
            <td class="text-end">${raw(money(b.amount_paid))}</td>
            <td class="text-end fw-bold">${raw(money(bal))}</td>
            <td><span class="badge ${badge(disp)}">${disp}</span></td>
          </tr>`; })}
        </tbody>
      </table>
    </div>
  </div>
`;
    }

    return layout(ctx, { title: 'Workshop Billing' }, html`
<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
  <h4 class="mb-0">Workshop Billing</h4>
  <div class="d-flex gap-2">
    ${mode !== 'list' ? html`<a href="${billingUrl}" class="btn btn-sm btn-outline-secondary">All bills</a>` : ''}
    ${ctx.can('workshop.manage') ? html`<a href="${u('modules/workshop/settings.php')}" class="btn btn-sm btn-outline-secondary">Company &amp; invoice settings</a>` : ''}
    <a href="${u('modules/workshop/index.php')}" class="btn btn-sm btn-outline-secondary">&larr; Back to Workshop</a>
  </div>
</div>

${errors.map((er) => html`<div class="alert alert-danger">${er}</div>`)}
${success ? html`<div class="alert alert-success">${success}</div>` : ''}
${'created' in q ? html`<div class="alert alert-success">Invoice generated. Open <strong>View / Print Invoice</strong> to print it or save it as a PDF.</div>` : ''}

${content}
`);
  });
}
