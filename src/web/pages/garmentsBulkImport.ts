import type { FastifyInstance } from 'fastify';
import { phpEmpty } from '../../lib/php.js';
import { WebText, forbiddenPage, webPage, type WebCtx } from '../context.js';
import { csvBody } from '../csv.js';
import { html, raw, type Raw } from '../html.js';
import { importCleanupTemp, importStoreTempUpload, importTempPath, parseCsvFile } from '../importTemp.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const lower = (s: string) => s.toLowerCase();
const VALID_UNITS = ['Pcs', 'Set', 'Kg', 'Pair'];
const REQUIRED = ['Garment ID', 'Garment Code / SKU', 'Garment Name', 'Category', 'Unit', 'Default Service', 'Status', 'Description'];

export function registerGarmentBulkImportPage(app: FastifyInstance) {
  const { db } = app.services;

  /** validate_garment_import_rows(): nothing is written. */
  const validate = async (rows: Record<string, string>[]): Promise<Row[]> => {
    const garmentsById = new Map<number, Row>();
    for (const g of await db.query<Row>('SELECT id, garment_name, sku, category_id, is_active FROM garments')) garmentsById.set(Number(g.id), g);
    const categoriesByName = new Map<string, Row>();
    for (const c of await db.query<Row>('SELECT id, category_name FROM categories WHERE is_active=1')) categoriesByName.set(lower(String(c.category_name).trim()), c);
    const servicesByName = new Map<string, Row>();
    for (const s of await db.query<Row>('SELECT id, service_name FROM services WHERE is_active=1')) servicesByName.set(lower(String(s.service_name).trim()), s);
    const existingNameCat = new Map<string, number>();
    for (const g of await db.query<Row>('SELECT garment_name, category_id, id FROM garments')) existingNameCat.set(lower(String(g.garment_name).trim()) + '|' + g.category_id, Number(g.id));

    const results: Row[] = [];
    const seenIds = new Map<number, number>();
    const seenNameCat = new Map<string, number>();
    rows.forEach((row, i) => {
      const line = i + 2;
      const idRaw = (row['Garment ID'] ?? '').trim(), sku = (row['Garment Code / SKU'] ?? '').trim(), name = (row['Garment Name'] ?? '').trim();
      const categoryName = (row['Category'] ?? '').trim(), unit = (row['Unit'] ?? '').trim(), serviceName = (row['Default Service'] ?? '').trim();
      const statusRaw = (row['Status'] ?? '').trim(), description = (row['Description'] ?? '').trim();
      const rowErrors: string[] = [];
      let garmentId: number | null = null;
      const isNew = idRaw === '';
      if (!isNew) {
        if (!/^[0-9]+$/.test(idRaw) || !garmentsById.has(Number(idRaw))) {
          rowErrors.push(`Garment ID "${idRaw}" does not match any existing garment. Leave Garment ID blank to create a new one instead — never guessed.`);
        } else {
          garmentId = Number(idRaw);
          if (seenIds.has(garmentId)) rowErrors.push(`Duplicate Garment ID: already appears at line ${seenIds.get(garmentId)} in this file.`);
          else seenIds.set(garmentId, line);
        }
      }
      if (name === '') rowErrors.push('Garment Name is required.');
      let category: Row | null = null;
      if (categoryName === '') rowErrors.push('Category is required.');
      else if (!categoriesByName.has(lower(categoryName))) rowErrors.push(`Category "${categoryName}" not found in Categories Master. Categories are never created automatically.`);
      else category = categoriesByName.get(lower(categoryName))!;
      if (unit === '') rowErrors.push('Unit is required.');
      else if (!VALID_UNITS.includes(unit)) rowErrors.push(`Unit "${unit}" is not valid. Must be one of: ${VALID_UNITS.join(', ')}.`);
      let service: Row | null = null;
      if (serviceName !== '') {
        if (!servicesByName.has(lower(serviceName))) rowErrors.push(`Default Service "${serviceName}" not found in Services Master. Services are never created automatically.`);
        else service = servicesByName.get(lower(serviceName))!;
      }
      let isActive = 1;
      if (statusRaw !== '') {
        const sl = lower(statusRaw);
        if (sl === 'active') isActive = 1; else if (sl === 'inactive') isActive = 0;
        else rowErrors.push(`Status "${statusRaw}" is not valid. Must be "Active" or "Inactive".`);
      }
      if (name !== '' && category) {
        const key = lower(name) + '|' + category.id;
        const owner = existingNameCat.get(key) ?? null;
        if (owner !== null && owner !== garmentId) rowErrors.push(`A garment named "${name}" already exists in category "${categoryName}" (Garment ID ${owner}).`);
        else if (seenNameCat.has(key) && seenNameCat.get(key) !== line) rowErrors.push(`Duplicate row: same Garment Name + Category already appears at line ${seenNameCat.get(key)} in this file.`);
        else seenNameCat.set(key, line);
      }
      if (sku !== '') {
        for (const [gid, g] of garmentsById) { if (g.sku === sku && gid !== garmentId) { rowErrors.push(`SKU "${sku}" is already used by Garment ID ${gid}.`); break; } }
      }
      results.push({
        line, garment_id: garmentId, is_new: isNew, sku, garment_name: name, category_name: categoryName, category_id: category?.id ?? null,
        unit, service_name: serviceName, service_id: service?.id ?? null, is_active: isActive, description,
        status: rowErrors.length ? 'error' : (isNew ? 'new' : 'update'), errors: rowErrors,
      });
    });
    return results;
  };

  webPage(app, '/modules/garments/bulk_import', { auth: 'login' }, async (ctx, req) => {
    if (!ctx.can('garment.create') && !ctx.can('garments.manage')) return forbiddenPage(ctx);
    const q = req.query as Record<string, unknown>;
    let step = clean(body(ctx).step ?? q.step ?? 'upload') || 'upload';
    const errors: string[] = [];
    let preview: Row[] | null = null;
    let token = clean(body(ctx).import_token);
    let report: Row | null = null;

    if ('template' in q) {
      const rows = await db.query<Row>(`SELECT g.id, g.sku, g.garment_name, c.category_name, g.unit, s.service_name, g.is_active, g.description FROM garments g
        LEFT JOIN categories c ON c.id = g.category_id LEFT JOIN services s ON s.id = g.default_service_id ORDER BY g.garment_name, c.category_name`);
      const csvRows = rows.map((r) => [r.id, r.sku || '', r.garment_name, r.category_name || '', r.unit, r.service_name || '', r.is_active ? 'Active' : 'Inactive', r.description || '']);
      return new WebText(csvBody(REQUIRED.map((h) => h), csvRows), 200, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="garments-master-template.csv"' });
    }

    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      if (step === 'upload') {
        try {
          token = await importStoreTempUpload(ctx, 'file');
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          const missing = REQUIRED.filter((c) => !parsed.headers.includes(c));
          if (missing.length) {
            await importCleanupTemp(ctx, token);
            errors.push(`Missing required column(s): ${missing.join(', ')}. Please use the downloaded template and do not rename its columns.`);
            step = 'upload';
          } else if (parsed.rows.length === 0) {
            await importCleanupTemp(ctx, token);
            errors.push('The file has no data rows.');
            step = 'upload';
          } else { preview = await validate(parsed.rows); step = 'preview'; }
        } catch (e) { errors.push('IMPORT ERROR: ' + (e as Error).message); step = 'upload'; }
      } else if (step === 'confirm') {
        try {
          const parsed = await parseCsvFile(importTempPath(ctx, token));
          preview = await validate(parsed.rows);
          if (preview.some((r) => r.status === 'error')) {
            errors.push('Import blocked: this file still has row errors. Fix them and re-upload — no rows were changed.');
            step = 'preview';
          } else {
            let created = 0, updated = 0;
            const userId = ctx.data.user_id ?? null;
            await db.tx(async (t) => {
              const audit = ctx.svc.audit.using(t);
              for (const row of preview!) {
                if (row.is_new) {
                  const r = await t.execute('INSERT INTO garments (garment_name, sku, category_id, default_service_id, unit, description, is_active) VALUES (?,?,?,?,?,?,?)',
                    [row.garment_name, phpEmpty(row.sku) ? null : row.sku, row.category_id, row.service_id, row.unit, row.description, row.is_active]);
                  await audit.record({ action: 'create', module: 'garments', recordId: String(r.insertId), newValue: row, userId, ip: req.ip });
                  created++;
                } else {
                  const oldRow = (await t.query<Row>('SELECT * FROM garments WHERE id = ?', [row.garment_id]))[0];
                  await t.execute('UPDATE garments SET garment_name=?, sku=?, category_id=?, default_service_id=?, unit=?, description=?, is_active=? WHERE id=?',
                    [row.garment_name, phpEmpty(row.sku) ? null : row.sku, row.category_id, row.service_id, row.unit, row.description, row.is_active, row.garment_id]);
                  await audit.record({ action: 'edit', module: 'garments', recordId: String(row.garment_id), oldValue: oldRow, newValue: row, userId, ip: req.ip });
                  updated++;
                }
              }
            });
            await importCleanupTemp(ctx, token);
            report = { created, updated };
            step = 'done';
          }
        } catch (e) { errors.push('Import failed, no changes were made: ' + (e as Error).message); step = 'upload'; }
      } else if (step === 'cancel') {
        await importCleanupTemp(ctx, token);
        step = 'upload';
      }
    }

    const u = (p: string) => ctx.baseUrl(p);
    let content: Raw | string = '';
    if (step === 'upload') {
      content = html`
        <h6 class="fw-bold">Import Garments</h6>
        <p class="text-muted">Blank Garment ID creates a new garment. An existing Garment ID updates that exact record. Category and Default Service must already exist — this never creates them. Nothing is changed until you review the preview and confirm.</p>
        <a href="?template=1" class="btn btn-outline-secondary btn-sm mb-3"><i class="fa-solid fa-download me-1"></i>Download CSV Template</a>
        <form method="POST" enctype="multipart/form-data">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="upload">
          <div class="mb-3"><input type="file" name="file" class="form-control" accept=".csv" required></div>
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-upload me-1"></i>Upload &amp; Validate</button>
        </form>`;
    } else if (step === 'preview' && preview !== null) {
      const counts = { new: 0, update: 0, error: 0 } as Record<string, number>;
      for (const r of preview) counts[r.status]!++;
      const validCount = counts.new! + counts.update!;
      const hasErrors = counts.error! > 0;
      content = html`
        <h6 class="fw-bold">Import Preview</h6>
        <p>
          <span class="badge bg-success">${counts.new} new</span>
          <span class="badge bg-primary">${counts.update} update</span>
          <span class="badge bg-danger">${counts.error} errors</span>
        </p>
        ${hasErrors ? html`<div class="alert alert-danger">This file has ${counts.error} row error(s). <strong>No rows can be imported until every error is fixed</strong> — all-or-nothing import.</div>` : ''}
        <div class="table-responsive udc-cards-wrap" style="max-height:420px;overflow-y:auto;">
          <table class="udc-cards table table-sm">
            <thead><tr><th>Line</th><th>ID</th><th>Name</th><th>Category</th><th>SKU</th><th>Unit</th><th>Service</th><th>Status</th></tr></thead>
            <tbody>
            ${preview.map((r) => html`
              <tr class="${r.status === 'error' ? 'table-danger' : ''}">
                <td data-label="Line">${r.line}</td>
                <td data-label="ID">${r.garment_id ?? '(new)'}</td>
                <td data-label="Name">${r.garment_name}</td>
                <td data-label="Category">${r.category_name}</td>
                <td data-label="SKU">${r.sku !== '' && r.sku !== '0' ? r.sku : '—'}</td>
                <td data-label="Unit">${r.unit}</td>
                <td data-label="Service">${r.service_name !== '' && r.service_name !== '0' ? r.service_name : '—'}</td>
                <td data-label="Status">
                  ${r.status === 'error' ? html`<span class="badge bg-danger">Error</span> <span class="small text-danger">${r.errors.join(' ')}</span>`
                    : r.status === 'new' ? html`<span class="badge bg-success">New</span>` : html`<span class="badge bg-primary">Update</span>`}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="confirm">
          <input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-primary" type="submit" ${(hasErrors || validCount === 0) ? 'disabled' : ''}>
            <i class="fa-solid fa-check me-1"></i>Confirm Import (${validCount} rows)
          </button>
        </form>
        <a href="?" class="btn btn-outline-secondary">Back to Upload</a>
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
          ${report.created} garment(s) created, ${report.updated} updated.
        </div>
        <a href="?" class="btn btn-primary btn-sm">Import Another File</a>
        <a href="${u('modules/garments/list.php')}" class="btn btn-outline-secondary btn-sm">Back to Garments</a>`;
    }
    return layout(ctx, { title: 'Bulk Import Garments' }, html`
<div class="col-12 d-flex justify-content-between align-items-start flex-wrap gap-2">
  <div><h4 class="mb-0">Bulk Import Garments</h4></div>
  <a href="${u('modules/garments/list.php')}" class="btn btn-outline-secondary btn-sm">Back to Garments</a>
</div>

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
  void raw;
}
