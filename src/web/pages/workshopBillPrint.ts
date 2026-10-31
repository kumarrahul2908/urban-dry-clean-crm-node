import type { FastifyInstance } from 'fastify';
import { phpEmpty, phpRound } from '../../lib/php.js';
import { wiInrFormat, wiInrInWords, wiPeriodLabel } from '../../services/workshopInvoice.js';
import { wsBillingScope } from '../../services/workshopScope.js';
import { WebText, webPage } from '../context.js';
import { flt, int } from '../format.js';
import { html, raw } from '../html.js';

type Row = Record<string, any>;
const dmy = (d: unknown) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const plural = (n: number, w: string) => w + (n === 1 ? '' : 's');
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');

export function registerWorkshopBillPrintPage(app: FastifyInstance) {
  const { db } = app.services;

  webPage(app, '/modules/workshop/bill_print', { auth: 'login' }, async (ctx, req) => {
    if (!ctx.can('workshop.billing') && !ctx.can('billing.view')) return new WebText('<h2>403 - Access Denied</h2><p>You do not have permission to access this page.</p>', 403);
    const scope = await wsBillingScope(db, ctx.data.user_id ?? 0, ctx.data.user?.role_name ?? '');
    const myWs = scope.workshop_id;
    const id = int((req.query as Record<string, unknown>).id);
    const b = (await db.query<Row>("SELECT wb.*, CASE WHEN wb.is_combined = 1 THEN 'All stores (combined)' ELSE s.store_name END AS store_label FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id WHERE wb.id = ?", [id]))[0];
    if (!b || scope.blocked || (myWs !== null && Number(b.workshop_id) !== myWs)) return new WebText('<h2>Bill not found</h2>', 404);

    let snap: Row = {};
    try { snap = JSON.parse(String(b.snapshot_json ?? '')) || {}; } catch { snap = {}; }
    const iss: Row = snap.issuer ?? {};
    const companyName = iss.company_name ?? '';
    const billTo = snap.bill_to ?? b.store_label;
    const itemDesc = snap.item_description ?? 'Dry Clean charges';
    const periodLabel = snap.period_label ?? wiPeriodLabel(b.period_start, b.period_end);
    const total = flt(b.grand_total);
    const subTotal = phpRound(total - flt(b.gst_amount), 2);
    const gstMode = String(b.gst_mode);
    const gstAmount = flt(b.gst_amount), gstRate = flt(b.gst_rate), paid = flt(b.amount_paid);
    const isVoid = b.status === 'Void';
    const balance = isVoid ? 0 : phpRound(total - paid, 2);
    const title = phpTrim(String(iss.gstin ?? '')) !== '' ? 'TAX INVOICE' : 'INVOICE';
    const addressLines = String(iss.address ?? '').split('\n').map(phpTrim).filter((l) => l !== '');
    const items = await db.query<Row>(
      `SELECT wbi.item_value, o.order_number, o.short_order_code, g.garment_name, c.full_name AS customer_name, COALESCE(s2.store_name, 'Unassigned') AS store_name
       FROM workshop_bill_items wbi JOIN order_items oi ON oi.id = wbi.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
       LEFT JOIN stores s2 ON s2.id = o.store_id LEFT JOIN garments g ON g.id = oi.garment_id WHERE wbi.bill_id = ? ORDER BY store_name, o.order_number`, [id]);
    const groups = new Map<string, Row[]>();
    for (const it of items) (groups.get(it.store_name) ?? groups.set(it.store_name, []).get(it.store_name)!).push(it);
    const r2 = (n: unknown) => wiInrFormat(flt(n));
    const u = (p: string) => ctx.baseUrl(p);

    return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${b.bill_number} - ${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #e9ecef; font-family: "Segoe UI", "Noto Sans", Arial, sans-serif; color: #222; font-size: 12px; }
  .toolbar { max-width: 210mm; margin: 12px auto 0; display: flex; gap: 8px; justify-content: flex-end; }
  .toolbar button, .toolbar a { font: inherit; padding: 6px 14px; border: 1px solid #0b3d91; background: #0b3d91; color: #fff; border-radius: 4px; cursor: pointer; text-decoration: none; }
  .toolbar a.secondary { background: #fff; color: #0b3d91; }
  .page { width: 210mm; min-height: 297mm; margin: 12px auto; background: #fff; padding: 12mm 12mm 10mm; position: relative; box-shadow: 0 1px 6px rgba(0,0,0,.25); page-break-after: always; }
  .page:last-of-type { page-break-after: auto; }
  .box { border: 1px solid #9aa0a6; min-height: 262mm; display: flex; flex-direction: column; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; padding: 8px 12px 6px; border-bottom: 1px solid #9aa0a6; }
  .company { font-size: 11px; line-height: 1.35; }
  .company .name { font-size: 18px; font-weight: 700; margin-bottom: 3px; }
  .doc-title { font-size: 30px; font-weight: 300; letter-spacing: .5px; padding-bottom: 2px; }
  .meta { display: flex; border-bottom: 1px solid #9aa0a6; }
  .meta > div { flex: 1; padding: 4px 12px; }
  .meta > div + div { border-left: 1px solid #9aa0a6; }
  .meta table { width: 100%; border-collapse: collapse; }
  .meta td { padding: 1px 0; vertical-align: top; }
  .meta td.l { width: 38%; color: #444; }
  .meta td.v { font-weight: 700; }
  .billto-h { background: #f1f2f4; border-bottom: 1px solid #9aa0a6; padding: 3px 12px; font-weight: 700; font-size: 11px; }
  .billto { padding: 8px 12px; font-weight: 700; font-size: 13px; border-bottom: 1px solid #9aa0a6; }
  .subject { padding: 8px 12px 10px; border-bottom: 1px solid #9aa0a6; }
  .subject .lbl { color: #555; }
  .subject .val { margin-top: 6px; font-size: 12px; }
  table.items { width: 100%; border-collapse: collapse; }
  table.items th { background: #f1f2f4; text-align: left; padding: 4px 8px; border-bottom: 1px solid #9aa0a6; border-top: 0; font-weight: 700; }
  table.items td { padding: 4px 8px; border-bottom: 1px solid #9aa0a6; vertical-align: top; }
  table.items .num { text-align: right; white-space: nowrap; }
  table.items .sub { color: #777; font-size: 10.5px; }
  table.items th.c1, table.items td.c1 { width: 28px; }
  table.items th.c3, table.items td.c3 { width: 70px; } table.items th.c4, table.items td.c4 { width: 90px; } table.items th.c5, table.items td.c5 { width: 100px; }
  .bottom { display: flex; border-bottom: 1px solid #9aa0a6; }
  .bottom .left { flex: 1.1; padding: 8px 12px; }
  .bottom .right { flex: 1; border-left: 1px solid #9aa0a6; }
  .words { font-style: italic; font-weight: 700; margin: 2px 0 12px; }
  .lbl { color: #444; }
  .notes { white-space: pre-line; margin-top: 2px; }
  .totals { width: 100%; border-collapse: collapse; }
  .totals td { padding: 3px 10px; text-align: right; }
  .totals tr.strong td { font-weight: 700; }
  .totals tr.big td { font-weight: 700; font-size: 14px; padding-top: 6px; }
  .sign { border-top: 1px solid #9aa0a6; margin-top: 90px; padding: 4px 10px; text-align: center; color: #333; }
  .spacer { flex: 1; }
  .watermark { position: absolute; top: 90mm; left: 0; right: 0; text-align: center; font-size: 120px; font-weight: 800; color: rgba(200,0,0,.13); transform: rotate(-25deg); pointer-events: none; letter-spacing: 8px; }
  .annex h2 { font-size: 15px; margin: 0 0 2px; } .annex .sm { color: #555; margin-bottom: 10px; }
  .annex table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  .annex th { background: #f1f2f4; text-align: left; padding: 4px 8px; border: 1px solid #c9cdd2; }
  .annex td { padding: 4px 8px; border: 1px solid #c9cdd2; }
  .annex tr.store td { background: #fafbfc; font-weight: 700; }
  .annex .num { text-align: right; white-space: nowrap; }
  @media print {
    @page { size: A4; margin: 0; }
    body { background: #fff; }
    .toolbar { display: none; }
    .page { margin: 0; box-shadow: none; width: 210mm; min-height: 297mm; }
  }
</style>
</head>
<body>
<div class="toolbar">
  <a class="secondary" href="${u('modules/workshop/billing.php?id=' + b.id)}">&larr; Back to bill</a>
  <button onclick="window.print()">Print / Save as PDF</button>
</div>

<div class="page">
  ${isVoid ? html`<div class="watermark">VOID</div>` : ''}
  <div class="box">
    <div class="head">
      <div class="company">
        <div class="name">${companyName}</div>
        ${addressLines.map((line) => html`<div>${line}</div>`)}
        ${!phpEmpty(iss.gstin) ? html`<div>GSTIN ${iss.gstin}</div>` : ''}
        ${!phpEmpty(iss.phone) ? html`<div>${iss.phone}</div>` : ''}
        ${!phpEmpty(iss.email) ? html`<div>${iss.email}</div>` : ''}
      </div>
      <div class="doc-title">${title}</div>
    </div>

    <div class="meta">
      <div>
        <table>
          <tr><td class="l">#</td><td class="v">: ${b.bill_number}</td></tr>
          <tr><td class="l">Invoice Date</td><td class="v">: ${dmy(b.invoice_date)}</td></tr>
          <tr><td class="l">Terms</td><td class="v">: ${String(b.terms_label ?? '')}</td></tr>
          <tr><td class="l">Due Date</td><td class="v">: ${dmy(b.due_date)}</td></tr>
        </table>
      </div>
      <div>
        ${!phpEmpty(iss.state_name) ? html`
        <table>
          <tr><td class="l">Place Of Supply</td><td class="v">: ${iss.state_name}${!phpEmpty(iss.state_code) ? ' (' + iss.state_code + ')' : ''}</td></tr>
        </table>` : ''}
      </div>
    </div>

    <div class="billto-h">Bill To</div>
    <div class="billto">${String(billTo ?? '')}</div>

    <div class="subject">
      <div class="lbl">Subject :</div>
      <div class="val">${String(b.subject ?? '')}</div>
    </div>

    <table class="items">
      <thead><tr><th class="c1">#</th><th class="c2">Item &amp; Description</th><th class="c3 num">Qty</th><th class="c4 num">Rate</th><th class="c5 num">Amount</th></tr></thead>
      <tbody>
        <tr>
          <td class="c1">1</td>
          <td class="c2">${itemDesc}<div class="sub">${periodLabel}</div></td>
          <td class="c3 num">1.00</td>
          <td class="c4 num">${r2(subTotal)}</td>
          <td class="c5 num">${r2(subTotal)}</td>
        </tr>
      </tbody>
    </table>

    <div class="bottom">
      <div class="left">
        <div class="lbl">Total In Words</div>
        <div class="words">${wiInrInWords(total)}</div>
        ${phpTrim(String(iss.notes ?? '')) !== '' ? html`
          <div class="lbl">Notes</div>
          <div class="notes">${String(iss.notes)}</div>` : ''}
        ${phpTrim(String(iss.bank_details ?? '')) !== '' ? html`
          <div class="lbl" style="margin-top:10px;">Payment Details</div>
          <div class="notes">${String(iss.bank_details)}</div>` : ''}
      </div>
      <div class="right">
        <table class="totals">
          <tr><td>Sub Total</td><td>${r2(subTotal)}</td></tr>
          ${gstMode !== 'none' ? html`<tr><td>GST (${String(gstRate)}%)</td><td>${r2(gstAmount)}</td></tr>` : ''}
          <tr class="strong"><td>Total</td><td>₹${r2(total)}</td></tr>
          ${paid > 0 ? html`<tr><td>Payment Made</td><td>(-) ${r2(paid)}</td></tr>` : ''}
          <tr class="big"><td>Balance Due</td><td>₹${r2(balance)}</td></tr>
        </table>
        <div class="sign">Authorized Signature</div>
      </div>
    </div>
    <div class="spacer"></div>
  </div>
</div>

${!isVoid && items.length ? html`
<div class="page annex">
  <h2>Annexure to invoice ${b.bill_number}</h2>
  <div class="sm">${String(b.subject ?? '')} &middot; ${periodLabel} &middot; garments handled for ${String(billTo ?? '')}</div>
  <table>
    <thead><tr><th>Order</th><th>Customer</th><th>Garment</th><th class="num">Bill value</th></tr></thead>
    <tbody>
      ${[...groups].map(([storeName, rows]) => html`
        ${int(b.is_combined) === 1 ? html`
          <tr class="store"><td colspan="3">${storeName} (${rows.length} ${plural(rows.length, 'item')})</td><td class="num">${r2(rows.reduce((a, r) => a + flt(r.item_value), 0))}</td></tr>` : ''}
        ${rows.map((it) => html`
          <tr><td>${it.short_order_code ?? it.order_number}</td><td>${it.customer_name}</td><td>${String(it.garment_name ?? '')}</td><td class="num">${r2(it.item_value)}</td></tr>`)}`)}
    </tbody>
    <tfoot>
      <tr><td colspan="3" style="text-align:right;font-weight:700;">Total bill value of these garments</td><td class="num" style="font-weight:700;">${r2(b.total_value)}</td></tr>
      <tr><td colspan="3" style="text-align:right;">Workshop share (${String(flt(b.share_percent))}%)</td><td class="num">${r2(b.workshop_share)}</td></tr>
      ${gstMode !== 'none' ? html`<tr><td colspan="3" style="text-align:right;">GST (${String(gstRate)}%)</td><td class="num">${r2(gstAmount)}</td></tr>` : ''}
      <tr><td colspan="3" style="text-align:right;font-weight:700;">Invoice total</td><td class="num" style="font-weight:700;">${r2(total)}</td></tr>
    </tfoot>
  </table>
</div>` : ''}
</body>
</html>`;
  });
}
