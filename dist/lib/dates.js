/** Calendar helpers in a fixed IANA timezone (APP_TIMEZONE) — PHP's date()/strtotime() ran in it. */
export function todayIn(tz, now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
/** date('Y-m-d', strtotime("+N day")) */
export function datePlusDays(tz, days, now = new Date()) {
    const [y, m, d] = todayIn(tz, now).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export const yearIn = (tz, now = new Date()) => todayIn(tz, now).slice(0, 4);
/** First day of the current month in `tz` (PHP date('Y-m-01')). */
export const monthStartIn = (tz, now = new Date()) => `${todayIn(tz, now).slice(0, 7)}-01`;
/** PHP strtotime("YYYY-MM-DD") truthiness for a date that already matched \d{4}-\d{2}-\d{2}: month 1-12, day 1-31 (overflow allowed). */
export function isStrtotimeDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
        return false;
    const mo = Number(m[2]), d = Number(m[3]);
    return Number(m[1]) >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}
/** date('Y-m-d', strtotime("$date +N day")) with PHP-style day overflow. */
export function addDays(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** date('d-M', ...) e.g. 10-Oct */
export function dayMon(date) {
    const [y, m, d] = date.split('-').map(Number);
    return `${String(d).padStart(2, '0')}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
}
/** checkdate() */
export function checkDate(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** format_date() for a pure DATE column ('YYYY-MM-DD' -> 'd-M-Y'); '' for empty / 0000-00-00. */
export function formatDateOnly(v) {
    if (v === null || v === undefined || v === '' || v === 0 || v === '0')
        return '';
    const s = String(v).trim();
    if (s === '' || s.startsWith('0000-00-00'))
        return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
        return '';
    return `${m[3]}-${dayMon(s).slice(3)}-${m[1]}`;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parts = (d) => d.split('-').map(Number);
/** PHP date('jMy') of a YYYY-MM-DD, e.g. 5Oct26 */
export const fmtJMy = (d) => { const [y, m, dd] = parts(d); return `${dd}${MON[m - 1]}${String(y).slice(-2)}`; };
/** PHP date('My') e.g. Oct26 */
export const fmtMy = (d) => { const [y, m] = parts(d); return `${MON[m - 1]}${String(y).slice(-2)}`; };
/** PHP date('j') */
export const fmtJ = (d) => String(parts(d)[2]);
/** PHP date('Ym') */
export const fmtYm = (d) => d.slice(0, 7).replace('-', '');
/** Whole days between two YYYY-MM-DD dates (a - b). */
export const diffDays = (a, b) => Math.floor((Date.UTC(...parts(a).map((v, i) => (i === 1 ? v - 1 : v))) - Date.UTC(...parts(b).map((v, i) => (i === 1 ? v - 1 : v)))) / 86400000);
/** PHP date('H:i:s') in tz */
export const timeIn = (tz, now = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
