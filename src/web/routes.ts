import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { jsonEncode } from './html.js';
import { WebRedirect, WebText, webPage } from './context.js';
import { registerAuthPages, postLoginRedirect } from './pages/auth.js';
import { registerDashboardPages } from './pages/dashboard.js';
import { registerCustomerPages } from './pages/customers.js';
import { registerCustomerPortPages } from './pages/customerPorts.js';
import { registerDailyDashboard } from './pages/dailyDashboard.js';
import { registerAccountPages } from './pages/accounts.js';
import { registerBarcodeTagPages } from './pages/barcodeTags.js';
import { registerBarcodePages } from './pages/barcode.js';
import { registerGarmentBulkImagePage } from './pages/garmentsBulkImage.js';
import { registerGarmentBulkImportPage } from './pages/garmentsBulkImport.js';
import { registerGarmentPages } from './pages/garments.js';
import { registerMiscPages } from './pages/miscPages.js';
import { registerAdminSettingsPages } from './pages/adminSettings.js';
import { registerAdminUsersPage } from './pages/adminUsers.js';
import { registerPricelistImportPage } from './pages/pricelistImport.js';
import { registerPricingPages } from './pages/pricing.js';
import { registerPricelistPages } from './pages/pricelist.js';
import { registerMasterPages } from './pages/master.js';
import { registerDeliveryPages } from './pages/delivery.js';
import { registerWorkshopBillPrintPage } from './pages/workshopBillPrint.js';
import { registerWorkshopBillingPage } from './pages/workshopBilling.js';
import { registerWorkshopReportPage } from './pages/workshopReport.js';
import { registerWorkshopIndexPage } from './pages/workshopIndex.js';
import { registerWorkshopPages } from './pages/workshop.js';
import { registerOpsPages } from './pages/ops.js';
import { registerPosPages } from './pages/pos.js';
import { registerPaymentPages } from './pages/payments.js';
import { registerOrderPortPages } from './pages/orderPorts.js';
import { registerPosApis } from './pages/posApis.js';
import { registerOrderPages } from './pages/orders.js';
import { registerLandingPages } from './pages/landing.js';

const json = (data: unknown, status = 200) => new WebText(jsonEncode(data), status, 'application/json');

/** Server-rendered CRM pages (Phase 5). Same URLs as the PHP app, including the ".php" forms. */
export async function registerWebRoutes(app: FastifyInstance) {
  const { db } = app.services;

  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../../public/assets/', import.meta.url)),
    prefix: '/assets/',
    index: false,
    decorateReply: false,
  });

  // index.php — role-aware destination
  for (const exact of ['/', '/index.php']) {
    webPage(app, exact, { auth: 'public', exact: true }, async (ctx) =>
      new WebRedirect(ctx.isLoggedIn() ? postLoginRedirect(ctx) : 'modules/auth/login.php'));
  }

  registerAuthPages(app);
  registerLandingPages(app);
  registerDashboardPages(app);
  registerDailyDashboard(app);
  registerCustomerPages(app);
  registerCustomerPortPages(app);
  registerOrderPages(app);
  registerOrderPortPages(app);
  registerPaymentPages(app);
  registerPosPages(app);
  registerOpsPages(app);
  registerWorkshopPages(app);
  registerWorkshopIndexPage(app);
  registerWorkshopReportPage(app);
  registerWorkshopBillingPage(app);
  registerWorkshopBillPrintPage(app);
  registerDeliveryPages(app);
  registerMasterPages(app);
  registerGarmentPages(app);
  registerPricelistPages(app);
  registerPricingPages(app);
  registerAdminUsersPage(app);
  registerAdminSettingsPages(app);
  registerMiscPages(app);
  registerPricelistImportPage(app);
  registerGarmentBulkImportPage(app);
  registerGarmentBulkImagePage(app);
  registerBarcodePages(app);
  registerBarcodeTagPages(app);
  registerAccountPages(app);
  registerPosApis(app);

  // api/set_active_store.php
  webPage(app, '/api/set_active_store', { auth: 'login', methods: ['GET', 'POST'] }, async (ctx, req) => {
    if (req.method !== 'POST') return json({ success: false, error: 'Invalid request method.' }, 405);
    if (!ctx.csrfValid()) return new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
    if (ctx.fixedStoreId() !== null) return json({ success: false, error: 'Your store is fixed by your account and cannot be changed here.' }, 403);
    const storeId = parseInt(String((req.body as Record<string, unknown>)?.store_id ?? ''), 10) || 0;
    const active = storeId ? (await db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [storeId])).length > 0 : false;
    if (!storeId || !active) return json({ success: false, error: 'Selected store is invalid or inactive.' }, 422);
    ctx.set('active_store_id', storeId);
    return json({ success: true });
  });

  // api/customers_search.php
  webPage(app, '/api/customers_search', { auth: 'login', methods: ['GET'] }, async (ctx, req) => {
    if (!ctx.can('customers.view')) return json({ results: [], error: 'You do not have permission to search customers.' }, 403);
    const q = String((req.query as Record<string, unknown>).q ?? '').trim();
    if (Buffer.byteLength(q) < 2) return json({ results: [] });
    const like = `%${q}%`;
    const rows = await db.query(
      `SELECT id, customer_code, title, full_name, mobile, address, area, city, state, pincode, barcode, discount_percent, price_list_id, home_delivery
       FROM customers
       WHERE is_active = 1 AND (full_name LIKE ? OR mobile LIKE ? OR customer_code LIKE ? OR barcode LIKE ? OR address LIKE ? OR area LIKE ? OR city LIKE ? OR state LIKE ? OR pincode LIKE ?)
       ORDER BY full_name LIMIT 15`, Array(9).fill(like));
    return json({ results: rows });
  });

  // api/orders_search.php
  webPage(app, '/api/orders_search', { auth: 'packing.manage', methods: ['GET'] }, async (_ctx, req) => {
    const q = String((req.query as Record<string, unknown>).q ?? '').trim();
    if (Buffer.byteLength(q) < 2) return json({ results: [] });
    const like = `%${q}%`;
    const rows = await db.query(
      `SELECT o.id, o.order_number, o.invoice_number, c.full_name AS customer_name, c.mobile
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.order_number LIKE ? OR o.invoice_number LIKE ? OR c.full_name LIKE ? OR c.mobile LIKE ?
       ORDER BY o.id DESC LIMIT 15`, Array(4).fill(like));
    return json({ results: rows });
  });
}
