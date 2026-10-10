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

/** PHP round(x, 2). */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

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
