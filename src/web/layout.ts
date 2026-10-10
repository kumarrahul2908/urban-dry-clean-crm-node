import { dMonY } from '../lib/tzFormat.js';
import { getSetting } from '../services/settings.js';
import type { WebCtx } from './context.js';
import { e, html, jsonEncode, Raw, raw } from './html.js';

type NavItem = [label: string, icon: string, url: string, permission: string | null];

const AUDIT_ROLES = ['Super Admin', 'Admin'];

const navSections = (workshopStaff: boolean): Record<string, NavItem[]> => ({
  Main: [
    ['Home', 'fa-house', 'modules/dashboard/landing.php', 'dashboard.view'],
    ['Dashboard', 'fa-gauge-high', workshopStaff ? 'modules/workshop/dashboard.php' : 'modules/dashboard/index.php', 'dashboard.view'],
    ['Daily Dashboard', 'fa-calendar-day', 'modules/daily_dashboard/index.php', 'dashboard.view'],
  ],
  Sales: [
    ['New Order (Dry Cleaning)', 'fa-cash-register', 'modules/pos/index.php', 'pos.create'],
    ['New Order (Laundry)', 'fa-weight-scale', 'modules/laundry/index.php', 'pos.create'],
    ['Orders', 'fa-receipt', 'modules/orders/list.php', 'orders.view'],
    ['Customers', 'fa-users', 'modules/customers/list.php', 'customers.view'],
    ['Payments', 'fa-money-bill-wave', 'modules/payments/list.php', 'payments.collect'],
    ['Customer Wallet', 'fa-wallet', 'modules/payments/wallet.php', 'wallet.manage'],
    ['Outstanding', 'fa-triangle-exclamation', 'modules/accounts/outstanding.php', 'accounts.view'],
  ],
  'Barcode & Tags': [
    ['Print Garment Tags', 'fa-tags', 'modules/barcode/tags.php', 'garment_tags.view'],
    ['Barcode Search', 'fa-magnifying-glass', 'modules/barcode/search.php', 'garment_tags.view'],
    ['QR Scan', 'fa-qrcode', 'modules/barcode/scan.php', 'garment_tags.view'],
    ['Packing Stickers', 'fa-box-open', 'modules/barcode/packing.php', 'packing.manage'],
  ],
  Operations: [
    ['Workshop', 'fa-industry', 'modules/workshop/index.php', 'workshop.manage'],
    ['Workshop Dashboard', 'fa-gauge-high', 'modules/workshop/dashboard.php', 'workshop.manage'],
    ['Workshop Returns', 'fa-truck-ramp-box', 'modules/workshop/receiving.php', 'workshop.manage'],
    ['Workshop Report', 'fa-chart-pie', 'modules/workshop/report.php', 'workshop.manage'],
    ['Workshop Settings', 'fa-sliders', 'modules/workshop/settings.php', 'workshop.manage'],
    ['Workshop Billing', 'fa-file-invoice-dollar', 'modules/workshop/billing.php', 'workshop.billing'],
    ['Quality Control', 'fa-magnifying-glass', 'modules/qc/index.php', 'qc.manage'],
    ['Rework', 'fa-rotate-left', 'modules/qc/rework.php', 'rework.manage'],
    ['Packing', 'fa-box', 'modules/packing/index.php', 'packing.manage'],
  ],
  'Pickup & Delivery': [
    ['Home Pickup', 'fa-house-circle-check', 'modules/pickup/index.php', 'pickup.manage'],
    ['Home Delivery', 'fa-truck', 'modules/delivery/index.php', 'delivery.manage'],
    ['Drivers', 'fa-id-card', 'modules/delivery/drivers.php', 'drivers.manage'],
  ],
  Accounts: [
    ['Daily Collection', 'fa-receipt', 'modules/accounts/daily-collection.php', 'payments.view'],
    ['Wallet Adjustment', 'fa-wallet', 'modules/accounts/wallet-adjustment.php', 'payments.adjust'],
    ['Expenses', 'fa-file-invoice-dollar', 'modules/accounts/expenses.php', 'expenses.manage'],
    ['Income', 'fa-sack-dollar', 'modules/accounts/income.php', 'expenses.manage'],
  ],
  Reports: [
    ['All Reports', 'fa-chart-column', 'modules/reports/index.php', 'reports.view'],
    ['Customer Feedback', 'fa-star', 'modules/feedback/index.php', 'feedback.manage'],
    ['WhatsApp — API Settings', 'fa-brands fa-whatsapp', 'modules/reports/whatsapp/settings.php', 'whatsapp.settings'],
    ['WhatsApp — Templates', 'fa-brands fa-whatsapp', 'modules/reports/whatsapp/templates.php', 'whatsapp.settings'],
    ['WhatsApp — Campaigns', 'fa-brands fa-whatsapp', 'modules/reports/whatsapp/campaigns.php', 'whatsapp.settings'],
    ['WhatsApp — Analytics', 'fa-brands fa-whatsapp', 'modules/reports/whatsapp/analytics.php', 'whatsapp.settings'],
    ['WhatsApp — Inbox', 'fa-brands fa-whatsapp', 'modules/reports/whatsapp/inbox.php', 'whatsapp.settings'],
    ['WhatsApp — Marketing', 'fa-brands fa-whatsapp', 'modules/reports/whatsapp/marketing.php', 'whatsapp.settings'],
    ['WhatsApp — Rate List', 'fa-brands fa-whatsapp', 'modules/reports/whatsapp/rate_list.php', 'whatsapp.settings'],
  ],
  Setup: [
    ['Master Data', 'fa-database', 'modules/master_data/index.php', 'master.manage'],
    ['Garments', 'fa-shirt', 'modules/garments/list.php', 'garments.manage'],
    ['Price Lists', 'fa-tags', 'modules/pricelist/list.php', 'pricelist.manage'],
    ['Bulk Price Update (Legacy)', 'fa-file-csv', 'modules/pricing/bulk_update.php', 'pricing.bulk_update'],
    ['Import Customers', 'fa-file-import', 'modules/customers/import.php', 'customer.import'],
    ['Export Customers', 'fa-file-export', 'modules/customers/export.php', 'customer.export'],
    ['Import Orders', 'fa-file-import', 'modules/orders/import.php', 'order.import'],
    ['Export Orders', 'fa-file-export', 'modules/orders/export.php', 'order.export'],
    ['Notifications', 'fa-bell', 'modules/notifications/index.php', 'notifications.manage'],
    ['Users & Roles', 'fa-user-shield', 'modules/admin/users.php', 'users.manage'],
    ['Admin Settings', 'fa-gear', 'modules/admin/settings.php', 'admin.settings'],
    ['Print Settings', 'fa-print', 'modules/admin/print_settings.php', 'master.manage'],
    ['Audit Log', 'fa-clipboard-list', 'modules/audit/index.php', 'audit.view'],
  ],
});

