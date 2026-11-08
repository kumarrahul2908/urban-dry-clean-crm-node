import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Business } from '../src/services/invoicePdf.js';
import { ChallanPdfService, type ChallanLineRow, type ChallanOrderRow } from '../src/services/challanPdf.js';

/** Page content streams of a PDF (inflated), in page order. */
function streams(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  const out: string[] = [];
  const re = /<<([^>]*)>>\nstream\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const len = Number(/\/Length (\d+)/.exec(m[1]!)![1]);
    const raw = pdf.subarray(start, start + len);
    const text = (/FlateDecode/.test(m[1]!) ? inflateSync(raw) : raw).toString('latin1');
    if (!text.startsWith('/CIDInit')) out.push(text);
  }
  return out;
}

const business: Business = { name: 'Urban Dry Clean', address: '12 Market Road, Hauz Khas, New Delhi', phone: '9876543210', gstin: '07ABCDE1234F1Z5', currencySymbol: 'Rs.' };
const challan = { id: 1, challan_number: 'UDC-CHL-000001', created_at: '2026-11-08 10:30:00', with_amount: 1 };
const orderA: ChallanOrderRow = { id: 1, order_number: 'UDC-2026-000001', short_order_code: 'A0001', order_date: '2026-11-06 09:00:00', customer_name: 'Rahul Verma', mobile: '9876500000', subtotal: '200.00', discount_amount: '0.00', tax_amount: '0.00', grand_total: '250.00' };
const orderB: ChallanOrderRow = { id: 2, order_number: 'UDC-2026-000002', short_order_code: 'A0002', order_date: '2026-11-07 11:15:00', customer_name: 'Priya Singh', mobile: '9876500001', subtotal: '400.00', discount_amount: '20.00', tax_amount: '10.00', grand_total: '450.00' };
const line = (orderId: number, garment: string, service: string, qty: string, piecesPerUnit: string, unitPrice: string, total: string): ChallanLineRow => ({ order_id: orderId, garment_name: garment, service_name: service, quantity: qty, pieces_per_unit: piecesPerUnit, unit_price: unitPrice, total });

describe('challan PDF', () => {
  it('renders a valid single-object-per-page PDF, single order, with amount', () => {
    const lines = [line(1, 'Shirt', 'Dry Clean', '2.00', '1', '100.00', '200.00'), line(1, 'Suit', 'Dry Clean', '1.00', '1', '450.00', '450.00')];
    const buf = ChallanPdfService.render(challan, [orderA], lines, business, true, false).output();
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.3\n')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(streams(buf)).toHaveLength(1);
    const text = streams(buf)[0]!;
    expect(text).toContain('(CHALLAN) Tj');
    expect(text).toContain('(UDC-CHL-000001) Tj');
    expect(text).toContain('(A0001) Tj');
    expect(text).toContain('(Rahul Verma) Tj');
    expect(text).toContain('(Shirt) Tj');
    expect(text).toContain('(Suit) Tj');
    expect(text).toContain('(Dry Clean) Tj');
    // single-order mode is NOT aggregated, and shows the ordered-unit quantity (no pieces_per_unit
    // multiplication) and real per-line amounts: two distinct garments, two distinct rows
    expect(text).toContain('(Rs. 200.00) Tj');
    expect(text).toContain('(Rs. 450.00) Tj');
    expect(text).toContain('(Total Value) Tj');
    expect(text).toContain('(Rs. 650.00) Tj');
  });

  it('without amount: no rate/amount columns, no totals block', () => {
    const lines = [line(1, 'Shirt', 'Dry Clean', '2.00', '1', '100.00', '200.00')];
    const buf = ChallanPdfService.render(challan, [orderA], lines, business, false, false).output();
    const text = streams(buf)[0]!;
    expect(text).not.toContain('(Rs. 200.00) Tj');
    expect(text).not.toContain('(Total Value) Tj');
    expect(text).not.toContain('(Amount) Tj');
    expect(text).toContain('(Shirt) Tj');
    expect(text).toContain('(Qty) Tj');
  });

  it('combined mode: no customer section, garments folded by name using physical pieces (quantity * pieces_per_unit), never a per-garment-name amount', () => {
    const lines = [
      line(1, 'Shirt', 'Dry Clean', '2.00', '1', '100.00', '200.00'),
      line(2, 'Shirt', 'Steam Press', '1.00', '1', '50.00', '50.00'),
      line(2, 'Suit', 'Dry Clean', '1.00', '2', '450.00', '450.00'), // a 2-piece Set: 1 ordered unit = 2 physical pieces
    ];
    const buf = ChallanPdfService.render(challan, [orderA, orderB], lines, business, true, true).output();
    const text = streams(buf)[0]!;
    expect(text).toContain('(ORDERS ON THIS CHALLAN \\(2\\)) Tj');
    expect(text).toContain('(A0001) Tj');
    expect(text).toContain('(A0002) Tj');
    // no customer section at all for combined challans (confirmed business rule)
    expect(text).not.toContain('(Rahul Verma) Tj');
    expect(text).not.toContain('(Priya Singh) Tj');
    expect(text).not.toContain('(Customer) Tj');
    // Shirt appears ONCE, combining both orders' quantity (2+1=3 physical pieces)
    expect((text.match(/\(Shirt\) Tj/g) ?? []).length).toBe(1);
    expect(text).toContain('(3) Tj');
    // Suit: 1 ordered unit * 2 pieces_per_unit = 2 physical pieces
    expect(text).toContain('(Suit) Tj');
    expect(text).toContain('(2) Tj');
    // never a per-garment-name amount column, even With Amount
    expect(text).not.toContain('(Amount) Tj');
    expect(text).not.toContain('(Rs. 250.00) Tj');
    expect(text).not.toContain('(Rs. 450.00) Tj');
    // instead, each financial component summed across every included order, as one totals block
    expect(text).toContain('(Subtotal) Tj');
    expect(text).toContain('(Rs. 600.00) Tj'); // 200 + 400
    expect(text).toContain('(Discount) Tj');
    expect(text).toContain('(Tax) Tj');
    expect(text).toContain('(Grand Total) Tj');
    expect(text).toContain('(Rs. 700.00) Tj'); // 250 + 450
    // Service column is dropped entirely in combined mode
    expect(text).not.toContain('(Dry Clean) Tj');
    expect(text).not.toContain('(Steam Press) Tj');
    expect(text).not.toContain('(Service) Tj');
  });

  it('combined mode, without amount: no totals block at all', () => {
    const lines = [line(1, 'Shirt', 'Dry Clean', '2.00', '1', '100.00', '200.00'), line(2, 'Shirt', 'Steam Press', '1.00', '1', '50.00', '50.00')];
    const buf = ChallanPdfService.render(challan, [orderA, orderB], lines, business, false, true).output();
    const text = streams(buf)[0]!;
    expect((text.match(/\(Shirt\) Tj/g) ?? []).length).toBe(1);
    expect(text).toContain('(3) Tj');
    expect(text).not.toContain('(Subtotal) Tj');
    expect(text).not.toContain('(Grand Total) Tj');
    expect(text).not.toContain('(Rs.');
  });

  it('handles an empty items list without crashing', () => {
    const buf = ChallanPdfService.render(challan, [orderA], [], business, true, false).output();
    const text = streams(buf)[0]!;
    expect(text).toContain('(No garments on this challan.) Tj');
  });
});

