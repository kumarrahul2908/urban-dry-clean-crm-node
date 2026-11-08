import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/pool.js';
import { cp1252 } from '../pdf/cp1252.js';
import { MiniFpdf } from '../pdf/miniFpdf.js';
import { numberFormat2, phpEmpty } from '../lib/php.js';
import { getSetting } from './settings.js';
import type { Business } from './invoicePdf.js';

type Row = Record<string, any>;
type RGB = [number, number, number];

const NAVY: RGB = [10, 42, 102];
const BRAND: RGB = [11, 61, 145];
const AQUA: RGB = [11, 159, 179];
const INK: RGB = [17, 24, 39];
const MUTED: RGB = [100, 116, 139];
const LINE: RGB = [226, 232, 240];
const SOFT: RGB = [243, 246, 251];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const f = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export interface ChallanOrderRow {
  id: number; order_number: string; short_order_code: string | null; order_date: unknown; customer_name: string; mobile: string;
  subtotal: unknown; discount_amount: unknown; tax_amount: unknown; grand_total: unknown;
}
export interface ChallanLineRow { order_id: number; garment_name: string; service_name: string; quantity: unknown; pieces_per_unit: unknown; unit_price: unknown; total: unknown }
/** One rendered row of the items table — already resolved for single-order (as-is) or combined (aggregated by garment name, physical-piece-counted) mode. */
export interface ChallanLine { garment_name: string; service_name: string; quantity: number; amount: number }

/**
 * Challan PDF (delivery/packing-note document) — same visual family as InvoicePdfService (palette,
 * header band, boxed info sections) but its own self-contained class, same as the two were separate
 * classes on the live PHP app. Single-order mode lists that order's items as-is; combined mode (more
 * than one order on the same challan) aggregates by garment NAME across every included order, since a
 * combined challan is one packing note for a mixed pickup/delivery run, not a per-order breakdown.
 * "With Amount" / "Without Amount" (challans.with_amount) controls whether rate/amount columns and the
 * totals section are shown at all — a Without Amount challan is purely a count of what's being handed
 * over, with no pricing on it.
 */
export class ChallanPdfService {
  constructor(private readonly db: Db, private readonly appName: string, private readonly log: (m: string) => void = console.error) {}

  /** Returns a temp file the caller deletes when done with it. */
  async generate(challanId: number): Promise<{ success: boolean; file_path?: string; error?: string }> {
    const [challan] = await this.db.query<Row>('SELECT * FROM challans WHERE id = ?', [challanId]);
    if (!challan) return { success: false, error: 'Challan not found.' };
    const orderIds = (await this.db.query<Row>('SELECT order_id FROM challan_orders WHERE challan_id = ? ORDER BY order_id', [challanId])).map((r) => Number(r.order_id));
    if (!orderIds.length) return { success: false, error: 'This challan has no orders on it.' };

    const orders = await this.db.query<ChallanOrderRow>(
      `SELECT o.id, o.order_number, o.short_order_code, o.order_date, o.subtotal, o.discount_amount, o.tax_amount, o.grand_total, c.full_name AS customer_name, c.mobile
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id IN (?) ORDER BY o.id`, [orderIds]);
    const lines = await this.db.query<ChallanLineRow>(
      `SELECT oi.order_id, COALESCE(g.garment_name, CONCAT('Laundry: ', s.service_name)) AS garment_name, COALESCE(s.service_name, 'Unknown Service') AS service_name, oi.quantity, oi.pieces_per_unit, oi.unit_price, oi.total
       FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id
       WHERE oi.order_id IN (?) ORDER BY oi.id`, [orderIds]);

    const business: Business = {
      name: str(await getSetting(this.db, 'business_name', this.appName)),
      address: str(await getSetting(this.db, 'address', '')),
      phone: str(await getSetting(this.db, 'phone', '')),
      gstin: str(await getSetting(this.db, 'gstin', '')),
      currencySymbol: str(await getSetting(this.db, 'currency_symbol', 'Rs.')),
    };
    const withAmount = !!Number(challan.with_amount);
    const combined = orders.length > 1;

    try {
      const path = join(tmpdir(), `challan_${challanId}_${randomBytes(6).toString('hex')}.pdf`);
      await writeFile(path, ChallanPdfService.render(challan, orders, lines, business, withAmount, combined).output());
      return { success: true, file_path: path };
    } catch (e) {
      this.log(`ChallanPdfService::generate — ${(e as Error).message}`);
      return { success: false, error: 'PDF generation failed.' };
    }
  }

