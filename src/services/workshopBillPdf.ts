import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/pool.js';
import { phpEmpty, phpRound } from '../lib/php.js';
import { cp1252 } from '../pdf/cp1252.js';
import { MiniFpdf } from '../pdf/miniFpdf.js';
import { wiInrFormat, wiInrInWords, wiPeriodLabel } from './workshopInvoice.js';

type Row = Record<string, any>;
type RGB = [number, number, number];

const INK: RGB = [17, 24, 39];
const MUTED: RGB = [100, 116, 139];
const LINE: RGB = [154, 160, 166];
const SOFT: RGB = [241, 242, 244];

const a = cp1252;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => { const n = parseFloat(str(v)); return Number.isFinite(n) ? n : 0; };
const fill = (p: MiniFpdf, c: RGB) => p.setFillColor(c[0], c[1], c[2]);
const draw = (p: MiniFpdf, c: RGB) => p.setDrawColor(c[0], c[1], c[2]);
const text = (p: MiniFpdf, c: RGB) => p.setTextColor(c[0], c[1], c[2]);
/** rtrim(rtrim(number_format($n, 2, '.', ''), '0'), '.') */
const numStr = (v: unknown) => num(v).toFixed(2).replace(/0+$/, '').replace(/\.+$/, '');
const dmy = (d: unknown) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(d)); return phpEmpty(d) || !m ? '' : `${m[3]}/${m[2]}/${m[1]}`; };

function clip(pdf: MiniFpdf, t: string, width: number): string {
  if (pdf.getStringWidth(a(t)) <= width) return t;
  let chars = Array.from(t);
  while (chars.length > 0 && pdf.getStringWidth(a(chars.join('') + '...')) > width) chars = chars.slice(0, -1);
  return chars.join('').replace(/\s+$/, '') + '...';
}

export interface WorkshopBillPdfResult { success: boolean; file_path: string | null; error: string | null; bill_number: string | null; filename: string | null }

/**
 * Port of includes/WorkshopBillPdfService.php -- the workshop invoice (invoice page + garment annexure) as a PDF, for
 * WhatsApp, the web "Download PDF" button and the app's Print/Share. Printed from the snapshot taken when the invoice
 * was issued, exactly like bill_print.php.
 */
export class WorkshopBillPdfService {
  constructor(private readonly db: Db, private readonly log: (m: string) => void = console.error) {}

