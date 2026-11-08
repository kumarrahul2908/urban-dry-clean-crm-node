import { createHash } from 'node:crypto';
import { WebRedirect, WebText, webPage } from '../web/context.js';
import { postLoginRedirect } from '../web/pages/auth.js';
import { currentTenant } from './als.js';
/** Tenant-host side of "open as owner": a 60-second single-use token minted by the operator console becomes a normal session for that business's Super Admin. Audited in both places. */
export function registerImpersonation(app, registry) {
    webPage(app, '/__impersonate', { auth: 'public', methods: ['GET'], exact: true }, async (ctx, req) => {
        const token = String(req.query.token ?? '');
        const tenant = currentTenant()?.tenant;
        if (!tenant || !/^[0-9a-f]{64}$/.test(token))
            return new WebText('Invalid link.', 400);
        const h = createHash('sha256').update(token).digest('hex');
        const claimed = await registry.control.execute('UPDATE impersonation_tokens SET used = 1 WHERE token_hash = ? AND used = 0 AND expires_at > NOW() AND tenant_id = ?', [h, tenant.id]);
        if (!claimed.affectedRows)
            return new WebText('This link has expired or was already used.', 410);
        const row = (await registry.control.query('SELECT user_id, admin_id FROM impersonation_tokens WHERE token_hash = ?', [h]))[0];
        const { auth, audit, db } = ctx.svc;
        const u = (await db.query('SELECT u.id, u.full_name, u.username, u.role_id, u.store_id, r.role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.is_active = 1', [row.user_id]))[0];
        if (!u)
            return new WebText('The owner account is no longer available.', 410);
        ctx.regenerateId();
        ctx.set('user_id', Number(u.id));
        ctx.set('user', { id: Number(u.id), full_name: u.full_name, username: u.username, role_id: Number(u.role_id), role_name: u.role_name, store_id: u.store_id === null ? null : Number(u.store_id) });
        ctx.set('permissions', await auth.permissionsForRole(Number(u.role_id)));
        ctx.set('last_activity', ctx.now);
        ctx.set('impersonated_by_admin', row.admin_id);
        await audit.record({ action: 'impersonate', module: 'auth', recordId: String(u.id), newValue: { operator_admin_id: row.admin_id }, userId: Number(u.id), ip: req.ip });
        return new WebRedirect(postLoginRedirect(ctx));
    });
}
