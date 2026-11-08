/** Trusted markup produced by html``/raw(); everything else interpolated into html`` is escaped. */
export class Raw {
    value;
    constructor(value) {
        this.value = value;
    }
    toString() { return this.value; }
}
export const raw = (s) => new Raw(s);
/** PHP htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE): & < > " ' → entities (single quote as &#039;). */
export function e(v) {
    if (v === null || v === undefined || v === false)
        return '';
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function part(v) {
    if (v instanceof Raw)
        return v.value;
    if (Array.isArray(v))
        return v.map(part).join('');
    return e(v);
}
/** Tagged template: interpolations are HTML-escaped unless they are Raw (nested html``) or arrays of them. */
export function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++)
        out += part(values[i]) + strings[i + 1];
    return new Raw(out);
}
/** (float) cast of a DB/request value for json_encode (PHP prints whole floats as 370, not 370.0). */
export const pf = (v) => parseFloat(String(v ?? '')) || 0;
function encode(v) {
    if (v === null || v === undefined)
        return 'null';
    if (typeof v === 'string')
        return JSON.stringify(v).replace(/\//g, '\\/').replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (typeof v === 'number' || typeof v === 'boolean')
        return String(v);
    if (Array.isArray(v))
        return `[${v.map(encode).join(',')}]`;
    return `{${Object.entries(v).map(([k, x]) => `${encode(k)}:${encode(x)}`).join(',')}}`;
}
/** json_encode() as PHP emits it (slashes and non-ASCII escaped) — for inline scripts and JSON responses. */
export const jsonEncode = encode;
