import { z } from 'zod';
import { ApiError, ok } from '../../lib/http.js';
import { bearerToken } from '../../app.js';
const loginBody = z.object({
    username: z.string().trim().min(1),
    password: z.string().min(1), // never trim a password
    device_name: z.string().trim().max(150).optional().default(''),
    device_id: z.string().trim().max(150).optional().default(''),
});
/** Ports of api/mobile/login.php, logout.php and me.php — same paths minus ".php" kept as aliases. */
export async function registerMobileAuthRoutes(app) {
    const { auth, apiAuth, audit, db } = app.services;
    const login = async (req) => {
        const parsed = loginBody.safeParse(req.body ?? {});
        if (!parsed.success)
            throw new ApiError('invalid_request', 'Username and password are required.', 422);
        const { username, password, device_name, device_id } = parsed.data;
        const result = await auth.verifyCredentials(username, password, req.ip);
        if (!result.success) {
            const accountState = /locked|deactivated/i.test(result.message);
            throw new ApiError('authentication_failed', result.message, accountState ? 403 : 401);
        }
        const issued = await apiAuth.issueToken(result.user.id, device_name, device_id, req.ip);
        await audit.record({
            action: 'login',
            module: 'auth',
            recordId: String(result.user.id),
            newValue: `mobile login${device_name ? ` (${device_name})` : ''}`,
            userId: result.user.id,
            ip: req.ip,
        });
        return ok({ ...issued, user: await apiAuth.userContext(result.user) });
    };
    const logout = async (req) => {
        const token = bearerToken(req);
        if (token === null)
            throw new ApiError('unauthorized', 'Missing or malformed Authorization header.', 401);
        const ctx = await apiAuth.validateToken(token); // resolve the actor BEFORE revoking
        const revoked = await apiAuth.revokeToken(token);
        if (ctx) {
            await audit.record({ action: 'logout', module: 'auth', recordId: String(ctx.id), newValue: 'mobile logout', userId: ctx.id, ip: req.ip });
        }
        return ok({ revoked });
    };
    const me = async (req) => {
        const ctx = await app.requireToken(req);
        let fixedStore = null;
        if (ctx.store_id !== null) {
            const rows = await db.query('SELECT id, store_name, store_type, is_active FROM stores WHERE id = ?', [ctx.store_id]);
            const r = rows[0];
            if (r)
                fixedStore = { id: Number(r.id), name: r.store_name, type: r.store_type, is_active: !!r.is_active };
        }
        let available = [];
        if (fixedStore === null) {
            const rows = await db.query('SELECT id, store_name, store_type FROM stores WHERE is_active = 1 ORDER BY store_name');
            available = rows.map((r) => ({ id: Number(r.id), name: r.store_name, type: r.store_type }));
        }
        return ok({
            user: { id: ctx.id, username: ctx.username, full_name: ctx.full_name, email: ctx.email, role_id: ctx.role_id, role_name: ctx.role_name },
            store: { fixed_store: fixedStore, requires_store_selection: fixedStore === null, available_stores: available },
            permissions: ctx.permissions,
        });
    };
    for (const suffix of ['', '.php']) {
        app.post(`/login${suffix}`, login);
        app.post(`/logout${suffix}`, logout);
        app.get(`/me${suffix}`, me);
    }
}
