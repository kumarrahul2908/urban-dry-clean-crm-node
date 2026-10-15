import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import { createPool } from '../db/pool.js';
import type { BuildOptions, Services } from '../app.js';
import { buildServices } from '../app.js';
import { tenantAwareServices } from './aware.js';
import { tenantStorage } from './als.js';
import { TenantRegistry, controlEnv } from './registry.js';

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
      app.addHook('onRequest', (req, reply, done) => {
        registry.resolveHost(req.hostname).then(async (row) => {
          if (!row || row.status === 'cancelled') { reply.code(404).type('text/plain').send('Unknown business.'); return; }
          if (row.status === 'suspended') { reply.code(402).type('text/html; charset=utf-8').send('<h2>Account suspended</h2><p>Please contact support to reactivate this account.</p>'); return; }
          const rt = await registry.runtimeFor(row);
          tenantStorage.run({ tenant: rt.info, services: rt.services }, done);
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
