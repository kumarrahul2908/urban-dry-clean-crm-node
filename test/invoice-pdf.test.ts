import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { cp1252 } from '../src/pdf/cp1252.js';
import { InvoicePdfService, type Business } from '../src/services/invoicePdf.js';

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
    if (!text.startsWith('/CIDInit')) out.push(text); // skip the ToUnicode CMap stream
  }
  return out;
}

const business: Business = { name: 'Urban Dry Clean', address: '12 Market Road, Hauz Khas, New Delhi', phone: '9876543210', gstin: '07ABCDE1234F1Z5', currencySymbol: 'Rs.' };
const base = {
  id: 7, invoice_number: 'INV-2026-000007', order_number: 'UDC-2026-000007', order_date: '2026-10-05 14:07:09', due_date: '2026-10-08', due_time: '17:30:00',
  order_mode: 'standard', full_name: 'Rahul Verma', mobile: '9876500000', address: '5 Rose Lane', area: 'Saket', city: 'New Delhi', state: 'Delhi', pincode: '110017', customer_gstin: null,
  urgent_level_name: null, subtotal: '1250.00', discount_type: null, discount_value: '0.00', discount_amount: '0.00', urgent_charge: '0.00', delivery_charge: '0.00', tax_amount: '0.00',
  grand_total: '1250.00', total_paid: '0.00', current_due: '1250.00', cancelled_at: null, notes: null,
};
const item = (i: number, extra: Record<string, unknown> = {}) => ({ id: i, garment_name: `Garment ${i}`, service_name: 'Dry Clean', quantity: '2.00', unit_price: '125.50', total: '251.00', weight: null, weight_rate: null, remarks: null, ...extra });

const scenarios: Record<string, { order: Record<string, unknown>; items: Record<string, unknown>[]; business?: Business }> = {
  plain: { order: base, items: [item(1), item(2, { quantity: '1.00', unit_price: '999.99', total: '999.99' })] },
  everything: {
    order: { ...base, subtotal: '5000.50', discount_type: 'Percent', discount_value: '12.50', discount_amount: '625.06', urgent_level_name: 'Express', urgent_charge: '250.00', delivery_charge: '60.00', tax_amount: '120.25',
      grand_total: '4805.69', total_paid: '1234.50', current_due: '3571.19', customer_gstin: '07AAAAA0000A1Z5', notes: 'Please handle the silk saree with extra care.\nCall before delivery.\nA very long note line that must wrap onto several lines inside the notes column of the invoice so MultiCell is exercised properly.',
      full_name: 'Maharaja Extraordinarily Long Customer Name That Will Not Fit In The Box', address: 'Flat 1204, Tower C, Some Extremely Long Residency Complex Name', area: 'South Extension Part Two', due_time: '00:05:00' },
    items: [item(1, { remarks: 'Stain on collar — treat first' }), item(2, { garment_name: 'Wedding Sherwani with embroidery and a very very long descriptive name', remarks: 'x'.repeat(220) }), item(3, { weight: '3.5', weight_rate: '60.00', quantity: '4.00', total: '210.00' })],
  },
  fixedDiscount: { order: { ...base, discount_type: 'Flat', discount_value: '50.00', discount_amount: '50.00', grand_total: '1200.00', total_paid: '1200.00', current_due: '0.00' }, items: [item(1)] },
  paidInFull: { order: { ...base, total_paid: '1250.00', current_due: '0.00', invoice_number: null, due_time: null }, items: [item(1)] },
  cancelled: { order: { ...base, cancelled_at: '2026-10-06 10:00:00' }, items: [item(1)] },
  laundry: { order: { ...base, order_mode: 'weight' }, items: [{ ...item(1), garment_name: 'Laundry batch (6 garments)', quantity: '6.00', weight: '4.20', weight_rate: '61.37', total: '257.75' }] },
  noItems: { order: base, items: [] },
  unicode: { order: { ...base, full_name: 'José Müller ₹ राहुल “quoted” – dash', notes: 'Amount ₹500 • café' }, items: [item(1, { garment_name: 'Café Ñandú ₹ नमस्ते', remarks: 'smart “quotes” … done' })], business: { ...business, name: 'Ürban Dry Clean ™', address: '' } },
  noBusinessExtras: { order: { ...base, mobile: '', address: '', area: '', city: '', state: '', pincode: '' }, items: [item(1)], business: { ...business, address: '', phone: '', gstin: '' } },
  manyItemsTwoPages: { order: { ...base, subtotal: '9000.00', grand_total: '9000.00' }, items: Array.from({ length: 31 }, (_, i) => item(i + 1, i % 5 === 0 ? { remarks: 'note ' + i } : {})) },
  manyItemsThreePages: { order: { ...base, notes: 'n'.repeat(500) }, items: Array.from({ length: 70 }, (_, i) => item(i + 1)) },
  totalsOverflow: { order: { ...base, discount_type: 'Percent', discount_value: '5', discount_amount: '10', urgent_charge: '1', delivery_charge: '1', tax_amount: '1', notes: 'multi\nline\nnotes' }, items: Array.from({ length: 23 }, (_, i) => item(i + 1)) },
};

