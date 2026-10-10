import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import formbody from '@fastify/formbody';
import type { Env } from './config/env.js';
import type { Db } from './db/pool.js';
import { AuditLog } from './audit/auditLog.js';
import { LoginRateLimiter } from './auth/loginRateLimiter.js';
import { AuthService } from './auth/authService.js';
import { ApiAuth, type UserContext } from './auth/apiAuth.js';
import { Crypto } from './lib/crypto.js';
import { NoDefaultPriceListError, PricingEngine } from './services/pricingEngine.js';
import { CustomerService } from './services/customerService.js';
import { CustomerWallet } from './services/customerWallet.js';
import { OrderFinance } from './services/orderFinance.js';
import { OrderService } from './services/orderService.js';
import { NotificationService } from './services/notificationService.js';
import { noopOrderHooks, type OrderHooks } from './services/hooks.js';
import { ApiError } from './lib/http.js';
import { registerMobileAuthRoutes } from './routes/mobile/auth.js';
import { registerMobileCatalogRoutes } from './routes/mobile/catalog.js';
import { registerMobileCustomerRoutes } from './routes/mobile/customers.js';
import { registerMobileOrderRoutes } from './routes/mobile/orders.js';

export interface Services {
  env: Env;
  db: Db;
  audit: AuditLog;
  auth: AuthService;
  apiAuth: ApiAuth;
  crypto: Crypto;
  pricing: PricingEngine;
  customers: CustomerService;
  wallet: CustomerWallet;
  orders: OrderService;
  finance: OrderFinance;
  notifications: NotificationService;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
    /** Bearer-token gate (ApiAuth::requireToken). Returns the user context or throws 401. */
    requireToken(req: FastifyRequest): Promise<UserContext>;
    /** ApiAuth::requirePermission — throws 403 if the permission key is missing. */
    requirePermission(ctx: UserContext, key: string): void;
  }
}

export function buildServices(env: Env, db: Db, hooks: OrderHooks = noopOrderHooks): Services {
  const limiter = new LoginRateLimiter(db, env.LOGIN_LOCKOUT_MINUTES);
  const auth = new AuthService(db, limiter, { maxLoginAttempts: env.MAX_LOGIN_ATTEMPTS, lockoutMinutes: env.LOGIN_LOCKOUT_MINUTES });
  const audit = new AuditLog(db);
  const wallet = new CustomerWallet(db, audit);
  const pricing = new PricingEngine(db);
  const finance = new OrderFinance(db, audit);
  const notifications = new NotificationService(db);
  return {
    env,
    db,
    audit,
    auth,
    apiAuth: new ApiAuth(db, auth, env.API_TOKEN_LIFETIME_DAYS),
    crypto: new Crypto(env.APP_SECRET_KEY),
    pricing,
    customers: new CustomerService(db, audit),
    wallet,
    finance,
    notifications,
    orders: new OrderService(db, audit, wallet, pricing, finance, notifications, hooks, env.APP_TIMEZONE),
  };
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization ?? '';
  return /^bearer /i.test(h) ? h.slice(7).trim() : null;
}

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: services.env.NODE_ENV !== 'test',
    trustProxy: services.env.TRUST_PROXY,
  });
  app.decorate('services', services);

  await app.register(helmet);
  await app.register(cors, { origin: false });
  await app.register(formbody); // PHP's $_POST fallback for form-encoded bodies

  app.decorate('requireToken', async (req: FastifyRequest) => {
    const token = bearerToken(req);
    if (token === null) throw new ApiError('unauthorized', 'Missing or malformed Authorization header.', 401);
    const ctx = await services.apiAuth.validateToken(token);
    if (!ctx) throw new ApiError('unauthorized', 'Invalid, expired, or revoked token.', 401);
    return ctx;
  });
  app.decorate('requirePermission', (ctx: UserContext, key: string) => {
    if (!ctx.permissions.includes(key)) {
      throw new ApiError('forbidden', 'You do not have permission to perform this action.', 403);
    }
  });

  // Never leak stack traces / SQL to clients (same promise as mobile_set_error_handlers()).
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ success: false, error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err instanceof NoDefaultPriceListError) {
      return reply.status(409).send({ success: false, error: { code: 'no_default_price_list', message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ success: false, error: { code: 'invalid_request', message: status === 400 ? 'Invalid request payload.' : 'Invalid request.' } });
    }
    req.log.error(err);
    return reply.status(500).send({ success: false, error: { code: 'server_error', message: 'Something went wrong.' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ success: false, error: { code: 'not_found', message: 'Not found.' } }),
  );

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(registerMobileAuthRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileCatalogRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileCustomerRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileOrderRoutes, { prefix: '/api/mobile' });
  return app;
}
