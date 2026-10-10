import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from '../app.js';
import { parseCookies, serializeCookie } from './cookies.js';
import { Raw } from './html.js';
import type { SessionData } from './session.js';

export const SESSION_COOKIE = 'udc_sid';

/** What a page handler may return. */
export class WebRedirect { constructor(readonly path: string, readonly status = 302) {} }
export class WebText { constructor(readonly body: string, readonly status = 200, readonly contentType = 'text/html; charset=utf-8') {} }
export type WebResult = Raw | WebRedirect | WebText | string;

/** Per-request view of the PHP $_SESSION + helper functions (Auth::can, csrf_token, flash_*, base_url …). */
export class WebCtx {
  dirty = false;
  destroyed = false;
  regenerate = false;
  constructor(
    readonly svc: Services,
    readonly req: FastifyRequest,
    public sid: string | null,
    public data: SessionData,
  ) {}

  get now() { return Math.floor(Date.now() / 1000); }
  baseUrl(path = ''): string { return `${this.svc.env.APP_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`; }

  get user() { return this.data.user ?? null; }
  isLoggedIn(): boolean { return this.data.user_id !== undefined; }
  can(key: string): boolean { return (this.data.permissions ?? []).includes(key); }
  roleName(): string { return this.data.user?.role_name ?? ''; }
  fixedStoreId(): number | null { const id = this.data.user?.store_id; return id ? Number(id) : null; }
  activeStoreId(): number | null { return this.data.active_store_id !== undefined ? Number(this.data.active_store_id) : null; }

  set(key: string, value: unknown) { (this.data as Record<string, unknown>)[key] = value; this.dirty = true; }

  csrfToken(): string {
    if (!this.data.csrf_token) { this.data.csrf_token = randomBytes(32).toString('hex'); this.dirty = true; }
    return this.data.csrf_token;
  }
  csrfField(): Raw { return new Raw(`<input type="hidden" name="csrf_token" value="${this.csrfToken()}">`); }

  /** verify_csrf(): token from POST body or query string. Returns false when invalid (caller answers 419). */
  csrfValid(): boolean {
    const body = (this.req.body ?? {}) as Record<string, unknown>;
    const q = (this.req.query ?? {}) as Record<string, unknown>;
    const t = String(body.csrf_token ?? q.csrf_token ?? '');
    const have = this.data.csrf_token;
    if (!have || t.length !== have.length) return false;
    return timingSafeEqual(Buffer.from(have), Buffer.from(t));
  }

  flashSet(type: string, message: string) { (this.data.flash ??= []).push({ type, message }); this.dirty = true; }
  flashGet(): { type: string; message: string }[] {
    const f = this.data.flash ?? [];
    if (f.length) { delete this.data.flash; this.dirty = true; }
    return f;
  }

  /** session_regenerate_id(true): new cookie value, old row deleted. */
  regenerateId() { this.regenerate = true; this.dirty = true; }

  /** Auth::logout(): wipes the session and the cookie. */
  logout() { this.data = {}; this.destroyed = true; }
}

export interface PageOptions {
  /** 'public' = no login needed; 'login' = Auth::requireLogin(); string = Auth::requirePermission(key). */
  auth: 'public' | 'login' | string;
  methods?: ('GET' | 'POST')[];
  /** Register the path exactly as given (no ".php" twin) — e.g. "/". */
  exact?: boolean;
  /** JSON endpoint (api/*.php): same session + auth redirect, responses are the handler's business. */
}

const forbiddenPage = (ctx: WebCtx) =>
  new WebText(`<h2>403 - Access Denied</h2><p>You do not have permission to access this page.</p><p><a href="${ctx.baseUrl('modules/dashboard/index.php')}">Back to Dashboard</a></p>`, 403);

/**
 * Registers `path` (and its ".php" twin) as a session-aware page. Mirrors includes/bootstrap.php: session start,
 * idle timeout, then the page's own Auth::requireLogin()/requirePermission().
 */
export function webPage(app: FastifyInstance, paths: string | string[], opts: PageOptions, handler: (ctx: WebCtx, req: FastifyRequest, reply: FastifyReply) => Promise<WebResult>) {
  const svc = app.services;
  const store = svc.web.sessions;
  const run = async (req: FastifyRequest, reply: FastifyReply) => {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies[SESSION_COOKIE] ?? null;
    let data: SessionData | null = sid ? await store.load(sid) : null;
    if (!data) { sid = null; data = {}; }
    const ctx = new WebCtx(svc, req, sid, data);
    const lifetime = svc.env.SESSION_LIFETIME_MINUTES * 60;

    let result: WebResult;
    if (ctx.isLoggedIn() && ctx.data.last_activity !== undefined && ctx.now - ctx.data.last_activity > lifetime) {
      ctx.logout();
      result = new WebRedirect(ctx.baseUrl('modules/auth/login.php?timeout=1'));
    } else {
      if (ctx.isLoggedIn()) { ctx.data.last_activity = ctx.now; ctx.dirty = true; }
      if (opts.auth !== 'public' && !ctx.isLoggedIn()) result = new WebRedirect(ctx.baseUrl('modules/auth/login.php'));
      else if (opts.auth !== 'public' && opts.auth !== 'login' && !ctx.can(opts.auth)) result = forbiddenPage(ctx);
      else result = await handler(ctx, req, reply);
    }

    // persist session + cookie
    const secure = req.protocol === 'https' || String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
    if (ctx.destroyed) {
      if (ctx.sid) await store.destroy(ctx.sid);
      reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure }));
    } else if (ctx.dirty) {
      if (ctx.regenerate && ctx.sid) { await store.destroy(ctx.sid); ctx.sid = null; }
      if (!ctx.sid) ctx.sid = store.newId();
      await store.save(ctx.sid, ctx.data);
      if (ctx.sid !== sid) reply.header('Set-Cookie', serializeCookie(SESSION_COOKIE, ctx.sid, { secure }));
    }

    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate').header('Pragma', 'no-cache').header('Expires', 'Thu, 19 Nov 1981 08:52:00 GMT');
    if (result instanceof WebRedirect) return reply.type('text/html; charset=UTF-8').redirect(result.path.startsWith('http') ? result.path : ctx.baseUrl(result.path), result.status);
    if (result instanceof WebText) return reply.status(result.status).type(result.contentType).send(result.body);
    return reply.type('text/html; charset=utf-8').send(result instanceof Raw ? result.value : result);
  };
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    if (p.startsWith('/modules/')) svc.web.pages.add(`${p.slice(1)}.php`);
    for (const suffix of opts.exact ? [''] : ['', '.php']) {
      for (const m of opts.methods ?? ['GET', 'POST']) app.route({ method: m, url: p + suffix, handler: run });
    }
  }
}
