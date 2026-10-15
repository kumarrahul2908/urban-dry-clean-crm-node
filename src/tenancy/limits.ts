import type { Db } from '../db/pool.js';
import { currentTenant } from './als.js';

export type LimitKind = 'orders' | 'users' | 'stores';

/** Plan limit check for the current business. Returns a user-facing message when the limit is reached, otherwise null. No tenant (single-business mode) = no limits. */
export async function limitError(db: Db, kind: LimitKind): Promise<string | null> {
  const t = currentTenant()?.tenant;
  if (!t) return null;
  const max = kind === 'orders' ? t.limits.ordersPerMonth : kind === 'users' ? t.limits.users : t.limits.stores;
  if (!max) return null; // 0 = unlimited
  const sql = kind === 'orders' ? "SELECT COUNT(*) AS n FROM orders WHERE order_date >= DATE_FORMAT(NOW(), '%Y-%m-01')"
    : kind === 'users' ? 'SELECT COUNT(*) AS n FROM users WHERE is_active = 1' : 'SELECT COUNT(*) AS n FROM stores WHERE is_active = 1';
  const n = Number((await db.query<{ n: number }>(sql))[0]!.n);
  if (n < max) return null;
  const what = kind === 'orders' ? `${max} orders per month` : kind === 'users' ? `${max} active users` : `${max} active store${max === 1 ? '' : 's'}`;
  return `Your ${t.planCode ?? 'current'} plan allows up to ${what}. Please upgrade your plan to add more.`;
}
