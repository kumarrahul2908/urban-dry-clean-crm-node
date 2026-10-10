import type { Db } from '../db/pool.js';
import { getSetting } from './settings.js';

/**
 * Port of generate_document_number(): prefix from settings[prefixKey], counter in
 * settings[prefixKey + '_counter'], incremented under a row lock so concurrent requests never
 * get the same number. Safe to call inside a caller's transaction (joins it).
 */
export async function generateDocumentNumber(db: Db, prefixKey: string, padLength = 6): Promise<string> {
  const prefix = (await getSetting(db, prefixKey, `${prefixKey.slice(0, 3).toUpperCase()}-`)) ?? '';
  const counterKey = `${prefixKey}_counter`;
  const next = await db.tx(async (t) => {
    const rows = await t.query<{ setting_value: string }>('SELECT setting_value FROM settings WHERE setting_key = ? FOR UPDATE', [counterKey]);
    if (rows.length === 0) {
      await t.execute('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [counterKey, '1']);
      return 1;
    }
    const n = parseInt(rows[0]!.setting_value, 10) + 1;
    await t.execute('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [String(n), counterKey]);
    return n;
  });
  return prefix + String(next).padStart(padLength, '0');
}

export const generateCustomerCode = (db: Db) => generateDocumentNumber(db, 'customer_prefix', 5);

/** Reads + bumps settings[counterKey] under a row lock; returns the new value. */
async function nextCounter(db: Db, counterKey: string): Promise<number> {
  return db.tx(async (t) => {
    const rows = await t.query<{ setting_value: string }>('SELECT setting_value FROM settings WHERE setting_key = ? FOR UPDATE', [counterKey]);
    if (rows.length === 0) {
      await t.execute('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [counterKey, '1']);
      return 1;
    }
    const n = parseInt(rows[0]!.setting_value, 10) + 1;
    await t.execute('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [String(n), counterKey]);
    return n;
  });
}

/** generate_order_number(): 'UDC-<year in APP_TIMEZONE>-<6-digit counter>'. */
export async function generateOrderNumber(db: Db, year: string): Promise<string> {
  const n = await nextCounter(db, 'order_number_counter');
  return `UDC-${year}-${String(n).padStart(6, '0')}`;
}

/** generate_short_order_code(): null when disabled; prefix + counter padded to `digits` (never truncated). */
export async function generateShortOrderCode(db: Db): Promise<string | null> {
  if ((await getSetting(db, 'short_order_code_enabled', '1')) !== '1') return null;
  const prefix = (await getSetting(db, 'short_order_code_prefix', 'A')) ?? 'A';
  const digits = Math.max(1, parseInt((await getSetting(db, 'short_order_code_digits', '4')) ?? '4', 10) || 0);
  const n = await nextCounter(db, 'short_order_seq_counter');
  return prefix + String(n).padStart(digits, '0');
}

export const generateInvoiceNumber = (db: Db) => generateDocumentNumber(db, 'invoice_prefix', 6);
export const generatePaymentNumber = (db: Db) => generateDocumentNumber(db, 'payment_prefix', 6);
export const generateRefundNumber = (db: Db) => generateDocumentNumber(db, 'refund_prefix', 6);
