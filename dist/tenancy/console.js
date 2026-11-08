import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { parseCookies, serializeCookie } from '../web/cookies.js';
import { approveSignup } from './signup.js';
const COOKIE = 'udc_admin';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Operator console (admin host): tenants, usage, plans, signup requests, suspend/resume, plan changes, impersonation, export. */
export function registerConsole(app, env, registry) {
    const ctl = registry.control;
    const attempts = new Map();
    const throttled = (ip) => { const now = Date.now(); const a = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000); a.push(now); attempts.set(ip, a); return a.length > 10; };
    const secure = (req) => req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
    const session = async (req) => {
        const id = parseCookies(req.headers.cookie)[COOKIE];
        if (!id)
            return null;
        const r = (await ctl.query('SELECT s.admin_id, s.csrf, a.username FROM admin_sessions s JOIN super_admins a ON a.id = s.admin_id AND a.is_active = 1 WHERE s.id = ? AND s.expires_at > NOW()', [sha(id)]))[0];
        return r ? { adminId: r.admin_id, csrf: r.csrf, username: r.username } : null;
    };
    const html = (reply, body, status = 200, sess) => reply.code(status).type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Operator console</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.2/css/bootstrap.min.css" rel="stylesheet"></head><body class="bg-light">
<nav class="navbar navbar-dark bg-dark px-3 mb-3"><span class="navbar-brand">Operator console</span>${sess ? `<span class="navbar-text"><a class="text-white me-3" href="/console">Businesses</a><a class="text-white me-3" href="/console/requests">Signup requests</a><a class="text-white me-3" href="/console/plans">Plans</a>${esc(sess.username)}
<form method="POST" action="/console/logout" class="d-inline ms-3"><input type="hidden" name="csrf" value="${sess.csrf}"><button class="btn btn-sm btn-outline-light">Logout</button></form></span>` : ''}</nav>
<div class="container-fluid px-4">${body}</div></body></html>`);
    const needLogin = async (req, reply) => {
        const s = await session(req);
        if (!s) {
            reply.redirect('/console/login');
            return null;
        }
        return s;
    };
    const post = async (req, reply) => {
        const s = await needLogin(req, reply);
        if (!s)
            return null;
        const b = (req.body ?? {});
        if (b.csrf !== s.csrf) {
            reply.code(419).type('text/plain').send('Invalid or expired security token.');
            return null;
        }
        return { s, b };
    };
    const tenantBySlug = async (slug) => (await ctl.query('SELECT t.*, p.code AS plan_code, p.max_stores, p.max_users, p.max_orders_month FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id WHERE t.slug = ?', [slug]))[0] ?? null;
    const event = (tenantId, ev, detail) => ctl.execute('INSERT INTO tenant_events (tenant_id, event, detail) VALUES (?,?,?)', [tenantId, ev, detail]);
    const usage = async (t) => {
        try {
            const rt = await registry.runtimeFor(t);
            const db = rt.services.db;
            const n = async (sql) => Number((await db.query(sql))[0].n);
            return { stores: await n('SELECT COUNT(*) AS n FROM stores WHERE is_active=1'), users: await n('SELECT COUNT(*) AS n FROM users WHERE is_active=1'), orders: await n("SELECT COUNT(*) AS n FROM orders WHERE order_date >= DATE_FORMAT(NOW(), '%Y-%m-01')"), customers: await n('SELECT COUNT(*) AS n FROM customers') };
        }
        catch {
            return null;
        }
    };
    // ---- login / logout ---------------------------------------------------------------------------
    app.get('/console/login', async (_req, reply) => html(reply, `<div class="card mx-auto" style="max-width:380px"><div class="card-body"><h5>Sign in</h5><form method="POST" action="/console/login">
