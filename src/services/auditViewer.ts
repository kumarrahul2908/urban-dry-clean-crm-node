import type { Db } from '../db/pool.js';
import { checkDate } from '../lib/dates.js';

/** Port of includes/AuditViewer.php — filters, pagination and (security-critical) value redaction. */
export const AUDIT_ALLOWED_ROLES = ['Super Admin', 'Admin'];
const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 100;
const MAX_VALUE_CHARS = 4000;
export const REDACTED = '[REDACTED]';
const SECRET_KEYS = new Set(['otp', 'otp_expires', 'otp_code', 'csrf', 'csrf_token', 'password', 'password_hash', 'passwd', 'pass', 'pwd', 'pin',
  'token', 'token_hash', 'access_token', 'refresh_token', 'bearer', 'auth_key', 'auth_token', 'authorization',
  'api_key', 'apikey', 'secret', 'client_secret', 'private_key', 'credentials', 'session', 'session_id', 'remember_token']);
const SECRET_KEY_PARTS = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'csrf', 'credential', 'private_key', 'session'];
const PHONE_KEYS = new Set(['mobile', 'alt_mobile', 'phone', 'whatsapp', 'whatsapp_number', 'contact_number', 'recipient']);
const EMAIL_KEYS = new Set(['email']);
const PII_REDACT_KEYS = new Set(['address', 'birthday', 'anniversary', 'gstin']);

export interface AuditFilters { module: string | null; action: string | null; user_id: number | null; record_id: string | null; date_from: string | null; date_to: string | null; page: number; per_page: number }

export const roleAllowed = (role: string | null | undefined) => AUDIT_ALLOWED_ROLES.includes(role ?? '');

export function parseFilters(q: Record<string, unknown>): { filters: AuditFilters; errors: string[] } {
  const f: AuditFilters = { module: null, action: null, user_id: null, record_id: null, date_from: null, date_to: null, page: 1, per_page: DEFAULT_PER_PAGE };
  const errors: string[] = [];
  const str = (k: string) => (typeof q[k] === 'string' || typeof q[k] === 'number' ? String(q[k]).trim() : '');
  for (const k of ['module', 'action'] as const) {
    const v = str(k);
    if (v === '') continue;
    if (!/^[a-z0-9_]{1,60}$/.test(v)) errors.push(`Invalid ${k}.`);
    else f[k] = v;
  }
  let v = str('user_id');
  if (v !== '') {
    if (!/^\d+$/.test(v) || parseInt(v, 10) < 1) errors.push('Invalid user.');
    else f.user_id = parseInt(v, 10);
  }
  v = str('record_id');
  if (v !== '') {
    if ([...v].length > 30 || /[\x00-\x1F\x7F]/.test(v)) errors.push('Invalid record id.');
    else f.record_id = v;
  }
  for (const k of ['date_from', 'date_to'] as const) {
    v = str(k);
    if (v === '') continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m || !checkDate(Number(m[1]), Number(m[2]), Number(m[3]))) errors.push('Invalid date (use YYYY-MM-DD).');
    else f[k] = v;
  }
  if (f.date_from && f.date_to && f.date_from > f.date_to) errors.push('From date is after To date.');
  v = str('page');
  if (v !== '') {
    if (!/^\d+$/.test(v) || parseInt(v, 10) < 1 || parseInt(v, 10) > 100000) errors.push('Invalid page.');
    else f.page = parseInt(v, 10);
  }
  v = str('per_page');
  if (v !== '') {
    if (!/^\d+$/.test(v) || parseInt(v, 10) < 1 || parseInt(v, 10) > MAX_PER_PAGE) errors.push(`per_page must be 1-${MAX_PER_PAGE}.`);
    else f.per_page = parseInt(v, 10);
  }
  return { filters: f, errors: [...new Set(errors)] };
}

