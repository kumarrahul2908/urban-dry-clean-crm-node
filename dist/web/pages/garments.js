import { phpEmpty } from '../../lib/php.js';
import { WebRedirect, WebText, webPage } from '../context.js';
import { flt, int } from '../format.js';
import { raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { deleteUploadedImage, handleImageUpload } from '../uploads.js';
import { tplGarmentsAdd } from '../tpl/garments_add.js';
import { tplGarmentsEdit } from '../tpl/garments_edit.js';
import { tplGarmentsList } from '../tpl/garments_list.js';
import { tplGarmentsView } from '../tpl/garments_view.js';
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => str(v).trim();
const body = (ctx) => (ctx.req.body ?? {});
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const denied = (ctx) => new WebText(`<h2>403 - Access Denied</h2><p>You do not have permission to access this page.</p><p><a href="${ctx.baseUrl('modules/dashboard/index.php')}">Back to Dashboard</a></p>`, 403);
const looseId = (a, b) => String(a ?? '') === String(b ?? '') && String(a ?? '') !== '' || (parseFloat(String(a)) === parseFloat(String(b)) && !Number.isNaN(parseFloat(String(a))));
export function registerGarmentPages(app) {
    const { db, audit } = app.services;
    const any = (ctx, ...keys) => keys.some((k) => ctx.can(k));
    const lists = async () => ({
        categories: await db.query('SELECT id, category_name FROM categories WHERE is_active=1 ORDER BY sort_order'),
        services: await db.query('SELECT id, service_name FROM services WHERE is_active=1 ORDER BY sort_order'),
    });
    // ---- list --------------------------------------------------------------------------------------
    webPage(app, '/modules/garments/list', { auth: 'login' }, async (ctx, req) => {
        if (!any(ctx, 'garment.view', 'garments.manage'))
            return denied(ctx);
        const q = req.query;
        const search = clean(q.q), categoryFilter = int(q.category_id), serviceFilter = int(q.service_id), statusFilter = clean(q.status);
        const page = Math.max(1, int(q.page) || 1), perPage = 20, offset = (page - 1) * perPage;
        let where = '1=1';
        const params = [];
        if (search !== '') {
            where += ' AND (g.garment_name LIKE ? OR g.sku LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }
        if (categoryFilter) {
            where += ' AND g.category_id = ?';
            params.push(categoryFilter);
        }
        if (serviceFilter) {
            where += ' AND g.default_service_id = ?';
            params.push(serviceFilter);
        }
        if (statusFilter === 'active')
            where += ' AND g.is_active = 1';
        if (statusFilter === 'inactive')
            where += ' AND g.is_active = 0';
        const total = int((await db.query(`SELECT COUNT(*) AS n FROM garments g WHERE ${where}`, params))[0].n);
        const rows = await db.query(`SELECT g.*, c.category_name, s.service_name FROM garments g LEFT JOIN categories c ON c.id = g.category_id LEFT JOIN services s ON s.id = g.default_service_id WHERE ${where} ORDER BY g.id DESC LIMIT ${perPage} OFFSET ${offset}`, params);
        const h = await tplHelpers(ctx);
        return layout(ctx, { title: 'Garments' }, raw(tplGarmentsList({ search, categoryFilter, serviceFilter, statusFilter, page, rows, totalPages: Math.ceil(total / perPage), ...(await lists()) }, h)));
    });
    // ---- add ---------------------------------------------------------------------------------------
    webPage(app, '/modules/garments/add', { auth: 'login' }, async (ctx, req) => {
        if (!any(ctx, 'garment.create', 'garments.manage'))
            return denied(ctx);
        const errors = [];
        const form = { garment_name: '', sku: '', category_id: '', default_service_id: '', unit: 'Pcs', pieces_per_unit: '1', description: '' };
        if (req.method === 'POST') {
            if (!ctx.csrfValid())
                return csrfFail();
            const p = body(ctx);
            for (const k of Object.keys(form))
                form[k] = clean(p[k]);
            if (form.garment_name === '')
                errors.push('Garment name is required.');
            if (form.category_id === '')
                errors.push('Category is required.');
            if (form.unit === '')
                errors.push('Unit is required.');
            // a Set garment (e.g. 2-piece Suit) is ordered as ONE unit but is several physical garments, each needing its own tag
            if (int(form.pieces_per_unit) < 1)
                errors.push('Pieces per Unit must be at least 1.');
            if (form.sku !== '' && (await db.query('SELECT id FROM garments WHERE sku = ?', [form.sku])).length)
                errors.push('This SKU is already used by another garment.');
            if (form.garment_name !== '' && form.category_id !== '' && (await db.query('SELECT id FROM garments WHERE LOWER(garment_name) = LOWER(?) AND category_id = ?', [form.garment_name, form.category_id])).length) {
                errors.push(`A garment named "${form.garment_name}" already exists in this category.`);
            }
            let image = null;
            if (!errors.length) {
                try {
                    image = await handleImageUpload(ctx, 'image', 'garments');
                }
                catch (ex) {
                    errors.push(ex.message);
                }
            }
            if (!errors.length) {
                const r = await db.execute('INSERT INTO garments (garment_name, sku, category_id, default_service_id, unit, pieces_per_unit, image, description) VALUES (?,?,?,?,?,?,?,?)', [form.garment_name, phpEmpty(form.sku) ? null : form.sku, form.category_id, phpEmpty(form.default_service_id) ? null : form.default_service_id, form.unit, Math.max(1, int(form.pieces_per_unit)), image, form.description]);
                await audit.record({ action: 'create', module: 'garments', recordId: String(r.insertId), newValue: form, userId: ctx.data.user_id ?? null, ip: req.ip });
                ctx.flashSet('success', `Garment "${form.garment_name}" added successfully.`);
                return new WebRedirect('modules/garments/view.php?id=' + r.insertId);
            }
        }
        const h = await tplHelpers(ctx);
        return layout(ctx, { title: 'Add Garment' }, raw(tplGarmentsAdd({ errors, form, ...(await lists()) }, h)));
    });
    // ---- edit --------------------------------------------------------------------------------------
    webPage(app, '/modules/garments/edit', { auth: 'login' }, async (ctx, req) => {
        if (!any(ctx, 'garment.edit', 'garments.manage'))
            return denied(ctx);
        const canDeactivate = any(ctx, 'garment.delete', 'garments.manage');
        const id = int(req.query.id);
        const garment = (await db.query('SELECT * FROM garments WHERE id = ?', [id]))[0];
        if (!garment) {
            ctx.flashSet('danger', 'Garment not found.');
            return new WebRedirect('modules/garments/list.php');
        }
        const errors = [];
        const form = { ...garment };
        if (req.method === 'POST') {
            if (!ctx.csrfValid())
                return csrfFail();
            const p = body(ctx);
            for (const f of ['garment_name', 'sku', 'category_id', 'default_service_id', 'unit', 'pieces_per_unit', 'description'])
                form[f] = clean(p[f]);
            form.is_active = 'is_active' in p ? 1 : 0;
            const removeImage = 'remove_image' in p;
            let permissionWarning = null;
            if (Number(form.is_active) !== Number(garment.is_active) && !canDeactivate) {
                form.is_active = garment.is_active;
                permissionWarning = 'You do not have permission to activate/deactivate garments — that change was not applied, but your other edits were saved.';
            }
            if (form.garment_name === '')
                errors.push('Garment name is required.');
            if (form.category_id === '')
                errors.push('Category is required.');
            if (form.unit === '')
                errors.push('Unit is required.');
            if (int(form.pieces_per_unit) < 1)
                errors.push('Pieces per Unit must be at least 1.');
            if (form.sku !== '' && (await db.query('SELECT id FROM garments WHERE sku = ? AND id != ?', [form.sku, id])).length)
                errors.push('This SKU is already used by another garment.');
            if (form.garment_name !== '' && form.category_id !== '' && (await db.query('SELECT id FROM garments WHERE LOWER(garment_name) = LOWER(?) AND category_id = ? AND id != ?', [form.garment_name, form.category_id, id])).length) {
                errors.push(`A garment named "${form.garment_name}" already exists in this category.`);
            }
            let newImage = garment.image;
            if (!errors.length) {
                try {
                    const uploaded = await handleImageUpload(ctx, 'image', 'garments');
                    if (uploaded) {
                        await deleteUploadedImage(ctx, garment.image, 'garments');
                        newImage = uploaded;
                    }
                    else if (removeImage) {
                        await deleteUploadedImage(ctx, garment.image, 'garments');
                        newImage = null;
                    }
                }
                catch (ex) {
                    errors.push(ex.message);
                }
            }
            if (!errors.length) {
                await db.execute('UPDATE garments SET garment_name=?, sku=?, category_id=?, default_service_id=?, unit=?, pieces_per_unit=?, description=?, image=?, is_active=? WHERE id=?', [form.garment_name, phpEmpty(form.sku) ? null : form.sku, form.category_id, phpEmpty(form.default_service_id) ? null : form.default_service_id, form.unit, Math.max(1, int(form.pieces_per_unit)), form.description, newImage, form.is_active, id]);
                await audit.record({ action: 'edit', module: 'garments', recordId: String(id), oldValue: garment, newValue: form, userId: ctx.data.user_id ?? null, ip: req.ip });
                ctx.flashSet('success', 'Garment updated successfully.' + (permissionWarning ? ' ' + permissionWarning : ''));
                return new WebRedirect('modules/garments/view.php?id=' + id);
            }
        }
        const h = await tplHelpers(ctx);
        return layout(ctx, { title: 'Edit Garment' }, raw(tplGarmentsEdit({ canDeactivate, errors, form, garment, id, ...(await lists()) }, h)));
    });
    // ---- view --------------------------------------------------------------------------------------
    webPage(app, '/modules/garments/view', { auth: 'login' }, async (ctx, req) => {
        if (!any(ctx, 'garment.view', 'garments.manage'))
            return denied(ctx);
        const id = int(req.query.id);
        const garment = (await db.query('SELECT g.*, c.category_name, s.service_name FROM garments g LEFT JOIN categories c ON c.id = g.category_id LEFT JOIN services s ON s.id = g.default_service_id WHERE g.id = ?', [id]))[0];
        if (!garment) {
            ctx.flashSet('danger', 'Garment not found.');
            return new WebRedirect('modules/garments/list.php');
        }
        const rates = await db.query(`SELECT pli.*, pl.price_list_name, pl.list_type, s.service_name, s.billing_unit, t.tax_name, t.tax_percent FROM price_list_items pli JOIN price_lists pl ON pl.id = pli.price_list_id
       JOIN services s ON s.id = pli.service_id LEFT JOIN taxes t ON t.id = pli.tax_id WHERE pli.garment_id = ? ORDER BY pl.price_list_name, s.service_name`, [id]);
        const ratesByList = {};
        const rateOrder = [];
        for (const r of rates) {
            const k = String(r.price_list_id);
            if (!(k in ratesByList)) {
                ratesByList[k] = { rows: [] };
                rateOrder.push(k);
            }
            ratesByList[k].name = r.price_list_name;
            ratesByList[k].type = r.list_type;
            ratesByList[k].rows.push(r);
        }
        const universal = await db.query(`SELECT plsr.*, pl.id AS price_list_id, pl.price_list_name, pl.list_type, s.service_name, s.billing_unit, t.tax_name, t.tax_percent FROM price_list_service_rates plsr
       JOIN price_lists pl ON pl.id = plsr.price_list_id AND pl.is_active = 1 JOIN services s ON s.id = plsr.service_id LEFT JOIN taxes t ON t.id = plsr.tax_id
       WHERE plsr.is_active = 1 ORDER BY pl.price_list_name, s.service_name`);
        const universalByList = {};
        const uniOrder = [];
        for (const u of universal) {
            const k = String(u.price_list_id);
            if (!(k in universalByList)) {
                universalByList[k] = { rows: [] };
                uniOrder.push(k);
            }
            universalByList[k].name = u.price_list_name;
            universalByList[k].rows.push(u);
        }
        // array_unique(array_merge(keys)) keeps the first occurrence; PHP int keys become ints
        const allListIds = [...new Set([...rateOrder, ...uniOrder])].map((k) => Number(k));
        const money = await ctx.loadMoney();
        const unconfigured = '<span class="text-muted fst-italic">Not Configured</span>';
        const formatRateOrUnconfigured = (r) => {
            if (r.billing_unit === 'weight') {
                if (r.weight_rate === null || flt(r.weight_rate) === 0)
                    return unconfigured;
                return money(r.weight_rate) + ' / Kg';
            }
            if (flt(r.piece_rate) === 0 && r.weight_rate === null)
                return unconfigured;
            return money(r.piece_rate) + ' / Pc';
        };
        const h = await tplHelpers(ctx, { formatRateOrUnconfigured });
        return layout(ctx, { title: 'Garment Details' }, raw(tplGarmentsView({ allListIds, garment, id, ratesByList, universalByList }, h)));
    });
    void looseId;
}
