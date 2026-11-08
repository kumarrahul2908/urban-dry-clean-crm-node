import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookies, serializeCookie } from './cookies.js';
import { Raw } from './html.js';
import { formatDate, formatDatetime } from './format.js';
import { numberFormat2 } from '../lib/php.js';
import { todayIn } from '../lib/dates.js';
export const SESSION_COOKIE = 'udc_sid';
/** What a page handler may return. */
export class WebRedirect {
    path;
    status;
    constructor(path, status = 302) {
        this.path = path;
        this.status = status;
    }
}
export class WebText {
    body;
    status;
    contentType;
    headers;
    constructor(body, status = 200, contentType = 'text/html; charset=utf-8', headers = {}) {
        this.body = body;
        this.status = status;
        this.contentType = contentType;
        this.headers = headers;
    }
}
/** Per-request view of the PHP $_SESSION + helper functions (Auth::can, csrf_token, flash_*, base_url …). */
export class WebCtx {
    svc;
    req;
    sid;
    data;
    dirty = false;
    destroyed = false;
    regenerate = false;
    constructor(svc, req, sid, data) {
        this.svc = svc;
        this.req = req;
        this.sid = sid;
        this.data = data;
    }
    settingsCache = null;
    /** get_setting(): the settings table is read once per request. */
    async setting(key, fallback = null) {
        if (!this.settingsCache) {
            this.settingsCache = {};
            for (const r of await this.svc.db.query('SELECT setting_key, setting_value FROM settings'))
                this.settingsCache[r.setting_key] = r.setting_value;
        }
        return this.settingsCache[key] ?? fallback;
    }
    /** get_setting() for templates; call `await ctx.setting('x')` first so the cache is loaded. */
    settingSync(key, fallback = null) { return this.settingsCache?.[key] ?? fallback; }
    symbol = null;
    /** Loads the currency symbol so money() can be used synchronously inside templates. */
    async loadMoney() {
        this.symbol = (await this.setting('currency_symbol', 'Rs.')) ?? 'Rs.';
        return (a) => this.money(a);
    }
    /** format_currency() */
    money(amount) { return `${this.symbol ?? 'Rs.'} ${numberFormat2(parseFloat(String(amount ?? '')) || 0)}`; }
    /** format_date() / format_datetime() in APP_TIMEZONE */
    date(v, fmt) { return formatDate(v, this.svc.env.APP_TIMEZONE, fmt); }
    datetime(v, fmt) { return formatDatetime(v, this.svc.env.APP_TIMEZONE, fmt); }
    /** date('Y-m-d') in APP_TIMEZONE */
    get today() { return todayIn(this.svc.env.APP_TIMEZONE); }
    get now() { return Math.floor(Date.now() / 1000); }
    baseUrl(path = '') { return `${this.svc.env.APP_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`; }
    get user() { return this.data.user ?? null; }
    isLoggedIn() { return this.data.user_id !== undefined; }
    can(key) { return (this.data.permissions ?? []).includes(key); }
    roleName() { return this.data.user?.role_name ?? ''; }
    fixedStoreId() { const id = this.data.user?.store_id; return id ? Number(id) : null; }
    activeStoreId() { return this.data.active_store_id !== undefined ? Number(this.data.active_store_id) : null; }
    /** Uploaded files of a multipart/form-data request (field name → file). Text fields end up in req.body, like $_POST. */
    files = {};
    /** every file part in arrival order (PHP "images[]" style multi-uploads); filename is "" when the browser sent no file. */
    fileParts = [];
    async readMultipart() {
        const fields = {};
        for await (const part of this.req.parts()) {
            if (part.type === 'file') {
                const buffer = await part.toBuffer();
                this.fileParts.push({ field: part.fieldname, filename: part.filename ?? '', buffer });
                if (part.filename)
                    this.files[part.fieldname] = { filename: part.filename, mimetype: part.mimetype, buffer };
            }
            else {
                fields[part.fieldname] = part.value;
            }
        }
        this.req.body = fields;
    }
    set(key, value) { this.data[key] = value; this.dirty = true; }
    csrfToken() {
        if (!this.data.csrf_token) {
            this.data.csrf_token = randomBytes(32).toString('hex');
            this.dirty = true;
        }
        return this.data.csrf_token;
    }
    csrfField() { return new Raw(`<input type="hidden" name="csrf_token" value="${this.csrfToken()}">`); }
    /** verify_csrf(): token from POST body or query string. Returns false when invalid (caller answers 419). */
    csrfValid() {
        const body = (this.req.body ?? {});
        const q = (this.req.query ?? {});
        const t = String(body.csrf_token ?? q.csrf_token ?? '');
        const have = this.data.csrf_token;
        if (!have || t.length !== have.length)
            return false;
        return timingSafeEqual(Buffer.from(have), Buffer.from(t));
    }
    flashSet(type, message) { (this.data.flash ??= []).push({ type, message }); this.dirty = true; }
    flashGet() {
        const f = this.data.flash ?? [];
        if (f.length) {
            delete this.data.flash;
            this.dirty = true;
        }
        return f;
    }
    /** session_regenerate_id(true): new cookie value, old row deleted. */
    regenerateId() { this.regenerate = true; this.dirty = true; }
    /** Auth::logout(): wipes the session and the cookie. */
    logout() { this.data = {}; this.destroyed = true; }
}
export const forbiddenPage = (ctx) => new WebText(`<h2>403 - Access Denied</h2><p>You do not have permission to access this page.</p><p><a href="${ctx.baseUrl('modules/dashboard/index.php')}">Back to Dashboard</a></p>`, 403);
/**
 * Registers `path` (and its ".php" twin) as a session-aware page. Mirrors includes/bootstrap.php: session start,
 * idle timeout, then the page's own Auth::requireLogin()/requirePermission().
 */