const PHP_APP = process.env.PARITY_PHP_APP;
describe('invoice PDF', () => {
  it('cp1252 transliteration', () => {
    expect(cp1252('Rs. 5 – “x” é€')).toBe('Rs. 5 \x96 \x93x\x94 \xe9\x80');
    expect(cp1252('₹ नमस्ते')).toBe('INR ??????');
    expect(cp1252('ā Ž')).toBe('a \x8e');
  });

  it('renders a valid multi-object PDF', () => {
    const buf = InvoicePdfService.render({ ...base }, [item(1)], business).output();
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.3\n')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/BaseFont /Helvetica-Bold');
    expect(streams(buf)).toHaveLength(1);
    expect(streams(buf)[0]).toContain('(INVOICE) Tj');
  });

  describe.skipIf(!PHP_APP)('PHP FPDF ↔ Node content-stream parity', () => {
    for (const [name, sc] of Object.entries(scenarios)) {
      it(name, () => {
        const biz = sc.business ?? business;
        const dir = mkdtempSync(join(tmpdir(), 'inv-'));
        const phpFile = join(dir, 'php.pdf');
        execFileSync('php', [`${PHP_APP}/invoice.php`, phpFile], {
          input: JSON.stringify({ order: sc.order, items: sc.items, business: { name: biz.name, address: biz.address, phone: biz.phone, gstin: biz.gstin } }),
          env: {
            ...process.env, UDC_DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', UDC_DB_PORT: process.env.TEST_DB_PORT ?? '3306',
            UDC_DB_NAME: process.env.TEST_DB_NAME ?? '', UDC_DB_USER: process.env.TEST_DB_USER ?? '', UDC_DB_PASS: process.env.TEST_DB_PASS ?? '',
          },
        });
        const php = readFileSync(phpFile);
        const node = InvoicePdfService.render(sc.order, sc.items, biz).output();
        const a = streams(node), b = streams(php);
        expect(a.length).toBe(b.length);
        a.forEach((s, i) => expect(s, `page ${i + 1}`).toBe(b[i]));
        // same font table (names + order)
        const fonts = (buf: Buffer) => [...buf.toString('latin1').matchAll(/\/BaseFont \/(\S+)/g)].map((m) => m[1]);
        expect(fonts(node)).toEqual(fonts(php));
      });
    }
  });
});

const dbEnabled = !!process.env.TEST_DB_NAME;
describe.skipIf(!dbEnabled)('InvoicePdfService.generate (real MariaDB schema)', async () => {
  const { loadEnv } = await import('../src/config/env.js');
  const { createPool } = await import('../src/db/pool.js');
  const { resetAndSeed } = await import('./helpers.js');
  const { buildServices } = await import('../src/app.js');
  const { existsSync, unlinkSync } = await import('node:fs');
  const env = loadEnv({ NODE_ENV: 'test', DB_HOST: process.env.TEST_DB_HOST ?? '127.0.0.1', DB_PORT: process.env.TEST_DB_PORT ?? '3306', DB_NAME: process.env.TEST_DB_NAME!, DB_USER: process.env.TEST_DB_USER!, DB_PASS: process.env.TEST_DB_PASS ?? '', APP_SECRET_KEY: 'k' } as NodeJS.ProcessEnv);
  const { db, close } = createPool(env);
  it('builds the PDF from a real order and reports unknown orders', async () => {
    await resetAndSeed(db);
    await db.execute("INSERT INTO settings (setting_key, setting_value) VALUES ('business_name', 'Seed Cleaners'), ('currency_symbol', 'Rs.') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
    const svc = buildServices(env, db);
    const o = await svc.orders.createOrder({ customer_id: 1, items: [{ garment_id: 1, service_id: 1, quantity: 2 }] }, { userId: 1 }, true, 1, true);
    const pdf = new InvoicePdfService(db, 'X');
    const r = await pdf.generate(o.order_id as number);
    expect(r.success).toBe(true);
    const buf = readFileSync(r.file_path!);
    expect(buf.subarray(0, 8).toString()).toBe('%PDF-1.3');
    const text = streams(buf)[0]!;
    expect(text).toContain('(Seed Cleaners)');
    // the PDF prints the internal order number (the Short Order Code is what createOrder() now returns to callers)
    const [row] = await db.query<any>('SELECT order_number FROM orders WHERE id = ?', [o.order_id]);
    expect(text).toContain(`(${row.order_number})`);
    unlinkSync(r.file_path!);
    expect(existsSync(r.file_path!)).toBe(false);
    expect(await pdf.generate(99999)).toEqual({ success: false, error: 'Order not found.' });
    await close();
  });
});