const dbEnabled = !!process.env.TEST_DB_NAME;
describe.skipIf(!dbEnabled)('ChallanPdfService.generate (real MariaDB schema)', async () => {
  const { loadEnv } = await import('../src/config/env.js');
  const { createPool } = await import('../src/db/pool.js');
  const { resetAndSeed } = await import('./helpers.js');
  const env = loadEnv({ NODE_ENV: 'test', DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_NAME: process.env.TEST_DB_NAME!, DB_USER: process.env.TEST_DB_USER!, DB_PASS: process.env.TEST_DB_PASS ?? '', APP_SECRET_KEY: 'k' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);

  it('builds the PDF from real challan/challan_orders rows, single and combined', async () => {
    await resetAndSeed(db);
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('business_name', 'Seed Cleaners'), ('currency_symbol', 'Rs.') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
    const svc = (await import('../src/app.js')).buildServices(env, db);

    const o1 = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 2 }] }, { userId: 1 }, true, 1, true);
    const o2 = await svc.orders.createOrder({ customer_id: 2, items: [{ garment_id: 1, service_id: 1, quantity: 1 }] }, { userId: 1 }, true, 1, true);

    const ch = await db.execute('INSERT INTO challans (challan_number, with_amount, created_by) VALUES (?, 1, 1)', ['UDC-CHL-000001']);
    await db.execute('INSERT INTO challan_orders (challan_id, order_id) VALUES (?, ?), (?, ?)', [ch.insertId, o1.order_id, ch.insertId, o2.order_id]);

    const pdf = new ChallanPdfService(db, 'X');
    const r = await pdf.generate(ch.insertId);
    expect(r.success).toBe(true);
    const buf = readFileSync(r.file_path!);
    expect(buf.subarray(0, 8).toString()).toBe('%PDF-1.3');
    const text = streams(buf)[0]!;
    expect(text).toContain('(Seed Cleaners)');
    expect(text).toContain('(UDC-CHL-000001)');
    // combined (2 orders): no customer section at all
    expect(text).not.toContain('(Vip Cust)');
    expect(text).not.toContain('(Plain)');
    unlinkSync(r.file_path!);
    expect(existsSync(r.file_path!)).toBe(false);

    expect(await pdf.generate(99999)).toEqual({ success: false, error: 'Challan not found.' });
    await close();
  });
});
