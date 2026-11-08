import { num, numOrNull } from '../lib/http.js';
const rateOut = (svc, r) => ({
    service_id: Number(svc.id),
    service_name: svc.service_name,
    billing_unit: svc.billing_unit,
    piece_rate: numOrNull(r.piece_rate),
    weight_rate: numOrNull(r.weight_rate),
    min_weight_charge: numOrNull(r.min_weight_charge),
    tax_name: r.tax_name,
    tax_percent: num(r.tax_percent ?? 0),
    source_list_type: r.list_type,
});
/**
 * NEW (no PHP equivalent): product list WITH rates in one call, so the app does not need one
 * pos_rate request per garment/service. Rate resolution is identical to PricingEngine.getRate():
 * the requested price list first, then the Default list for every garment/service pair the
 * requested list does not price. A pair with no rate in either list is simply absent from `rates`
 * (never a made-up zero).
 */
export async function listProductsWithRates(db, pricing, q) {
    const where = ['g.is_active = 1'];
    const params = [];
    if (q.categoryId) {
        where.push('g.category_id = ?');
        params.push(q.categoryId);
    }
    if (q.search) {
        where.push('(g.garment_name LIKE ? OR g.sku LIKE ?)');
        params.push(`%${q.search}%`, `%${q.search}%`);
    }
    const w = where.join(' AND ');
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM garments g WHERE ${w}`, params);
    const garments = await db.query(`SELECT g.id, g.garment_name, g.sku, g.unit, g.image, g.category_id, c.category_name, g.default_service_id
     FROM garments g LEFT JOIN categories c ON c.id = g.category_id
     WHERE ${w} ORDER BY c.sort_order, c.category_name, g.garment_name, g.id LIMIT ? OFFSET ?`, [...params, q.perPage, (q.page - 1) * q.perPage]);
    const services = await db.query('SELECT id, service_name, billing_unit, pricing_scope FROM services WHERE is_active = 1 ORDER BY sort_order, id');
    const garmentServices = services.filter((s) => s.pricing_scope === 'garment');
    const universalServices = services.filter((s) => s.pricing_scope === 'universal');
    // Lists to read: the requested one, then the Default fallback (same order as getRate()).
    const listIds = [q.priceListId];
    const defaultId = await pricing.resolvePriceListId(null).catch(() => null);
    const requestedIsDefault = (await db.query('SELECT list_type FROM price_lists WHERE id = ?', [q.priceListId]))[0]?.list_type === 'Default';
    if (defaultId !== null && defaultId !== q.priceListId && !requestedIsDefault)
        listIds.push(defaultId);
    const itemsByKey = new Map();
    if (garments.length) {
        const rows = await db.query(`SELECT pli.price_list_id, pli.garment_id, pli.service_id, pli.piece_rate, pli.weight_rate, pli.min_weight_charge,
              pli.tax_id, t.tax_name, t.tax_percent, pl.list_type
       FROM price_list_items pli JOIN price_lists pl ON pl.id = pli.price_list_id
       LEFT JOIN taxes t ON t.id = pli.tax_id
       WHERE pli.is_active = 1 AND pli.price_list_id IN (?) AND pli.garment_id IN (?)`, [listIds, garments.map((g) => g.id)]);
        // Iterate lists in priority order and keep the first hit per (garment, service).
        for (const lid of listIds) {
            for (const r of rows) {
                const key = `${r.garment_id}:${r.service_id}`;
                if (Number(r.price_list_id) === lid && !itemsByKey.has(key))
                    itemsByKey.set(key, r);
            }
        }
    }
    const universal = [];
    if (universalServices.length) {
        const rows = await db.query(`SELECT plsr.price_list_id, plsr.service_id, plsr.weight_rate, plsr.min_weight_charge, plsr.tax_id, t.tax_name, t.tax_percent, pl.list_type
       FROM price_list_service_rates plsr JOIN price_lists pl ON pl.id = plsr.price_list_id
       LEFT JOIN taxes t ON t.id = plsr.tax_id
       WHERE plsr.is_active = 1 AND plsr.price_list_id IN (?) AND plsr.service_id IN (?)`, [listIds, universalServices.map((s) => s.id)]);
        for (const s of universalServices) {
            for (const lid of listIds) {
                const hit = rows.find((r) => Number(r.service_id) === Number(s.id) && Number(r.price_list_id) === lid);
                if (hit) {
                    universal.push(rateOut(s, hit));
                    break;
                }
            }
        }
    }
    const [pl] = await db.query('SELECT id, price_list_name, list_type FROM price_lists WHERE id = ?', [q.priceListId]);
    return {
        price_list: pl ? { id: Number(pl.id), name: pl.price_list_name, type: pl.list_type } : null,
        garments: garments.map((g) => ({
            id: Number(g.id),
            name: g.garment_name,
            sku: g.sku,
            unit: g.unit,
            category_id: Number(g.category_id),
            category_name: g.category_name,
            image: g.image,
            default_service_id: g.default_service_id !== null ? Number(g.default_service_id) : null,
            rates: garmentServices.flatMap((s) => {
                const hit = itemsByKey.get(`${g.id}:${s.id}`);
                if (!hit)
                    return [];
                // Same "has price" rule as pos_garments.php: weight services need weight_rate, piece services piece_rate.
                if (s.billing_unit === 'weight' ? hit.weight_rate === null : hit.piece_rate === null || hit.piece_rate === undefined)
                    return [];
                return [rateOut(s, hit)];
            }),
        })),
        universal_services: universal,
        page: q.page,
        per_page: q.perPage,
        total: Number(n),
    };
}
