import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import { createPool } from '../db/pool.js';
import type { BuildOptions, Services } from '../app.js';
import { buildServices } from '../app.js';
import { tenantAwareServices } from './aware.js';
import { tenantStorage } from './als.js';
import { TenantRegistry, controlEnv } from './registry.js';
import { registerConsole } from './console.js';
import { registerImpersonation } from './impersonate.js';
import { registerSignup } from './signup.js';

/** Still allowed when a subscription has lapsed: signing in/out and Meta's inbound webhook (so the account can be viewed and exported). */
const READONLY_OK = /^\/(modules\/auth\/(login|logout|forgot-password|reset-password)(\.php)?|api\/mobile\/(login|logout|password_reset_request)(\.php)?|api\/whatsapp_webhook(\.php)?)$/;

export interface MultiTenant { services: Services; registry: TenantRegistry; install(app: FastifyInstance): void; close(): Promise<void> }

/** Builds the tenant-aware Services plus the Fastify hook that binds each request to its business by hostname. */
export function createMultiTenant(env: Env, options: BuildOptions = {}): MultiTenant {
  const control = createPool(controlEnv(env));
  const baseDb = createPool(env); // base services exist only so registration-time destructuring has something to forward from
  const base = buildServices(env, baseDb.db, options);
  const registry = new TenantRegistry(env, control.db, options, base.web.pages);
  const services = tenantAwareServices(base);
  return {
    services,
    registry,
    install(app) {
      const root = env.CONTROL_ROOT_HOST.toLowerCase();
      if (root) registerSignup(app, env, registry);
      const adminHost = env.CONTROL_ADMIN_HOST.toLowerCase();
      if (adminHost) registerConsole(app, env, registry);
      registerImpersonation(app, registry);
      const bare = (h: string) => h.toLowerCase().replace(/:\d+$/, '');
      app.addHook('onRequest', (req, reply, done) => {
        const host = bare(req.hostname);
        if (adminHost && host === adminHost) { // operator console host: /console/* only
          if (req.url.startsWith('/console') || req.url === '/health') { done(); return; }
          reply.code(404).type('text/plain').send('Not found.'); return;
        }
        if (root && host === root) { // the marketing/signup host belongs to no business
          if (req.url === '/signup' || req.url.startsWith('/signup?') || req.url === '/health') { done(); return; }
          reply.code(404).type('text/plain').send('Not found.'); return;
        }
        // the public signup and operator console belong to their own hosts only — never reachable on a business's host
        if (/^\/(signup|console)(\/|\?|$)/.test(req.url)) { reply.code(404).type('text/plain').send('Not found.'); return; }
        registry.resolveHost(req.hostname).then(async (row) => {
          if (!row || row.status === 'cancelled') { reply.code(404).type('text/plain').send('Unknown business.'); return; }
          if (row.status === 'suspended') { reply.code(402).type('text/html; charset=utf-8').send('<h2>Account suspended</h2><p>Please contact support to reactivate this account.</p>'); return; }
          const rt = await registry.runtimeFor(row);
          const info = registry.infoFor(row); // recomputed per request: trial / paid-through dates move while the runtime stays cached
          if (info.access === 'readonly' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !READONLY_OK.test(req.url.split('?')[0]!)) {
            const msg = 'Your subscription has expired — the account is read-only. Please renew to continue.';
            if (req.url.startsWith('/api/')) reply.code(402).send({ success: false, error: { code: 'subscription_expired', message: msg } });
            else reply.code(402).type('text/html; charset=utf-8').send(`<h2>Subscription expired</h2><p>${msg}</p>`);
            return;
          }
          tenantStorage.run({ tenant: info, services: rt.services }, done);
        }).catch((e) => { req.log.error(e); reply.code(500).type('text/plain').send('Service unavailable.'); });
      });
    },
    async close() { await registry.closeAll(); await control.close(); await baseDb.close(); },
  };
}

/** Runs `fn` once for the single business (classic mode) or once per active business (multi-tenant mode) — used by the cron jobs. */
export async function forEachBusiness(env: Env, fn: (env: Env, db: import('../db/pool.js').Db, label: string) => Promise<void>): Promise<void> {
  if (!env.CONTROL_DB_NAME) {
    const { db, close } = createPool(env);
    try { await fn(env, db, 'single'); } finally { await close(); }
    return;
  }
  const control = createPool(controlEnv(env));
  const registry = new TenantRegistry(env, control.db);
  try {
    for (const row of await registry.list()) {
      if (row.status !== 'active' && row.status !== 'trial') continue;
      const tenv = registry.tenantEnv(row);
      const { db, close } = createPool(tenv);
      try { await fn(tenv, db, row.slug); } catch (e) { console.error(`[${row.slug}] job failed:`, (e as Error).message); process.exitCode = 1; } finally { await close(); }
    }
  } finally { await control.close(); }
}
