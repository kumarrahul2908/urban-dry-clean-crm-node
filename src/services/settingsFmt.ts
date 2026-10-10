import type { Db } from '../db/pool.js';
import { numberFormat2 } from '../lib/php.js';
import { getSetting } from './settings.js';

/** format_currency(): '<currency_symbol> 1,234.50' (symbol defaults to 'Rs.'). */
export async function formatCurrency(db: Db, amount: number): Promise<string> {
  return `${(await getSetting(db, 'currency_symbol', 'Rs.')) ?? 'Rs.'} ${numberFormat2(amount)}`;
}