  /** Pure layout. */
  static render(challan: Row, orders: ChallanOrderRow[], lines: ChallanLineRow[], business: Business, withAmount: boolean, combined: boolean): MiniFpdf {
    const pdf = new MiniFpdf();
    const money = (v: unknown) => `${business.currencySymbol} ${numberFormat2(f(v))}`;
    pdf.setTitle(`Challan ${str(challan.challan_number)}`);
    pdf.setAuthor(business.name);
    pdf.addPage();
    ChallanPdfService.header(pdf, challan, business);
    // Confirmed business rule: a combined challan shows no per-order customer section (just order
    // numbers + the garments summary) and never a per-garment-name line price -- the same garment
    // name can carry a different rate on different orders, so a per-line amount would be misleading.
    // With Amount instead sums each financial component across every included order, as one totals
    // block, never inside the garments table itself.
    let y = combined ? ChallanPdfService.ordersBox(pdf, orders) : ChallanPdfService.singleOrderBox(pdf, orders[0]!);
    const rows = combined ? ChallanPdfService.aggregateByGarment(lines) : ChallanPdfService.perOrderLines(lines);
    y = ChallanPdfService.itemsTable(pdf, rows, withAmount, combined, y + 6, business, money);
    if (withAmount) { if (combined) ChallanPdfService.combinedTotals(pdf, orders, y + 4, money); else ChallanPdfService.totals(pdf, rows, y + 4, money); }
    ChallanPdfService.footer(pdf, business);
    return pdf;
  }

  // ------------------------------------------------------------------ data shaping
  /** Single-order mode: every line as-is, in order -- the ordered-unit quantity, not multiplied by
   * pieces_per_unit (that physical-piece convention is combined mode's own aggregation rule below). */
  private static perOrderLines(lines: ChallanLineRow[]): ChallanLine[] {
    return lines.map((l) => ({ garment_name: l.garment_name, service_name: l.service_name, quantity: f(l.quantity), amount: f(l.total) }));
  }

  /** Combined mode: folded by garment NAME alone across every order on the challan (service AND amount
   * are dropped -- see the business rule above). Quantity is physical pieces (quantity *
   * pieces_per_unit, order_items' own order-time-frozen copy, same convention used everywhere else in
   * this app a 2-piece Set garment must not be undercounted as 1). */
  private static aggregateByGarment(lines: ChallanLineRow[]): ChallanLine[] {
    const byName = new Map<string, ChallanLine>();
    for (const l of lines) {
      const qty = f(l.quantity) * Math.max(1, f(l.pieces_per_unit) || 1);
      const existing = byName.get(l.garment_name);
      if (existing) existing.quantity += qty;
      else byName.set(l.garment_name, { garment_name: l.garment_name, service_name: '', quantity: qty, amount: 0 });
    }
    return [...byName.values()].sort((a, b) => a.garment_name.localeCompare(b.garment_name));
  }

