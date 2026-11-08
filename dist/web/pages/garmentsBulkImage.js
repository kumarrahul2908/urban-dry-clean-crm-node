import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { WebText, forbiddenPage, webPage } from '../context.js';
import { html } from '../html.js';
import { importCleanupTemp, importStoreTempUpload, importTempPath, parseCsvFile } from '../importTemp.js';
import { layout } from '../layout.js';
import { ALLOWED_IMAGE_TYPES, MAX_UPLOAD_SIZE_MB, deleteUploadedImage, looksLikeImage } from '../uploads.js';
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => str(v).trim();
const body = (ctx) => (ctx.req.body ?? {});
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const dash = (v) => (v !== '' && v !== '0' ? v : '—');
/** pathinfo($name, PATHINFO_FILENAME / PATHINFO_EXTENSION) */
const baseOf = (n) => n.slice(n.lastIndexOf('/') + 1);
const pathFilename = (n) => { const b = baseOf(n); const d = b.lastIndexOf('.'); return d === -1 ? b : b.slice(0, d); };
const pathExt = (n) => { const b = baseOf(n); const d = b.lastIndexOf('.'); return d === -1 ? '' : b.slice(d + 1); };
export function registerGarmentBulkImagePage(app) {
    const { db } = app.services;
    const mappingPath = (ctx, token) => {
        if (!/^[a-f0-9]{32}$/.test(token))
            throw new Error('Invalid upload session.');
        return join(ctx.svc.storage.root, 'tmp', `${token}.json`);
    };
    const cleanup = async (ctx, mapping) => {
        for (const row of mapping)
            if (row.staged_filename)
                await unlink(join(ctx.svc.storage.root, 'garments', basename(row.staged_filename))).catch(() => { });
    };
    webPage(app, '/modules/garments/bulk_image', { auth: 'login' }, async (ctx, req) => {
        if (!ctx.can('garment.edit') && !ctx.can('garments.manage'))
            return forbiddenPage(ctx);
        const q = req.query;
        let step = clean(body(ctx).step ?? q.step ?? 'upload') || 'upload';
        const errors = [];
        let preview = null;
        let token = clean(body(ctx).mapping_token);
        let report = null;
        if (req.method === 'POST') {
            if (!ctx.csrfValid())
                return csrfFail();
            if (step === 'upload') {
                try {
                    const explicit = new Map();
                    if (ctx.files.mapping_file) {
                        const mapToken = await importStoreTempUpload(ctx, 'mapping_file');
                        const parsed = await parseCsvFile(importTempPath(ctx, mapToken));
                        await importCleanupTemp(ctx, mapToken);
                        for (const r of parsed.rows) {
                            const gid = (r['Garment ID'] ?? '').trim(), fname = (r['Image Filename'] ?? '').trim();
                            if (gid !== '' && fname !== '')
                                explicit.set(fname.toLowerCase(), gid);
                        }
                    }
                    const garmentsById = new Map();
                    for (const g of await db.query('SELECT id, garment_name, category_id, image FROM garments'))
                        garmentsById.set(Number(g.id), g);
                    const categoriesById = new Map();
                    for (const c of await db.query('SELECT id, category_name FROM categories'))
                        categoriesById.set(Number(c.id), c.category_name);
                    const results = [];
                    const seen = new Map();
                    const parts = ctx.fileParts.filter((f) => f.field === 'images[]' || f.field === 'images');
                    if (parts.length === 0)
                        errors.push('No image files were selected.');
                    for (const part of parts) {
                        const origName = part.filename;
                        const rowErrors = [];
                        let garmentId = null;
                        if (origName === '') {
                            rowErrors.push('Upload error (code 4).'); // UPLOAD_ERR_NO_FILE
                        }
                        else {
                            const gidRaw = explicit.get(origName.toLowerCase()) ?? pathFilename(origName);
                            if (!/^[0-9]+$/.test(gidRaw))
                                rowErrors.push(`Could not determine a Garment ID from "${origName}" (expected the filename itself to be the Garment ID, or a row in the mapping CSV).`);
                            else if (!garmentsById.has(Number(gidRaw)))
                                rowErrors.push(`Garment ID ${gidRaw} does not match any existing garment. Never guessed by name.`);
                            else {
                                garmentId = Number(gidRaw);
                                if (seen.has(garmentId))
                                    rowErrors.push(`Duplicate mapping: Garment ID ${garmentId} is also targeted by "${seen.get(garmentId)}" in this same batch.`);
                            }
                            const ext = pathExt(origName).toLowerCase();
                            if (!ALLOWED_IMAGE_TYPES.includes(ext))
                                rowErrors.push(`Invalid image type "${ext}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}.`);
                            else if (part.buffer.length > MAX_UPLOAD_SIZE_MB * 1024 * 1024)
                                rowErrors.push(`File too large. Maximum ${MAX_UPLOAD_SIZE_MB}MB per image.`);
                            else if (!looksLikeImage(part.buffer))
                                rowErrors.push('This file is not a valid image.');
                        }
                        let staged = null;
                        if (rowErrors.length === 0) {
                            seen.set(garmentId, origName);
                            staged = randomBytes(16).toString('hex') + '.' + pathExt(origName).toLowerCase();
                            const dir = join(ctx.svc.storage.root, 'garments');
                            await mkdir(dir, { recursive: true });
                            await writeFile(join(dir, staged), part.buffer, { mode: 0o644 });
                        }
                        const g = garmentId !== null ? garmentsById.get(garmentId) : null;
                        results.push({
                            original_filename: origName, garment_id: garmentId, garment_name: g?.garment_name ?? null,
                            category_name: g ? (categoriesById.get(Number(g.category_id)) ?? null) : null,
                            had_existing_image: !!(g && g.image && g.image !== '0'), staged_filename: staged,
                            status: rowErrors.length ? 'error' : 'matched', errors: rowErrors,
                        });
                    }
                    if (errors.length === 0) {
                        const newToken = randomBytes(16).toString('hex');
                        await mkdir(join(ctx.svc.storage.root, 'tmp'), { recursive: true });
                        await writeFile(mappingPath(ctx, newToken), JSON.stringify(results));
                        token = newToken;
                        preview = results;
                        step = 'preview';
                    }
                    else
                        step = 'upload';
                }
                catch (e) {
                    errors.push('UPLOAD ERROR: ' + e.message);
                    step = 'upload';
                }
            }
            else if (step === 'confirm') {
                try {
                    const path = mappingPath(ctx, token);
                    let mapping;
                    try {
                        mapping = JSON.parse(await readFile(path, 'utf8'));
                    }
                    catch {
                        throw new Error('This upload session has expired. Please upload again.');
                    }
                    if (mapping.some((r) => r.status === 'error')) {
                        errors.push('Confirm blocked: this batch still has errors. Go back and fix or remove the problem files — no images were linked.');
                        preview = mapping;
                        step = 'preview';
                    }
                    else {
                        let linked = 0;
                        const userId = ctx.data.user_id ?? null;
                        await db.tx(async (t) => {
                            const audit = ctx.svc.audit.using(t);
                            for (const row of mapping) {
                                if (row.status !== 'matched' || !row.staged_filename)
                                    continue;
                                const oldRow = (await t.query('SELECT * FROM garments WHERE id = ?', [row.garment_id]))[0];
                                if (oldRow && oldRow.image)
                                    await deleteUploadedImage(ctx, oldRow.image, 'garments');
                                await t.execute('UPDATE garments SET image = ? WHERE id = ?', [row.staged_filename, row.garment_id]);
                                await audit.record({ action: 'edit', module: 'garments', recordId: String(row.garment_id), oldValue: { image: oldRow?.image ?? null }, newValue: { image: row.staged_filename }, userId, ip: req.ip });
                                linked++;
                            }
                        });
                        await unlink(path).catch(() => { });
                        report = { linked };
                        step = 'done';
                    }
                }
                catch (e) {
                    errors.push('Confirm failed, no images were linked: ' + e.message);
                    step = 'upload';
                }
            }
            else if (step === 'cancel') {
                try {
                    const path = mappingPath(ctx, token);
                    let mapping = null;
                    try {
                        mapping = JSON.parse(await readFile(path, 'utf8'));
                    }
                    catch { /* no session */ }
                    if (mapping) {
                        await cleanup(ctx, mapping);
                        await unlink(path).catch(() => { });
                    }
                }
                catch { /* best-effort cleanup */ }
                step = 'upload';
            }
        }
        const u = (p) => ctx.baseUrl(p);
        let content = '';
        if (step === 'upload') {
            content = html `
        <h6 class="fw-bold">Upload Images</h6>
        <p class="text-muted">Matching is always by <strong>Garment ID</strong> — never by name, since duplicate names exist (e.g. two different "Jeans" garments). Two ways to match:</p>
        <ul class="text-muted small">
          <li><strong>Option A</strong> — name each file after its Garment ID, e.g. <code>2.jpg</code>, <code>31.jpg</code>.</li>
          <li><strong>Option B</strong> — upload an explicit mapping CSV with columns <code>Garment ID, Image Filename</code> alongside your images.</li>
        </ul>
        <p class="text-muted small">Max ${MAX_UPLOAD_SIZE_MB}MB per image (${ALLOWED_IMAGE_TYPES.join(', ')}). Note: the server also caps total upload size per request — for large batches, upload in a few smaller groups if needed.</p>
        <form method="POST" enctype="multipart/form-data">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="upload">
          <div class="mb-3">
            <label class="form-label">Images *</label>
            <input type="file" name="images[]" class="form-control" accept=".jpg,.jpeg,.png,.webp" multiple required>
          </div>
          <div class="mb-3">
            <label class="form-label">Mapping CSV (optional — Option B)</label>
            <input type="file" name="mapping_file" class="form-control" accept=".csv">
          </div>
          <button class="btn btn-primary" type="submit"><i class="fa-solid fa-upload me-1"></i>Upload &amp; Validate</button>
        </form>`;
        }
        else if (step === 'preview' && preview !== null) {
            const matched = preview.filter((r) => r.status === 'matched').length, errCount = preview.filter((r) => r.status === 'error').length;
            const hasErrors = errCount > 0;
            content = html `
        <h6 class="fw-bold">Upload Preview</h6>
        <p>
          <span class="badge bg-success">${matched} matched</span>
          <span class="badge bg-danger">${errCount} errors</span>
        </p>
        ${hasErrors ? html `<div class="alert alert-danger">This batch has ${errCount} error(s). <strong>No images will be linked until every error is resolved</strong> — all-or-nothing. Cancel and re-upload only the corrected files.</div>` : ''}
        <div class="table-responsive udc-cards-wrap" style="max-height:420px;overflow-y:auto;">
          <table class="udc-cards table table-sm">
            <thead><tr><th>File</th><th>Garment ID</th><th>Garment</th><th>Category</th><th>Existing Image?</th><th>Status</th></tr></thead>
            <tbody>
            ${preview.map((r) => html `
              <tr class="${r.status === 'error' ? 'table-danger' : ''}">
                <td data-label="File">${r.original_filename}</td>
                <td data-label="Garment ID">${r.garment_id ?? '—'}</td>
                <td data-label="Garment">${dash(String(r.garment_name ?? ''))}</td>
                <td data-label="Category">${dash(String(r.category_name ?? ''))}</td>
                <td data-label="Existing Image?">${r.had_existing_image ? html `<span class="text-warning">Will be replaced</span>` : '—'}</td>
                <td data-label="Status">
                  ${r.status === 'error' ? html `<span class="badge bg-danger">Error</span> <span class="small text-danger">${r.errors.join(' ')}</span>` : html `<span class="badge bg-success">Matched</span>`}
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="confirm">
          <input type="hidden" name="mapping_token" value="${token}">
          <button class="btn btn-primary" type="submit" ${(hasErrors || matched === 0) ? 'disabled' : ''}>
            <i class="fa-solid fa-check me-1"></i>Confirm (${matched} images)
          </button>
        </form>
        <form method="POST" class="d-inline">
          ${ctx.csrfField()}
          <input type="hidden" name="step" value="cancel">
          <input type="hidden" name="mapping_token" value="${token}">
          <button class="btn btn-outline-secondary" type="submit">Cancel</button>
        </form>`;
        }
        else if (step === 'done' && report) {
            content = html `
        <div class="alert alert-success">
          <h6 class="fw-bold">Upload Complete</h6>
          ${report.linked} image(s) linked to garments.
        </div>
        <a href="?" class="btn btn-primary btn-sm">Upload More</a>
        <a href="${u('modules/garments/list.php')}" class="btn btn-outline-secondary btn-sm">Back to Garments</a>`;
        }
        return layout(ctx, { title: 'Bulk Image Upload' }, html `
<div class="col-12 d-flex justify-content-between align-items-start flex-wrap gap-2">
  <div><h4 class="mb-0">Bulk Garment Image Upload</h4></div>
  <a href="${u('modules/garments/list.php')}" class="btn btn-outline-secondary btn-sm">Back to Garments</a>
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
