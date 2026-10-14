import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../../lib/password.js';
import { phpEmpty, toInt } from '../../lib/php.js';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplAdminUsers } from '../tpl/admin_users.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);

export function registerAdminUsersPage(app: FastifyInstance) {
  const { db, audit } = app.services;
  webPage(app, '/modules/admin/users', { auth: 'users.manage' }, async (ctx, req) => {
    const errors: string[] = [];
    const roles = await db.query<Row>('SELECT id, role_name FROM roles ORDER BY id');
    const stores = await db.query<Row>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
    const workshopsList = await db.query<Row>('SELECT id, workshop_name FROM workshops WHERE is_active = 1 ORDER BY workshop_name');
    const sessionUser = Number(ctx.data.user_id);
    const actorId = ctx.data.user_id ?? null;

    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const action = clean(p.action);
      if (action === 'create' || action === 'update') {
        const userId = toInt(p.user_id);
        const fullName = clean(p.full_name), username = clean(p.username), email = clean(p.email), mobile = clean(p.mobile), employeeCode = clean(p.employee_code);
        const roleId = toInt(p.role_id);
        const storeId: number | null = !phpEmpty(p.store_id) ? toInt(p.store_id) : null;
        let workshopId: number | null = !phpEmpty(p.workshop_id) ? toInt(p.workshop_id) : null;
        const isActive = 'is_active' in p ? 1 : 0;
        const password = str(p.password);
        if (fullName === '') errors.push('Full name is required.');
        if (username === '') errors.push('Username is required.');
        if (!roles.some((r) => Number(r.id) === roleId)) errors.push('Please select a valid, existing role.');
        const roleName = roles.find((r) => Number(r.id) === roleId)?.role_name ?? '';
        if (roleName !== 'Workshop Staff') workshopId = null;
        if (workshopId !== null && !workshopsList.some((w) => Number(w.id) === workshopId)) errors.push('Please select a valid, active workshop.');
        if (storeId !== null && !stores.some((s) => Number(s.id) === storeId)) errors.push('Please select a valid, active store.');
        if (action === 'create' && Buffer.byteLength(password) < 8) errors.push('Password must be at least 8 characters.');
        if (action === 'update' && password !== '' && Buffer.byteLength(password) < 8) errors.push('New password must be at least 8 characters (leave blank to keep the current password).');
        if (action === 'update' && userId === sessionUser && !isActive) errors.push('You cannot deactivate your own account while logged in as it.');
        if (!errors.length) {
          try {
            if (action === 'create') {
              const hash = await hashPassword(password);
              const r = await db.execute('INSERT INTO users (role_id, employee_code, full_name, username, email, mobile, password_hash, store_id, workshop_id, is_active) VALUES (?,?,?,?,?,?,?,?,?,?)',
                [roleId, phpEmpty(employeeCode) ? null : employeeCode, fullName, username, phpEmpty(email) ? null : email, phpEmpty(mobile) ? null : mobile, hash, storeId, workshopId, isActive]);
              await audit.record({ action: 'create', module: 'users', recordId: String(r.insertId), newValue: { username, role_id: roleId, store_id: storeId, workshop_id: workshopId }, userId: actorId, ip: req.ip });
              ctx.flashSet('success', `User "${fullName}" created.`);
            } else if (!userId) errors.push('Invalid user.');
            else {
              const old = (await db.query<Row>('SELECT * FROM users WHERE id = ?', [userId]))[0];
              if (!old) errors.push('User not found.');
              else {
                let sql = 'UPDATE users SET role_id=?, employee_code=?, full_name=?, username=?, email=?, mobile=?, store_id=?, workshop_id=?, is_active=?';
                const params: unknown[] = [roleId, phpEmpty(employeeCode) ? null : employeeCode, fullName, username, phpEmpty(email) ? null : email, phpEmpty(mobile) ? null : mobile, storeId, workshopId, isActive];
                if (password !== '') { sql += ', password_hash=?'; params.push(await hashPassword(password)); }
                sql += ' WHERE id = ?'; params.push(userId);
                await db.execute(sql, params);
                await audit.record({ action: 'edit', module: 'users', recordId: String(userId),
                  oldValue: { role_id: old.role_id, store_id: old.store_id, workshop_id: old.workshop_id ?? null, is_active: old.is_active },
                  newValue: { role_id: roleId, store_id: storeId, workshop_id: workshopId, is_active: isActive, password_changed: password !== '' }, userId: actorId, ip: req.ip });
                ctx.flashSet('success', `User "${fullName}" updated.`);
              }
            }
          } catch (e) {
            errors.push((e as { sqlState?: string }).sqlState === '23000' ? 'That username, email, or employee code is already in use by another user.' : 'Could not save the user.');
          }
        }
        if (!errors.length) return new WebRedirect('modules/admin/users.php');
      } else if (action === 'toggle_active') {
        const userId = toInt(p.user_id);
        if (userId === sessionUser) ctx.flashSet('danger', 'You cannot deactivate your own account.');
        else {
          const row = (await db.query<Row>('SELECT is_active, full_name FROM users WHERE id = ?', [userId]))[0];
          if (row) {
            const ns = row.is_active ? 0 : 1;
            await db.execute('UPDATE users SET is_active = ? WHERE id = ?', [ns, userId]);
            await audit.record({ action: 'edit', module: 'users', recordId: String(userId), oldValue: { is_active: row.is_active }, newValue: { is_active: ns }, userId: actorId, ip: req.ip });
            ctx.flashSet('success', `${ns ? 'Activated' : 'Deactivated'} "${row.full_name}".`);
          }
        }
        return new WebRedirect('modules/admin/users.php');
      }
    }
    const users = await db.query<Row>(
      `SELECT u.id, u.full_name, u.username, u.email, u.mobile, u.employee_code, u.is_active, u.created_at, u.store_id, u.workshop_id,
       r.id AS role_id, r.role_name, s.store_name, w.workshop_name FROM users u JOIN roles r ON r.id = u.role_id
       LEFT JOIN stores s ON s.id = u.store_id LEFT JOIN workshops w ON w.id = u.workshop_id ORDER BY u.full_name`);
    const h = await tplHelpers(ctx);
    return layout(ctx, { title: 'Users & Roles' }, raw(tplAdminUsers({ _SESSION: { user_id: ctx.data.user_id }, errors, roles, stores, users, workshopsList }, h)));
  });
}
