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