<input class="form-control mb-2" name="username" placeholder="Username" autofocus required><input class="form-control mb-3" type="password" name="password" placeholder="Password" required><button class="btn btn-primary w-100">Sign in</button></form></div></div>`));
    app.post('/console/login', async (req, reply) => {
        const b = (req.body ?? {});
        if (throttled(req.ip))
            return html(reply, '<div class="alert alert-danger">Too many attempts. Try again in 15 minutes.</div>', 429);
        const a = (await ctl.query('SELECT id, password_hash FROM super_admins WHERE username = ? AND is_active = 1', [String(b.username ?? '')]))[0];
        const ok = a ? await verifyPassword(String(b.password ?? ''), a.password_hash) : (await verifyPassword('x', '$2a$10$7EqJtq98hPqEX7fNZaFWoOa5oXk6mQbv0QkZ0m0y3kQm4m3o8lG3S'), false);
        if (!a || !ok) {
            await event(null, 'console_login_failed', `${String(b.username ?? '').slice(0, 50)} from ${req.ip}`);
            return html(reply, '<div class="alert alert-danger mx-auto" style="max-width:380px">Invalid username or password.</div>', 401);
        }
        const sid = randomBytes(32).toString('hex');
        await ctl.execute('INSERT INTO admin_sessions (id, admin_id, csrf, expires_at) VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL 8 HOUR))', [sha(sid), a.id, randomBytes(32).toString('hex')]);
        await ctl.execute('DELETE FROM admin_sessions WHERE expires_at < NOW()');
        await event(null, 'console_login', `admin #${a.id} from ${req.ip}`);
        return reply.header('Set-Cookie', serializeCookie(COOKIE, sid, { maxAgeSeconds: 8 * 3600, secure: secure(req) })).redirect('/console');
    });
    app.post('/console/logout', async (req, reply) => {
        const id = parseCookies(req.headers.cookie)[COOKIE];
        if (id)
            await ctl.execute('DELETE FROM admin_sessions WHERE id = ?', [sha(id)]);
        return reply.header('Set-Cookie', serializeCookie(COOKIE, '', { maxAgeSeconds: 0, secure: secure(req) })).redirect('/console/login');
    });
    // ---- businesses ---------------------------------------------------------------------------------
    const badge = (t, access) => {
        const c = t.status === 'suspended' || t.status === 'cancelled' ? 'danger' : access === 'readonly' ? 'warning text-dark' : t.status === 'trial' ? 'info text-dark' : 'success';
        return `<span class="badge bg-${c}">${esc(t.status)}${access === 'readonly' ? ' · read-only' : ''}</span>`;
    };
    app.get('/console', async (req, reply) => {
        const s = await needLogin(req, reply);
        if (!s)
            return;
        const rows = await ctl.query('SELECT t.*, p.code AS plan_code, p.max_stores, p.max_users, p.max_orders_month FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id ORDER BY t.id');
        const lines = [];
        for (const t of rows) {
            const info = registry.infoFor(t), u = t.status === 'cancelled' ? null : await usage(t);
            const lim = (v) => (v ? `/${v}` : '');
            lines.push(`<tr><td><a href="/console/t/${esc(t.slug)}">${esc(t.slug)}</a><div class="small text-muted">${esc(t.name)}</div></td><td>${badge(t, info.access)}</td><td>${esc(info.planCode ?? '—')}</td>
<td>${u ? `${u.stores}${lim(info.limits.stores)}` : '—'}</td><td>${u ? `${u.users}${lim(info.limits.users)}` : '—'}</td><td>${u ? `${u.orders}${lim(info.limits.ordersPerMonth)}` : '—'}</td><td>${u ? u.customers : '—'}</td>
<td class="small">${t.plan_ends_at ? 'paid → ' + esc(String(t.plan_ends_at).slice(0, 10)) : t.trial_ends_at ? 'trial → ' + esc(t.trial_ends_at.slice(0, 10)) : ''}</td></tr>`);
        }
        const pending = Number((await ctl.query("SELECT COUNT(*) AS n FROM signup_requests WHERE status IN ('pending','failed')"))[0].n);
        return html(reply, `${pending ? `<div class="alert alert-warning">${pending} signup request(s) waiting — <a href="/console/requests">review</a></div>` : ''}<h5>Businesses (${rows.length})</h5>
<table class="table table-sm table-hover bg-white"><thead><tr><th>Business</th><th>Status</th><th>Plan</th><th>Stores</th><th>Users</th><th>Orders (month)</th><th>Customers</th><th>Dates</th></tr></thead><tbody>${lines.join('')}</tbody></table>`, 200, s);
    });
    app.get('/console/t/:slug', async (req, reply) => {
        const s = await needLogin(req, reply);
        if (!s)
            return;
        const t = await tenantBySlug(req.params.slug);
        if (!t)
            return html(reply, '<div class="alert alert-danger">No such business.</div>', 404, s);
        const info = registry.infoFor(t), u = await usage(t);
        const plans = await ctl.query('SELECT code, name FROM plans WHERE is_active = 1 ORDER BY id');
        const events = await ctl.query('SELECT event, detail, created_at FROM tenant_events WHERE tenant_id = ? ORDER BY id DESC LIMIT 15', [t.id]);
        const host = (await ctl.query('SELECT hostname FROM tenant_domains WHERE tenant_id = ? ORDER BY is_primary DESC', [t.id])).map((d) => d.hostname);
        const f = (action, inner, confirm = '') => `<form method="POST" action="/console/t/${esc(t.slug)}" class="d-inline-flex gap-1 align-items-center mb-2"${confirm ? ` onsubmit="return confirm('${confirm}')"` : ''}><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="action" value="${action}">${inner}</form>`;
        return html(reply, `<h5>${esc(t.name)} <small class="text-muted">${esc(t.slug)}</small> ${badge(t, info.access)}</h5>
<p class="mb-1">Hosts: ${host.map((h) => `<code>${esc(h)}</code>`).join(', ')} · database <code>${esc(t.db_name)}</code> · plan <b>${esc(info.planCode ?? '—')}</b>${t.plan_ends_at ? ' paid → ' + esc(String(t.plan_ends_at).slice(0, 10)) : ''}${t.trial_ends_at ? ' trial → ' + esc(t.trial_ends_at.slice(0, 10)) : ''}</p>
<p class="text-muted">${u ? `Stores ${u.stores} · Users ${u.users} · Orders this month ${u.orders} · Customers ${u.customers}` : 'Database not reachable'}</p><hr>
<div class="row"><div class="col-md-6"><h6>Subscription</h6>
${f('plan', `<select name="plan" class="form-select form-select-sm">${plans.map((p) => `<option value="${esc(p.code)}"${p.code === info.planCode ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select><input type="date" name="until" class="form-control form-control-sm" title="Paid through"><button class="btn btn-sm btn-primary">Set plan</button>`)}<br>
${f('extend', '<input type="number" name="days" value="14" min="1" max="365" class="form-control form-control-sm" style="width:80px"><button class="btn btn-sm btn-outline-primary">Extend days</button>')}<br>
${t.status === 'suspended' ? f('resume', '<button class="btn btn-sm btn-success">Resume</button>') : f('suspend', '<button class="btn btn-sm btn-warning">Suspend</button>', 'Suspend this business? Its users will be locked out.')}
${t.status !== 'cancelled' ? f('cancel', '<button class="btn btn-sm btn-outline-danger">Cancel</button>', 'Cancel this business? Its host will stop working (data is kept).') : ''}</div>
<div class="col-md-6"><h6>Support</h6>
${f('impersonate', '<button class="btn btn-sm btn-outline-dark">Open as owner (audited)</button>')}<br>
<a class="btn btn-sm btn-outline-secondary" href="/console/t/${esc(t.slug)}/export">Download database backup (.sql.gz)</a></div></div><hr>
<h6>Recent events</h6><table class="table table-sm bg-white"><tbody>${events.map((e) => `<tr><td class="small text-muted">${esc(e.created_at)}</td><td>${esc(e.event)}</td><td>${esc(e.detail)}</td></tr>`).join('')}</tbody></table>`, 200, s);
    });
    app.post('/console/t/:slug', async (req, reply) => {
        const p = await post(req, reply);
        if (!p)
            return;
        const t = await tenantBySlug(req.params.slug);
        if (!t)
            return html(reply, '<div class="alert alert-danger">No such business.</div>', 404, p.s);
        const back = () => { registry.invalidate(); return reply.redirect(`/console/t/${t.slug}`); };
        const who = `admin ${p.s.username}`;
        switch (p.b.action) {
            case 'suspend':
            case 'resume':
            case 'cancel': {
                const st = p.b.action === 'suspend' ? 'suspended' : p.b.action === 'cancel' ? 'cancelled' : 'active';
                await ctl.execute('UPDATE tenants SET status = ? WHERE id = ?', [st, t.id]);
                await event(t.id, st, who);
                return back();
            }
            case 'plan': {
                const pl = (await ctl.query('SELECT id FROM plans WHERE code = ?', [String(p.b.plan ?? '')]))[0];
                if (!pl)
                    return html(reply, '<div class="alert alert-danger">Unknown plan.</div>', 422, p.s);
                const until = /^\d{4}-\d{2}-\d{2}$/.test(p.b.until ?? '') ? p.b.until : null;
                await ctl.execute("UPDATE tenants SET plan_id = ?, plan_ends_at = ?, trial_ends_at = IF(? IS NULL, trial_ends_at, NULL), status = IF(status IN ('trial','suspended'), 'active', status) WHERE id = ?", [pl.id, until, until, t.id]);
                await event(t.id, 'plan_set', `${p.b.plan} until ${until ?? '-'} by ${who}`);
                return back();
            }
            case 'extend': {
                const d = Math.min(365, Math.max(1, Number(p.b.days) || 0));
                await ctl.execute("UPDATE tenants SET trial_ends_at = IF(status = 'trial', DATE_ADD(GREATEST(COALESCE(trial_ends_at, NOW()), NOW()), INTERVAL ? DAY), trial_ends_at), plan_ends_at = IF(status = 'active', DATE_ADD(GREATEST(COALESCE(plan_ends_at, CURDATE()), CURDATE()), INTERVAL ? DAY), plan_ends_at) WHERE id = ?", [d, d, t.id]);
                await event(t.id, 'extended', `${d} days by ${who}`);
                return back();
            }
            case 'impersonate': {
                const rt = await registry.runtimeFor(t);
                const owner = (await rt.services.db.query("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.role_name = 'Super Admin' AND u.is_active = 1 ORDER BY u.id LIMIT 1"))[0];
                if (!owner)
                    return html(reply, '<div class="alert alert-danger">This business has no active Super Admin user.</div>', 422, p.s);
                const tok = randomBytes(32).toString('hex');
                await ctl.execute('INSERT INTO impersonation_tokens (token_hash, tenant_id, user_id, admin_id, expires_at) VALUES (?,?,?,?, DATE_ADD(NOW(), INTERVAL 60 SECOND))', [sha(tok), t.id, owner.id, p.s.adminId]);
                await event(t.id, 'impersonate', who);
                return reply.redirect(`${t.app_url.replace(/\/+$/, '')}/__impersonate?token=${tok}`);
            }
            default: return html(reply, '<div class="alert alert-danger">Unknown action.</div>', 422, p.s);
        }
    });
    app.get('/console/t/:slug/export', async (req, reply) => {
        const s = await needLogin(req, reply);
        if (!s)
            return;
        const t = await tenantBySlug(req.params.slug);
        if (!t)
            return html(reply, '<div class="alert alert-danger">No such business.</div>', 404, s);
        const te = registry.tenantEnv(t);
        const dump = spawn('mysqldump', ['--single-transaction', '--routines', '-h', te.DB_HOST, '-P', String(te.DB_PORT), '-u', te.DB_USER, te.DB_NAME], { env: { ...process.env, MYSQL_PWD: te.DB_PASS } });
        let started = false;
        const errs = [];
        dump.stderr.on('data', (c) => errs.push(c));
        const spawnErr = new Promise((res) => dump.once('error', res));
        await event(t.id, 'export', `by admin ${s.username}`);
        const gz = dump.stdout.pipe(createGzip());
        const out = new PassThrough();
        gz.pipe(out); // attach the real consumer first so peeking at the first chunk below cannot swallow it
        const first = await Promise.race([new Promise((res) => gz.once('data', () => res('data'))), spawnErr, new Promise((res) => dump.once('close', () => res('end')))]);
        if (first instanceof Error || first === 'end')
            return reply.code(500).type('text/plain').send(`Backup failed: ${first instanceof Error ? first.message : Buffer.concat(errs).toString().slice(0, 300)}`);
        started = true;
        void started;
        return reply.header('Content-Type', 'application/gzip').header('Content-Disposition', `attachment; filename="${t.slug}-${new Date().toISOString().slice(0, 10)}.sql.gz"`).send(out);
    });
    // ---- signup requests ------------------------------------------------------------------------
    app.get('/console/requests', async (req, reply) => {
        const s = await needLogin(req, reply);
        if (!s)
            return;
        const rows = await ctl.query('SELECT * FROM signup_requests ORDER BY id DESC LIMIT 100');
        return html(reply, `<h5>Signup requests</h5><table class="table table-sm bg-white"><thead><tr><th>#</th><th>Business</th><th>Owner</th><th>Web address</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.business_name)}</td>
<td>${esc(r.owner_name)}<div class="small text-muted">${esc(r.mobile)} · ${esc(r.email)}</div></td><td><code>${esc(r.slug)}.${esc(env.TENANT_BASE_DOMAIN)}</code></td><td>${esc(r.status)}${r.note ? `<div class="small text-danger">${esc(r.note)}</div>` : ''}</td><td class="small">${esc(r.created_at)}</td>
<td>${r.status === 'pending' || r.status === 'failed' ? `<form method="POST" action="/console/requests/${r.id}" class="d-inline"><input type="hidden" name="csrf" value="${s.csrf}"><button name="action" value="approve" class="btn btn-sm btn-success">Approve</button> <button name="action" value="reject" class="btn btn-sm btn-outline-danger">Reject</button></form>` : ''}</td></tr>`).join('')}</tbody></table>`, 200, s);
    });
    app.post('/console/requests/:id', async (req, reply) => {
        const p = await post(req, reply);
        if (!p)
            return;
        const id = Number(req.params.id);
        try {
            if (p.b.action === 'approve')
                await approveSignup(env, registry, id);
            else if (p.b.action === 'reject')
                await ctl.execute("UPDATE signup_requests SET status = 'rejected' WHERE id = ? AND status IN ('pending','failed')", [id]);
        }
        catch (e) {
            return html(reply, `<div class="alert alert-danger">${esc(e.message)}</div><a href="/console/requests">Back</a>`, 422, p.s);
        }
        return reply.redirect('/console/requests');
    });
    // ---- plans ------------------------------------------------------------------------------------
    app.get('/console/plans', async (req, reply) => {
        const s = await needLogin(req, reply);
        if (!s)
            return;
        const plans = await ctl.query('SELECT * FROM plans ORDER BY id');
        const num = (n, v) => `<input class="form-control form-control-sm" style="width:100px" name="${n}" value="${esc(v ?? '')}">`;
        return html(reply, `<h5>Plans</h5><p class="text-muted small">0 = unlimited. Leave prices empty until decided. Changes apply to every business on the plan within a minute.</p>${plans.map((p) => `<form method="POST" action="/console/plans" class="d-flex gap-2 align-items-center mb-2 bg-white p-2 border rounded"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="id" value="${p.id}">
<b style="width:90px">${esc(p.name)}</b><label class="small">Stores</label>${num('max_stores', p.max_stores)}<label class="small">Users</label>${num('max_users', p.max_users)}<label class="small">Orders/mo</label>${num('max_orders_month', p.max_orders_month)}<label class="small">₹/month</label>${num('price_monthly', p.price_monthly)}<label class="small">₹/year</label>${num('price_yearly', p.price_yearly)}<button class="btn btn-sm btn-primary">Save</button></form>`).join('')}`, 200, s);
    });
    app.post('/console/plans', async (req, reply) => {
        const p = await post(req, reply);
        if (!p)
            return;
        const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
        const price = (v) => (v === undefined || v.trim() === '' || !(Number(v) >= 0) ? null : Number(v));
        await ctl.execute('UPDATE plans SET max_stores = ?, max_users = ?, max_orders_month = ?, price_monthly = ?, price_yearly = ? WHERE id = ?', [n(p.b.max_stores), n(p.b.max_users), n(p.b.max_orders_month), price(p.b.price_monthly), price(p.b.price_yearly), Number(p.b.id)]);
        await event(null, 'plan_edited', `plan #${p.b.id} by admin ${p.s.username}`);
        registry.invalidate();
        return reply.redirect('/console/plans');
    });
}
export async function addSuperAdmin(registry, username, password) {
    if (!/^[a-z0-9._-]{3,50}$/i.test(username))
        throw new Error('username: 3-50 chars (letters, digits . _ -)');
    if (password.length < 12)
        throw new Error('operator password must be at least 12 characters');
    await registry.control.execute('INSERT INTO super_admins (username, password_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1', [username, await hashPassword(password)]);
}
