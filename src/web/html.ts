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

/** json_encode() as PHP emits it for inline scripts: "/" escaped as "\/". */
export const jsonEncode = (v: unknown) =>
  JSON.stringify(v).replace(/\//g, '\\/').replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
