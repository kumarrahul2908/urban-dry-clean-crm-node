import { phpRound } from '../lib/php.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ws_qty()/dash_qty(): whole numbers without decimals, otherwise 2dp with trailing zeros trimmed. */
export function qty(v: unknown): string {
  const q = parseFloat(String(v ?? '')) || 0;
  return q === Math.floor(q) ? String(Math.trunc(q)) : q.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** date('d M Y', strtotime('YYYY-MM-DD')) */
export function dMY(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d)); // day overflow rolls over like strtotime ("2026-02-31" → 03 Mar)
  return `${String(t.getUTCDate()).padStart(2, '0')} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/** PHP number_format($n, $dec) */
export function numberFormat(n: number, dec = 2): string {
  return phpRound(n, dec).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** (int)$x / intval for request/DB values */
export const int = (v: unknown): number => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : 0; };
export const flt = (v: unknown): number => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0; };

/** Groups rows by key, keeping first-seen order (PHP array insertion order for string keys). */
export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return m;
}
