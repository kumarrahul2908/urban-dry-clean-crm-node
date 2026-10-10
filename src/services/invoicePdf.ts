import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/pool.js';
import { cp1252 } from '../pdf/cp1252.js';
import { MiniFpdf } from '../pdf/miniFpdf.js';
import { numberFormat2, phpEmpty } from '../lib/php.js';
import { getSetting } from './settings.js';
import type { InvoicePdfGenerator } from './whatsappService.js';

type Row = Record<string, any>;
type RGB = [number, number, number];

const NAVY: RGB = [10, 42, 102];
const BRAND: RGB = [11, 61, 145];
const AQUA: RGB = [11, 159, 179];
const INK: RGB = [17, 24, 39];
const MUTED: RGB = [100, 116, 139];
const LINE: RGB = [226, 232, 240];
const SOFT: RGB = [243, 246, 251];
const DANGER: RGB = [185, 28, 28];
const SUCCESS: RGB = [21, 128, 61];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const f = (v: unknown) => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export interface Business { name: string; address: string; phone: string; gstin: string; currencySymbol: string }

/** Port of includes/InvoicePdfService.php — same layout, coordinates and wording, rendered with the FPDF subset in pdf/miniFpdf.ts. */
export class InvoicePdfService implements InvoicePdfGenerator {
  constructor(private readonly db: Db, private readonly appName: string, private readonly log: (m: string) => void = console.error) {}

