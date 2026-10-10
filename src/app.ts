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
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { LocalDiskStorage } from './storage/localDisk.js';
import { PhotoService } from './services/photoService.js';
import { LaundryGarmentService } from './services/laundryGarmentService.js';
import { FulfillmentService } from './services/fulfillmentService.js';
import { WorkshopService } from './services/workshopService.js';
import { WorkshopInvoice } from './services/workshopInvoice.js';
import { QcService } from './services/qcService.js';
import { ExpenseService } from './services/expenseService.js';
import { noopOrderHooks, type OrderHooks } from './services/hooks.js';
import { ApiError } from './lib/http.js';
import { registerMobileAuthRoutes } from './routes/mobile/auth.js';
import { registerMobileCatalogRoutes } from './routes/mobile/catalog.js';
import { registerMobileCustomerRoutes } from './routes/mobile/customers.js';
import { registerMobileOrderRoutes } from './routes/mobile/orders.js';
import { registerMobileReportRoutes } from './routes/mobile/reports.js';
import { registerMobileMiscRoutes } from './routes/mobile/misc.js';
import { registerMobileGarmentRoutes } from './routes/mobile/garments.js';
import { registerMobileUploadRoutes } from './routes/mobile/uploads.js';
import { registerMobileQcRoutes } from './routes/mobile/qc.js';
import { registerMobileFulfillmentRoutes } from './routes/mobile/fulfillment.js';
import { registerMobileWorkshopRoutes } from './routes/mobile/workshop.js';
import { registerMobileWhatsAppRoutes } from './routes/mobile/whatsapp.js';
import { registerWebRoutes } from './web/routes.js';
import { registerWhatsAppWebhook } from './routes/whatsappWebhook.js';
import { WhatsAppService, type InvoicePdfGenerator } from './services/whatsappService.js';
import { PasswordResetService } from './services/passwordReset.js';
import { MetaCloudProvider, type WhatsAppProvider } from './whatsapp/provider.js';
import { whatsappOrderHooks } from './services/whatsappHooks.js';
import { WebSessionStore } from './web/session.js';
import { InvoicePdfService } from './services/invoicePdf.js';

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
  expenses: ExpenseService;
  storage: LocalDiskStorage;
  photos: PhotoService;
  laundry: LaundryGarmentService;
  qc: QcService;
  fulfillment: FulfillmentService;
  workshop: WorkshopService;
  workshopInvoice: WorkshopInvoice;
  hooks: OrderHooks;
  whatsapp: WhatsAppService;
  passwordReset: PasswordResetService;
  web: { sessions: WebSessionStore; /** nav entries whose page exists in this app (is_file() in header.php) */ pages: Set<string>; navShowAll: boolean };
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

export interface BuildOptions {
  /** Override order side-effects (tests). Default: real WhatsApp queueing. */
  hooks?: OrderHooks;
  /** Override the WhatsApp provider (tests). Default: Meta Cloud API. */
  provider?: WhatsAppProvider;
  invoicePdf?: InvoicePdfGenerator;
  /** Render every sidebar link as live (PHP's is_file() is always true there) — used by HTML-parity tests. */
  navShowAll?: boolean;
}

export function buildServices(env: Env, db: Db, options: BuildOptions = {}): Services {
  const crypto = new Crypto(env.APP_SECRET_KEY);
  const audit0 = new AuditLog(db);
  const whatsapp = new WhatsAppService(db, crypto, options.provider ?? new MetaCloudProvider(), { appName: env.APP_NAME, timezone: env.APP_TIMEZONE, invoicePdf: options.invoicePdf ?? new InvoicePdfService(db, env.APP_NAME) });
  const hooks = options.hooks ?? whatsappOrderHooks(db, whatsapp, env.APP_NAME);
  const limiter = new LoginRateLimiter(db, env.LOGIN_LOCKOUT_MINUTES);
  const auth = new AuthService(db, limiter, { maxLoginAttempts: env.MAX_LOGIN_ATTEMPTS, lockoutMinutes: env.LOGIN_LOCKOUT_MINUTES });
  const audit = audit0;
  const wallet = new CustomerWallet(db, audit);
  const pricing = new PricingEngine(db);
  const finance = new OrderFinance(db, audit);
  const notifications = new NotificationService(db);
  const storage = new LocalDiskStorage(env.UPLOAD_DIR, env.APP_URL);
  const laundry = new LaundryGarmentService(db, hooks);
  const workshop = new WorkshopService(db, audit);
  return {
    env,
    db,
    audit,
    auth,
    apiAuth: new ApiAuth(db, auth, env.API_TOKEN_LIFETIME_DAYS),
    crypto,
    pricing,
    customers: new CustomerService(db, audit),
    wallet,
    finance,
    notifications,
    expenses: new ExpenseService(db, audit, env.APP_TIMEZONE),
    storage,
    photos: new PhotoService(db, audit, storage, env.PHOTO_RETENTION_DAYS),
    laundry,
    qc: new QcService(db, audit, laundry, notifications, hooks),
    fulfillment: new FulfillmentService(db, audit, notifications),
    workshop,
    workshopInvoice: new WorkshopInvoice(db, audit, workshop, env.APP_TIMEZONE),
    hooks,
    whatsapp,
    web: { sessions: new WebSessionStore(db), pages: new Set<string>(), navShowAll: !!options.navShowAll },
    passwordReset: new PasswordResetService(db, whatsapp, audit, env.APP_URL),
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

  await app.register(helmet, { contentSecurityPolicy: false }); // the CRM pages use inline scripts/styles and CDN assets (as the PHP app did)
  await app.register(cors, { origin: false });
  await app.register(formbody); // PHP's $_POST fallback for form-encoded bodies
  // Photos are stored verbatim; the only limit is a generous safety ceiling (UPLOAD_MAX_MB, 0 = none).
  await app.register(multipart, {
    limits: { fileSize: services.env.UPLOAD_MAX_MB > 0 ? services.env.UPLOAD_MAX_MB * 1024 * 1024 : Number.MAX_SAFE_INTEGER, files: 3, fields: 20, fieldSize: 64 * 1024 },
  });
  if (services.env.SERVE_UPLOADS) {
    await app.register(fastifyStatic, { root: services.storage.root, prefix: '/uploads/', index: false, list: false, dotfiles: 'deny', setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); } });
  }

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
  await app.register(registerMobileReportRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileMiscRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileGarmentRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileUploadRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileQcRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileFulfillmentRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileWorkshopRoutes, { prefix: '/api/mobile' });
  await app.register(registerMobileWhatsAppRoutes, { prefix: '/api/mobile' });
  await app.register(registerWhatsAppWebhook);
  await app.register(registerWebRoutes);
  return app;
}