export async function fetchAudit(db: Db, f: AuditFilters) {
  const where = ['1=1'];
  const params: unknown[] = [];
  if (f.module !== null) { where.push('a.module = ?'); params.push(f.module); }
  if (f.action !== null) { where.push('a.action = ?'); params.push(f.action); }
  if (f.user_id !== null) { where.push('a.user_id = ?'); params.push(f.user_id); }
  if (f.record_id !== null) { where.push('a.record_id = ?'); params.push(f.record_id); }
  if (f.date_from !== null) { where.push('a.created_at >= ?'); params.push(`${f.date_from} 00:00:00`); }
  if (f.date_to !== null) { where.push('a.created_at < ? + INTERVAL 1 DAY'); params.push(`${f.date_to} 00:00:00`); }
  const w = where.join(' AND ');
  const [{ n }] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${w}`, params)) as [{ n: number }];
  const rows = await db.query<Record<string, any>>(
    `SELECT a.id, a.user_id, a.action, a.module, a.record_id, a.old_value, a.new_value, a.ip_address, a.created_at,
            u.full_name AS actor_name, u.username AS actor_username
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, f.per_page, (f.page - 1) * f.per_page],
  );
  return {
    rows: rows.map((r) => {
      const [oldText, oldFormat] = redactValue(r.old_value);
      const [newText, newFormat] = redactValue(r.new_value);
      return {
        id: Number(r.id),
        created_at: r.created_at,
        user_id: r.user_id !== null ? Number(r.user_id) : null,
        actor: r.user_id === null ? 'System' : r.actor_name || r.actor_username || `User #${r.user_id}`,
        actor_username: r.actor_username,
        module: r.module, action: r.action, record_id: r.record_id,
        old_value: oldText, old_format: oldFormat, new_value: newText, new_format: newFormat,
        ip_address: r.ip_address !== null && r.ip_address !== '' ? REDACTED : null,
      };
    }),
    total: Number(n), page: f.page, per_page: f.per_page,
  };
}

export async function auditOptions(db: Db) {
  const modules = await db.query<{ module: string }>('SELECT DISTINCT module FROM audit_logs ORDER BY module');
  const actions = await db.query<{ action: string }>('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  const actors = await db.query<{ id: number; full_name: string | null; username: string }>(
    'SELECT u.id, u.full_name, u.username FROM users u WHERE u.id IN (SELECT DISTINCT user_id FROM audit_logs WHERE user_id IS NOT NULL) ORDER BY u.full_name, u.id',
  );
  return { modules: modules.map((m) => m.module), actions: actions.map((a) => a.action), actors: actors.map((u) => ({ id: Number(u.id), name: u.full_name || u.username })) };
}

export function redactValue(raw: string | null): [string | null, 'json' | 'text' | null] {
  if (raw === null || raw === '') return [null, null];
  let decoded: unknown;
  let valid = true;
  try { decoded = JSON.parse(raw); } catch { valid = false; }
  if (valid && decoded !== null && typeof decoded === 'object') {
    // PHP decodes {} and [] alike (empty array) and re-encodes both as [].
    return [truncate(JSON.stringify(redactNode(decoded), null, 4)), 'json'];
  }
  const text = valid && decoded !== null && typeof decoded !== 'object' ? String(decoded) : valid && decoded === null ? '' : raw;
  return [truncate(redactText(text)), 'text'];
}

function redactNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((v) => (v !== null && typeof v === 'object' ? redactNode(v) : redactScalar(null, v)));
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return [];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    const key = k.toLowerCase();
    if (isSecretKey(key)) { out[k] = REDACTED; continue; }
    if (PII_REDACT_KEYS.has(key)) { out[k] = v === null || v === '' ? v : REDACTED; continue; }
    if (v !== null && typeof v === 'object') { out[k] = redactNode(v); continue; }
    if (PHONE_KEYS.has(key) && v !== null && v !== '' && typeof v !== 'object') { out[k] = maskPhone(String(v)); continue; }
    if (EMAIL_KEYS.has(key) && typeof v === 'string' && v !== '') { out[k] = maskEmail(v); continue; }
    out[k] = redactScalar(key, v);
  }
  return out;
}
const redactScalar = (_k: string | null, v: unknown) => (typeof v === 'string' && looksLikeSecretValue(v) ? REDACTED : v);

export function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(key)) return true;
  if (SECRET_KEY_PARTS.some((p) => key.includes(p))) return true;
  return /(^|_)otp($|_)|(^|_)hash$/.test(key);
}
const looksLikeSecretValue = (v: string) => /^\s*bearer\s+\S+|^eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}$|^\$(2[abxy]|argon2i?d?)\$/i.test(v);
function redactText(t: string): string {
  if (/pass(word|wd)?|token|secret|otp|csrf|api.?key|bearer|credential|eyJ[\w-]{5,}\.|\$2[abxy]\$/i.test(t)) return REDACTED;
  return t.replace(/\d{6,}/g, (m) => '*'.repeat(m.length - 4) + m.slice(-4));
}
function maskPhone(v: string): string {
  const digits = v.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : '*'.repeat(digits.length - 4) + digits.slice(-4);
}
function maskEmail(v: string): string {
  const at = v.lastIndexOf('@');
  if (at <= 0) return REDACTED;
  return `${[...v][0]}***${v.slice(at)}`;
}
function truncate(t: string): string {
  const chars = [...t];
  return chars.length > MAX_VALUE_CHARS ? `${chars.slice(0, MAX_VALUE_CHARS).join('')}\n… (truncated)` : t;
}