  // ------------------------------------------------------------------ sections
  private static header(pdf: MiniFpdf, c: Row, b: Business) {
    fill(pdf, NAVY); pdf.rect(0, 0, 210, 36, 'F');
    fill(pdf, AQUA); pdf.rect(0, 36, 210, 1.4, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setXY(15, 9);
    pdf.setFont('Helvetica', 'B', 19);
    pdf.cell(120, 9, ascii(b.name), 2);
    pdf.setFont('Helvetica', '', 9);
    if (b.address !== '') pdf.cell(120, 4.6, ascii(b.address), 2);
    const contact = [b.phone !== '' ? `Phone: ${b.phone}` : '', b.gstin !== '' ? `GSTIN: ${b.gstin}` : ''].filter((x) => !phpEmpty(x));
    if (contact.length) pdf.cell(120, 4.6, ascii(contact.join('   |   ')), 2);

    pdf.setXY(125, 10);
    pdf.setFont('Helvetica', 'B', 22);
    pdf.cell(70, 10, 'CHALLAN', 2, 'R');
    pdf.setFont('Helvetica', '', 9.5);
    pdf.cell(70, 5, ascii(str(c.challan_number)), 2, 'R');
    pdf.cell(70, 5, ascii(`Date: ${dateStr(c.created_at)}`), 2, 'R');
  }

  /** Single-order mode: one "CUSTOMER" / "ORDER DETAILS" box pair, same shape InvoicePdfService uses. */
  private static singleOrderBox(pdf: MiniFpdf, o: ChallanOrderRow): number {
    const top = 45, h = 26;
    for (const [x, title] of [[15, 'CUSTOMER'], [110, 'ORDER DETAILS']] as const) {
      fill(pdf, SOFT); draw(pdf, LINE);
      pdf.setLineWidth(0.3);
      pdf.rect(x, top, 85, h, 'DF');
      pdf.setXY(x + 5, top + 4);
      pdf.setFont('Helvetica', 'B', 7.5);
      text(pdf, MUTED);
      pdf.cell(75, 4, title, 2);
    }
    pdf.setXY(20, top + 9.5);
    pdf.setFont('Helvetica', 'B', 11);
    text(pdf, INK);
    pdf.cell(75, 5.5, ascii(clip(pdf, o.customer_name, 75)), 2);
    pdf.setFont('Helvetica', '', 9);
    text(pdf, MUTED);
    if (!phpEmpty(o.mobile)) pdf.cell(75, 4.6, ascii(`Mobile: ${o.mobile}`), 2);

    pdf.setXY(115, top + 9.5);
    pdf.setFont('Helvetica', '', 8.5);
    text(pdf, MUTED);
    pdf.cell(24, 4.8, 'Order no.', 0);
    pdf.setFont('Helvetica', 'B', 8.5);
    text(pdf, INK);
    pdf.cell(51, 4.8, ascii(str(o.short_order_code ?? o.order_number)), 0);
    pdf.setXY(115, top + 14.3);
    pdf.setFont('Helvetica', '', 8.5);
    text(pdf, MUTED);
    pdf.cell(24, 4.8, 'Order date', 0);
    pdf.setFont('Helvetica', 'B', 8.5);
    text(pdf, INK);
    pdf.cell(51, 4.8, ascii(dateStr(o.order_date, true)), 0);
    return top + h;
  }

  /** Combined mode: no customer section at all (an explicit, confirmed business rule -- a combined
   * challan can cover several different customers, and this is a packing/delivery note handed to a
   * driver or processing unit, not a customer-facing document) -- just the order numbers it covers. */
  private static ordersBox(pdf: MiniFpdf, orders: ChallanOrderRow[]): number {
    const top = 45;
    pdf.setXY(15, top);
    pdf.setFont('Helvetica', 'B', 8.5);
    text(pdf, MUTED);
    pdf.cell(180, 5, `ORDERS ON THIS CHALLAN (${orders.length})`, 2);
    let y = top + 6;
    fill(pdf, BRAND);
    pdf.rect(15, y, 180, 6.5, 'F');
    pdf.setFont('Helvetica', 'B', 8);
    pdf.setTextColor(255, 255, 255);
    pdf.setXY(17, y);
    pdf.cell(90, 6.5, 'Order #', 0);
    pdf.cell(88, 6.5, 'Date', 0);
    y += 6.5;
    let n = 0;
    for (const o of orders) {
      n++;
      if (n % 2 === 0) { fill(pdf, SOFT); pdf.rect(15, y, 180, 6, 'F'); }
      pdf.setXY(17, y + 1);
      pdf.setFont('Helvetica', '', 8.5);
      text(pdf, INK);
      pdf.cell(88, 4.5, ascii(clip(pdf, str(o.short_order_code ?? o.order_number), 88)), 0);
      pdf.cell(86, 4.5, ascii(dateStr(o.order_date)), 0);
      y += 6;
    }
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, y, 195, y);
    return y;
  }

