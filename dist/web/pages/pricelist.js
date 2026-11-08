import { isNumeric, phpRound, toFloat, toInt } from '../../lib/php.js';
import { WebRedirect, WebText, forbiddenPage, webPage } from '../context.js';
import { int } from '../format.js';
import { jsonEncode, raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplPricelistAdd } from '../tpl/pricelist_add.js';
import { tplPricelistEdit } from '../tpl/pricelist_edit.js';
import { tplPricelistList } from '../tpl/pricelist_list.js';
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => str(v).trim();
const body = (ctx) => (ctx.req.body ?? {});
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const TYPES = ['Default', 'Customer', 'Membership'];
const json = (d, status = 200) => new WebText(jsonEncode(d), status, 'application/json');
const taxOrNull = (p) => ((p.tax_id ?? '') !== '' ? p.tax_id : null);
export function registerPricelistPages(app) {
    const { db, audit } = app.services;
    const any = (ctx, ...keys) => keys.some((k) => ctx.can(k));
    // ---- list ---------------------------------------------------------------------------------------
    webPage(app, '/modules/pricelist/list', { auth: 'login' }, async (ctx, req) => {
        if (!any(ctx, 'pricing.view', 'pricelist.manage'))
            return forbiddenPage(ctx);
        const q = req.query;
        const search = clean(q.q), typeFilter = clean(q.type);
        const page = Math.max(1, int(q.page) || 1), perPage = 20, offset = (page - 1) * perPage;
        let where = '1=1';
        const params = [];
        if (search !== '') {
            where += ' AND pl.price_list_name LIKE ?';
            params.push(`%${search}%`);
        }
        if (TYPES.includes(typeFilter)) {
            where += ' AND pl.list_type = ?';
            params.push(typeFilter);
        }
        const total = int((await db.query(`SELECT COUNT(*) AS n FROM price_lists pl WHERE ${where}`, params))[0].n);
        const rows = await db.query(`SELECT pl.*, (SELECT COUNT(*) FROM price_list_items pli WHERE pli.price_list_id = pl.id) AS item_count,
       (SELECT COUNT(*) FROM customers c WHERE c.price_list_id = pl.id) AS customer_count
       FROM price_lists pl WHERE ${where} ORDER BY pl.id ASC LIMIT ${perPage} OFFSET ${offset}`, params);
        const h = await tplHelpers(ctx);
        return layout(ctx, { title: 'Price Lists' }, raw(tplPricelistList({ search, typeFilter, page, rows, totalPages: Math.ceil(total / perPage) }, h)));
    });
    // ---- add ----------------------------------------------------------------------------------------
    webPage(app, '/modules/pricelist/add', { auth: 'login' }, async (ctx, req) => {
        if (!any(ctx, 'pricing.edit', 'pricelist.manage'))
            return forbiddenPage(ctx);
        const errors = [];
        const form = { price_list_name: '', list_type: 'Default' };
        if (req.method === 'POST') {
            if (!ctx.csrfValid())
                return csrfFail();
            const p = body(ctx);
            form.price_list_name = clean(p.price_list_name);
            form.list_type = 'list_type' in p ? clean(p.list_type) : 'Default';
            if (form.price_list_name === '')
                errors.push('Price list name is required.');
            if (!TYPES.includes(form.list_type))
                errors.push('Invalid price list type.');
            if (!errors.length) {
                const r = await db.execute('INSERT INTO price_lists (price_list_name, list_type) VALUES (?, ?)', [form.price_list_name, form.list_type]);
                await audit.record({ action: 'create', module: 'pricelist', recordId: String(r.insertId), newValue: form, userId: ctx.data.user_id ?? null, ip: req.ip });
                ctx.flashSet('success', `Price list "${form.price_list_name}" created. Now add garment rates.`);
                return new WebRedirect('modules/pricelist/edit.php?id=' + r.insertId);
            }
        }
        const h = await tplHelpers(ctx);
        return layout(ctx, { title: 'Add Price List' }, raw(tplPricelistAdd({ errors, form }, h)));
    });
    // ---- edit (manage rates) -----------------------------------------------------------------------
    webPage(app, '/modules/pricelist/edit', { auth: 'login' }, async (ctx, req) => {
        if (!any(ctx, 'pricing.edit', 'pricelist.manage'))
            return forbiddenPage(ctx);
        const q = req.query;
        const id = int(q.id);
        const priceList = (await db.query('SELECT * FROM price_lists WHERE id = ?', [id]))[0];
        if (!priceList) {
            ctx.flashSet('danger', 'Price list not found.');
            return new WebRedirect('modules/pricelist/list.php');
        }
        const search = clean(q.q), categoryFilter = int(q.category_id);
        let where = 'pli.price_list_id = ?';
        const params = [id];
        if (search !== '') {
            where += ' AND g.garment_name LIKE ?';
            params.push(`%${search}%`);
        }
        if (categoryFilter) {
            where += ' AND g.category_id = ?';
            params.push(categoryFilter);
        }
        const items = await db.query(`SELECT pli.*, g.garment_name, g.sku, g.category_id, c.category_name, s.service_name, s.billing_unit, t.tax_name, t.tax_percent
       FROM price_list_items pli JOIN garments g ON g.id = pli.garment_id LEFT JOIN categories c ON c.id = g.category_id
       JOIN services s ON s.id = pli.service_id LEFT JOIN taxes t ON t.id = pli.tax_id
       WHERE ${where} AND s.pricing_scope = 'garment' ORDER BY g.garment_name, s.service_name`, params);
        const universalItems = await db.query(`SELECT plsr.*, s.service_name, s.billing_unit, t.tax_name, t.tax_percent FROM price_list_service_rates plsr
       JOIN services s ON s.id = plsr.service_id LEFT JOIN taxes t ON t.id = plsr.tax_id WHERE plsr.price_list_id = ? ORDER BY s.service_name`, [id]);
        const garments = await db.query('SELECT g.id, g.garment_name, g.sku, g.category_id, g.default_service_id, c.category_name FROM garments g LEFT JOIN categories c ON c.id = g.category_id WHERE g.is_active=1 ORDER BY g.garment_name');
        const services = await db.query("SELECT id, service_name, billing_unit FROM services WHERE is_active=1 AND pricing_scope='garment' ORDER BY sort_order");
        const configured = universalItems.map((u) => Number(u.service_id));
        const universalServices = await db.query("SELECT id, service_name, billing_unit FROM services WHERE is_active=1 AND pricing_scope='universal' ORDER BY sort_order");
        const universalServicesAvailable = universalServices.filter((s) => !configured.includes(Number(s.id)));
        const taxes = await db.query('SELECT id, tax_name, tax_percent FROM taxes WHERE is_active=1 ORDER BY id');
        const categories = await db.query('SELECT id, category_name FROM categories WHERE is_active=1 ORDER BY sort_order');
        const nameCounts = {};
        for (const g of garments)
            nameCounts[g.garment_name] = (nameCounts[g.garment_name] ?? 0) + 1;
        const garmentDisplayLabel = (g, counts) => {
            let label = g.garment_name;
            if ((counts[g.garment_name] ?? 1) > 1)
                label += ' (' + (g.category_name || 'Uncategorized') + ')';
            return label;
        };
        const money = await ctx.loadMoney();
        const nc = '<span class="text-muted fst-italic">Not Configured</span>';
        const formatRateOrUnconfigured = (r) => {
            if (r.billing_unit === 'weight') {
                if (r.weight_rate === null || toFloat(r.weight_rate) === 0)
                    return nc;
                return money(r.weight_rate);
            }
            if (toFloat(r.piece_rate) === 0 && r.weight_rate === null)
                return nc;
            return money(r.piece_rate);
        };
        const h = await tplHelpers(ctx, { formatRateOrUnconfigured, garmentDisplayLabel });
        return layout(ctx, { title: 'Manage Rates: ' + priceList.price_list_name }, raw(tplPricelistEdit({
            categories, categoryFilter, garments, id, items, nameCounts, priceList, search, services, taxes, universalItems, universalServicesAvailable,
        }, h)));
    });
    // ---- api/pricelist_toggle.php -------------------------------------------------------------------
    webPage(app, '/api/pricelist_toggle', { auth: 'pricelist.manage', methods: ['GET', 'POST'] }, async (ctx, req) => {
        const p = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
        const token = p.csrf_token ?? '';
        if (!ctx.data.csrf_token || typeof token !== 'string' || token !== ctx.data.csrf_token)
            return json({ success: false, message: 'Invalid or expired security token.' }, 419);
        const id = toInt(p.id);
        const row = (await db.query('SELECT * FROM price_lists WHERE id = ?', [id]))[0];
        if (!row)
            return json({ success: false, message: 'Price list not found.' }, 404);
        const nv = row.is_active ? 0 : 1;
        await db.execute('UPDATE price_lists SET is_active = ? WHERE id = ?', [nv, id]);
        await audit.record({ action: 'edit', module: 'pricelist', recordId: String(id), oldValue: { is_active: row.is_active }, newValue: { is_active: nv }, userId: ctx.data.user_id ?? null, ip: req.ip });
        return json({ success: true });
    });
    /** Shared preamble of the two rate APIs: payload, CSRF, price list lookup. */
    const rateApi = (path, handle) => webPage(app, path, { auth: 'pricelist.manage', methods: ['GET', 'POST'] }, async (ctx, req) => {
        const p = req.body;
        if (req.method !== 'POST' || !p || typeof p !== 'object' || Array.isArray(p))
            return json({ success: false, message: 'Invalid request payload.' }, 400);
        const payload = p;
        const token = payload.csrf_token ?? '';
        if (!ctx.data.csrf_token || typeof token !== 'string' || token !== ctx.data.csrf_token)
            return json({ success: false, message: 'Invalid or expired security token. Please refresh the page.' }, 419);
        const priceListId = toInt(payload.price_list_id);
        if (!(await db.query('SELECT id, price_list_name FROM price_lists WHERE id = ?', [priceListId])).length)
            return json({ success: false, message: 'Price list not found.' }, 404);
        return handle(ctx, req, payload, priceListId, ctx.data.user_id ?? null);
    });
    const negOrBad = (v) => v === null || v === undefined || v === '' || !isNumeric(v) || toFloat(v) < 0;
    // ---- api/price_list_items.php -------------------------------------------------------------------
    rateApi('/api/price_list_items', async (_ctx, req, payload, priceListId, userId) => {
        const action = payload.action ?? '';
        const billingUnitOf = async (serviceId) => (await db.query('SELECT billing_unit FROM services WHERE id = ?', [serviceId]))[0]?.billing_unit ?? null;
        const validate = async (excludeId) => {
            const errors = [];
            const garmentId = toInt(payload.garment_id), serviceId = toInt(payload.service_id);
            if (!garmentId)
                errors.push('Garment is required.');
            if (!serviceId)
                errors.push('Service is required.');
            if (serviceId) {
                const unit = await billingUnitOf(serviceId);
                if (!unit)
                    errors.push('Selected service was not found.');
                else if (unit === 'weight') {
                    if (negOrBad(payload.weight_rate))
                        errors.push('Weight rate must be a valid non-negative number for a weight-billed service.');
                }
                else if (negOrBad(payload.piece_rate))
                    errors.push('Piece rate must be a valid non-negative number for a piece-billed service.');
            }
            if (garmentId && serviceId && !errors.length) {
                let sql = 'SELECT id FROM price_list_items WHERE price_list_id = ? AND garment_id = ? AND service_id = ?';
                const params = [priceListId, garmentId, serviceId];
                if (excludeId) {
                    sql += ' AND id != ?';
                    params.push(excludeId);
                }
                if ((await db.query(sql, params)).length)
                    errors.push('A rate for this garment + service combination already exists in this price list.');
            }
            return errors;
        };
        const resolve = async (serviceId) => ((await billingUnitOf(serviceId)) === 'weight' ? [0, toFloat(payload.weight_rate)] : [toFloat(payload.piece_rate), null]);
        const rec = (a, rid, o, n) => audit.record({ action: a, module: 'pricelist', recordId: rid, oldValue: o, newValue: n, userId, ip: req.ip });
        const findItem = async (id) => (await db.query('SELECT * FROM price_list_items WHERE id = ? AND price_list_id = ?', [id, priceListId]))[0] ?? null;
        switch (action) {
            case 'create': {
                const errors = await validate(null);
                if (errors.length)
                    return json({ success: false, message: errors.join(' ') }, 422);
                const [pieceRate, weightRate] = await resolve(toInt(payload.service_id));
                const r = await db.execute('INSERT INTO price_list_items (price_list_id, garment_id, service_id, piece_rate, weight_rate, tax_id, is_active) VALUES (?,?,?,?,?,?,1)', [priceListId, payload.garment_id, payload.service_id, pieceRate, weightRate, taxOrNull(payload)]);
                await rec('create', String(r.insertId), null, payload);
                return json({ success: true, id: Number(r.insertId) });
            }
            case 'update': {
                const id = toInt(payload.id);
                const old = await findItem(id);
                if (!old)
                    return json({ success: false, message: 'Rate not found.' }, 404);
                const errors = await validate(id);
                if (errors.length)
                    return json({ success: false, message: errors.join(' ') }, 422);
                const [pieceRate, weightRate] = await resolve(toInt(payload.service_id));
                await db.execute('UPDATE price_list_items SET garment_id=?, service_id=?, piece_rate=?, weight_rate=?, tax_id=? WHERE id=?', [payload.garment_id, payload.service_id, pieceRate, weightRate, taxOrNull(payload), id]);
                await rec('edit', String(id), old, payload);
                return json({ success: true });
            }
            case 'toggle': {
                const id = toInt(payload.id);
                const row = await findItem(id);
                if (!row)
                    return json({ success: false, message: 'Rate not found.' }, 404);
                const nv = row.is_active ? 0 : 1;
                await db.execute('UPDATE price_list_items SET is_active = ? WHERE id = ?', [nv, id]);
                await rec('edit', String(id), { is_active: row.is_active }, { is_active: nv });
                return json({ success: true });
            }
            case 'delete': {
                const id = toInt(payload.id);
                const row = await findItem(id);
                if (!row)
                    return json({ success: false, message: 'Rate not found.' }, 404);
                const used = Number((await db.query('SELECT COUNT(*) AS n FROM order_items WHERE garment_id = ? AND service_id = ?', [row.garment_id, row.service_id]))[0].n);
                if (used > 0)
                    return json({ success: false, message: 'Cannot delete — this garment/service has been used in orders. Deactivate it instead.' });
                await db.execute('DELETE FROM price_list_items WHERE id = ?', [id]);
                await rec('delete', String(id), row, null);
                return json({ success: true });
            }
            case 'bulk_preview':
            case 'bulk_apply': {
                const rawIds = payload.garment_ids ?? [];
                const garmentIds = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(toInt);
                const serviceId = toInt(payload.service_id);
                const updateType = ['increase', 'decrease'].includes(payload.update_type) ? payload.update_type : null;
                const unit = ['percent', 'amount'].includes(payload.unit) ? payload.unit : null;
                const value = isNumeric(payload.value) ? toFloat(payload.value) : null;
                if (!garmentIds.length || !serviceId || !updateType || !unit || value === null || value < 0)
                    return json({ success: false, message: 'Select at least one garment, a service, and a valid increase/decrease value.' }, 422);
                const bu = await billingUnitOf(serviceId);
                if (!bu)
                    return json({ success: false, message: 'Service not found.' }, 404);
                const rateColumn = bu === 'weight' ? 'weight_rate' : 'piece_rate';
                const rows = await db.query(`SELECT pli.id, pli.${rateColumn} AS old_rate, g.garment_name FROM price_list_items pli JOIN garments g ON g.id = pli.garment_id
           WHERE pli.price_list_id = ? AND pli.garment_id IN (${garmentIds.map(() => '?').join(',')}) AND pli.service_id = ? AND pli.is_active = 1`, [priceListId, ...garmentIds, serviceId]);
                const changes = [], skipped = [];
                for (const row of rows) {
                    const oldRate = toFloat(row.old_rate);
                    if (oldRate <= 0) {
                        skipped.push({ garment_name: row.garment_name, reason: 'Not Configured' });
                        continue;
                    }
                    const delta = unit === 'percent' ? (oldRate * value) / 100 : value;
                    const newRate = phpRound(updateType === 'increase' ? oldRate + delta : Math.max(0, oldRate - delta), 2);
                    changes.push({ id: row.id, garment_name: row.garment_name, old_rate: oldRate, new_rate: newRate });
                }
                if (action === 'bulk_preview')
                    return json({ success: true, changes, skipped });
                let updated = 0;
                for (const c of changes) {
                    await db.execute(`UPDATE price_list_items SET ${rateColumn} = ? WHERE id = ? AND price_list_id = ?`, [c.new_rate, c.id, priceListId]);
                    updated++;
                }
                await rec('edit', String(priceListId), null, { bulk_update: changes });
                return json({ success: true, updated, skipped: skipped.length });
            }
            default: return json({ success: false, message: 'Unknown action.' }, 400);
        }
    });
    // ---- api/price_list_service_rates.php -----------------------------------------------------------
    rateApi('/api/price_list_service_rates', async (_ctx, req, payload, priceListId, userId) => {
        const action = payload.action ?? '';
        const rec = (a, rid, o, n) => audit.record({ action: a, module: 'pricelist', recordId: rid, oldValue: o, newValue: n, userId, ip: req.ip });
        const validateService = async () => {
            const serviceId = toInt(payload.service_id);
            if (!serviceId)
                return ['Service is required.'];
            const svc = (await db.query('SELECT id, service_name, billing_unit, pricing_scope FROM services WHERE id = ? AND is_active = 1', [serviceId]))[0];
            if (!svc)
                return ['Selected service was not found.'];
            if (svc.pricing_scope !== 'universal')
                return [`${svc.service_name} is a garment-specific service — manage its rate under Garment-Based Services, not here.`];
            return [];
        };
        const findRow = async (id) => (await db.query('SELECT * FROM price_list_service_rates WHERE id = ? AND price_list_id = ?', [id, priceListId]))[0] ?? null;
        switch (action) {
            case 'create': {
                const errors = await validateService();
                if (negOrBad(payload.weight_rate))
                    errors.push('Weight rate must be a valid non-negative number.');
                if (!errors.length && (await db.query('SELECT id FROM price_list_service_rates WHERE price_list_id = ? AND service_id = ?', [priceListId, toInt(payload.service_id)])).length) {
                    errors.push('A rate for this service already exists in this price list — edit it instead of adding a new one.');
                }
                if (errors.length)
                    return json({ success: false, message: errors.join(' ') }, 422);
                const r = await db.execute('INSERT INTO price_list_service_rates (price_list_id, service_id, weight_rate, tax_id, is_active) VALUES (?,?,?,?,1)', [priceListId, payload.service_id, toFloat(payload.weight_rate), taxOrNull(payload)]);
                await rec('create', 'universal-' + r.insertId, null, payload);
                return json({ success: true, id: Number(r.insertId) });
            }
            case 'update': {
                const id = toInt(payload.id);
                const old = await findRow(id);
                if (!old)
                    return json({ success: false, message: 'Rate not found.' }, 404);
                const errors = await validateService();
                if (negOrBad(payload.weight_rate))
                    errors.push('Weight rate must be a valid non-negative number.');
                if (!errors.length && (await db.query('SELECT id FROM price_list_service_rates WHERE price_list_id = ? AND service_id = ? AND id != ?', [priceListId, toInt(payload.service_id), id])).length) {
                    errors.push('A rate for this service already exists in this price list.');
                }
                if (errors.length)
                    return json({ success: false, message: errors.join(' ') }, 422);
                await db.execute('UPDATE price_list_service_rates SET service_id=?, weight_rate=?, tax_id=? WHERE id=?', [payload.service_id, toFloat(payload.weight_rate), taxOrNull(payload), id]);
                await rec('edit', 'universal-' + id, old, payload);
                return json({ success: true });
            }
            case 'toggle': {
                const id = toInt(payload.id);
                const row = await findRow(id);
                if (!row)
                    return json({ success: false, message: 'Rate not found.' }, 404);
                const nv = row.is_active ? 0 : 1;
                await db.execute('UPDATE price_list_service_rates SET is_active = ? WHERE id = ?', [nv, id]);
                await rec('edit', 'universal-' + id, { is_active: row.is_active }, { is_active: nv });
                return json({ success: true });
            }
            case 'delete': {
                const id = toInt(payload.id);
                const row = await findRow(id);
                if (!row)
                    return json({ success: false, message: 'Rate not found.' }, 404);
                await db.execute('DELETE FROM price_list_service_rates WHERE id = ?', [id]);
                await rec('delete', 'universal-' + id, row, null);
                return json({ success: true });
            }
            default: return json({ success: false, message: 'Unknown action.' }, 400);
        }
    });
}
