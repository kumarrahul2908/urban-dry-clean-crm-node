export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ } }
  }
  return out;
}

export function serializeCookie(name: string, value: string, o: { maxAgeSeconds?: number; secure?: boolean } = {}): string {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (o.maxAgeSeconds !== undefined) s += `; Max-Age=${o.maxAgeSeconds}; Expires=${new Date(Date.now() + o.maxAgeSeconds * 1000).toUTCString()}`;
  if (o.secure) s += '; Secure';
  return s;
}
