import { createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from '../lib/password.js';
/** Auth::attempt(): credentials → fresh session with user + permissions. */
export async function attemptLogin(ctx, username, password) {
    const { auth, audit } = ctx.svc;
    const r = await auth.verifyCredentials(username, password, ctx.req.ip);
    if (!r.success)
        return { success: false, message: r.message };
    const u = r.user;
    ctx.regenerateId();
    ctx.set('user_id', Number(u.id));
    ctx.set('user', { id: Number(u.id), full_name: u.full_name, username: u.username, role_id: Number(u.role_id), role_name: u.role_name, store_id: u.store_id === null ? null : Number(u.store_id) });
    ctx.set('permissions', await auth.permissionsForRole(Number(u.role_id)));
    ctx.set('last_activity', ctx.now);
    await audit.record({ action: 'login', module: 'auth', recordId: String(u.id), userId: Number(u.id), ip: ctx.req.ip });
    return { success: true, message: 'Login successful.' };
}
export async function logoutUser(ctx) {
    if (ctx.data.user_id !== undefined) {
        await ctx.svc.audit.record({ action: 'logout', module: 'auth', recordId: String(ctx.data.user_id), userId: ctx.data.user_id, ip: ctx.req.ip });
    }
    ctx.logout();
}
export async function resetPasswordWithToken(svc, rawToken, newPassword, ip) {
    const hashed = createHash('sha256').update(rawToken).digest('hex');
    const rows = await svc.db.query('SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > NOW() LIMIT 1', [hashed]);
    if (!rows[0])
        return { success: false, message: 'This reset link is invalid or has expired.' };
    await svc.db.execute('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?', [await hashPassword(newPassword), rows[0].id]);
    await svc.audit.record({ action: 'edit', module: 'auth', recordId: String(rows[0].id), newValue: 'password reset via token', userId: null, ip });
    return { success: true, message: 'Password has been reset. You can now log in.' };
}
export async function changePassword(svc, userId, current, next, ip) {
    const rows = await svc.db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash)))
        return { success: false, message: 'Current password is incorrect.' };
    await svc.db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), userId]);
    await svc.audit.record({ action: 'edit', module: 'auth', recordId: String(userId), newValue: 'password changed by user', userId, ip });
    return { success: true, message: 'Password changed successfully.' };
}
