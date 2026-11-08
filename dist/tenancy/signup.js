import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword } from '../lib/password.js';
import { provisionTenant } from './provision.js';
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'crm', 'mail', 'staging', 'test', 'demo', 'support', 'help', 'billing', 'status', 'static', 'assets', 'cdn', 'root', 'login', 'signup', 'dashboard', 'whatsapp']);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function validateSignup(f) {
    const e = [];
    if (f.business_name.length < 2 || f.business_name.length > 100)
        e.push('Business name must be 2–100 characters.');
    if (f.owner_name.length < 2 || f.owner_name.length > 100)
        e.push('Owner name is required.');
    if (!/^\+?[0-9]{10,15}$/.test(f.mobile))
        e.push('Enter a valid mobile number (10–15 digits).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email) || f.email.length > 150)
        e.push('Enter a valid email address.');
    if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(f.slug))
        e.push('Web address: 3–30 letters/digits/hyphens, starting and ending with a letter or digit.');
    else if (RESERVED.has(f.slug))
        e.push('That web address is reserved — please choose another.');
    if (f.password.length < 8)
        e.push('Password must be at least 8 characters.');
    if (f.password !== f.password2)
        e.push('Passwords do not match.');
    return e;
}
/** Public signup on the root host: form → request row → (auto-approve) provisioning → redirect to the new business. */
export function registerSignup(app, env, registry) {
    const key = env.CONTROL_MASTER_KEY;
    const sign = (ts) => createHmac('sha256', key).update('signup:' + ts).digest('base64url');
    const mint = () => { const ts = String(Date.now()); return `${ts}.${sign(ts)}`; };
    const valid = (t) => {
        if (typeof t !== 'string')
            return false;
        const [ts, sig] = t.split('.');
        if (!ts || !sig || !/^\d+$/.test(ts) || Date.now() - Number(ts) > 2 * 3600_000 || Date.now() - Number(ts) < 2000)
            return false; // too old, or filled in under 2 s (bot)
        const want = Buffer.from(sign(ts)), got = Buffer.from(sig);
        return want.length === got.length && timingSafeEqual(want, got);
    };
    const hits = new Map();
    const limited = (ip) => { const now = Date.now(); const arr = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000); arr.push(now); hits.set(ip, arr); return arr.length > 5; };
    const page = (body, title = 'Start your free trial') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.2/css/bootstrap.min.css" rel="stylesheet"></head><body style="background:#eef1f6"><div class="container" style="max-width:560px;padding:32px 16px">
<div class="card shadow-sm"><div class="card-body p-4">${body}</div></div></div></body></html>`;
    const input = (n, label, v, type = 'text', extra = '') => `<div class="mb-3"><label class="form-label">${label}</label><input class="form-control" name="${n}" type="${type}" value="${type === 'password' ? '' : esc(v)}" required ${extra}></div>`;
    const form = (f, errors) => page(`<h4 class="mb-1">Start your free trial</h4><p class="text-muted">${env.SIGNUP_TRIAL_DAYS}-day trial · set up in about a minute</p>