export interface PageMeta {
  title?: string;
  /** Extra <script src> URLs appended after app.js ($pageScripts). */
  scripts?: string[];
}

const BOOTSTRAP_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.2/css/bootstrap.min.css';
const FA_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css';
const BOOTSTRAP_JS = 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/5.3.2/js/bootstrap.bundle.min.js';

const storeSelectorScript = (ctx: WebCtx) => `
        <script>
        document.addEventListener('DOMContentLoaded', function () {
          document.querySelectorAll('.store-select-option').forEach(function (opt) {
            opt.addEventListener('click', function (e) {
              e.preventDefault();
              const fd = new FormData();
              fd.append('csrf_token', document.querySelector('meta[name="csrf-token"]').content);
              fd.append('store_id', this.dataset.storeId);
              fetch(${jsonEncode(ctx.baseUrl('api/set_active_store.php'))}, { method: 'POST', body: fd })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                  if (data.success) { window.location.reload(); }
                  else { alert(data.error || 'Could not set store.'); }
                });
            });
          });
        });
        </script>`;

/** includes/header.php + includes/footer.php around the page body. `body` goes inside <div class="row g-3">. */
export async function layout(ctx: WebCtx, meta: PageMeta, body: Raw | string): Promise<Raw> {
  const { db, env } = ctx.svc;
  const businessName = (await getSetting(db, 'business_name', env.APP_NAME)) ?? '';
  const flashes = ctx.flashGet();
  const user = ctx.user;
  const isWorkshopStaff = ctx.roleName() === 'Workshop Staff';
  const uri = ctx.req.raw.url ?? '';
  const exists = (url: string) => ctx.svc.web.navShowAll || ctx.svc.web.pages.has(url);

  const nav = Object.entries(navSections(isWorkshopStaff)).map(([section, items]) => {
    const visible = items.filter(([, , url, perm]) =>
      (perm === null || ctx.can(perm))
      && (url !== 'modules/audit/index.php' || AUDIT_ROLES.includes(ctx.roleName()))
      && (!isWorkshopStaff || !['modules/dashboard/landing.php', 'modules/daily_dashboard/index.php'].includes(url)));
    if (visible.length === 0) return '';
    return html`
        <div class="udc-nav-section">${section}</div>
        ${visible.map(([label, icon, url]) => {
          const ok = exists(url);
          const active = ok && uri.includes(url) ? 'active' : '';
          return ok
            ? html`
            <a class="udc-nav-link ${active}" href="${ctx.baseUrl(url)}">
              <i class="fa-solid ${icon}"></i><span>${label}</span>
            </a>`
            : html`
            <span class="udc-nav-link udc-nav-link-disabled" aria-disabled="true" title="Coming soon — this module hasn't been built yet">
              <i class="fa-solid ${icon}"></i><span>${label}</span><span class="udc-coming-soon">Coming Soon</span>
            </span>`;
        })}`;
  });

  let storeSelector: Raw | string = '';
  if (ctx.fixedStoreId() === null && !isWorkshopStaff) {
    const stores = await db.query<{ id: number; store_name: string }>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
    const active = ctx.activeStoreId();
    const activeName = stores.find((s) => Number(s.id) === active)?.store_name ?? '(select store)';
    storeSelector = html`
        <div class="dropdown me-2">
          <button class="btn btn-sm btn-outline-primary dropdown-toggle" data-bs-toggle="dropdown">
            <i class="fa-solid fa-store me-1"></i>
            ${activeName}
          </button>
          <ul class="dropdown-menu" id="storeSelectorMenu">
            ${stores.map((s) => html`
              <li><a class="dropdown-item store-select-option${Number(s.id) === active ? ' active' : ''}" href="#" data-store-id="${s.id}">${s.store_name}</a></li>`)}
          </ul>
        </div>${raw(storeSelectorScript(ctx))}`;
  }

  const year = new Intl.DateTimeFormat('en-GB', { timeZone: env.APP_TIMEZONE, year: 'numeric' }).format(new Date());
  void dMonY;

  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="csrf-token" content="${ctx.csrfToken()}">
<title>${meta.title ? `${meta.title} - ` : ''}${businessName}</title>
<link href="${BOOTSTRAP_CSS}" rel="stylesheet">
<link href="${FA_CSS}" rel="stylesheet">
<link href="${ctx.baseUrl('assets/css/app.css')}" rel="stylesheet">
</head>
<body>
<div class="udc-wrapper">
  <!-- SIDEBAR -->
  <nav class="udc-sidebar" id="udcSidebar">
    <div class="udc-brand">
      <i class="fa-solid fa-shirt"></i>
      <span>URBAN DRY CLEAN</span>
    </div>
    <div class="udc-nav">
      ${nav}
    </div>
  </nav>

  <!-- MAIN -->
  <div class="udc-main">
    <header class="udc-topbar">
      <button class="btn btn-sm btn-outline-secondary d-lg-none" id="udcSidebarToggle"><i class="fa-solid fa-bars"></i></button>
      <h5 class="mb-0 flex-grow-1">${meta.title ?? ''}</h5>
      ${storeSelector}
      <div class="dropdown">
        <button class="btn btn-light dropdown-toggle d-flex align-items-center gap-2" data-bs-toggle="dropdown">
          <i class="fa-solid fa-circle-user fa-lg"></i>
          <span class="d-none d-md-inline">${user?.full_name ?? ''}</span>
        </button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><span class="dropdown-item-text small text-muted">${user?.role_name ?? ''}</span></li>
          <li><hr class="dropdown-divider"></li>
          <li><a class="dropdown-item" href="${ctx.baseUrl('modules/auth/change-password.php')}"><i class="fa-solid fa-key me-2"></i>Change Password</a></li>
          <li><a class="dropdown-item text-danger" href="${ctx.baseUrl('modules/auth/logout.php')}"><i class="fa-solid fa-right-from-bracket me-2"></i>Logout</a></li>
        </ul>
      </div>
    </header>

    <main class="udc-content">
      ${flashes.map((f) => html`
        <div class="alert alert-${f.type} alert-dismissible fade show" role="alert">
          ${f.message}
          <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        </div>`)}

      <div class="modal fade" id="installPrintSvcModal" tabindex="-1" data-bs-backdrop="static">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="fa-solid fa-gears me-2"></i>Install Printing Services</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p class="mb-2">Install the Urban Dry Clean Printing Services (Windows) application to set up your printers for invoice and tag(s) printing.</p>
              <p class="small text-muted mb-0">Optional &mdash; everything still works without it. Once installed, this computer will show your real printer list and can print silently, with no extra setup step.</p>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary btn-sm" id="installPrintSvcLater" data-bs-dismiss="modal">Not now</button>
              <a href="${ctx.baseUrl('downloads/UdcPrintService.exe')}" class="btn btn-primary" id="installPrintSvcDownload"><i class="fa-solid fa-download me-1"></i>Download Printer Setup</a>
            </div>
          </div>
        </div>
      </div>
      <script>
      (function () {
        var DISMISS_KEY = 'udc_print_svc_prompt_dismissed_until';
        var dismissedUntil = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
        if (Date.now() < dismissedUntil) return; // asked recently, don't nag every page load

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 1200);
        fetch('http://127.0.0.1:9294/ping', { signal: controller.signal })
          .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
          .then(function () { /* already installed on this computer -- nothing to prompt */ })
          .catch(function () {
            var el = document.getElementById('installPrintSvcModal');
            if (!el || typeof bootstrap === 'undefined') return;
            new bootstrap.Modal(el).show();
          })
          .finally(function () { clearTimeout(timeout); });

        document.getElementById('installPrintSvcLater')?.addEventListener('click', function () {
          localStorage.setItem(DISMISS_KEY, String(Date.now() + 24 * 60 * 60 * 1000)); // don't ask again for 24h on this computer
        });
        document.getElementById('installPrintSvcDownload')?.addEventListener('click', function () {
          localStorage.setItem(DISMISS_KEY, String(Date.now() + 24 * 60 * 60 * 1000));
        });
      })();
      </script>

      <div class="row g-3">${body instanceof Raw ? body : raw(body)}
      </div>
    </main>
    <footer class="udc-footer">
      &copy; ${year} ${businessName}. All rights reserved.
    </footer>
  </div>
</div>

<script src="${BOOTSTRAP_JS}"></script>
<script src="${ctx.baseUrl('assets/js/app.js')}"></script>
${(meta.scripts ?? []).map((s) => html`<script src="${s}"></script>
`)}</body>
</html>
`;
}

/** Standalone auth-style page shell (login, forgot/reset password): no sidebar. */
export const authHead = (ctx: WebCtx, title: string, extraStyle = '') => html`<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - ${ctx.svc.env.APP_NAME}</title>
<link href="${BOOTSTRAP_CSS}" rel="stylesheet">
<link href="${FA_CSS}" rel="stylesheet">
<link href="${ctx.baseUrl('assets/css/app.css')}" rel="stylesheet">
${raw(extraStyle)}</head>`;

export { e };
