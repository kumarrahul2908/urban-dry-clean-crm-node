/** Trusted markup produced by html``/raw(); everything else interpolated into html`` is escaped. */
export class Raw {
  constructor(readonly value: string) {}
  toString() { return this.value; }
}
export const raw = (s: string) => new Raw(s);

/** PHP htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE): & < > " ' → entities (single quote as &#039;). */
export function e(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function part(v: unknown): string {
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  return e(v);
}

/** Tagged template: interpolations are HTML-escaped unless they are Raw (nested html``) or arrays of them. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1]!;
  return new Raw(out);
}

/** (float) cast of a DB/request value for json_encode (PHP prints whole floats as 370, not 370.0). */
export const pf = (v: unknown): number => parseFloat(String(v ?? '')) || 0;

function encode(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v).replace(/\//g, '\\/').replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(encode).join(',')}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${encode(k)}:${encode(x)}`).join(',')}}`;
}

/** json_encode() as PHP emits it (slashes and non-ASCII escaped) — for inline scripts and JSON responses. */
export const jsonEncode = encode;