${errors.length ? `<div class="alert alert-danger"><ul class="mb-0">${errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
<form method="POST" action="/signup" autocomplete="off"><input type="hidden" name="t" value="${mint()}"><div style="display:none"><input name="website" tabindex="-1" autocomplete="off"></div>
${input('business_name', 'Business name', f.business_name ?? '')}${input('owner_name', 'Your name', f.owner_name ?? '')}${input('mobile', 'Mobile number', f.mobile ?? '', 'tel')}${input('email', 'Email', f.email ?? '', 'email')}
<div class="mb-3"><label class="form-label">Your web address</label><div class="input-group"><input class="form-control" name="slug" value="${esc(f.slug ?? '')}" pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" required><span class="input-group-text">.${esc(env.TENANT_BASE_DOMAIN)}</span></div></div>
${input('password', 'Password (min 8 characters)', '', 'password', 'minlength="8"')}${input('password2', 'Repeat password', '', 'password', 'minlength="8"')}
<button class="btn btn-primary w-100" type="submit">Create my account</button></form>`);
    app.get('/signup', async (_req, reply) => reply.type('text/html; charset=utf-8').send(form({}, [])));
    app.post('/signup', async (req, reply) => {
        const b = (req.body ?? {});
        const s = (k) => (typeof b[k] === 'string' ? b[k].trim() : '');
        const f = { business_name: s('business_name'), owner_name: s('owner_name'), mobile: s('mobile').replace(/[\s-]/g, ''), email: s('email'), slug: s('slug').toLowerCase(), password: typeof b.password === 'string' ? b.password : '', password2: typeof b.password2 === 'string' ? b.password2 : '' };
        const send = (code, html) => reply.code(code).type('text/html; charset=utf-8').send(html);
        if (s('website') !== '' || !valid(b.t))
            return send(400, form(f, ['Please reload the page and try again.']));
        if (limited(req.ip))
            return send(429, page('<h5>Too many attempts</h5><p>Please try again in an hour.</p>'));
        const errors = validateSignup(f);
        if (!errors.length) {
            const taken = (await registry.control.query('SELECT 1 FROM tenants WHERE slug = ? UNION SELECT 1 FROM signup_requests WHERE slug = ? AND status IN (\'pending\',\'approved\')', [f.slug, f.slug])).length;
            if (taken)
                errors.push('That web address is already taken.');
        }
        if (errors.length)
            return send(422, form({ ...f, password: '', password2: '' }, errors));
        const hash = await hashPassword(f.password);
        const r = await registry.control.execute('INSERT INTO signup_requests (business_name, owner_name, mobile, email, slug, password_hash, ip) VALUES (?,?,?,?,?,?,?)', [f.business_name, f.owner_name, f.mobile, f.email, f.slug, hash, req.ip]);
        if (!env.SIGNUP_AUTO_APPROVE)
            return send(200, page(`<h4>Thank you!</h4><p>We received your request for <strong>${esc(f.slug)}.${esc(env.TENANT_BASE_DOMAIN)}</strong>. We will contact you on ${esc(f.mobile)} shortly.</p>`, 'Request received'));
        try {
            const out = await approveSignup(env, registry, Number(r.insertId));
            return reply.redirect(`https://${out.host}/modules/auth/login.php`);
        }
        catch (e) {
            req.log.error(e);
            return send(200, page('<h4>Thank you!</h4><p>Your account is being set up — we will contact you shortly.</p>', 'Request received'));
        }
    });
}
/** Provisions the business for a pending request (used by auto-approve and `tenant approve`). */
export async function approveSignup(env, registry, id) {
    const req = (await registry.control.query('SELECT * FROM signup_requests WHERE id = ?', [id]))[0];
    if (!req)
        throw new Error('no such request');
    if (req.status !== 'pending' && req.status !== 'failed')
        throw new Error(`request is already ${req.status}`);
    if (!env.SIGNUP_TEMPLATE_DB || !env.TENANT_BASE_DOMAIN)
        throw new Error('SIGNUP_TEMPLATE_DB and TENANT_BASE_DOMAIN must be set');
    try {
        const out = await provisionTenant(env, registry, {
            slug: req.slug, name: req.business_name, host: `${req.slug}.${env.TENANT_BASE_DOMAIN}`, templateDb: env.SIGNUP_TEMPLATE_DB,
            admin: { username: 'owner', passwordHash: req.password_hash, fullName: req.owner_name, mobile: req.mobile, email: req.email },
            status: env.SIGNUP_TRIAL_DAYS > 0 ? 'trial' : 'active', trialDays: env.SIGNUP_TRIAL_DAYS, planCode: env.SIGNUP_TRIAL_DAYS > 0 ? 'trial' : 'starter',
        });
        await registry.control.execute("UPDATE signup_requests SET status = 'approved', tenant_id = ?, note = NULL WHERE id = ?", [out.tenantId, id]);
        return out;
    }
    catch (e) {
        await registry.control.execute("UPDATE signup_requests SET status = 'failed', note = ? WHERE id = ?", [String(e.message).slice(0, 480), id]);
        throw e;
    }
}
export const randomSlug = () => 'biz-' + randomBytes(3).toString('hex');
