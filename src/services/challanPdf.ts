import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/pool.js';
import { todayIn } from '../lib/dates.js';
import { numberFormat2, phpEmpty, phpRound } from '../lib/php.js';
import { cp1252 } from '../pdf/cp1252.js';
import { MiniFpdf } from '../pdf/miniFpdf.js';
import { getSetting } from './settings.js';

type Row = Record<string, any>;
type RGB = [number, number, number];

const NAVY: RGB = [10, 42, 102];
const BRAND: RGB = [11, 61, 145];
const AQUA: RGB = [11, 159, 179];
const INK: RGB = [17, 24, 39];
const MUTED: RGB = [100, 116, 139];
const LINE: RGB = [226, 232, 240];
const SOFT: RGB = [243, 246, 251];
const AMBER: RGB = [180, 83, 9];
const PACKAGING_LABELS: Record<string, string> = { FOLD: 'Fold', HANGER: 'Hanger', HALF_FOLD: 'Half Fold', HANGER_AND_FOLD: 'Hanger + Fold' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const a = cp1252;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const flt = (v: unknown) => { const n = parseFloat(str(v)); return Number.isFinite(n) ? n : 0; };
const fill = (p: MiniFpdf, c: RGB) => p.setFillColor(c[0], c[1], c[2]);
const draw = (p: MiniFpdf, c: RGB) => p.setDrawColor(c[0], c[1], c[2]);
const text = (p: MiniFpdf, c: RGB) => p.setTextColor(c[0], c[1], c[2]);
/** rtrim(rtrim(number_format($f, 2, '.', ''), '0'), '.') */
const num = (v: unknown) => flt(v).toFixed(2).replace(/0+$/, '').replace(/\.+$/, '');
const code = (o: Row) => str(phpEmpty(o.short_order_code) ? o.order_number : o.short_order_code);
/** array_filter() default: drops null, '' and '0'. */
const filterTruthy = (xs: (string | null)[]) => xs.filter((x): x is string => x !== null && x !== '' && x !== '0');
const pieces = (it: Row) => Math.round(flt(it.quantity) * (it.pieces_per_unit === null || it.pieces_per_unit === undefined ? 1 : Math.trunc(flt(it.pieces_per_unit))));

/** date('d M Y', strtotime($v)) for stored values; '-' when empty. */
function dmy(v: unknown): string {
  if (phpEmpty(v)) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  return m ? `${m[3]} ${MON[Number(m[2]) - 1]} ${m[1]}` : str(v);
}
/** date('g:i A', strtotime('HH:MM[:SS]')) */
function time12(t: string): string {
  const m = /(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

function clip(pdf: MiniFpdf, t: string, width: number): string {
  if (pdf.getStringWidth(a(t)) <= width) return t;
  let chars = Array.from(t);
  while (chars.length > 0 && pdf.getStringWidth(a(chars.join('') + '...')) > width) chars = chars.slice(0, -1);
  return chars.join('').replace(/\s+$/, '') + '...';
}

interface Business { name: string; address: string; phone: string }
type Money = (v: unknown) => string;
export interface ChallanPdfResult { success: boolean; file_path: string | null; error: string | null }

/**
 * Port of includes/ChallanPdfService.php -- customer Challan PDF (WhatsApp / download), single order, combined (summary or
 * order-wise) and Delivery formats, with or without amount. Same visual language as the invoice, drawn with the FPDF subset.
 */
export class ChallanPdfService {
  constructor(private readonly db: Db, private readonly appName: string, private readonly timezone: string, private readonly log: (m: string) => void = console.error) {}

  /** Returns a temp file the caller deletes when done with it. */
  async generate(orderIdsIn: number[], withAmount: boolean, challanNumber: string, combineFormat = 'aggregated'): Promise<ChallanPdfResult> {
    const orderIds = [...new Set(orderIdsIn.map((x) => Math.trunc(Number(x)) || 0))];
    if (!orderIds.length) return { success: false, file_path: null, error: 'No orders given.' };
    const ip = orderIds.map(() => '?').join(',');
    const orders = await this.db.query<Row>(
      `SELECT o.*, c.full_name, c.mobile, c.address, c.area, c.city, c.state, c.pincode
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id IN (${ip}) ORDER BY FIELD(o.id, ${ip})`, [...orderIds, ...orderIds]);
    if (!orders.length) return { success: false, file_path: null, error: 'Order(s) not found.' };

    const business: Business = {
      name: str(await getSetting(this.db, 'business_name', this.appName || 'Urban Dry Clean')),
      address: str(await getSetting(this.db, 'address', '')),
      phone: str(await getSetting(this.db, 'phone', '')),
    };
    const symbol = str(await getSetting(this.db, 'currency_symbol', 'Rs.'));
    const money: Money = (v) => `${symbol} ${numberFormat2(flt(v))}`;
    const today = this.todayLabel();

    try {
      const tmpPath = join(tmpdir(), `challan_${orderIds.join('-')}_${randomBytes(6).toString('hex')}.pdf`);
      let pdf: MiniFpdf;
      if (combineFormat === 'delivery') {
        const { itemsByOrder, defectsByItem } = await this.loadAll(orders);
        pdf = ChallanPdfService.renderDelivery(orders, itemsByOrder, defectsByItem, business, challanNumber, money, today);
      } else if (orders.length === 1) {
        const order = orders[0]!;
        const items = await this.fetchItemsForOrder(order);
        const defectsByItem = await this.fetchDefectsForItems(items.map((i) => Number(i.id)));
        pdf = ChallanPdfService.render(order, items, defectsByItem, business, withAmount, challanNumber, money);
      } else if (combineFormat === 'order_wise') {
        const { itemsByOrder, defectsByItem } = await this.loadAll(orders);
        pdf = ChallanPdfService.renderCombinedOrderWise(orders, itemsByOrder, defectsByItem, business, withAmount, challanNumber, money, today);
      } else {
        const summary = await this.fetchCombinedGarmentSummary(orderIds);
        pdf = ChallanPdfService.renderCombined(orders, summary, business, withAmount, challanNumber, money, today);
      }
      await writeFile(tmpPath, pdf.output());
      return { success: true, file_path: tmpPath, error: null };
    } catch (e) {
      this.log(`ChallanPdfService::generate — ${(e as Error).message}`);
      return { success: false, file_path: null, error: 'PDF generation failed.' };
    }
  }

  private todayLabel(): string {
    const d = todayIn(this.timezone);
    return dmy(d);
  }

  private async loadAll(orders: Row[]) {
    const itemsByOrder = new Map<number, Row[]>();
    const all: number[] = [];
    for (const order of orders) {
      const items = await this.fetchItemsForOrder(order);
      itemsByOrder.set(Number(order.id), items);
      for (const it of items) all.push(Number(it.id));
    }
    return { itemsByOrder, defectsByItem: await this.fetchDefectsForItems(all) };
  }

  private fetchItemsForOrder(order: Row): Promise<Row[]> {
    if (order.order_mode === 'weight') {
      return this.db.query<Row>(
        `SELECT oi.*, CONCAT('Laundry Batch (', oi.quantity, ' garments)') AS garment_name, s.service_name
         FROM order_items oi JOIN services s ON s.id = oi.service_id
         WHERE oi.order_id = ? ORDER BY oi.id`, [order.id]);
    }
    return this.db.query<Row>(
      `SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name,
              COALESCE(s.service_name, 'Unknown Service') AS service_name
       FROM order_items oi
       LEFT JOIN garments g ON g.id = oi.garment_id
       LEFT JOIN services s ON s.id = oi.service_id
       WHERE oi.order_id = ? ORDER BY oi.id`, [order.id]);
  }

  private async fetchDefectsForItems(itemIds: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    if (itemIds.length) {
      const ip = itemIds.map(() => '?').join(',');
      for (const r of await this.db.query<Row>(`SELECT oid.order_item_id, d.defect_name FROM order_item_defects oid JOIN defects d ON d.id = oid.defect_id WHERE oid.order_item_id IN (${ip})`, itemIds)) {
        const k = Number(r.order_item_id);
        (out.get(k) ?? out.set(k, []).get(k)!).push(r.defect_name);
      }
    }
    return out;
  }

  /** Garments grouped purely by name across every order_items row (quantity x pieces_per_unit = physical pieces). */
  private fetchCombinedGarmentSummary(orderIds: number[]): Promise<Row[]> {
    const ip = orderIds.map(() => '?').join(',');
    return this.db.query<Row>(
      `SELECT COALESCE(g.garment_name, CONCAT('Laundry: ', s.service_name)) AS garment_name,
       SUM(oi.quantity * COALESCE(oi.pieces_per_unit, 1)) AS total_quantity
       FROM order_items oi
       LEFT JOIN garments g ON g.id = oi.garment_id
       JOIN services s ON s.id = oi.service_id
       WHERE oi.order_id IN (${ip})
       GROUP BY garment_name ORDER BY garment_name`, orderIds);
  }

  private static newPdf(title: string, b: Business): MiniFpdf {
    const pdf = new MiniFpdf();
    pdf.setMargins(15, 15, 15);
    pdf.setTitle(a(title));
    pdf.setAuthor(a(b.name));
    pdf.addPage();
    return pdf;
  }

  // ------------------------------------------------------------------ single order
  static render(order: Row, items: Row[], defectsByItem: Map<number, string[]>, business: Business, withAmount: boolean, challanNumber: string, money: Money): MiniFpdf {
    const pdf = ChallanPdfService.newPdf('Challan ' + challanNumber, business);
    ChallanPdfService.header(pdf, order, business, withAmount, challanNumber);
    let y = ChallanPdfService.infoBox(pdf, order, items);
    y = ChallanPdfService.itemsTable(pdf, items, defectsByItem, business, withAmount, y + 6, money);
    if (withAmount) ChallanPdfService.totals(pdf, order, y + 4, money);
    ChallanPdfService.footer(pdf, business);
    return pdf;
  }

  static renderCombined(orders: Row[], garmentSummary: Row[], business: Business, withAmount: boolean, challanNumber: string, money: Money, today: string): MiniFpdf {
    const pdf = ChallanPdfService.newPdf('Challan ' + challanNumber, business);
    ChallanPdfService.combinedHeader(pdf, orders, business, withAmount, challanNumber, today);
    let y = ChallanPdfService.combinedOrdersBox(pdf, orders);
    y = ChallanPdfService.combinedGarmentsTable(pdf, garmentSummary, y + 6);
    if (withAmount) ChallanPdfService.combinedTotals(pdf, orders, y + 4, money);
    ChallanPdfService.footer(pdf, business);
    return pdf;
  }

  private static combinedHeader(pdf: MiniFpdf, orders: Row[], b: Business, withAmount: boolean, challanNumber: string, today: string, orderWise = false, delivery = false) {
    fill(pdf, NAVY);
    pdf.rect(0, 0, 210, 32, 'F');
    fill(pdf, AQUA);
    pdf.rect(0, 32, 210, 1.4, 'F');

    pdf.setTextColor(255, 255, 255);
    pdf.setXY(15, 8);
    pdf.setFont('Helvetica', 'B', 18);
    pdf.cell(120, 9, a(b.name), 2);
    pdf.setFont('Helvetica', '', 9);
    if (b.address !== '') pdf.cell(120, 4.6, a(b.address), 2);
    if (b.phone !== '') pdf.cell(120, 4.6, a('Phone: ' + b.phone), 2);

    pdf.setXY(125, 9);
    pdf.setFont('Helvetica', 'B', 18);
    pdf.cell(70, 9, delivery ? 'DELIVERY CHALLAN' : 'COMBINED CHALLAN' + (withAmount ? '' : ' (No Amount)'), 2, 'R');
    pdf.setFont('Helvetica', '', 9);
    pdf.cell(70, 4.8, a('Challan #: ' + challanNumber), 2, 'R');
    pdf.cell(70, 4.8, a(orders.length + (orders.length === 1 ? ' order' : ' orders') + (orderWise ? ' - Order-wise' : '')), 2, 'R');
    pdf.cell(70, 4.8, a('Date: ' + today), 2, 'R');
  }

  private static combinedOrdersBox(pdf: MiniFpdf, orders: Row[]): number {
    const top = 40;
    const t = orders.map((o) => code(o)).join(', ');
    pdf.setFont('Helvetica', '', 9);
    const lineWidth = 170;
    const lines = Math.max(1, Math.ceil(pdf.getStringWidth(a(t)) / lineWidth));
    const h = 10 + lines * 5;

    fill(pdf, SOFT);
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.rect(15, top, 180, h, 'DF');

    pdf.setXY(20, top + 4);
    pdf.setFont('Helvetica', 'B', 7.5);
    text(pdf, MUTED);
    pdf.cell(170, 4, 'ORDERS IN THIS CHALLAN', 2);
    pdf.setX(20);
    pdf.setFont('Helvetica', 'B', 10);
    text(pdf, INK);
    pdf.multiCell(170, 5, a(t), 'J');
    return top + h;
  }

  private static combinedGarmentsTable(pdf: MiniFpdf, garmentSummary: Row[], y0: number): number {
    const drawHead = (yy: number) => {
      fill(pdf, BRAND);
      pdf.rect(15, yy, 180, 8, 'F');
      pdf.setFont('Helvetica', 'B', 9);
      pdf.setTextColor(255, 255, 255);
      pdf.setXY(17, yy);
      pdf.cell(140, 8, 'Garment', 0, 'L');
      pdf.cell(38, 8, 'Total Quantity', 0, 'R');
      return yy + 8;
    };
    let y = drawHead(y0);

    if (!garmentSummary.length) {
      pdf.setXY(15, y + 3);
      pdf.setFont('Helvetica', 'I', 9);
      text(pdf, MUTED);
      pdf.cell(180, 6, 'No garments found on the selected orders.', 0, 'C');
      return y + 12;
    }

    let n = 0;
    let grandTotalQty = 0;
    for (const row of garmentSummary) {
      n++;
      const rowH = 8;
      if (n % 2 === 0) { fill(pdf, SOFT); pdf.rect(15, y, 180, rowH, 'F'); }
      pdf.setXY(17, y + 1.8);
      pdf.setFont('Helvetica', 'B', 9.5);
      text(pdf, INK);
      pdf.cell(140, 4.5, a(clip(pdf, str(row.garment_name), 138)), 0, 'L');
      pdf.cell(36, 4.5, num(row.total_quantity), 0, 'R');
      y += rowH;
      grandTotalQty += flt(row.total_quantity);
    }
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, y, 195, y);

    pdf.setXY(17, y + 2);
    pdf.setFont('Helvetica', 'B', 9.5);
    text(pdf, MUTED);
    pdf.cell(140, 5, 'Total Garments', 0, 'L');
    text(pdf, INK);
    pdf.cell(36, 5, num(grandTotalQty), 0, 'R');
    return y + 9;
  }

  /** Sums each financial component ACROSS the included orders -- never a fabricated per-garment price. */
  private static combinedTotals(pdf: MiniFpdf, orders: Row[], y0: number, money: Money) {
    let subtotal = 0, discount = 0, tax = 0, grandTotal = 0;
    for (const o of orders) { subtotal += flt(o.subtotal); discount += flt(o.discount_amount); tax += flt(o.tax_amount); grandTotal += flt(o.grand_total); }
    const rows: [string, string][] = [['Subtotal (all orders)', money(subtotal)]];
    if (discount > 0) rows.push(['Discount', '- ' + money(discount)]);
    if (tax > 0) rows.push(['Tax', money(tax)]);
    ChallanPdfService.totalsBlock(pdf, rows, grandTotal, y0, money);
  }

  private static totalsBlock(pdf: MiniFpdf, rows: [string, string][], grandTotal: number | string, y0: number, money: Money) {
    let y = y0;
    const needed = rows.length * 6.5 + 14;
    if (y + needed > 268) { pdf.addPage(); y = 20; }
    const x = 115, w = 80, lw = 44, vw = 32;
    let cy = y + 2;
    for (const [label, value] of rows) {
      pdf.setXY(x, cy);
      pdf.setFont('Helvetica', '', 9.5);
      text(pdf, MUTED);
      pdf.cell(lw, 6.5, a(label), 0, 'L');
      text(pdf, INK);
      pdf.cell(vw, 6.5, a(value), 0, 'R');
      cy += 6.5;
    }
    cy += 1.5;
    fill(pdf, NAVY);
    pdf.rect(x, cy, w, 10, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setXY(x + 3, cy);
    pdf.setFont('Helvetica', 'B', 11);
    pdf.cell(lw - 3, 10, 'Grand Total', 0, 'L');
    pdf.cell(vw, 10, a(money(grandTotal)), 0, 'R');
  }

  // ------------------------------------------------------------------ order-wise + delivery
  static renderCombinedOrderWise(orders: Row[], itemsByOrder: Map<number, Row[]>, defectsByItem: Map<number, string[]>, business: Business, withAmount: boolean, challanNumber: string, money: Money, today: string): MiniFpdf {
    const pdf = ChallanPdfService.newPdf('Challan ' + challanNumber, business);
    ChallanPdfService.combinedHeader(pdf, orders, business, withAmount, challanNumber, today, true);
    let y = 40;
    for (const order of orders) y = ChallanPdfService.orderWiseSection(pdf, order, itemsByOrder.get(Number(order.id)) ?? [], defectsByItem, business, withAmount, y, money);
    if (withAmount) ChallanPdfService.combinedTotals(pdf, orders, y + 2, money);
    ChallanPdfService.footer(pdf, business);
    return pdf;
  }

  static renderDelivery(orders: Row[], itemsByOrder: Map<number, Row[]>, defectsByItem: Map<number, string[]>, business: Business, challanNumber: string, money: Money, today: string): MiniFpdf {
    const pdf = ChallanPdfService.newPdf('Delivery Challan ' + challanNumber, business);
    ChallanPdfService.combinedHeader(pdf, orders, business, true, challanNumber, today, true, true);
    let y = 40;
    let grand = 0;
    for (const order of orders) {
      y = ChallanPdfService.orderWiseSection(pdf, order, itemsByOrder.get(Number(order.id)) ?? [], defectsByItem, business, false, y, money, true);
      grand += flt(order.grand_total);
    }
    if (orders.length > 1) {
      if (y + 14 > 268) { ChallanPdfService.footer(pdf, business); pdf.addPage(); y = 20; }
      fill(pdf, NAVY);
      pdf.rect(115, y + 2, 80, 10, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setXY(118, y + 2);
      pdf.setFont('Helvetica', 'B', 11);
      pdf.cell(44, 10, 'Total (' + orders.length + ' orders)', 0, 'L');
      pdf.cell(29, 10, a(money(grand)), 0, 'R');
    }
    ChallanPdfService.footer(pdf, business);
    return pdf;
  }

  private static cols(withAmount: boolean): [number, string, string][] {
    return withAmount
      ? [[9, '#', 'C'], [38, 'Garment', 'L'], [30, 'Service', 'L'], [43, 'Packaging/Defects', 'L'], [18, 'Qty', 'R'], [21, 'Rate', 'R'], [21, 'Amount', 'R']]
      : [[9, '#', 'C'], [48, 'Garment', 'L'], [38, 'Service', 'L'], [60, 'Packaging/Defects', 'L'], [25, 'Qty', 'R']];
  }

  private static itemCells(it: Row, n: number, defectsByItem: Map<number, string[]>, withAmount: boolean, money: Money): string[] {
    const pkg = !phpEmpty(it.packaging_style) && PACKAGING_LABELS[String(it.packaging_style)] !== undefined ? PACKAGING_LABELS[String(it.packaging_style)]! : null;
    const defects = defectsByItem.get(Number(it.id)) ?? [];
    const extra = filterTruthy([pkg, defects.length ? defects.join(', ') : null]).join(', ') || '-';
    const isWeight = it.weight !== null && it.weight !== undefined && it.weight !== '';
    const qty = isWeight ? num(it.weight) + ' kg' : num(it.quantity) + ' pcs';
    return withAmount
      ? [String(n), str(it.garment_name), str(it.service_name), extra, qty, isWeight ? money(it.weight_rate) : money(it.unit_price), money(it.total)]
      : [String(n), str(it.garment_name), str(it.service_name), extra, qty];
  }

  private static orderWiseSection(pdf: MiniFpdf, order: Row, items: Row[], defectsByItem: Map<number, string[]>, b: Business, withAmount: boolean, y0: number, money: Money, delivery = false): number {
    let y = y0;
    let totalGarments = 0;
    for (const it of items) totalGarments += pieces(it);

    // Section band (9mm) + its column header (7mm) + at least one row (7mm) must fit, else start the section on a new page.
    if (y + 9 + 7 + 7 > 268) {
      ChallanPdfService.footer(pdf, b);
      pdf.addPage();
      y = 20;
    }

    fill(pdf, SOFT);
    pdf.rect(15, y, 180, 9, 'F');
    fill(pdf, AQUA);
    pdf.rect(15, y, 1.5, 9, 'F');
    pdf.setXY(20, y + 1.3);
    pdf.setFont('Helvetica', 'B', 10);
    text(pdf, INK);
    let bandTitle = 'Order: ' + code(order);
    if (delivery && !phpEmpty(order.full_name)) bandTitle += '  |  ' + order.full_name;
    pdf.cell(95, 6, a(clip(pdf, bandTitle, 93)), 0, 'L');
    pdf.setFont('Helvetica', '', 8.5);
    text(pdf, MUTED);
    pdf.cell(65, 6, a('Due: ' + dmy(order.due_date) + '  |  ' + totalGarments + ' garments'), 0, 'R');
    y += 9 + 2;

    const cols = ChallanPdfService.cols(withAmount);
    const drawHead = (yy: number) => {
      fill(pdf, BRAND);
      pdf.rect(15, yy, 180, 7, 'F');
      pdf.setFont('Helvetica', 'B', 8);
      pdf.setTextColor(255, 255, 255);
      let x = 15;
      for (const [w, label, align] of cols) {
        pdf.setXY(x + (align === 'L' ? 2 : 0), yy + 0.3);
        pdf.cell(w - (align === 'R' ? 2 : (align === 'L' ? 2 : 0)), 6.5, label, 0, align);
        x += w;
      }
      return yy + 7;
    };
    y = drawHead(y);

    if (!items.length) {
      pdf.setXY(15, y + 2);
      pdf.setFont('Helvetica', 'I', 8.5);
      text(pdf, MUTED);
      pdf.cell(180, 6, 'No items on this order.', 0, 'C');
      return y + 11;
    }

    let n = 0;
    let orderTotal = 0;
    for (const it of items) {
      n++;
      const rowH = 7;
      if (y + rowH > 262) {
        ChallanPdfService.footer(pdf, b);
        pdf.addPage();
        y = drawHead(15);
      }
      if (n % 2 === 0) { fill(pdf, SOFT); pdf.rect(15, y, 180, rowH, 'F'); }
      const cells = ChallanPdfService.itemCells(it, n, defectsByItem, withAmount, money);
      let x = 15;
      cols.forEach(([w, , align], i) => {
        pdf.setXY(x + (align === 'L' ? 2 : 0), y + 1.3);
        pdf.setFont('Helvetica', i === 1 ? 'B' : '', 8);
        text(pdf, i === 3 ? AMBER : (i === 0 ? MUTED : INK));
        const inner = w - (align === 'C' ? 0 : 2);
        pdf.cell(inner, 4.4, a(clip(pdf, cells[i]!, inner)), 0, align);
        x += w;
      });
      y += rowH;
      if (withAmount) orderTotal += flt(it.total ?? 0);
    }
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, y, 195, y);
    y += 1.5;

    if (delivery) {
      // Final amount = what the order actually comes to (after discount/tax), not the sum of line totals.
      fill(pdf, SOFT);
      pdf.rect(115, y + 1, 80, 8, 'F');
      pdf.setXY(117, y + 1.5);
      pdf.setFont('Helvetica', 'B', 9.5);
      text(pdf, MUTED);
      pdf.cell(40, 7, 'Order Final Amount', 0, 'L');
      text(pdf, INK);
      pdf.cell(36, 7, a(money(order.grand_total)), 0, 'R');
      y += 10;
    }

    if (withAmount) {
      pdf.setXY(130, y + 1);
      pdf.setFont('Helvetica', 'B', 9);
      text(pdf, MUTED);
      pdf.cell(40, 5, 'Order Total', 0, 'R');
      text(pdf, INK);
      pdf.cell(25, 5, a(money(orderTotal)), 0, 'R');
      y += 7;
    }
    return y + 4;
  }

  // ------------------------------------------------------------------ single-order pieces
  private static header(pdf: MiniFpdf, order: Row, b: Business, withAmount: boolean, challanNumber: string) {
    fill(pdf, NAVY);
    pdf.rect(0, 0, 210, 32, 'F');
    fill(pdf, AQUA);
    pdf.rect(0, 32, 210, 1.4, 'F');

    pdf.setTextColor(255, 255, 255);
    pdf.setXY(15, 8);
    pdf.setFont('Helvetica', 'B', 18);
    pdf.cell(120, 9, a(b.name), 2);
    pdf.setFont('Helvetica', '', 9);
    if (b.address !== '') pdf.cell(120, 4.6, a(b.address), 2);
    if (b.phone !== '') pdf.cell(120, 4.6, a('Phone: ' + b.phone), 2);

    pdf.setXY(125, 9);
    pdf.setFont('Helvetica', 'B', 20);
    pdf.cell(70, 9, 'CHALLAN' + (withAmount ? '' : ' (No Amount)'), 2, 'R');
    pdf.setFont('Helvetica', '', 9);
    pdf.cell(70, 4.8, a('Challan #: ' + challanNumber), 2, 'R');
    pdf.cell(70, 4.8, a('Order #: ' + code(order)), 2, 'R');
    pdf.cell(70, 4.8, a('Date: ' + dmy(order.order_date)), 2, 'R');
  }

  private static infoBox(pdf: MiniFpdf, o: Row, items: Row[]): number {
    const top = 40, h = 28;
    fill(pdf, SOFT);
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.rect(15, top, 180, h, 'DF');

    pdf.setXY(20, top + 4);
    pdf.setFont('Helvetica', 'B', 7.5);
    text(pdf, MUTED);
    pdf.cell(80, 4, 'CUSTOMER', 2);
    pdf.setFont('Helvetica', 'B', 11);
    text(pdf, INK);
    pdf.cell(80, 5.5, a(clip(pdf, str(o.full_name), 80)), 2);
    pdf.setFont('Helvetica', '', 9);
    text(pdf, MUTED);
    if (!phpEmpty(o.mobile)) pdf.cell(80, 4.6, a('Mobile: ' + o.mobile), 2);
    const addr = filterTruthy([str(o.address).trim(), str(o.area).trim(), str(o.city).trim()]).join(', ').trim();
    if (addr !== '') pdf.cell(80, 4.6, a(clip(pdf, addr, 80)), 2);

    let totalGarments = 0;
    for (const it of items) totalGarments += pieces(it);
    pdf.setXY(110, top + 4);
    pdf.setFont('Helvetica', 'B', 7.5);
    text(pdf, MUTED);
    pdf.cell(80, 4, 'ORDER DETAILS', 2);
    const rows: [string, string][] = [
      ['Due date', dmy(o.due_date) + (!phpEmpty(o.due_time) ? ', ' + time12(str(o.due_time)) : '')],
      ['Total garments', String(totalGarments)],
    ];
    let y = top + 9.5;
    for (const [k, v] of rows) {
      pdf.setXY(110, y);
      pdf.setFont('Helvetica', '', 8.5);
      text(pdf, MUTED);
      pdf.cell(28, 4.8, k, 0);
      pdf.setFont('Helvetica', 'B', 8.5);
      text(pdf, INK);
      pdf.cell(52, 4.8, a(v), 0);
      y += 4.8;
    }
    return top + h;
  }

  private static itemsTable(pdf: MiniFpdf, items: Row[], defectsByItem: Map<number, string[]>, b: Business, withAmount: boolean, y0: number, money: Money): number {
    const cols = ChallanPdfService.cols(withAmount);
    const drawHead = (yy: number) => {
      fill(pdf, BRAND);
      pdf.rect(15, yy, 180, 8, 'F');
      pdf.setFont('Helvetica', 'B', 8.5);
      pdf.setTextColor(255, 255, 255);
      let x = 15;
      for (const [w, label, align] of cols) {
        pdf.setXY(x + (align === 'L' ? 2 : 0), yy);
        pdf.cell(w - (align === 'R' ? 2 : (align === 'L' ? 2 : 0)), 8, label, 0, align);
        x += w;
      }
      return yy + 8;
    };
    let y = drawHead(y0);

    if (!items.length) {
      pdf.setXY(15, y + 3);
      pdf.setFont('Helvetica', 'I', 9);
      text(pdf, MUTED);
      pdf.cell(180, 6, 'No items on this order.', 0, 'C');
      return y + 12;
    }

    let n = 0;
    for (const it of items) {
      n++;
      const rowH = 7.5;
      if (y + rowH > 262) {
        ChallanPdfService.footer(pdf, b);
        pdf.addPage();
        y = drawHead(15);
      }
      if (n % 2 === 0) { fill(pdf, SOFT); pdf.rect(15, y, 180, rowH, 'F'); }
      const cells = ChallanPdfService.itemCells(it, n, defectsByItem, withAmount, money);
      let x = 15;
      cols.forEach(([w, , align], i) => {
        pdf.setXY(x + (align === 'L' ? 2 : 0), y + 1.6);
        pdf.setFont('Helvetica', i === 1 ? 'B' : '', 8.5);
        text(pdf, i === 3 ? AMBER : (i === 0 ? MUTED : INK));
        const inner = w - (align === 'C' ? 0 : 2);
        pdf.cell(inner, 4.5, a(clip(pdf, cells[i]!, inner)), 0, align);
        x += w;
      });
      y += rowH;
    }
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, y, 195, y);
    return y;
  }

  private static totals(pdf: MiniFpdf, o: Row, y0: number, money: Money) {
    const rows: [string, string][] = [['Subtotal', money(o.subtotal)]];
    if (flt(o.discount_amount) > 0) rows.push(['Discount', '- ' + money(o.discount_amount)]);
    if (flt(o.tax_amount) > 0) rows.push(['Tax', money(o.tax_amount)]);
    ChallanPdfService.totalsBlock(pdf, rows, o.grand_total, y0, money);
  }

  private static footer(pdf: MiniFpdf, b: Business) {
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, 272, 195, 272);
    pdf.setXY(15, 275);
    pdf.setFont('Helvetica', '', 7.5);
    text(pdf, MUTED);
    pdf.cell(180, 4, a('This is a system-generated challan from ' + b.name + ', not a tax invoice.'), 2, 'C');
  }
}
void phpRound;
