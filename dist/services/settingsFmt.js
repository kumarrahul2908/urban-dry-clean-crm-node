import { numberFormat2 } from '../lib/php.js';
import { getSetting } from './settings.js';
/** format_currency(): '<currency_symbol> 1,234.50' (symbol defaults to 'Rs.'). */
export async function formatCurrency(db, amount) {
    return `${(await getSetting(db, 'currency_symbol', 'Rs.')) ?? 'Rs.'} ${numberFormat2(amount)}`;
}
