import type { Db } from '../db/pool.js';
import { verifyPassword } from '../lib/password.js';
import { parseUtcDatetime } from '../lib/time.js';
import type { LoginRateLimiter } from './loginRateLimiter.js';

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  full_name: string;
  password_hash: string;
  role_id: number;
  role_name: string;
  store_id: number | null;
  is_active: number;
  failed_login_count: number;
  locked_until: string | null;
}

export type VerifyResult =
  | { success: true; message: string; user: UserRow }
  | { success: false; message: string; user: null };

export interface AuthOptions {
  maxLoginAttempts: number;
  lockoutMinutes: number;
}

/** Roles that manage deliveries (Auth::DELIVERY_MANAGER_ROLES in PHP). */
export const DELIVERY_MANAGER_ROLES = ['Super Admin', 'Admin', 'Store Manager', 'Delivery Manager'];

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly limiter: LoginRateLimiter,
    private readonly opts: AuthOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Port of Auth::verifyCredentials(): same order of checks (IP block → unknown user → account
   * lock → inactive → wrong password) and same side effects, with identical messages.
   * Local time is only used for lock comparison; DB writes use the same formats as PHP.
   */
  async verifyCredentials(username: string, password: string, ip: string | null): Promise<VerifyResult> {
    const fail = (message: string): VerifyResult => ({ success: false, message, user: null });

    const ipBlocked = await this.limiter.blockedMinutesRemaining(ip);
    if (ipBlocked !== null) {
      return fail(`Login temporarily locked for this network. Try again in ${ipBlocked} minute(s).`);
    }

    const rows = await this.db.query<UserRow>(
      `SELECT u.*, r.role_name FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.username = ? OR u.email = ? LIMIT 1`,
      [username, username],
    );
    const user = rows[0];
    if (!user) {
      await this.limiter.recordFailure(ip);
      return fail('Invalid username or password.');
    }

    if (user.locked_until && parseUtcDatetime(user.locked_until) > this.now()) {
      const mins = Math.ceil((parseUtcDatetime(user.locked_until) - this.now()) / 60000);
      return fail(`Account locked. Try again in ${mins} minute(s).`);
    }

    if (!user.is_active) {
      return fail('Your account is deactivated. Contact administrator.');
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      await this.limiter.recordFailure(ip);
      const fails = Number(user.failed_login_count) + 1;
      const lockSql = fails >= this.opts.maxLoginAttempts;
      await this.db.execute(
        `UPDATE users SET failed_login_count = ?, locked_until = ${
          lockSql ? `NOW() + INTERVAL ${Math.max(1, this.opts.lockoutMinutes)} MINUTE` : 'NULL'
        } WHERE id = ?`,
        [fails, user.id],
      );
      return fail('Invalid username or password.');
    }

    await this.db.execute(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = ? WHERE id = ?',
      [ip, user.id],
    );
    return { success: true, message: 'Login successful.', user };
  }

  async permissionsForRole(roleId: number): Promise<string[]> {
    const rows = await this.db.query<{ permission_key: string }>(
      `SELECT p.permission_key FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      [roleId],
    );
    return rows.map((r) => r.permission_key);
  }
}
