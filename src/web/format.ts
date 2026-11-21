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

// ---------------------------------------------------------------------------------------------------------------
// format_date() / format_datetime() — DB datetimes are UTC and shown in APP_TIMEZONE; pure DATE / TIME values are not shifted.

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
interface Parts { y: number; m: number; d: number; h: number; i: number; s: number; dow: number }

/** PHP date($fmt) for the supported letters: d j D l N m n M F Y y H G h g i s A a. */
function phpDate(fmt: string, p: Parts): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  let out = '';
  for (let k = 0; k < fmt.length; k++) {
    const c = fmt[k]!;
    switch (c) {
      case 'd': out += pad(p.d); break;
      case 'j': out += String(p.d); break;
      case 'D': out += DAYS_FULL[p.dow]!.slice(0, 3); break;
      case 'l': out += DAYS_FULL[p.dow]; break;
      case 'm': out += pad(p.m); break;
      case 'n': out += String(p.m); break;
      case 'M': out += MON[p.m - 1]; break;
      case 'Y': out += String(p.y); break;
      case 'y': out += pad(p.y % 100); break;
      case 'H': out += pad(p.h); break;
      case 'G': out += String(p.h); break;
      case 'h': out += pad(h12); break;
      case 'g': out += String(h12); break;
      case 'i': out += pad(p.i); break;
      case 's': out += pad(p.s); break;
      case 'A': out += p.h < 12 ? 'AM' : 'PM'; break;
      case 'a': out += p.h < 12 ? 'am' : 'pm'; break;
      case '\\': k++; out += fmt[k] ?? ''; break;
      default: out += c;
    }
  }
  return out;
}

const partsFromUtcString = (s: string): Parts | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, i, sec] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  return { y, m: mo, d, h, i, s: sec, dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay() };
};

const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function partsInTz(ms: number, tz: string): Parts {
  let f = tzFormatters.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' }); tzFormatters.set(tz, f); }
  const o: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) o[x.type] = x.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday!);
  return { y: +o.year!, m: +o.month!, d: +o.day!, h: +o.hour! % 24, i: +o.minute!, s: +o.second!, dow };
}

/** date($fmt, strtotime($v)) for a DB wall-clock string: formatted AS-IS in the app timezone, no UTC->tz shift (unlike format_date). */
export function wallDate(fmt: string, v: unknown): string {
  const p = partsFromUtcString(String(v ?? '').trim());
  return p ? phpDate(fmt, p) : '';
}

/** format_date($v, $fmt): '' for empty/zero dates. */
export function formatDate(v: unknown, tz: string, fmt = 'd-M-Y'): string {
  if (v === null || v === undefined || v === '' || v === 0 || v === '0') return '';
  if (typeof v === 'number') return phpDate(fmt, partsInTz(v * 1000, tz));
  const str = String(v).trim();
  if (str === '' || str.startsWith('0000-00-00')) return '';
  if (/^\d+$/.test(str)) return phpDate(fmt, partsInTz(Number(str) * 1000, tz));
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) { const p = partsFromUtcString(str); return p ? phpDate(fmt, p) : ''; }
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str);
  if (t) return phpDate(fmt, { y: 1970, m: 1, d: 1, h: +t[1]!, i: +t[2]!, s: +(t[3] ?? 0), dow: 4 });
  const p = partsFromUtcString(str);
  if (!p) return '';
  return phpDate(fmt, partsInTz(Date.UTC(p.y, p.m - 1, p.d, p.h, p.i, p.s), tz));
}
export const formatDatetime = (v: unknown, tz: string, fmt = 'd-M-Y h:i A') => formatDate(v, tz, fmt);

/** urlencode(): everything except [A-Za-z0-9_.-] is percent-encoded, space as "+". */
export const urlencode = (s: string) => encodeURIComponent(s).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');

/** http_build_query() for flat string maps (urlencode for keys and values, "&"-joined). */
export const httpBuildQuery = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${urlencode(k)}=${urlencode(String(v ?? ''))}`).join('&');

/** A form field posted as `name[]` (PHP array): string for one value, string[] for several (querystring parser). */
export function formArray(body: Record<string, unknown>, name: string): string[] {
  const v = body[`${name}[]`] ?? body[name];
  return Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)];
}

/** PHP (string) of a float: whole numbers without ".0". */
export const floatStr = (n: number) => String(n);

/**
 * whatsapp_link_number(): normalizes a raw customer/staff-entered mobile number into the digits-only, country-coded shape a wa.me link needs
 * (e.g. "919667271056"), assuming India/+91 when no country code is present.
 */
export function whatsappLinkNumber(rawNumber: string): string {
  let digits = rawNumber.replace(/\D+/g, '');
  if (digits === '') return digits;
  if (digits.length >= 13 || (digits.length === 12 && digits.startsWith('91'))) return digits;
  if (digits.length === 11 && digits[0] === '0') digits = digits.slice(1);
  if (digits.length === 10) return '91' + digits;
  return digits;
}