  /** Combined mode drops the Service AND Amount columns entirely, regardless of with_amount --
   * garment-name-aggregated, no per-service breakdown once orders are mixed together, and never a
   * per-garment-name price (see the business rule on render()). */
  private static itemsTable(pdf: MiniFpdf, rows: ChallanLine[], withAmount: boolean, combined: boolean, y0: number, b: Business, money: (v: unknown) => string): number {
    const cols: [number, string, string][] = combined
      ? [[12, '#', 'C'], [95, 'Garment', 'L'], [73, 'Qty', 'R']]
      : (withAmount ? [[9, '#', 'C'], [68, 'Garment', 'L'], [43, 'Service', 'L'], [20, 'Qty', 'R'], [40, 'Amount', 'R']] : [[12, '#', 'C'], [98, 'Garment', 'L'], [50, 'Service', 'L'], [20, 'Qty', 'R']]);
    const rowCells = (n: number, r: ChallanLine): string[] => combined
      ? [String(n), r.garment_name, numStr(r.quantity)]
      : (withAmount ? [String(n), r.garment_name, r.service_name, numStr(r.quantity), money(r.amount)] : [String(n), r.garment_name, r.service_name, numStr(r.quantity)]);

    const drawHead = (y: number) => {
      fill(pdf, BRAND);
      pdf.rect(15, y, 180, 8, 'F');
      pdf.setFont('Helvetica', 'B', 8.5);
      pdf.setTextColor(255, 255, 255);
      let x = 15;
      for (const [w, label, align] of cols) {
        pdf.setXY(x + (align === 'L' ? 2 : 0), y);
        pdf.cell(w - (align === 'R' ? 2 : align === 'L' ? 2 : 0), 8, label, 0, align);
        x += w;
      }
      return y + 8;
    };
    let y = drawHead(y0);
    if (rows.length === 0) {
      pdf.setXY(15, y + 3);
      pdf.setFont('Helvetica', 'I', 9);
      text(pdf, MUTED);
      pdf.cell(180, 6, 'No garments on this challan.', 0, 'C');
      return y + 12;
    }
    let n = 0;
    for (const r of rows) {
      n++;
      const rowH = 7.5;
      if (y + rowH > 262) {
        ChallanPdfService.footer(pdf, b);
        pdf.addPage();
        y = drawHead(15);
      }
      if (n % 2 === 0) { fill(pdf, SOFT); pdf.rect(15, y, 180, rowH, 'F'); }
      const cells = rowCells(n, r);
      let x = 15;
      cols.forEach(([w, , align], i) => {
        pdf.setXY(x + (align === 'L' ? 2 : 0), y + 1.3);
        pdf.setFont('Helvetica', i === 1 ? 'B' : '', 9);
        text(pdf, i === 0 ? MUTED : INK);
        const inner = w - (align === 'C' ? 0 : 2);
        pdf.cell(inner, 5, ascii(clip(pdf, cells[i] ?? '', inner)), 0, align);
        x += w;
      });
      y += rowH;
    }
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, y, 195, y);
    return y;
  }

  private static totals(pdf: MiniFpdf, rows: ChallanLine[], y0: number, money: (v: unknown) => string) {
    let y = y0;
    if (y + 24 > 268) { pdf.addPage(); y = 20; }
    const totalQty = rows.reduce((s, r) => s + r.quantity, 0);
    const totalAmount = rows.reduce((s, r) => s + r.amount, 0);

    pdf.setXY(15, y + 2);
    pdf.setFont('Helvetica', 'B', 9);
    text(pdf, INK);
    pdf.cell(90, 5, ascii(`Total garments: ${numStr(totalQty)}`), 2);

    const x = 115, w = 80, lw = 44, vw = 32;
    fill(pdf, NAVY);
    pdf.rect(x, y, w, 10, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setXY(x + 3, y);
    pdf.setFont('Helvetica', 'B', 11);
    pdf.cell(lw - 3, 10, 'Total Value', 0, 'L');
    pdf.cell(vw, 10, ascii(money(totalAmount)), 0, 'R');
  }

  /** Combined mode's own With Amount block: each financial component summed across every included
   * order (never a per-garment line price -- see the business rule on render()). */
  private static combinedTotals(pdf: MiniFpdf, orders: ChallanOrderRow[], y0: number, money: (v: unknown) => string) {
    let y = y0;
    if (y + 34 > 268) { pdf.addPage(); y = 20; }
    const sum = (k: 'subtotal' | 'discount_amount' | 'tax_amount' | 'grand_total') => orders.reduce((s, o) => s + f(o[k]), 0);
    const rows: [string, string][] = [['Subtotal', money(sum('subtotal'))]];
    const discount = sum('discount_amount');
    if (discount > 0.009) rows.push(['Discount', `- ${money(discount)}`]);
    const tax = sum('tax_amount');
    if (tax > 0.009) rows.push(['Tax', money(tax)]);

    const x = 115, w = 80, lw = 44, vw = 32;
    let cy = y;
    for (const [label, value] of rows) {
      pdf.setXY(x, cy);
      pdf.setFont('Helvetica', '', 9.5);
      text(pdf, MUTED);
      pdf.cell(lw, 6.5, ascii(label), 0, 'L');
      text(pdf, INK);
      pdf.cell(vw, 6.5, ascii(value), 0, 'R');
      cy += 6.5;
    }
    cy += 1.5;
    fill(pdf, NAVY);
    pdf.rect(x, cy, w, 10, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setXY(x + 3, cy);
    pdf.setFont('Helvetica', 'B', 11);
    pdf.cell(lw - 3, 10, 'Grand Total', 0, 'L');
    pdf.cell(vw, 10, ascii(money(sum('grand_total'))), 0, 'R');
  }

  private static footer(pdf: MiniFpdf, b: Business) {
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, 272, 195, 272);
    pdf.setXY(15, 275);
    pdf.setFont('Helvetica', 'B', 10);
    text(pdf, BRAND);
    pdf.cell(180, 5, ascii(`${b.name} — Delivery Challan`), 2, 'C');
    pdf.setFont('Helvetica', '', 7.5);
    text(pdf, MUTED);
    pdf.cell(180, 4, ascii('This is a system-generated challan. For any query please share your order number' + (b.phone !== '' ? ` - call ${b.phone}` : '') + '.'), 2, 'C');
  }
}

