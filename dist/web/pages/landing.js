import { webPage } from '../context.js';
import { e, html, jsonEncode, raw } from '../html.js';
import { layout } from '../layout.js';
import { landingScript, landingStyle } from './landing.static.js';
export function registerLandingPages(app) {
    webPage(app, '/modules/dashboard/landing', { auth: 'dashboard.view' }, async (ctx) => {
        const u = (p) => ctx.baseUrl(p);
        return layout(ctx, { title: 'Home' }, html `
<div class="col-12">
  <div class="udc-home">
    <p class="udc-greeting">Welcome, ${ctx.user?.full_name ?? ''}</p>
    <div class="card udc-search-card">
      <div class="card-body">
        <div class="udc-search-modes">
          <label class="udc-mode">
            <input type="radio" name="landingSearchType" value="customer" checked>
            <span class="udc-mode-body">
              <span class="udc-mode-title">Customer</span>
              <span class="udc-mode-hint">Name, mobile, address or customer code</span>
            </span>
          </label>
          <label class="udc-mode">
            <input type="radio" name="landingSearchType" value="order">
            <span class="udc-mode-body">
              <span class="udc-mode-title">Order / Invoice</span>
              <span class="udc-mode-hint">For delivery or payment</span>
            </span>
          </label>
        </div>
        <div class="udc-search-row">
          <div class="udc-search-field">
            <i class="fa-solid fa-magnifying-glass udc-search-icon"></i>
            <input type="text" id="landingSearchInput" class="form-control udc-search-input"
                   placeholder="Search name, mobile, code, barcode..." autocomplete="off">
            <div id="landingSearchResults" class="list-group udc-search-results d-none"></div>
          </div>
          <button type="button" class="btn btn-primary udc-search-btn" id="landingSearchBtn">Search</button>
        </div>
        <div class="udc-search-help" id="landingSearchHelp">Search by Name, Address, Mobile, Customer Code or Barcode</div>
      </div>
    </div>
    <div class="udc-actions">
      <a href="${u('modules/customers/add.php')}" class="udc-action">
        <i class="fa-solid fa-user-plus"></i>
        <span>Add new customer</span>
      </a>
      <a href="${u('modules/daily_dashboard/index.php')}" class="udc-action">
        <i class="fa-solid fa-calendar-day"></i>
        <span>Daily dashboard</span>
      </a>
    </div>
    <p class="udc-secondary">
      Looking for sales figures and order analytics?
      <a href="${u('modules/dashboard/index.php')}">Open the business dashboard</a>
    </p>
  </div>
</div>
${raw(landingStyle(u, jsonEncode, e))}
${raw(landingScript(u, jsonEncode, e))}
`);
    });
}
