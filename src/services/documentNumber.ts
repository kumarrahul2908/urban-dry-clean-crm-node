import type { Db } from '../db/pool.js';
import { getSetting } from './settings.js';

/** Where each counter's numbers actually end up, so a counter that drifted behind real data can never hand out a number already in use. */
const NUMBER_COLUMNS: Record<string, [table: string, column: string]> = {
  customer_prefix: ['customers', 'customer_code'], invoice_prefix: ['orders', 'invoice_number'],
  payment_prefix: ['payments', 'payment_number'], refund_prefix: ['payments', 'payment_number'],
  pickup_prefix: ['pickups', 'pickup_number'], delivery_prefix: ['deliveries', 'delivery_number'], challan_prefix: ['workshop_challans', 'challan_number'],
  // Deliberately separate from challan_prefix above: workshop_challans (UDC-CHL-, internal
  // send-to-workshop tracking) and challans (customer-facing delivery/packing-note documents) are
  // two independent numbering sequences that must never collide.
  customer_challan_prefix: ['challans', 'challan_number'],
};

/** Highest numeric tail among values `<prefix><digits>` of table.column (0 when none). Never throws: a missing table just means "no floor". */
async function highestUsed(db: Db, table: string, column: string, likePrefix: string, tailFrom: string): Promise<number> {
  try {
    const rows = await db.query<{ n: string | number | null }>(
      `SELECT MAX(CAST(${tailFrom} AS UNSIGNED)) AS n FROM \`${table}\` WHERE \`${column}\` LIKE ? AND ${tailFrom} REGEXP '^[0-9]+$'`, [likePrefix.replace(/[%_\\]/g, '\\$&') + '%']);
    return Number(rows[0]?.n ?? 0) || 0;
  } catch { return 0; }
}

/**
 * Reads + bumps settings[counterKey] under a row lock; returns the new value. Derived from MAX(existing)+1 as well as the stored counter,
 * so a counter that fell behind the real data (it happened on the live CRM) heals itself instead of failing with a duplicate key.
 */
async function nextCounter(db: Db, counterKey: string, used?: () => Promise<number>): Promise<number> {
  return db.tx(async (t) => {
    const rows = await t.query<{ setting_value: string }>('SELECT setting_value FROM settings WHERE setting_key = ? FOR UPDATE', [counterKey]);
    const floor = used ? await used() : 0;
    const n = Math.max(rows.length ? parseInt(rows[0]!.setting_value, 10) + 1 : 1, floor + 1);
    if (rows.length === 0) await t.execute('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)', [counterKey, String(n)]);
    else await t.execute('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [String(n), counterKey]);
    return n;
  });
}

/**
 * Port of generate_document_number(): prefix from settings[prefixKey], counter in settings[prefixKey + '_counter'], incremented under a row lock so
 * concurrent requests never get the same number. Safe to call inside a caller's transaction (joins it).
 */
export async function generateDocumentNumber(db: Db, prefixKey: string, padLength = 6): Promise<string> {
  const prefix = (await getSetting(db, prefixKey, `${prefixKey.slice(0, 3).toUpperCase()}-`)) ?? '';
  const where = NUMBER_COLUMNS[prefixKey];
  const next = await nextCounter(db, `${prefixKey}_counter`, where ? () => highestUsed(db, where[0], where[1], prefix, `SUBSTRING(\`${where[1]}\`, ${prefix.length + 1})`) : undefined);
  return prefix + String(next).padStart(padLength, '0');
}

export const generateCustomerCode = (db: Db) => generateDocumentNumber(db, 'customer_prefix', 5);

/** generate_order_number(): 'UDC-<year in APP_TIMEZONE>-<6-digit counter>'. */
export async function generateOrderNumber(db: Db, year: string): Promise<string> {
  const n = await nextCounter(db, 'order_number_counter', () => highestUsed(db, 'orders', 'order_number', 'UDC-', "SUBSTRING_INDEX(`order_number`, '-', -1)"));
  return `UDC-${year}-${String(n).padStart(6, '0')}`;
}

/**
 * generate_short_order_code(): null when disabled; prefix + counter padded to `digits` (never
 * truncated). Each store can have its own prefix letter (stores.code_prefix), set via Admin >
 * Settings -- `storeId` is optional and falls back to the single global short_order_code_prefix
 * setting when omitted or when that store has no prefix of its own (NULL/empty). All stores share
 * the same running number sequence -- only the letter differs per store.
 */
export async function generateShortOrderCode(db: Db, storeId: number | null = null): Promise<string | null> {
  if ((await getSetting(db, 'short_order_code_enabled', '1')) !== '1') return null;
  let prefix = (await getSetting(db, 'short_order_code_prefix', 'A')) ?? 'A';
  if (storeId !== null) {
    const [store] = await db.query<{ code_prefix: string | null }>('SELECT code_prefix FROM stores WHERE id = ?', [storeId]);
    if (store?.code_prefix) prefix = store.code_prefix;
  }
  const digits = Math.max(1, parseInt((await getSetting(db, 'short_order_code_digits', '4')) ?? '4', 10) || 0);
  const n = await nextCounter(db, 'short_order_seq_counter', () => highestUsed(db, 'orders', 'short_order_code', prefix, `SUBSTRING(\`short_order_code\`, ${prefix.length + 1})`));
  return prefix + String(n).padStart(digits, '0');
}

export const generateInvoiceNumber = (db: Db) => generateDocumentNumber(db, 'invoice_prefix', 6);
export const generatePaymentNumber = (db: Db) => generateDocumentNumber(db, 'payment_prefix', 6);
export const generateRefundNumber = (db: Db) => generateDocumentNumber(db, 'refund_prefix', 6);
export const generateChallanNumber = (db: Db) => generateDocumentNumber(db, 'customer_challan_prefix', 6);
