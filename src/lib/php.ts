/** PHP semantics the ported code relies on. */

/** PHP empty(): false for null/undefined, false, 0, "0", "", "0.0"? (no: only "0" and ""), []. */
export function phpEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || v === '0') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/** PHP (float) cast of a request value. */
export function toFloat(v: unknown): number {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** PHP (int) cast of a request value. */
export function toInt(v: unknown): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

const roundHelper = (v: number): number => (v >= 0 ? Math.floor(v + 0.5) : Math.ceil(v - 0.5));

/**
 * PHP 7 round($value, $places) (_php_math_round with pre-rounding), so money rounds exactly as the
 * PHP app did — e.g. round(1.005, 2) === 1.01, which naive Math.round(x*100)/100 gets wrong.
 */
export function phpRound(value: number, places = 2): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const precisionPlaces = 14 - Math.floor(Math.log10(Math.abs(value)));
  const f1 = 10 ** Math.abs(places);
  let tmp: number;
  if (precisionPlaces > places && precisionPlaces - 15 < places) {
    let usePrecision = precisionPlaces;
    tmp = usePrecision >= 0 ? value * 10 ** usePrecision : value / 10 ** -usePrecision;
    tmp = roundHelper(tmp);
    usePrecision = Math.max(-4 * 15, places - usePrecision);
    tmp = tmp / 10 ** Math.abs(usePrecision);
  } else {
    tmp = places >= 0 ? value * f1 : value / f1;
    if (!Number.isFinite(tmp)) return value;
  }
  if (Math.abs(tmp) >= 1e15) return value;
  tmp = roundHelper(tmp);
  return places >= 0 ? tmp / f1 : tmp * f1;
}

/** PHP round(x, 2). */
export const round2 = (n: number): number => phpRound(n, 2);

/** PHP is_numeric() for request values. */
export function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  return /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

/** PHP number_format($n, 2). */
export const numberFormat2 = (n: number): string =>
  phpRound(n, 2).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function simText(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let max = 0, pa = 0, pb = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > max) { max = k; pa = i; pb = j; }
    }
  }
  if (!max) return 0;
  return max + simText(a.slice(0, pa), b.slice(0, pb)) + simText(a.slice(pa + max), b.slice(pb + max));
}

/** PHP similar_text($a, $b, $percent): returns the percent. */
export function similarTextPercent(a: string, b: string): number {
  if (!a.length && !b.length) return 0;
  return (simText(a, b) * 2 * 100) / (a.length + b.length);
}