export function webPage(app, paths, opts, handler) {
    const svc = app.services;
    const store = svc.web.sessions;
    const run = async (req, reply) => {
        const cookies = parseCookies(req.headers.cookie);
        let sid = cookies[SESSION_COOKIE] ?? null;
        let data = sid ? await store.load(sid) : null;
        if (!data) {
            sid = null;
            data = {};
        }
        const ctx = new WebCtx(svc, req, sid, data);
        if (req.isMultipart())
            await ctx.readMultipart();
        const lifetime = svc.env.SESSION_LIFETIME_MINUTES * 60;
        let result;
        if (ctx.isLoggedIn() && ctx.data.last_activity !== undefined && ctx.now - ctx.data.last_activity > lifetime) {
            ctx.logout();
            result = new WebRedirect(ctx.baseUrl('modules/auth/login.php?timeout=1'));
        }
        else {
            if (ctx.isLoggedIn()) {
                ctx.data.last_activity = ctx.now;
                ctx.dirty = true;
            }
            if (opts.auth !== 'public' && !ctx.isLoggedIn())
                result = new WebRedirect(ctx.baseUrl('modules/auth/login.php'));
            else if (opts.auth !== 'public' && opts.auth !== 'login' && !ctx.can(opts.auth))
                result = forbiddenPage(ctx);
            else
                result = await handler(ctx, req, reply);
        }
        // persist session + cookie
        const secure = req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
        if (ctx.destroyed) {
            if (ctx.sid)
                await store.destroy(ctx.sid);
            reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure }));
        }
        else if (ctx.dirty) {
            if (ctx.regenerate && ctx.sid) {
                await store.destroy(ctx.sid);
                ctx.sid = null;
            }
            if (!ctx.sid)
                ctx.sid = store.newId();
            await store.save(ctx.sid, ctx.data);
            if (ctx.sid !== sid)
                reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, ctx.sid, { secure }));
        }
        reply.header('Cache-Control', 'no-store, no-cache, must-revalidate').header('Pragma', 'no-cache').header('Expires', 'Thu, 19 Nov 1981 08:52:00 GMT');
        if (result instanceof WebRedirect)
            return reply.type('text/html; charset=UTF-8').redirect(result.path.startsWith('http') ? result.path : ctx.baseUrl(result.path), result.status);
        if (result instanceof WebText) {
            for (const [k, v] of Object.entries(result.headers))
                reply.header(k, v);
            return reply.status(result.status).type(result.contentType).send(result.body);
        }
        return reply.type('text/html; charset=utf-8').send(result instanceof Raw ? result.value : result);
    };
    for (const p of Array.isArray(paths) ? paths : [paths]) {
        if (p.startsWith('/modules/'))
            svc.web.pages.add(`${p.slice(1)}.php`);
        for (const suffix of opts.exact ? [''] : ['', '.php']) {
            for (const m of opts.methods ?? ['GET', 'POST'])
                app.route({ method: m, url: p + suffix, handler: run });
        }
    }
}
