import { isNumeric, phpRound, toFloat } from '../../lib/php.js';
import { WebRedirect, WebText, forbiddenPage, webPage } from '../context.js';
import { csvBody } from '../csv.js';
import { int } from '../format.js';
import { html } from '../html.js';
import { importCleanupTemp, importStoreTempUpload, importTempPath, parseCsvFile } from '../importTemp.js';
import { layout } from '../layout.js';
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => str(v).trim();
const body = (ctx) => (ctx.req.body ?? {});
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const lower = (s) => s.toLowerCase();
const truthy = (v) => v !== null && v !== undefined && v !== '' && v !== '0' && v !== 0 && v !== false;
const dash = (v) => (v !== '' && v !== '0' ? v : '—');
const fixed2 = (n) => phpRound(n, 2).toFixed(2);
const REQUIRED = ['Rate Type', 'Garment ID', 'Garment Code / SKU', 'Garment Name', 'Category', 'Service', 'Billing Unit', 'Piece Rate', 'Weight Rate', 'Tax', 'Status'];
export function registerPricelistImportPage(app) {
    const { db } = app.services;
    /** validate_import_rows(): nothing is written. */
    const validate = async (priceListId, rows) => {
        const garmentsById = new Map(), garmentsBySku = new Map(), garmentsByNameCategory = new Map();
        const garmentNameCount = new Map(), garmentsByNameOnly = new Map();
        for (const g of await db.query('SELECT g.id, g.garment_name, g.sku, g.category_id, c.category_name FROM garments g LEFT JOIN categories c ON c.id=g.category_id WHERE g.is_active=1')) {
            garmentsById.set(Number(g.id), g);
            if (g.sku !== null && g.sku !== '')
                garmentsBySku.set(String(g.sku), g);
            garmentsByNameCategory.set(lower(String(g.garment_name).trim()) + '|' + lower(String(g.category_name ?? '').trim()), g);
            const nameKey = lower(String(g.garment_name).trim());
            garmentNameCount.set(nameKey, (garmentNameCount.get(nameKey) ?? 0) + 1);
            garmentsByNameOnly.set(nameKey, g);
        }
        const servicesByName = new Map();
        for (const s of await db.query('SELECT id, service_name, billing_unit, pricing_scope FROM services WHERE is_active=1'))
            servicesByName.set(lower(String(s.service_name).trim()), s);
        const taxesByName = new Map();
        for (const t of await db.query('SELECT id, tax_name FROM taxes WHERE is_active=1'))
            taxesByName.set(lower(String(t.tax_name).trim()), t.id);
        const results = [];
        const seen = new Map();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const line = i + 2;
            const rateType = (row['Rate Type'] ?? '').trim().toUpperCase();
            const garmentIdRaw = (row['Garment ID'] ?? '').trim(), code = (row['Garment Code / SKU'] ?? '').trim(), name = (row['Garment Name'] ?? '').trim();
            const category = (row['Category'] ?? '').trim(), serviceName = (row['Service'] ?? '').trim(), billingUnitInFile = lower((row['Billing Unit'] ?? '').trim());
            const pieceRateRaw = (row['Piece Rate'] ?? '').trim(), weightRateRaw = (row['Weight Rate'] ?? '').trim(), taxName = (row['Tax'] ?? '').trim();
            const rowErrors = [];
            if (!['GARMENT', 'SERVICE'].includes(rateType)) {
                rowErrors.push(`Rate Type must be exactly "GARMENT" or "SERVICE" — found "${row['Rate Type'] ?? ''}".`);
                results.push({ line, rate_type: 'ERROR', garment_code: code, garment_name: name, category, service: serviceName, billing_unit: null, old_rate: null, new_rate: null, rate_column: null, garment_id: null, service_id: null, tax_id: null, existing_id: null, status: 'error', errors: rowErrors });
                continue;
            }
            let service = null;
            if (serviceName === '')
                rowErrors.push('Service is required.');
            else if (!servicesByName.has(lower(serviceName)))
                rowErrors.push(`Service "${serviceName}" not found in Services Master.`);
            else {
                service = servicesByName.get(lower(serviceName));
                if (rateType === 'GARMENT' && service.pricing_scope !== 'garment')
                    rowErrors.push(`${service.service_name} is a universal (all-garment) service — use a SERVICE row for it, not GARMENT.`);
                else if (rateType === 'SERVICE' && service.pricing_scope !== 'universal')
                    rowErrors.push(`${service.service_name} is a garment-specific service — use a GARMENT row for it, not SERVICE.`);
                if (billingUnitInFile !== '' && billingUnitInFile !== service.billing_unit && !(billingUnitInFile === 'pc' && service.billing_unit === 'piece') && !(billingUnitInFile === 'kg' && service.billing_unit === 'weight')) {
                    rowErrors.push(`Billing Unit "${row['Billing Unit']}" does not match this service's actual billing unit (${service.billing_unit}). The spreadsheet value is not trusted over the master data.`);
                }
            }
            let taxId = null;
            if (taxName !== '') {
                const tk = lower(taxName);
                if (taxesByName.has(tk))
                    taxId = taxesByName.get(tk);
                else
                    rowErrors.push(`Tax "${taxName}" not found.`);
            }
            let status = 'error';
            let rateColumn = null, newRate = null, oldRate = null, existingId = null;
            if (rateType === 'SERVICE') {
                if (service) {
                    const ck = 'S:' + service.id;
                    if (seen.has(ck))
                        rowErrors.push(`Duplicate row: same Service already appears at line ${seen.get(ck)} in this file.`);
                    else
                        seen.set(ck, line);
                }
                if (!rowErrors.length && service) {
                    rateColumn = 'weight_rate';
                    const existing = (await db.query('SELECT id, weight_rate FROM price_list_service_rates WHERE price_list_id=? AND service_id=?', [priceListId, service.id]))[0] ?? null;
                    existingId = existing?.id ?? null;
                    oldRate = existing ? toFloat(existing.weight_rate) : null;
                    if (weightRateRaw === '' || lower(weightRateRaw) === 'not configured')
                        status = 'skip';
                    else if (!isNumeric(weightRateRaw) || toFloat(weightRateRaw) < 0)
                        rowErrors.push('Weight Rate must be a valid non-negative number, or left blank/"Not Configured" to skip this row.');
                    else {
                        newRate = phpRound(toFloat(weightRateRaw), 2);
                        if (!existing)
                            status = 'insert';
                        else if ((oldRate === null || oldRate <= 0) && newRate > 0)
                            status = 'insert_over_unconfigured';
                        else if (Math.abs((oldRate ?? 0) - newRate) < 0.005)
                            status = 'unchanged';
                        else
                            status = 'update';
                    }
                }
                if (rowErrors.length)
                    status = 'error';
                results.push({
                    line, rate_type: 'SERVICE', garment_code: '', garment_name: '', category: '', service: service?.service_name ?? serviceName, billing_unit: service?.billing_unit ?? null,
                    old_rate: oldRate, new_rate: newRate, rate_column: rateColumn, garment_id: null, service_id: service?.id ?? null, tax_id: taxId, existing_id: existingId, status, errors: rowErrors,
                });
                continue;
            }
            let garment = null;
            if (garmentIdRaw !== '') {
                if (/^[0-9]+$/.test(garmentIdRaw) && garmentsById.has(Number(garmentIdRaw)))
                    garment = garmentsById.get(Number(garmentIdRaw));
                else
                    rowErrors.push(`Garment ID "${garmentIdRaw}" does not match any existing active garment. Never guessed from Name/SKU when an ID is given but invalid.`);
            }
            else if (code !== '' && garmentsBySku.has(code))
                garment = garmentsBySku.get(code);
            else if (name !== '') {
                const key = lower(name) + '|' + lower(category);
                if (garmentsByNameCategory.has(key))
                    garment = garmentsByNameCategory.get(key);
                else {
                    const nk = lower(name);
                    const cnt = garmentNameCount.get(nk) ?? 0;
                    if (cnt === 1)
                        garment = garmentsByNameOnly.get(nk);
                    else if (cnt > 1)
                        rowErrors.push(`"${name}" is ambiguous (matches multiple garments). Use the Garment ID or Garment Code column to specify exactly which one.`);
                    else
                        rowErrors.push(`Garment "${name}" not found in Garments Master.`);
                }
            }
            else
                rowErrors.push('Garment ID, Garment Code, or Garment Name is required.');
            if (garment && service) {
                const ck = `G:${garment.id}:${service.id}`;
                if (seen.has(ck))
                    rowErrors.push(`Duplicate row: same Garment + Service already appears at line ${seen.get(ck)} in this file.`);
                else
                    seen.set(ck, line);
            }
            if (!rowErrors.length && service) {
                rateColumn = service.billing_unit === 'weight' ? 'weight_rate' : 'piece_rate';
                const relevantRaw = rateColumn === 'weight_rate' ? weightRateRaw : pieceRateRaw;
                const existing = (await db.query('SELECT id, piece_rate, weight_rate FROM price_list_items WHERE price_list_id=? AND garment_id=? AND service_id=?', [priceListId, garment.id, service.id]))[0] ?? null;
                existingId = existing?.id ?? null;
                oldRate = existing ? toFloat(existing[rateColumn]) : null;
                if (relevantRaw === '' || lower(relevantRaw) === 'not configured')
                    status = 'skip';
                else if (!isNumeric(relevantRaw) || toFloat(relevantRaw) < 0) {
                    const label = rateColumn.replace('_', ' ');
                    rowErrors.push(label.charAt(0).toUpperCase() + label.slice(1) + ' must be a valid non-negative number, or left blank/"Not Configured" to skip this row.');
                }
                else {
                    newRate = phpRound(toFloat(relevantRaw), 2);
                    if (!existing)
                        status = 'insert';
                    else if ((oldRate === null || oldRate <= 0) && newRate > 0)
                        status = 'insert_over_unconfigured';
                    else if (Math.abs((oldRate ?? 0) - newRate) < 0.005)
                        status = 'unchanged';
                    else
                        status = 'update';
                }
            }
            if (rowErrors.length)
                status = 'error';
            results.push({
                line, rate_type: 'GARMENT', garment_code: code, garment_name: garment?.garment_name ?? name, category: garment ? (garment.category_name ?? category) : category,
                service: service?.service_name ?? serviceName, billing_unit: service?.billing_unit ?? null, old_rate: oldRate, new_rate: newRate, rate_column: rateColumn,
                garment_id: garment?.id ?? null, service_id: service?.id ?? null, tax_id: taxId, existing_id: existingId, status, errors: rowErrors,
            });
        }
        return results;
    };
    webPage(app, '/modules/pricelist/import', { auth: 'login' }, async (ctx, req) => {
        if (!ctx.can('pricing.edit') && !ctx.can('pricelist.manage'))
            return forbiddenPage(ctx);
        const q = req.query;
        const priceListId = int(q.id ?? body(ctx).price_list_id);
        const priceList = (await db.query('SELECT * FROM price_lists WHERE id = ?', [priceListId]))[0];
        if (!priceList) {
            ctx.flashSet('danger', 'Price list not found.');
            return new WebRedirect('modules/pricelist/list.php');
        }
        let step = clean(body(ctx).step ?? q.step ?? 'upload') || 'upload';
        const errors = [];
        let preview = null;
        let token = clean(body(ctx).import_token);
        let report = null;
        if ('template' in q) {
            const garmentRows = await db.query(`SELECT g.id AS garment_id, g.sku, g.garment_name, c.category_name, s.service_name, s.billing_unit, pli.piece_rate, pli.weight_rate, t.tax_name
         FROM garments g CROSS JOIN services s LEFT JOIN categories c ON c.id = g.category_id
         LEFT JOIN price_list_items pli ON pli.price_list_id = ? AND pli.garment_id = g.id AND pli.service_id = s.id LEFT JOIN taxes t ON t.id = pli.tax_id
         WHERE g.is_active = 1 AND s.is_active = 1 AND s.pricing_scope = 'garment' ORDER BY g.garment_name, s.service_name`, [priceListId]);
            const csvRows = [];
            for (const r of garmentRows) {
                const rateCol = r.billing_unit === 'weight' ? 'weight_rate' : 'piece_rate';
                const rateVal = r[rateCol] !== null ? toFloat(r[rateCol]) : null;
                const rateDisplay = rateVal !== null && rateVal > 0 ? fixed2(rateVal) : 'Not Configured';
                csvRows.push(['GARMENT', r.garment_id, truthy(r.sku) ? r.sku : '', r.garment_name, truthy(r.category_name) ? r.category_name : '', r.service_name, r.billing_unit === 'weight' ? 'weight' : 'piece',
                    r.billing_unit === 'piece' ? rateDisplay : '', r.billing_unit === 'weight' ? rateDisplay : '', truthy(r.tax_name) ? r.tax_name : '', 'Active']);
            }
            const serviceRows = await db.query(`SELECT s.service_name, s.billing_unit, plsr.weight_rate, t.tax_name FROM services s
         LEFT JOIN price_list_service_rates plsr ON plsr.price_list_id = ? AND plsr.service_id = s.id LEFT JOIN taxes t ON t.id = plsr.tax_id
         WHERE s.is_active = 1 AND s.pricing_scope = 'universal' ORDER BY s.service_name`, [priceListId]);
            for (const r of serviceRows) {
                const rateVal = r.weight_rate !== null ? toFloat(r.weight_rate) : null;
                const rateDisplay = rateVal !== null && rateVal > 0 ? fixed2(rateVal) : 'Not Configured';
                csvRows.push(['SERVICE', '', '', '', '', r.service_name, 'weight', '', rateDisplay, truthy(r.tax_name) ? r.tax_name : '', 'Active']);
            }
            return new WebText(csvBody(['Rate Type', 'Garment ID', 'Garment Code / SKU', 'Garment Name', 'Category', 'Service', 'Billing Unit', 'Piece Rate', 'Weight Rate', 'Tax', 'Status'], csvRows), 200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="price-list-${String(priceList.price_list_name).replace(/[^a-z0-9]+/gi, '-')}-template.csv"` });
        }
        if ('error_report' in q && truthy(q.import_token)) {
            const reportToken = clean(q.import_token);
            try {
                const parsed = await parseCsvFile(importTempPath(ctx, reportToken));
                const pv = await validate(priceListId, parsed.rows);
                const errorRows = pv.filter((r) => r.status === 'error').map((r) => [r.line, r.garment_code, r.garment_name, r.category, r.service, r.errors.join(' ')]);
                return new WebText(csvBody(['Line', 'Garment Code', 'Garment Name', 'Category', 'Service', 'Error'], errorRows), 200, 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="import-errors.csv"' });
            }
            catch (e) {
                ctx.flashSet('danger', 'Could not generate the error report: ' + e.message);
                return new WebRedirect('modules/pricelist/import.php?id=' + priceListId);
            }
        }
        if (req.method === 'POST') {
            if (!ctx.csrfValid())
                return csrfFail();
            if (step === 'upload') {
                const hasField = ctx.fileParts.some((f) => f.field === 'file');
                if (!hasField)
                    errors.push('UPLOAD ERROR: n/a');
                else if (!ctx.files.file)
                    errors.push('UPLOAD ERROR: No file was uploaded.');
                else {
                    try {
                        token = await importStoreTempUpload(ctx, 'file');
                        const parsed = await parseCsvFile(importTempPath(ctx, token));
                        const missing = REQUIRED.filter((c) => !parsed.headers.includes(c));
                        if (missing.length) {
                            await importCleanupTemp(ctx, token);
                            errors.push(`Missing required column(s): ${missing.join(', ')}. Please use the downloaded template and do not rename its columns.`);
                            step = 'upload';
                        }
                        else if (parsed.rows.length === 0) {
                            await importCleanupTemp(ctx, token);
                            errors.push('The file has no data rows.');
                            step = 'upload';
                        }
                        else {
                            preview = await validate(priceListId, parsed.rows);
                            step = 'preview';
                        }
                    }
                    catch (e) {
                        errors.push('IMPORT PHP ERROR: ' + e.message);
                        step = 'upload';
                    }
                }
            }
            else if (step === 'confirm') {
                try {
                    const parsed = await parseCsvFile(importTempPath(ctx, token));
                    preview = await validate(priceListId, parsed.rows);
                    if (preview.some((r) => r.status === 'error')) {
                        errors.push('Import blocked: this file still has row errors. Fix them and re-upload — no rows were changed.');
                        step = 'preview';
                    }
                    else {
                        let inserted = 0, updated = 0, skipped = 0;
                        const userId = ctx.data.user_id ?? null;
                        await db.tx(async (t) => {
                            const audit = ctx.svc.audit.using(t);
                            const rec = (a, rid, row) => audit.record({ action: a, module: 'pricelist', recordId: rid, newValue: row, userId, ip: req.ip });
                            for (const row of preview) {
                                if (row.status === 'skip' || row.status === 'unchanged') {
                                    skipped++;
                                    continue;
                                }
                                if (row.rate_type === 'SERVICE') {
                                    if (truthy(row.existing_id)) {
                                        await t.execute('UPDATE price_list_service_rates SET weight_rate=?, tax_id=? WHERE id=?', [row.new_rate, row.tax_id, row.existing_id]);
                                        await rec('edit', 'universal-' + row.existing_id, row);
                                    }
                                    else {
                                        const r = await t.execute('INSERT INTO price_list_service_rates (price_list_id, service_id, weight_rate, tax_id, is_active) VALUES (?,?,?,?,1)', [priceListId, row.service_id, row.new_rate, row.tax_id]);
                                        await rec('create', 'universal-' + r.insertId, row);
                                    }
                                    inserted++;
                                    continue;
                                }
                                const pieceVal = row.rate_column === 'piece_rate' ? row.new_rate : 0;
                                const weightVal = row.rate_column === 'weight_rate' ? row.new_rate : null;
                                if (row.status === 'insert' || row.status === 'insert_over_unconfigured') {
                                    if (truthy(row.existing_id)) {
                                        await t.execute('UPDATE price_list_items SET piece_rate=?, weight_rate=?, tax_id=? WHERE id=?', [pieceVal, weightVal, row.tax_id, row.existing_id]);
                                        await rec('edit', String(row.existing_id), row);
                                    }
                                    else {
                                        const r = await t.execute('INSERT INTO price_list_items (price_list_id, garment_id, service_id, piece_rate, weight_rate, tax_id, is_active) VALUES (?,?,?,?,?,?,1)', [priceListId, row.garment_id, row.service_id, pieceVal, weightVal, row.tax_id]);
                                        await rec('create', String(r.insertId), row);
                                    }
                                    inserted++;
                                }
                                else {
                                    await t.execute('UPDATE price_list_items SET piece_rate=?, weight_rate=?, tax_id=? WHERE id=?', [pieceVal, weightVal, row.tax_id, row.existing_id]);
                                    await rec('edit', String(row.existing_id), row);
                                    updated++;
                                }
                            }
                        });
                        await importCleanupTemp(ctx, token);
                        await ctx.svc.audit.record({ action: 'edit', module: 'pricelist', recordId: String(priceListId), newValue: { excel_import: { inserted, updated, skipped } }, userId: ctx.data.user_id ?? null, ip: req.ip });
                        report = { inserted, updated, skipped };
                        step = 'done';
                    }
                }
                catch (e) {
                    errors.push('Import failed, no changes were made: ' + e.message);
                    step = 'upload';
                }
            }
            else if (step === 'cancel') {
                await importCleanupTemp(ctx, token);
                step = 'upload';
            }
        }
        const u = (p) => ctx.baseUrl(p);
        const money = await ctx.loadMoney();
        let content = '';
        if (step === 'upload') {
            content = html `
        <h6 class="fw-bold">Import Rates for ${priceList.price_list_name}</h6>
        <p class="text-muted">Garment, Category, and Service are existing master-data references — the importer never creates or renames them. Only rates are updated. Nothing is changed until you review the preview and confirm.</p>
        <a href="?id=${priceListId}&template=1" class="btn btn-outline-secondary btn-sm mb-3"><i class="fa-solid fa-download me-1"></i>Download CSV Template</a>

        <form method="POST" enctype="multipart/form-data" id="importUploadForm">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="upload">
          <input type="hidden" name="price_list_id" value="${priceListId}">
          <div class="mb-3">
            <input type="file" name="file" id="importFileInput" class="form-control" accept=".csv" required>
          </div>
          <button class="btn btn-primary" type="submit" id="importSubmitBtn"><i class="fa-solid fa-upload me-1"></i>Upload &amp; Validate</button>
        </form>`;
        }
        else if (step === 'preview' && preview !== null) {
            const counts = { insert: 0, insert_over_unconfigured: 0, update: 0, unchanged: 0, skip: 0, error: 0 };
            for (const r of preview)
                counts[r.status]++;
            const validCount = counts.insert + counts.insert_over_unconfigured + counts.update;
            const hasErrors = counts.error > 0;
            content = html `
        <h6 class="fw-bold">Import Preview</h6>
        <p>
          <span class="badge bg-success">${validCount} valid</span>
          <span class="badge bg-secondary">${counts.unchanged} unchanged</span>
          <span class="badge bg-light text-dark border">${counts.skip} Not Configured (skipped)</span>
          <span class="badge bg-danger">${counts.error} errors</span>
        </p>
        ${hasErrors ? html `<div class="alert alert-danger">This file has ${counts.error} row error(s). <strong>No rows can be imported until every error is fixed</strong> — this is an all-or-nothing import. Correct the file and upload again.</div>` : ''}
        <div class="table-responsive udc-cards-wrap" style="max-height:420px;overflow-y:auto;">
          <table class="udc-cards table table-sm">
            <thead><tr><th>Line</th><th>Type</th><th>ID</th><th>Garment</th><th>Category</th><th>Service</th><th>Unit</th><th class="text-end">Old → New</th><th>Status</th></tr></thead>
            <tbody>
            ${preview.map((r) => html `
              <tr class="${r.status === 'error' ? 'table-danger' : ''}">
                <td data-label="Line">${r.line}</td>
                <td data-label="Type"><span class="badge ${r.rate_type === 'SERVICE' ? 'bg-info text-dark' : 'bg-light text-dark border'}">${r.rate_type}</span></td>
                <td data-label="ID">${r.garment_id !== null ? int(r.garment_id) : '—'}</td>
                <td data-label="Garment">${r.rate_type === 'SERVICE' ? html `<span class="text-muted">— all garments —</span>` : html `${r.garment_name}${truthy(r.garment_code) ? html ` <span class="text-muted small">(${r.garment_code})</span>` : ''}`}</td>
                <td data-label="Category">${dash(String(r.category ?? ''))}</td>
                <td data-label="Service">${r.service}</td>
                <td data-label="Unit">${r.billing_unit === 'weight' ? '/ Kg' : (r.billing_unit === 'piece' ? '/ Pc' : '—')}</td>
                <td class="text-end" data-label="Old → New">
                  ${r.status === 'skip' ? 'Not Configured — skipped'
                : r.new_rate !== null ? html `${r.old_rate !== null && r.old_rate > 0 ? money(r.old_rate) : 'Not Configured'} → ${money(r.new_rate)}` : '—'}
                </td>
                <td data-label="Status">
                  ${r.status === 'error' ? html `<span class="badge bg-danger">Error</span> <span class="small text-danger">${r.errors.join(' ')}</span>`
                : r.status === 'insert' ? html `<span class="badge bg-success">New</span>`
                    : r.status === 'insert_over_unconfigured' ? html `<span class="badge bg-success">Now Configured</span>`
                        : r.status === 'update' ? html `<span class="badge bg-primary">Update</span>`
                            : r.status === 'skip' ? html `<span class="badge bg-light text-dark border">Skipped</span>` : html `<span class="badge bg-secondary">Unchanged</span>`}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="confirm">
          <input type="hidden" name="price_list_id" value="${priceListId}">
          <input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-primary" type="submit" ${(hasErrors || validCount === 0) ? 'disabled' : ''}>
            <i class="fa-solid fa-check me-1"></i>Confirm Import (${validCount} changes)
          </button>
        </form>
        ${hasErrors ? html `<a href="?id=${priceListId}&error_report=1&import_token=${token}" class="btn btn-outline-danger">Download Error Report</a>` : ''}
        <a href="?id=${priceListId}" class="btn btn-outline-secondary">Back to Upload</a>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="cancel">
          <input type="hidden" name="price_list_id" value="${priceListId}">
          <input type="hidden" name="import_token" value="${token}">
          <button class="btn btn-outline-secondary" type="submit">Cancel</button>
        </form>`;
        }
        else if (step === 'done' && report) {
            content = html `
        <div class="alert alert-success">
          <h6 class="fw-bold">Import Complete</h6>
          ${report.inserted} rate(s) inserted/updated, ${report.skipped} skipped (unchanged or left Not Configured).
        </div>
        <a href="${u('modules/pricelist/import.php?id=' + priceListId)}" class="btn btn-primary btn-sm">Import Another File</a>
        <a href="${u('modules/pricelist/edit.php?id=' + priceListId)}" class="btn btn-outline-secondary btn-sm">Back to Manage Rates</a>`;
        }
        return layout(ctx, { title: 'Import CSV: ' + priceList.price_list_name }, html `
<div class="col-12 d-flex justify-content-between align-items-start flex-wrap gap-2">
  <div>
    <h4 class="mb-0">Import CSV</h4>
    <span class="text-muted">${priceList.price_list_name}</span>
  </div>
  <a href="${u('modules/pricelist/edit.php?id=' + priceListId)}" class="btn btn-outline-secondary btn-sm">Back to Manage Rates</a>
</div>

<div class="col-12">
  <div class="card">
    <div class="card-body">
      ${errors.length ? html `
        <div class="alert alert-danger"><ul class="mb-0">${errors.map((er) => html `<li>${er}</li>`)}</ul></div>` : ''}

      ${content}
    </div>
  </div>
</div>
`);
    });
}