  /** Returns a temp file the caller deletes when done with it. */
  async generate(orderId: number): Promise<{ success: boolean; file_path?: string; error?: string }> {
    const order = (await this.db.query<Row>(
      `SELECT o.*, c.full_name, c.mobile, c.address, c.area, c.city, c.state, c.pincode, c.gstin AS customer_gstin, ul.level_name AS urgent_level_name
       FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id WHERE o.id = ?`, [orderId]))[0];
    if (!order) return { success: false, error: 'Order not found.' };
    const items = order.order_mode === 'weight'
      ? await this.db.query<Row>("SELECT oi.*, CONCAT('Laundry batch (', oi.quantity, ' garments)') AS garment_name, s.service_name FROM order_items oi JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [orderId])
      : await this.db.query<Row>("SELECT oi.*, COALESCE(g.garment_name, 'Unknown Garment') AS garment_name, COALESCE(s.service_name, 'Unknown Service') AS service_name FROM order_items oi LEFT JOIN garments g ON g.id = oi.garment_id LEFT JOIN services s ON s.id = oi.service_id WHERE oi.order_id = ? ORDER BY oi.id", [orderId]);
    const business: Business = {
      name: str(await getSetting(this.db, 'business_name', this.appName)),
      address: str(await getSetting(this.db, 'address', '')),
      phone: str(await getSetting(this.db, 'phone', '')),
      gstin: str(await getSetting(this.db, 'gstin', '')),
      currencySymbol: str(await getSetting(this.db, 'currency_symbol', 'Rs.')),
    };
    try {
      const path = join(tmpdir(), `invoice_${orderId}_${randomBytes(6).toString('hex')}.pdf`);
      await writeFile(path, InvoicePdfService.render(order, items, business).output());
      return { success: true, file_path: path };
    } catch (e) {
      this.log(`InvoicePdfService::generate — ${(e as Error).message}`);
      return { success: false, error: 'PDF generation failed.' };
    }
  }

  /** Pure layout. */
  static render(order: Row, items: Row[], business: Business): MiniFpdf {
    const pdf = new MiniFpdf();
    const money = (v: unknown) => `${business.currencySymbol} ${numberFormat2(f(v))}`;
    pdf.setTitle(`Invoice ${phpEmpty(order.invoice_number) ? str(order.order_number) : str(order.invoice_number)}`);
    pdf.setAuthor(business.name);
    pdf.addPage();
    InvoicePdfService.header(pdf, order, business);
    let y = InvoicePdfService.infoBoxes(pdf, order);
    y = InvoicePdfService.itemsTable(pdf, items, business, y + 6, money);
    InvoicePdfService.totals(pdf, order, items, y + 4, money);
    InvoicePdfService.footer(pdf, business);
    return pdf;
  }

  // ------------------------------------------------------------------ sections
  private static header(pdf: MiniFpdf, o: Row, b: Business) {
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
    pdf.cell(70, 10, 'INVOICE', 2, 'R');
    pdf.setFont('Helvetica', '', 9.5);
    pdf.cell(70, 5, ascii(phpEmpty(o.invoice_number) ? '-' : str(o.invoice_number)), 2, 'R');
    pdf.cell(70, 5, ascii(`Date: ${dateStr(o.order_date)}`), 2, 'R');
  }

  private static infoBoxes(pdf: MiniFpdf, o: Row): number {
    const top = 45, h = 34;
    for (const [x, title] of [[15, 'BILLED TO'], [110, 'ORDER DETAILS']] as const) {
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
    pdf.cell(75, 5.5, ascii(clip(pdf, str(o.full_name), 75)), 2);
    pdf.setFont('Helvetica', '', 9);
    if (!phpEmpty(o.mobile)) pdf.cell(75, 4.6, ascii(`Mobile: ${o.mobile}`), 2);
    const addr = [str(o.address).trim(), str(o.area).trim()].filter((x) => !phpEmpty(x)).join(', ').trim();
    const city = `${[str(o.city).trim(), str(o.state).trim()].filter((x) => !phpEmpty(x)).join(', ').trim()} ${str(o.pincode).trim()}`.trim();
    text(pdf, MUTED);
    if (addr !== '') pdf.cell(75, 4.6, ascii(clip(pdf, addr, 75)), 2);
    if (city.trim() !== '') pdf.cell(75, 4.6, ascii(clip(pdf, city, 75)), 2);
    if (!phpEmpty(o.customer_gstin)) pdf.cell(75, 4.6, ascii(`GSTIN: ${o.customer_gstin}`), 2);

    const due = dateStr(o.due_date) + (!phpEmpty(o.due_time) ? `, ${time12(str(o.due_time))}` : '');
    const rows: [string, string][] = [
      ['Order no.', str(o.order_number)],
      ['Order date', dateStr(o.order_date, true)],
      ['Due date', due],
      ['Order type', o.order_mode === 'weight' ? 'Laundry' : 'Dry Cleaning'],
    ];
    if (!phpEmpty(o.urgent_level_name) && f(o.urgent_charge) > 0) rows.push(['Urgency', str(o.urgent_level_name)]);
    let y = top + 9.5;
    for (const [k, v] of rows) {
      pdf.setXY(115, y);
      pdf.setFont('Helvetica', '', 8.5);
      text(pdf, MUTED);
      pdf.cell(24, 4.8, k, 0);
      pdf.setFont('Helvetica', 'B', 8.5);
      text(pdf, INK);
      pdf.cell(51, 4.8, ascii(clip(pdf, v, 51)), 0);
      y += 4.8;
    }
    return top + h;
  }

  private static itemsTable(pdf: MiniFpdf, items: Row[], b: Business, y0: number, money: (v: unknown) => string): number {
    const cols: [number, string, string][] = [[9, '#', 'C'], [65, 'Garment', 'L'], [38, 'Service', 'L'], [20, 'Qty', 'R'], [24, 'Rate', 'R'], [24, 'Amount', 'R']];
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
    if (items.length === 0) {
      pdf.setXY(15, y + 3);
      pdf.setFont('Helvetica', 'I', 9);
      text(pdf, MUTED);
      pdf.cell(180, 6, 'No items on this order.', 0, 'C');
      return y + 12;
    }
    let n = 0;
    for (const it of items) {
      n++;
      const remarks = str(it.remarks).trim();
      const rowH = remarks !== '' ? 11 : 7.5;
      if (y + rowH > 262) {
        InvoicePdfService.footer(pdf, b);
        pdf.addPage();
        y = drawHead(15);
      }
      if (n % 2 === 0) { fill(pdf, SOFT); pdf.rect(15, y, 180, rowH, 'F'); }
      const isWeight = it.weight !== null && it.weight !== undefined && it.weight !== '';
      const qty = isWeight ? `${numStr(it.weight)} kg` : numStr(it.quantity);
      const rate = isWeight ? `${money(it.weight_rate)}/kg` : money(it.unit_price);
      const cells = [String(n), str(it.garment_name), str(it.service_name), qty, rate, money(it.total)];
      let x = 15;
      cols.forEach(([w, , align], i) => {
        pdf.setXY(x + (align === 'L' ? 2 : 0), y + 1.3);
        pdf.setFont('Helvetica', i === 1 || i === 5 ? 'B' : '', 9);
        text(pdf, i === 0 ? MUTED : INK);
        const inner = w - (align === 'C' ? 0 : 2);
        pdf.cell(inner, 5, ascii(clip(pdf, cells[i]!, inner)), 0, align);
        x += w;
      });
      if (remarks !== '') {
        pdf.setXY(26, y + 6);
        pdf.setFont('Helvetica', 'I', 7.5);
        text(pdf, MUTED);
        pdf.cell(160, 4, ascii(clip(pdf, `Note: ${remarks}`, 160)), 0);
      }
      y += rowH;
    }
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, y, 195, y);
    return y;
  }

  private static totals(pdf: MiniFpdf, o: Row, items: Row[], y0: number, money: (v: unknown) => string) {
    const rows: [string, string][] = [['Subtotal', money(o.subtotal)]];
    if (f(o.discount_amount) > 0) {
      const label = 'Discount' + (o.discount_type === 'Percent' && f(o.discount_value) > 0 ? ` (${numStr(o.discount_value)}%)` : '');
      rows.push([label, `- ${money(o.discount_amount)}`]);
    }
    if (f(o.urgent_charge) > 0) rows.push(['Urgent charge', money(o.urgent_charge)]);
    if (f(o.delivery_charge) > 0) rows.push(['Delivery charge', money(o.delivery_charge)]);
    if (f(o.tax_amount) > 0) rows.push(['Tax', money(o.tax_amount)]);

    let y = y0;
    const needed = 8 + rows.length * 6.5 + 10 + 13 + 8;
    if (y + needed > 268) { pdf.addPage(); y = 20; }

    let pieces = 0;
    for (const it of items) pieces += f(it.quantity);
    pdf.setXY(15, y + 2);
    pdf.setFont('Helvetica', 'B', 9);
    text(pdf, INK);
    pdf.cell(90, 5, ascii((o.order_mode === 'weight' ? 'Garments: ' : 'Total pieces: ') + numStr(pieces)), 2);
    const notes = str(o.notes).trim();
    if (notes !== '') {
      pdf.ln(1);
      pdf.setFont('Helvetica', 'B', 7.5);
      text(pdf, MUTED);
      pdf.cell(90, 4, 'NOTES', 2);
      pdf.setFont('Helvetica', '', 8.5);
      text(pdf, INK);
      pdf.multiCell(88, 4.2, ascii(Array.from(notes).slice(0, 400).join('')));
    }

    const x = 115, w = 80, lw = 44, vw = 32;
    let cy = y + 2;
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
    pdf.cell(vw, 10, ascii(money(o.grand_total)), 0, 'R');
    cy += 12;

    pdf.setXY(x, cy);
    pdf.setFont('Helvetica', '', 9.5);
    text(pdf, MUTED);
    pdf.cell(lw, 6.5, 'Paid', 0, 'L');
    text(pdf, INK);
    pdf.cell(vw, 6.5, ascii(money(o.total_paid)), 0, 'R');
    cy += 7.5;

    const due = f(o.current_due);
    if (!phpEmpty(o.cancelled_at)) badge(pdf, x, cy, w, 'ORDER CANCELLED', DANGER);
    else if (due > 0.009) {
      draw(pdf, DANGER);
      pdf.setLineWidth(0.4);
      pdf.rect(x, cy, w, 9, 'D');
      pdf.setXY(x + 3, cy);
      pdf.setFont('Helvetica', 'B', 10.5);
      text(pdf, DANGER);
      pdf.cell(lw - 3, 9, 'Balance Due', 0, 'L');
      pdf.cell(vw, 9, ascii(money(due)), 0, 'R');
    } else badge(pdf, x, cy, w, 'PAID IN FULL', SUCCESS);
  }

  private static footer(pdf: MiniFpdf, b: Business) {
    draw(pdf, LINE);
    pdf.setLineWidth(0.3);
    pdf.line(15, 272, 195, 272);
    pdf.setXY(15, 275);
    pdf.setFont('Helvetica', 'B', 10);
    text(pdf, BRAND);
    pdf.cell(180, 5, ascii(`Thank you for choosing ${b.name}!`), 2, 'C');
    pdf.setFont('Helvetica', '', 7.5);
    text(pdf, MUTED);
    pdf.cell(180, 4, ascii('This is a system-generated invoice. For any query please share your order or invoice number' + (b.phone !== '' ? ` - call ${b.phone}` : '') + '.'), 2, 'C');
  }
}

// ------------------------------------------------------------------ helpers
const fill = (p: MiniFpdf, c: RGB) => p.setFillColor(c[0], c[1], c[2]);
const draw = (p: MiniFpdf, c: RGB) => p.setDrawColor(c[0], c[1], c[2]);
const text = (p: MiniFpdf, c: RGB) => p.setTextColor(c[0], c[1], c[2]);
const ascii = cp1252;

function badge(pdf: MiniFpdf, x: number, y: number, w: number, label: string, rgb: RGB) {
  fill(pdf, rgb);
  pdf.rect(x, y, w, 9, 'F');
  pdf.setXY(x, y);
  pdf.setFont('Helvetica', 'B', 10.5);
  pdf.setTextColor(255, 255, 255);
  pdf.cell(w, 9, label, 0, 'C');
}

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
