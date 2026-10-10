import type { FastifyInstance } from 'fastify';
import { checkCustomerDuplicate } from '../../services/customerService.js';
import { generateCustomerCode } from '../../services/documentNumber.js';
import { phpEmpty, isNumeric } from '../../lib/php.js';
import { WebText, webPage, type WebCtx } from '../context.js';
import { csvBody } from '../csv.js';
import { httpBuildQuery, int } from '../format.js';
import { html, raw, type Raw } from '../html.js';
import { importCleanupTemp, importStoreTempUpload, importTempPath, parseCsvFile } from '../importTemp.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const csv = (filename: string, headers: string[], rows: unknown[][]) =>
  new WebText(csvBody(headers, rows), 200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${filename}"` });

const IMPORT_TARGET_FIELDS: Record<string, string> = {
  '': '-- Do not import --', customer_code: 'Customer Code', title: 'Title (Mr/Mrs/Ms)', full_name: 'Name *', mobile: 'Mobile *', alt_mobile: 'Alternate Mobile',
  email: 'Email', address: 'Address', area: 'Area', city: 'City', state: 'State', pincode: 'Pincode', company: 'Company (merged into Remarks)', birthday: 'Date of Birth',
  anniversary: 'Anniversary', notes: 'Notes (merged into Remarks)', price_list: 'Price List (matched by name)', opening_wallet: 'Opening Balance / Wallet-Advance (credited via wallet)',
};

const GUESS: Record<string, string[]> = {
  customer_code: ['customer code', 'code', 'custcode', 'cust code'], title: ['title'], full_name: ['name', 'customer name', 'full name'],
  mobile: ['mobile', 'phone', 'mobile number', 'phone number'], alt_mobile: ['alternate mobile', 'alt mobile', 'secondary mobile'], email: ['email', 'email address'],
  address: ['address'], city: ['city'], area: ['area', 'locality'], state: ['state'], pincode: ['pincode', 'pin', 'zip', 'postal code'], company: ['company'],
  birthday: ['dob', 'date of birth', 'birthday'], anniversary: ['anniversary'], notes: ['notes', 'remarks'], price_list: ['price list', 'pricelist'],
  opening_wallet: ['opening balance', 'wallet', 'advance', 'opening wallet'],
};
function guessMapping(headers: string[]): Record<string, string> {
  const g: Record<string, string> = {};
  for (const h of headers) {
    const norm = h.trim().toLowerCase();
    for (const [target, aliases] of Object.entries(GUESS)) if (aliases.includes(norm)) { g[h] = target; break; }
  }
  return g;
}

export function registerCustomerPortPages(app: FastifyInstance) {
  const { db } = app.services;

  // ---- export ---------------------------------------------------------------------------------
  webPage(app, '/modules/customers/export', { auth: 'customer.export' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const status = (typeof q.status === 'string' ? q.status : 'all').trim();
    const priceListId = int(q.price_list_id);
    const search = clean(q.q), dateFrom = clean(q.date_from), dateTo = clean(q.date_to);
    let where = '1=1';
    const params: unknown[] = [];
    if (status === 'active') where += ' AND c.is_active = 1';
    if (status === 'inactive') where += ' AND c.is_active = 0';
    if (priceListId) { where += ' AND c.price_list_id = ?'; params.push(priceListId); }
    if (search !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ? OR c.customer_code LIKE ?)'; const like = `%${search}%`; params.push(like, like, like); }
    if (dateFrom !== '') { where += ' AND DATE(c.created_at) >= ?'; params.push(dateFrom); }
    if (dateTo !== '') { where += ' AND DATE(c.created_at) <= ?'; params.push(dateTo); }

    if ('export' in q) {
      const data = await db.query<Row>(
        `SELECT c.customer_code, c.title, c.full_name, c.mobile, c.alt_mobile, c.email, c.address, c.area, c.city, c.state, c.pincode, c.birthday, c.anniversary, c.gstin, c.discount_percent,
                pl.price_list_name, c.home_delivery, c.is_active, c.created_at, COALESCE(cw.balance, 0) AS wallet_balance
         FROM customers c LEFT JOIN price_lists pl ON pl.id = c.price_list_id LEFT JOIN customer_wallet cw ON cw.customer_id = c.id WHERE ${where} ORDER BY c.id`, params);
      const rows = data.map((r) => [r.customer_code, r.title, r.full_name, r.mobile, r.alt_mobile, r.email, r.address, r.area, r.city, r.state, r.pincode, r.birthday, r.anniversary,
        r.gstin, r.discount_percent, r.price_list_name, r.home_delivery ? 'Yes' : 'No', r.is_active ? 'Active' : 'Inactive', r.created_at, r.wallet_balance]);
      await ctx.svc.audit.record({ action: 'export', module: 'customers', recordId: 'export', newValue: { count: rows.length, filters: { status, priceListId, search, dateFrom, dateTo } }, userId: ctx.data.user_id, ip: req.ip });
      return csv(`urban_dry_clean_customers_${ctx.today}.csv`,
        ['Customer Code', 'Title', 'Name', 'Mobile', 'Alt Mobile', 'Email', 'Address', 'Area', 'City', 'State', 'Pincode', 'Birthday', 'Anniversary', 'GSTIN', 'Discount %', 'Price List', 'Home Delivery', 'Status', 'Created At', 'Wallet Balance'], rows);
    }

    const priceLists = await db.query<Row>('SELECT id, price_list_name FROM price_lists WHERE is_active=1');
    const matchCount = int((await db.query<Row>(`SELECT COUNT(*) AS n FROM customers c WHERE ${where}`, params))[0]!.n);
    const qs = httpBuildQuery({ ...(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Array.isArray(v) ? '' : v])) as Record<string, unknown>), export: 1 });
    const sel = (c: boolean) => (c ? 'selected' : '');
    return layout(ctx, { title: 'Export Customers' }, html`
<div class="col-md-8">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold mb-3">Export Customers</h6>
      <form method="GET" class="row g-2">
        <div class="col-md-4">
          <label class="form-label small">Status</label>
          <select name="status" class="form-select form-select-sm">
            <option value="all" ${sel(status === 'all')}>All</option>
            <option value="active" ${sel(status === 'active')}>Active</option>
            <option value="inactive" ${sel(status === 'inactive')}>Inactive</option>
          </select>
        </div>
        <div class="col-md-4">
          <label class="form-label small">Price List</label>
          <select name="price_list_id" class="form-select form-select-sm">
            <option value="0">Any</option>
            ${priceLists.map((pl) => html`
              <option value="${pl.id}" ${sel(priceListId === Number(pl.id))}>${pl.price_list_name}</option>`)}
          </select>
        </div>
        <div class="col-md-4">
          <label class="form-label small">Search (name/mobile/code)</label>
          <input type="text" name="q" class="form-control form-control-sm" value="${search}">
        </div>
        <div class="col-md-4">
          <label class="form-label small">Created From</label>
          <input type="date" name="date_from" class="form-control form-control-sm" value="${dateFrom}">
        </div>
        <div class="col-md-4">
          <label class="form-label small">Created To</label>
          <input type="date" name="date_to" class="form-control form-control-sm" value="${dateTo}">
        </div>
        <div class="col-md-4 d-flex align-items-end">
          <button class="btn btn-outline-primary btn-sm w-100" type="submit"><i class="fa-solid fa-filter me-1"></i>Apply Filters</button>
        </div>
      </form>
      <hr>
      <p>${matchCount} customer(s) match the current filters.</p>
      <a href="?${raw(qs)}" class="btn btn-primary"><i class="fa-solid fa-download me-1"></i>Download CSV</a>
      <p class="text-muted small mt-3 mb-0">Passwords, session data, and internal security fields are never included in this export.</p>
    </div>
  </div>
</div>
`);
  });

  // ---- import ---------------------------------------------------------------------------------
  async function buildPreview(rows: Record<string, string>[], mapping: Record<string, string>): Promise<Row[]> {
    const results: Row[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const mapped: Record<string, string> = {};
      for (const [csvCol, target] of Object.entries(mapping)) {
        if (target === '') continue;
        const val = (row[csvCol] ?? '').trim();
        if (target === 'company' || target === 'notes') mapped.remarks = ((mapped.remarks ?? '') + (val !== '' ? ` ${val}` : '')).trim();
        else mapped[target] = val;
      }
      const errors: string[] = [], warnings: string[] = [];
      if (phpEmpty(mapped.full_name)) errors.push('Name is required.');
      if (phpEmpty(mapped.mobile) || !/^[0-9+ -]{7,15}$/.test(mapped.mobile!)) errors.push('A valid mobile number is required.');
      let priceListId: number | null = null;
      if (!phpEmpty(mapped.price_list)) {
        const p = (await db.query<Row>('SELECT id FROM price_lists WHERE price_list_name = ? LIMIT 1', [mapped.price_list]))[0];
        priceListId = p ? Number(p.id) : null;
        if (!priceListId) errors.push(`Price list "${mapped.price_list}" not found — will import with Default price list.`);
      }
      let existing: Row | null = null, matchedOn: string | null = null;
      if (errors.length === 0) {
        if (!phpEmpty(mapped.customer_code)) {
          existing = (await db.query<Row>('SELECT id, full_name FROM customers WHERE customer_code = ?', [mapped.customer_code]))[0] ?? null;
          if (existing) matchedOn = 'customer_code';
        }
        if (!existing && !phpEmpty(mapped.mobile)) {
          const dup = await checkCustomerDuplicate(db, mapped.mobile!, mapped.full_name ?? '', null);
          if (dup.action === 'block') { existing = dup.matched_customer; matchedOn = 'mobile'; }
          else if (dup.action === 'warn') warnings.push(`Mobile ${mapped.mobile} is already used by ${dup.matches[0]!.full_name} (${dup.matches[0]!.customer_code}) — importing as a separate customer (shared family/business number).`);
        }
        if (!existing && !phpEmpty(mapped.email)) {
          existing = (await db.query<Row>('SELECT id, full_name FROM customers WHERE email = ?', [mapped.email]))[0] ?? null;
          if (existing) matchedOn = 'email';
        }
      }
      results.push({ line: i + 2, mapped, errors, warnings, is_duplicate: !!existing, matched_on: matchedOn, existing_id: existing?.id ?? null, existing_name: existing?.full_name ?? null, price_list_id: priceListId });
    }
    return results;
  }

  webPage(app, '/modules/customers/import', { auth: 'customer.import' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    if ('template' in q) {
      return csv('urban_dry_clean_customer_import_template.csv',
        ['Customer Code', 'Title', 'Name', 'Mobile', 'Alt Mobile', 'Email', 'Address', 'City', 'Pincode', 'DOB', 'Anniversary', 'Notes', 'Price List', 'Opening Balance'],
        [['CUST001', 'Mr', 'Rahul Singh', '9999096552', '', 'rahul@example.com', 'Stellar Jeevan', 'Delhi', '110001', '1990-05-12', '', 'VIP customer', 'Default Price List', '500']]);
    }
    let step = clean(body(ctx).step ?? q.step ?? 'upload') || 'upload';
    const errors: string[] = [];
    let token = clean(body(ctx).import_token);
    let report: Row | null = null;
    let preview: Row[] | undefined;
    let headers: string[] = [];
    let guessed: Record<string, string> = {};
    const userId = ctx.data.user_id!;

    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      if (step === 'upload') {
        try {
          token = await importStoreTempUpload(ctx, 'file');
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          if (parsed.headers.length === 0 || parsed.rows.length === 0) {
            await importCleanupTemp(ctx, token);
            errors.push('The file has no headers or no data rows.');
            step = 'upload';
          } else {
            ctx.set('customer_import_headers', parsed.headers);
            step = 'mapping';
          }
        } catch (e) { errors.push((e as Error).message); step = 'upload'; }
      } else if (step === 'mapping') {
        const hs = (ctx.data.customer_import_headers as string[] | undefined) ?? [];
        const mapping: Record<string, string> = {};
        for (const h of hs) mapping[h] = clean(body(ctx)[`map[${h}]`]);
        try {
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          preview = await buildPreview(parsed.rows, mapping);
          ctx.set('customer_import_mapping', mapping);
          step = 'preview';
        } catch (e) { errors.push((e as Error).message); step = 'upload'; }
      } else if (step === 'confirm') {
        const policyRaw = str(body(ctx).duplicate_policy);
        const policy = ['skip', 'update', 'create'].includes(policyRaw) ? policyRaw : 'skip';
        const mapping = (ctx.data.customer_import_mapping as Record<string, string> | undefined) ?? {};
        try {
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          const rows = await buildPreview(parsed.rows, mapping);
          let created = 0, updated = 0, skipped = 0, errorCount = 0;
          await db.tx(async (t) => {
            const audit = ctx.svc.audit.using(t);
            const wallet = ctx.svc.wallet.using(t);
            for (const row of rows) {
              if (row.errors.length) { errorCount++; continue; }
              const m = row.mapped as Record<string, string>;
              if (row.is_duplicate) {
                if (policy === 'skip') { skipped++; continue; }
                if (policy === 'update') {
                  await t.execute(
                    "UPDATE customers SET title=COALESCE(NULLIF(?,''),title), full_name=?, mobile=?, alt_mobile=?, email=?, address=?, area=?, city=?, state=?, pincode=?, birthday=?, anniversary=?, remarks=?, price_list_id=COALESCE(?,price_list_id) WHERE id=?",
                    [m.title ?? '', m.full_name, m.mobile, m.alt_mobile ?? null, m.email ?? null, m.address ?? null, m.area ?? null, m.city ?? null, m.state ?? null, m.pincode ?? null,
                      !phpEmpty(m.birthday) ? m.birthday : null, !phpEmpty(m.anniversary) ? m.anniversary : null, m.remarks ?? null, row.price_list_id, row.existing_id]);
                  await audit.record({ action: 'edit', module: 'customers', recordId: String(row.existing_id), newValue: { imported_update: true, line: row.line }, userId, ip: req.ip });
                  updated++;
                  continue;
                }
              }
              const code = await generateCustomerCode(t);
              const barcode = `${(await ctx.setting('barcode_prefix', 'UDC')) ?? 'UDC'}-CUST-${code.slice(-6)}`;
              const ins = await t.execute(
                `INSERT INTO customers (customer_code, title, full_name, address, area, city, state, pincode, mobile, alt_mobile, email, barcode, birthday, anniversary, remarks, registration_source, price_list_id, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Import', ?, ?)`,
                [!phpEmpty(m.customer_code) ? m.customer_code : code, m.title ?? '', m.full_name, m.address ?? null, m.area ?? null, m.city ?? null, m.state ?? null, m.pincode ?? null,
                  m.mobile, m.alt_mobile ?? null, m.email ?? null, barcode, !phpEmpty(m.birthday) ? m.birthday : null, !phpEmpty(m.anniversary) ? m.anniversary : null,
                  m.remarks ?? null, row.price_list_id, userId]);
              await t.execute('INSERT INTO customer_wallet (customer_id, balance) VALUES (?, 0)', [ins.insertId]);
              await audit.record({ action: 'create', module: 'customers', recordId: String(ins.insertId), newValue: { imported: true, line: row.line }, userId, ip: req.ip });
              if (!phpEmpty(m.opening_wallet) && isNumeric(m.opening_wallet) && parseFloat(m.opening_wallet!) > 0) {
                await wallet.deposit(ins.insertId, parseFloat(m.opening_wallet!), 'Opening Balance', 'Imported opening balance', null, userId);
              }
              created++;
            }
          });
          await importCleanupTemp(ctx, token);
          delete ctx.data.customer_import_headers; delete ctx.data.customer_import_mapping; ctx.dirty = true;
          await ctx.svc.audit.record({ action: 'create', module: 'customers', recordId: 'bulk_import', newValue: { created, updated, skipped, errors: errorCount }, userId, ip: req.ip });
          report = { created, updated, skipped, errors: errorCount };
          step = 'done';
        } catch (e) { errors.push(`Import failed, no changes were made: ${(e as Error).message}`); step = 'upload'; }
      } else if (step === 'cancel') {
        await importCleanupTemp(ctx, token);
        delete ctx.data.customer_import_headers; delete ctx.data.customer_import_mapping; ctx.dirty = true;
        step = 'upload';
      }
    }

    if (step === 'mapping') { headers = (ctx.data.customer_import_headers as string[] | undefined) ?? []; guessed = guessMapping(headers); }
    if (step === 'preview') {
      headers = (ctx.data.customer_import_headers as string[] | undefined) ?? [];
      const mapping = (ctx.data.customer_import_mapping as Record<string, string> | undefined) ?? {};
      try {
        const parsed = await parseCsvFile(importTempPath(ctx, token));
        preview = await buildPreview(parsed.rows, mapping);
      } catch (e) { errors.push((e as Error).message); step = 'upload'; }
    }

    const u = (p: string) => ctx.baseUrl(p);
    let content: Raw | string = '';
    if (step === 'upload') {
      content = html`
        <h6 class="fw-bold">Import Customers from CSV</h6>
        <p class="text-muted">Migrate your customer database (e.g. from QDC). You'll map your file's columns to Urban Dry Clean fields before anything is imported.</p>
        <a href="?template=1" class="btn btn-outline-secondary btn-sm mb-3"><i class="fa-solid fa-download me-1"></i>Download Sample Template</a>
        <form method="POST" enctype="multipart/form-data">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="upload">
          <div class="mb-3"><input type="file" name="file" class="form-control" accept=".csv" required></div>
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-upload me-1"></i>Upload</button>
        </form>`;
    } else if (step === 'mapping') {
      content = html`
        <h6 class="fw-bold">Map Columns</h6>
        <p class="text-muted">Match each column from your file to an Urban Dry Clean field. Columns left as "Do not import" are safely skipped — nothing is discarded silently.</p>
        <form method="POST">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="mapping">
          <input type="hidden" name="import_token" value="${token}">
          <table class="table table-sm">
            <thead><tr><th>Your Column</th><th>Maps To</th></tr></thead>
            <tbody>
            ${headers.map((h) => html`
              <tr>
                <td><code>${h}</code></td>
                <td>
                  <select name="map[${h}]" class="form-select form-select-sm">
                    ${Object.entries(IMPORT_TARGET_FIELDS).map(([val, label]) => html`
                      <option value="${val}" ${(guessed[h] ?? '') === val ? 'selected' : ''}>${label}</option>`)}
                  </select>
                </td>
              </tr>`)}
            </tbody>
          </table>
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-arrow-right me-1"></i>Continue to Preview</button>
        </form>`;
    } else if (step === 'preview' && preview) {
      const counts = { create: 0, duplicate: 0, error: 0 };
      for (const r of preview) { if (r.errors.length) counts.error++; else if (r.is_duplicate) counts.duplicate++; else counts.create++; }
      content = html`
        <h6 class="fw-bold">Preview Import</h6>
        <p>
          <span class="badge bg-success">New: ${counts.create}</span>
          <span class="badge bg-warning text-dark">Duplicates found: ${counts.duplicate}</span>
          <span class="badge bg-danger">Errors (will be skipped): ${counts.error}</span>
        </p>
        <div class="table-responsive udc-cards-wrap" style="max-height:400px;overflow-y:auto;">
          <table class="udc-cards table table-sm">
            <thead><tr><th>Line</th><th>Name</th><th>Mobile</th><th>Email</th><th>Status</th></tr></thead>
            <tbody>
            ${preview.map((r) => html`
              <tr class="${r.errors.length ? 'table-danger' : (r.is_duplicate ? 'table-warning' : (r.warnings.length ? 'table-warning' : ''))}">
                <td data-label="Line">${r.line}</td>
                <td data-label="Name">${r.mapped.full_name ?? ''}</td>
                <td data-label="Mobile">${r.mapped.mobile ?? ''}</td>
                <td data-label="Email">${r.mapped.email ?? ''}</td>
                <td data-label="Status">
                  ${r.errors.length ? html`<span class="text-danger small">${r.errors.join(' ')}</span>` : r.is_duplicate ? html`Matches existing "${r.existing_name}" by ${r.matched_on}` : html`New customer`}
                  ${r.warnings.length ? html`<br><span class="text-warning small">${r.warnings.join(' ')}</span>` : ''}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <form method="POST" class="mt-3">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="confirm">
          <input type="hidden" name="import_token" value="${token}">
          <label class="form-label">For the ${counts.duplicate} duplicate(s) found:</label>
          <select name="duplicate_policy" class="form-select mb-3" style="max-width:320px">
            <option value="skip">Skip duplicates (do not modify existing records)</option>
            <option value="update">Update existing records with the imported data</option>
            <option value="create">Create as new customers anyway</option>
          </select>
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-check me-1"></i>Confirm Import</button>
        </form>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}<input type="hidden" name="step" value="cancel"><input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-outline-secondary" type="submit">Cancel</button>
        </form>`;
    } else if (step === 'done' && report) {
      content = html`
        <div class="alert alert-success">
          <h6 class="fw-bold">Import Complete</h6>
          ${report.created} customer(s) created, ${report.updated} updated,
          ${report.skipped} duplicate(s) skipped, ${report.errors} row(s) had errors and were skipped.
        </div>
        <a href="${u('modules/customers/import.php')}" class="btn btn-primary btn-sm">Import Another File</a>
        <a href="${u('modules/customers/list.php')}" class="btn btn-outline-secondary btn-sm">Back to Customers</a>`;
    }
    return layout(ctx, { title: 'Import Customers' }, html`
<div class="col-12">
  <div class="card">
    <div class="card-body">
      ${errors.length ? html`
        <div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html`<li>${er}</li>`)}</ul></div>` : ''}

      ${content}
    </div>
  </div>
</div>
`);
  });
}
