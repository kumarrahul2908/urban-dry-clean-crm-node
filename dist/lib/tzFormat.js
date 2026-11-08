const cache = new Map();
/** PHP date('Y-m-d H:i:s', $ts) in the given IANA time zone. */
export function datetimeIn(tz, ms) {
    let f = cache.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        cache.set(tz, f);
    }
    return f.format(new Date(ms)).replace(/ /g, ' ');
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** PHP date('d M Y', strtotime('YYYY-MM-DD…')). */
export function dMonY(date) {
    const [y, m, d] = date.slice(0, 10).split('-');
    return `${d} ${MON[Number(m) - 1]} ${y}`;
}