// ------------------------------------------------------------------ helpers
const fill = (p: MiniFpdf, c: RGB) => p.setFillColor(c[0], c[1], c[2]);
const draw = (p: MiniFpdf, c: RGB) => p.setDrawColor(c[0], c[1], c[2]);
const text = (p: MiniFpdf, c: RGB) => p.setTextColor(c[0], c[1], c[2]);
const ascii = cp1252;

/** rtrim(rtrim(number_format($f, 2, '.', ''), '0'), '.') */
function numStr(v: unknown): string {
  return f(v).toFixed(2).replace(/0+$/, '').replace(/\.+$/, '');
}

/** date('d M Y' | 'd M Y, g:i A', strtotime($v)) for stored 'YYYY-MM-DD[ HH:MM:SS]' values. */
function dateStr(v: unknown, withTime = false): string {
  if (phpEmpty(v)) return '-';
  const s = str(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return s;
  const d = `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}`;
  return withTime && s.length > 10 ? `${d}, ${time12(`${m[4] ?? '00'}:${m[5] ?? '00'}`)}` : d;
}

function time12(t: string): string {
  const m = /(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Shortens text with "..." so it fits in $width mm at the current font. */
function clip(pdf: MiniFpdf, t: string, width: number): string {
  if (pdf.getStringWidth(ascii(t)) <= width) return t;
  let chars = Array.from(t);
  while (chars.length > 0 && pdf.getStringWidth(ascii(chars.join('') + '...')) > width) chars = chars.slice(0, -1);
  return chars.join('').replace(/\s+$/, '') + '...';
}
