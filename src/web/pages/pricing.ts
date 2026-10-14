import type { FastifyInstance } from 'fastify';
import { isNumeric, phpEmpty, toFloat } from '../../lib/php.js';
import { WebRedirect, WebText, forbiddenPage, webPage, type WebCtx } from '../context.js';
import { csvBody } from '../csv.js';
import { int } from '../format.js';
import { html, raw, type Raw } from '../html.js';
import { importCleanupTemp, importStoreTempUpload, importTempPath, parseCsvFile } from '../importTemp.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplPricelistBulkUpdate } from '../tpl/pricelist_bulk_update.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);

export function registerPricingPages(app: FastifyInstance) {
  const { db } = app.services;

  // ---- pricelist/bulk_update (UI over api/price_list_items bulk_*) ---------------------------------
  webPage(app, '/modules/pricelist/bulk_update', { auth: 'login' }, async (ctx, req) => {
    if (!ctx.can('pricing.edit') && !ctx.can('pricelist.manage')) return forbiddenPage(ctx);
    const id = int((req.query as Record<string, unknown>).id);
    const priceList = (await db.query<Row>('SELECT * FROM price_lists WHERE id = ?', [id]))[0];
    if (!priceList) { ctx.flashSet('danger', 'Price list not found.'); return new WebRedirect('modules/pricelist/list.php'); }
    const garments = await db.query<Row>('SELECT g.id, g.garment_name, g.category_id, c.category_name FROM garments g LEFT JOIN categories c ON c.id = g.category_id WHERE g.is_active=1 ORDER BY g.garment_name, g.id');
    const services = await db.query<Row>('SELECT id, service_name, billing_unit FROM services WHERE is_active=1 ORDER BY sort_order, id');
    const categories = await db.query<Row>('SELECT id, category_name FROM categories WHERE is_active=1 ORDER BY sort_order, id');
    const nameCounts: Record<string, number> = {};
    for (const g of garments) nameCounts[g.garment_name] = (nameCounts[g.garment_name] ?? 0) + 1;
    const garmentDisplayLabel = (g: Row, counts: Record<string, number>): string => {
      let label = g.garment_name as string;
      if ((counts[g.garment_name] ?? 1) > 1) label += ' (' + (g.category_name || 'Uncategorized') + ')';
      return label;
    };
    const h = await tplHelpers(ctx, { garmentDisplayLabel });
    return layout(ctx, { title: 'Bulk Update: ' + priceList.price_list_name }, raw(tplPricelistBulkUpdate({ categories, garments, id, nameCounts, priceList, services }, h)));
  });

  // ---- pricing/bulk_update (CSV) -----------------------------------------------------------------
  const validateRows = async (rows: Record<string, string>[]): Promise<Row[]> => {
    const results: Row[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const line = i + 2;
      const garmentName = (row.garment ?? '').trim(), serviceName = (row.service ?? '').trim(), priceListName = (row.price_list ?? '').trim();
      const pieceRateRaw = (row.piece_rate ?? '').trim(), weightRateRaw = (row.weight_rate ?? '').trim(), minChargeRaw = (row.min_weight_charge ?? '').trim();
      const rowErrors: string[] = [];
      if (garmentName === '') rowErrors.push('Garment is required.');
      if (serviceName === '') rowErrors.push('Service is required.');
      if (priceListName === '') rowErrors.push('Price list is required.');
      if (pieceRateRaw === '' || !isNumeric(pieceRateRaw) || toFloat(pieceRateRaw) < 0) rowErrors.push('Piece rate must be a non-negative number (use 0, not blank, if not applicable).');
      if (weightRateRaw !== '' && (!isNumeric(weightRateRaw) || toFloat(weightRateRaw) < 0)) rowErrors.push('Weight rate must be blank or a non-negative number.');
      if (minChargeRaw !== '' && (!isNumeric(minChargeRaw) || toFloat(minChargeRaw) < 0)) rowErrors.push('Minimum weight charge must be blank or a non-negative number.');
      let garmentId: any = null, serviceId: any = null, priceListId: any = null;
      if (!rowErrors.length) {
        garmentId = (await db.query<Row>('SELECT id FROM garments WHERE sku = ? LIMIT 1', [garmentName]))[0]?.id ?? false;
        if (!garmentId) garmentId = (await db.query<Row>('SELECT id FROM garments WHERE garment_name = ? LIMIT 1', [garmentName]))[0]?.id ?? false;
        if (!garmentId) rowErrors.push(`Garment "${garmentName}" not found (matched by SKU or exact name).`);
        serviceId = (await db.query<Row>('SELECT id FROM services WHERE service_name = ? LIMIT 1', [serviceName]))[0]?.id ?? false;
        if (!serviceId) rowErrors.push(`Service "${serviceName}" not found.`);
        priceListId = (await db.query<Row>('SELECT id FROM price_lists WHERE price_list_name = ? LIMIT 1', [priceListName]))[0]?.id ?? false;
        if (!priceListId) rowErrors.push(`Price list "${priceListName}" not found.`);
      }
      let status = 'error';
      let existing: Row | null = null;
      if (!rowErrors.length) {
        existing = (await db.query<Row>('SELECT id, piece_rate, weight_rate, min_weight_charge FROM price_list_items WHERE price_list_id=? AND garment_id=? AND service_id=?', [priceListId, garmentId, serviceId]))[0] ?? null;
        if (!existing) status = 'insert';
        else {
          const newWeight = weightRateRaw === '' ? null : toFloat(weightRateRaw);
          const newMin = minChargeRaw === '' ? null : toFloat(minChargeRaw);
          const unchanged = Math.abs(toFloat(existing.piece_rate) - toFloat(pieceRateRaw)) < 0.001
            && toFloat(existing.weight_rate ?? 0) === toFloat(newWeight ?? 0) && toFloat(existing.min_weight_charge ?? 0) === toFloat(newMin ?? 0);
          status = unchanged ? 'unchanged' : 'update';
        }
      }
      results.push({
        line, garment: garmentName, service: serviceName, price_list: priceListName, piece_rate: pieceRateRaw, weight_rate: weightRateRaw, min_weight_charge: minChargeRaw,
        garment_id: garmentId, service_id: serviceId, price_list_id: priceListId, existing_id: existing?.id ?? null, status, errors: rowErrors,
      });
    }
    return results;
  };

  webPage(app, '/modules/pricing/bulk_update', { auth: 'pricing.bulk_update' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    let step = clean(body(ctx).step ?? q.step ?? 'upload') || 'upload';
    const errors: string[] = [];
    let preview: Row[] | null = null;
    let token = clean(body(ctx).import_token);
    let report: Row | null = null;
    if ('template' in q) {
      return new WebText(csvBody(['garment', 'service', 'price_list', 'piece_rate', 'weight_rate', 'min_weight_charge'],
        [['T Shirt', 'Dry Cleaning', 'Default Price List', '100.00', '', ''], ['Bedsheet (Double)', 'Laundry', 'Default Price List', '0.00', '80.00', '150.00']]),
      200, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="urban_dry_clean_price_template.csv"' });
    }
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      if (step === 'upload') {
        try {
          token = await importStoreTempUpload(ctx, 'file');
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          const missing = ['garment', 'service', 'price_list', 'piece_rate'].filter((c) => !parsed.headers.includes(c));
          if (missing.length) { await importCleanupTemp(ctx, token); errors.push(`Missing required column(s): ${missing.join(', ')}. Please use the provided template.`); step = 'upload'; }
          else if (parsed.rows.length === 0) { await importCleanupTemp(ctx, token); errors.push('The file has no data rows.'); step = 'upload'; }
          else { preview = await validateRows(parsed.rows); step = 'preview'; }
        } catch (e) { errors.push((e as Error).message); step = 'upload'; }
      } else if (step === 'confirm') {
        try {
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          preview = await validateRows(parsed.rows);
          let inserted = 0, updated = 0, skippedErrors = 0, skippedUnchanged = 0;
          const userId = ctx.data.user_id ?? null;
          await db.tx(async (t) => {
            const audit = ctx.svc.audit.using(t);
            for (const row of preview!) {
              if (row.status === 'error') { skippedErrors++; continue; }
              if (row.status === 'unchanged') { skippedUnchanged++; continue; }
              const weightVal = row.weight_rate === '' ? null : toFloat(row.weight_rate);
              const minVal = row.min_weight_charge === '' ? null : toFloat(row.min_weight_charge);
              if (row.status === 'insert') {
                const r = await t.execute('INSERT INTO price_list_items (price_list_id, garment_id, service_id, piece_rate, weight_rate, min_weight_charge, is_active) VALUES (?,?,?,?,?,?,1)', [row.price_list_id, row.garment_id, row.service_id, toFloat(row.piece_rate), weightVal, minVal]);
                await audit.record({ action: 'create', module: 'pricelist', recordId: String(r.insertId), newValue: row, userId, ip: req.ip });
                inserted++;
              } else {
                await t.execute('UPDATE price_list_items SET piece_rate=?, weight_rate=?, min_weight_charge=? WHERE id=?', [toFloat(row.piece_rate), weightVal, minVal, row.existing_id]);
                await audit.record({ action: 'edit', module: 'pricelist', recordId: String(row.existing_id), newValue: row, userId, ip: req.ip });
                updated++;
              }
            }
          });
          await importCleanupTemp(ctx, token);
          await ctx.svc.audit.record({ action: 'edit', module: 'pricelist', recordId: 'bulk_import', newValue: { inserted, updated, skipped_errors: skippedErrors }, userId: ctx.data.user_id ?? null, ip: req.ip });
          report = { inserted, updated, skipped_errors: skippedErrors, skipped_unchanged: skippedUnchanged };
          step = 'done';
        } catch (e) { errors.push('Import failed, no changes were made: ' + (e as Error).message); step = 'upload'; }
      } else if (step === 'cancel') { await importCleanupTemp(ctx, token); step = 'upload'; }
    }
    const u = (p: string) => ctx.baseUrl(p);
    let content: Raw | string = '';
    if (step === 'upload') {
      content = html`
        <h6 class="fw-bold">Bulk Price Update</h6>
        <p class="text-muted">Upload a CSV to insert or update multiple prices at once. Nothing is changed until you review and confirm.</p>
        <a href="?template=1" class="btn btn-outline-secondary btn-sm mb-3"><i class="fa-solid fa-download me-1"></i>Download Template</a>
        <form method="POST" enctype="multipart/form-data">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="upload">
          <div class="mb-3">
            <input type="file" name="file" class="form-control" accept=".csv" required>
          </div>
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-upload me-1"></i>Upload & Preview</button>
        </form>`;
    } else if (step === 'preview' && preview !== null) {
      const counts: Record<string, number> = { insert: 0, update: 0, unchanged: 0, error: 0 };
      for (const r of preview) counts[r.status]!++;
      const changes = counts.insert! + counts.update!;
      content = html`
        <h6 class="fw-bold">Preview Changes</h6>
        <p>
          <span class="badge bg-success">New: ${counts.insert}</span>
          <span class="badge bg-primary">Update: ${counts.update}</span>
          <span class="badge bg-secondary">Unchanged: ${counts.unchanged}</span>
          <span class="badge bg-danger">Errors: ${counts.error}</span>
        </p>
        <div class="table-responsive udc-cards-wrap" style="max-height:420px;overflow-y:auto;">
          <table class="udc-cards table table-sm">
            <thead><tr><th>Line</th><th>Garment</th><th>Service</th><th>Price List</th><th class="text-end">Piece</th><th class="text-end">Weight</th><th class="text-end">Min Charge</th><th>Status</th></tr></thead>
            <tbody>
            ${preview.map((r) => html`
              <tr class="${r.status === 'error' ? 'table-danger' : ''}">
                <td data-label="Line">${r.line}</td>
                <td data-label="Garment">${r.garment}</td>
                <td data-label="Service">${r.service}</td>
                <td data-label="Price List">${r.price_list}</td>
                <td class="text-end" data-label="Piece">${r.piece_rate}</td>
                <td class="text-end" data-label="Weight">${r.weight_rate}</td>
                <td class="text-end" data-label="Min Charge">${r.min_weight_charge}</td>
                <td data-label="Status">
                  ${r.status === 'error' ? html`<span class="badge bg-danger" title="${r.errors.join(' ')}">Error</span> <span class="small text-danger">${r.errors.join(' ')}</span>`
                    : r.status === 'insert' ? html`<span class="badge bg-success">New</span>`
                    : r.status === 'update' ? html`<span class="badge bg-primary">Update</span>` : html`<span class="badge bg-secondary">Unchanged</span>`}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <p class="text-muted small">Rows marked "Error" will be skipped automatically; rows marked "Unchanged" will not trigger an update. Only "New" and "Update" rows will be written.</p>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="confirm">
          <input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-primary" type="submit" ${changes === 0 ? 'disabled' : ''}><i class="fa-solid fa-check me-1"></i>Confirm Import (${changes} changes)</button>
        </form>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="cancel">
          <input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-outline-secondary" type="submit">Cancel</button>
        </form>`;
    } else if (step === 'done' && report) {
      content = html`
        <div class="alert alert-success">
          <h6 class="fw-bold">Import Complete</h6>
          ${report.inserted} new price(s) added, ${report.updated} updated,
          ${report.skipped_unchanged} unchanged (skipped), ${report.skipped_errors} error row(s) skipped.
        </div>
        <a href="${u('modules/pricing/bulk_update.php')}" class="btn btn-primary btn-sm">Import Another File</a>
        <a href="${u('modules/pricelist/list.php')}" class="btn btn-outline-secondary btn-sm">Back to Price Lists</a>`;
    }
    return layout(ctx, { title: 'Bulk Price Update' }, html`
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
  void phpEmpty;
}