  async generate(billId: number): Promise<WorkshopBillPdfResult> {
    const fail = (error: string): WorkshopBillPdfResult => ({ success: false, file_path: null, error, bill_number: null, filename: null });
    const b = (await this.db.query<Row>(
      `SELECT wb.*, CASE WHEN wb.is_combined = 1 THEN 'All stores (combined)' ELSE s.store_name END AS store_label
       FROM workshop_bills wb LEFT JOIN stores s ON s.id = wb.store_id WHERE wb.id = ?`, [billId]))[0];
    if (!b) return fail('Bill not found.');
    let snap: Row = {};
    try { snap = JSON.parse(str(b.snapshot_json)) || {}; } catch { snap = {}; }
    const iss: Row = snap.issuer ?? {};
    const items = await this.db.query<Row>(
      `SELECT wbi.item_value, o.order_number, o.short_order_code, g.garment_name, c.full_name AS customer_name, COALESCE(s2.store_name, 'Unassigned') AS store_name
       FROM workshop_bill_items wbi
       JOIN order_items oi ON oi.id = wbi.order_item_id
       JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN stores s2 ON s2.id = o.store_id
       LEFT JOIN garments g ON g.id = oi.garment_id
       WHERE wbi.bill_id = ? ORDER BY store_name, o.order_number`, [billId]);
    const path = join(tmpdir(), `wbill_${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(path, WorkshopBillPdfService.render(b, snap, iss, items).output());
    } catch (e) {
      this.log(`WorkshopBillPdfService: ${(e as Error).message}`);
      return fail('Could not generate the invoice PDF.');
    }
    const n = str(b.bill_number);
    return { success: true, file_path: path, error: null, bill_number: n, filename: 'Invoice-' + n.replace(/[^A-Za-z0-9_-]+/g, '-') + '.pdf' };
  }

  static render(b: Row, snap: Row, iss: Row, items: Row[]): MiniFpdf {
    const total = num(b.grand_total);
    const gstMode = str(b.gst_mode);
    const gstAmount = num(b.gst_amount);
    const gstRate = num(b.gst_rate);
    const subTotal = phpRound(total - gstAmount, 2);
    const paid = num(b.amount_paid);
    const isVoid = b.status === 'Void';
    const balance = isVoid ? 0.0 : phpRound(total - paid, 2);
    const title = str(iss.gstin).trim() !== '' ? 'TAX INVOICE' : 'INVOICE';
    const billTo = str(snap.bill_to ?? b.store_label);
    const itemDesc = str(snap.item_description ?? 'Dry Clean charges');
    const periodLabel = str(snap.period_label ?? wiPeriodLabel(b.period_start, b.period_end));
    const fmt = (n: unknown) => wiInrFormat(num(n));

    const pdf = new MiniFpdf();
    pdf.setMargins(12, 12, 12);
    pdf.setTitle(a(`${b.bill_number} - ${title}`));
    pdf.setAuthor(a(str(iss.company_name)));
    pdf.addPage();
    const x0 = 12, w = 186, right = x0 + w;

    // outer box
    draw(pdf, LINE); pdf.setLineWidth(0.3);
    pdf.rect(x0, 12, w, 270);

    // header: company (left) + title (right)
    let y = 16;
    pdf.setXY(x0 + 4, y);
    text(pdf, INK);
    pdf.setFont('Helvetica', 'B', 15);
    pdf.cell(110, 7, a(str(iss.company_name)), 2);
    pdf.setFont('Helvetica', '', 9);
    const lines = str(iss.address).split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (!phpEmpty(iss.gstin)) lines.push('GSTIN ' + str(iss.gstin));
    if (!phpEmpty(iss.phone)) lines.push(str(iss.phone));
    if (!phpEmpty(iss.email)) lines.push(str(iss.email));
    for (const l of lines) { pdf.setX(x0 + 4); pdf.cell(110, 4.4, a(l), 2); }
    pdf.setXY(x0 + 110, y + 2);
    pdf.setFont('Helvetica', '', 22);
    pdf.cell(w - 114, 10, title, 0, 'R');
    y = Math.max(pdf.getY(), y + 8 + lines.length * 4.4) + 4;
    pdf.line(x0, y, right, y);

    // meta
    pdf.setFont('Helvetica', '', 9.5);
    const meta: [string, string][] = [['#', str(b.bill_number)], ['Invoice Date', dmy(b.invoice_date)], ['Terms', str(b.terms_label)], ['Due Date', dmy(b.due_date)]];
    let yy = y + 2;
    for (const [k, v] of meta) {
      pdf.setXY(x0 + 4, yy); text(pdf, MUTED); pdf.setFont('Helvetica', '', 9.5); pdf.cell(30, 5, k, 0);
      text(pdf, INK); pdf.setFont('Helvetica', 'B', 9.5); pdf.cell(60, 5, ': ' + a(v), 0);
      yy += 5;
    }
    if (!phpEmpty(iss.state_name)) {
      pdf.setXY(x0 + 100, y + 2); text(pdf, MUTED); pdf.setFont('Helvetica', '', 9.5); pdf.cell(28, 5, 'Place Of Supply', 0);
      text(pdf, INK); pdf.setFont('Helvetica', 'B', 9.5);
      pdf.cell(55, 5, ': ' + a(str(iss.state_name) + (!phpEmpty(iss.state_code) ? ' (' + str(iss.state_code) + ')' : '')), 0);
    }
    y = yy + 2;
    pdf.line(x0, y, right, y);

    // bill to
    fill(pdf, SOFT);
    pdf.rect(x0, y, w, 7, 'F');
    pdf.setXY(x0 + 4, y + 1); text(pdf, INK); pdf.setFont('Helvetica', 'B', 9); pdf.cell(60, 5, 'Bill To', 0);
    y += 7; pdf.line(x0, y, right, y);
    pdf.setXY(x0 + 4, y + 2); pdf.setFont('Helvetica', 'B', 11); pdf.cell(w - 8, 6, a(billTo), 0);
    y += 10; pdf.line(x0, y, right, y);

    // subject
    pdf.setXY(x0 + 4, y + 2); text(pdf, MUTED); pdf.setFont('Helvetica', '', 9); pdf.cell(40, 5, 'Subject :', 2);
    text(pdf, INK); pdf.setFont('Helvetica', '', 10);
    pdf.setX(x0 + 4); pdf.cell(w - 8, 6, a(str(b.subject)), 0);
    y += 17; pdf.line(x0, y, right, y);

    // items table (one line, like the web invoice)
    fill(pdf, SOFT); pdf.rect(x0, y, w, 7, 'F');
    pdf.setFont('Helvetica', 'B', 9); text(pdf, INK);
    pdf.setXY(x0 + 3, y + 1); pdf.cell(10, 5, '#', 0);
    pdf.cell(90, 5, 'Item & Description', 0);
    pdf.cell(20, 5, 'Qty', 0, 'R'); pdf.cell(30, 5, 'Rate', 0, 'R'); pdf.cell(30, 5, 'Amount', 0, 'R');
    y += 7; pdf.line(x0, y, right, y);
    pdf.setFont('Helvetica', '', 10);
    pdf.setXY(x0 + 3, y + 2); pdf.cell(10, 5, '1', 0);
    pdf.cell(90, 5, a(itemDesc), 0);
    pdf.cell(20, 5, '1.00', 0, 'R'); pdf.cell(30, 5, fmt(subTotal), 0, 'R'); pdf.cell(30, 5, fmt(subTotal), 0, 'R');
    pdf.setXY(x0 + 13, y + 7); text(pdf, MUTED); pdf.setFont('Helvetica', '', 8.5); pdf.cell(90, 4, a(periodLabel), 0);
    y += 15; pdf.line(x0, y, right, y);

    // bottom: words / notes (left), totals (right)
    const leftW = 96, by = y;
    pdf.line(x0 + leftW, by, x0 + leftW, by + 90);
    pdf.setXY(x0 + 4, by + 3); text(pdf, MUTED); pdf.setFont('Helvetica', '', 9); pdf.cell(60, 4.5, 'Total In Words', 2);
    text(pdf, INK); pdf.setFont('Helvetica', 'BI', 9.5);
    pdf.setX(x0 + 4); pdf.multiCell(leftW - 8, 4.8, a(wiInrInWords(total)));
    let ly = pdf.getY() + 4;
    for (const [lbl, txt] of [['Notes', str(iss.notes).trim()], ['Payment Details', str(iss.bank_details).trim()]] as [string, string][]) {
      if (txt === '') continue;
      pdf.setXY(x0 + 4, ly); text(pdf, MUTED); pdf.setFont('Helvetica', '', 9); pdf.cell(60, 4.5, lbl, 2);
      text(pdf, INK); pdf.setFont('Helvetica', '', 9);
      pdf.setX(x0 + 4); pdf.multiCell(leftW - 8, 4.5, a(txt));
      ly = pdf.getY() + 4;
    }
    const rx = x0 + leftW, rw = w - leftW;
    let ty = by + 3;
    const row = (label: string, val: string, bold = false, size = 9.5) => {
      pdf.setXY(rx + 4, ty); pdf.setFont('Helvetica', bold ? 'B' : '', size);
      pdf.cell(rw - 8 - 38, 6, label, 0, 'R'); pdf.cell(38, 6, val, 0, 'R'); ty += 6;
    };
    text(pdf, INK);
    row('Sub Total', fmt(subTotal));
    if (gstMode !== 'none') row('GST (' + numStr(gstRate) + '%)', fmt(gstAmount));
    row('Total', 'Rs. ' + fmt(total), true);
    if (paid > 0) row('Payment Made', '(-) ' + fmt(paid));
    ty += 2;
    row('Balance Due', 'Rs. ' + fmt(balance), true, 12);
    pdf.line(x0 + leftW, by + 62, right, by + 62);
    pdf.setXY(rx, by + 64); text(pdf, MUTED); pdf.setFont('Helvetica', '', 9);
    pdf.cell(rw, 5, 'Authorized Signature', 0, 'C');
    const yb = Math.max(by + 90, ly);
    pdf.line(x0, yb, right, yb);

    if (isVoid) {
      text(pdf, [235, 190, 190]); pdf.setFont('Helvetica', 'B', 80);
      pdf.setXY(x0, 120); pdf.cell(w, 40, 'VOID', 0, 'C');
    }

    // annexure
    if (!isVoid && items.length > 0) {
      const groups = new Map<string, Row[]>();
      for (const it of items) { const k = str(it.store_name); (groups.get(k) ?? groups.set(k, []).get(k)!).push(it); }
      let ay = 0;
      const newPage = () => {
        pdf.addPage();
        text(pdf, INK); pdf.setFont('Helvetica', 'B', 13);
        pdf.setXY(12, 14); pdf.cell(186, 7, a('Annexure to invoice ' + str(b.bill_number)), 2);
        pdf.setFont('Helvetica', '', 9); text(pdf, MUTED);
        pdf.setX(12); pdf.cell(186, 5, a(str(b.subject) + '  |  ' + periodLabel + '  |  garments handled for ' + billTo), 2);
        ay = 29;
        fill(pdf, SOFT); draw(pdf, [201, 205, 210]);
        pdf.setFont('Helvetica', 'B', 9); text(pdf, INK);
        pdf.setXY(12, ay); pdf.cellB(28, 6, 'Order', 1, 0, 'L', true); pdf.cellB(66, 6, 'Customer', 1, 0, 'L', true);
        pdf.cellB(62, 6, 'Garment', 1, 0, 'L', true); pdf.cellB(30, 6, 'Bill value', 1, 0, 'R', true);
        ay += 6;
      };
      newPage();
      for (const [storeName, rows] of groups) {
        if (num(b.is_combined) === 1) {
          if (ay > 270) newPage();
          const sub = rows.reduce((s, r) => s + num(r.item_value), 0);
          pdf.setFont('Helvetica', 'B', 9); text(pdf, INK); fill(pdf, [250, 251, 252]);
          pdf.setXY(12, ay);
          pdf.cellB(156, 6, a(storeName + ' (' + rows.length + ' item' + (rows.length === 1 ? '' : 's') + ')'), 1, 0, 'L', true);
          pdf.cellB(30, 6, fmt(sub), 1, 0, 'R', true); ay += 6;
        }
        for (const it of rows) {
          if (ay > 272) newPage();
          pdf.setFont('Helvetica', '', 9); text(pdf, INK);
          pdf.setXY(12, ay);
          pdf.cellB(28, 5.6, a(str(phpEmpty(it.short_order_code) ? it.order_number : it.short_order_code)), 1, 0);
          pdf.cellB(66, 5.6, a(clip(pdf, str(it.customer_name), 62)), 1, 0);
          pdf.cellB(62, 5.6, a(clip(pdf, str(it.garment_name), 58)), 1, 0);
          pdf.cellB(30, 5.6, fmt(it.item_value), 1, 0, 'R'); ay += 5.6;
        }
      }
      if (ay > 250) newPage();
      const foot: [string, string, boolean][] = [['Total bill value of these garments', fmt(b.total_value), true],
        ['Workshop share (' + numStr(b.share_percent) + '%)', fmt(b.workshop_share), false]];
      if (gstMode !== 'none') foot.push(['GST (' + numStr(gstRate) + '%)', fmt(gstAmount), false]);
      foot.push(['Invoice total', fmt(total), true]);
      for (const [l, v, bold] of foot) {
        pdf.setFont('Helvetica', bold ? 'B' : '', 9); pdf.setXY(12, ay);
        pdf.cellB(156, 6, a(l), 1, 0, 'R'); pdf.cellB(30, 6, v, 1, 0, 'R'); ay += 6;
      }
    }
    return pdf;
  }
}
