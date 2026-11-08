import { getSetting } from './settings.js';
export class NoDefaultPriceListError extends Error {
    constructor() {
        super('No active Default price list is configured. Please configure one under Price Lists before creating orders.');
    }
}
/**
 * Port of includes/PricingEngine.php. Same rules: customer's active list → settings
 * default_price_list_id → first active Default list; a missing rate falls back to the Default
 * list (unless the requested list already is the Default); never returns a made-up zero rate —
 * null means "no price configured".
 */
export class PricingEngine {
    db;
    constructor(db) {
        this.db = db;
    }
    async resolvePriceListId(customerId) {
        if (customerId) {
            const r = await this.db.query('SELECT pl.id FROM customers c JOIN price_lists pl ON pl.id = c.price_list_id WHERE c.id = ? AND pl.is_active = 1', [customerId]);
            if (r[0])
                return Number(r[0].id);
        }
        const defaultId = Number((await getSetting(this.db, 'default_price_list_id', '0')) ?? 0);
        if (defaultId) {
            const r = await this.db.query("SELECT id FROM price_lists WHERE id = ? AND is_active = 1 AND list_type = 'Default'", [defaultId]);
            if (r[0])
                return Number(r[0].id);
        }
        const r = await this.db.query("SELECT id FROM price_lists WHERE list_type = 'Default' AND is_active = 1 ORDER BY id LIMIT 1");
        if (r[0])
            return Number(r[0].id);
        throw new NoDefaultPriceListError();
    }
    async listType(priceListId) {
        const r = await this.db.query('SELECT list_type FROM price_lists WHERE id = ?', [priceListId]);
        return r[0]?.list_type;
    }
    /** Default list id to fall back to, or null when the requested list is Default / no Default exists. */
    async fallbackListId(priceListId) {
        if ((await this.listType(priceListId)) === 'Default')
            return null;
        try {
            const id = await this.resolvePriceListId(null);
            return id === priceListId ? null : id;
        }
        catch (e) {
            if (e instanceof NoDefaultPriceListError)
                return null;
            throw e;
        }
    }
    async garmentRateIn(listId, garmentId, serviceId) {
        const r = await this.db.query(`SELECT pli.piece_rate, pli.weight_rate, pli.min_weight_charge, pli.tax_id, t.tax_name, t.tax_percent, pl.list_type
       FROM price_list_items pli
       JOIN price_lists pl ON pl.id = pli.price_list_id
       LEFT JOIN taxes t ON t.id = pli.tax_id
       WHERE pli.price_list_id = ? AND pli.garment_id = ? AND pli.service_id = ? AND pli.is_active = 1`, [listId, garmentId, serviceId]);
        return r[0] ?? null;
    }
    async getRate(priceListId, garmentId, serviceId) {
        const row = await this.garmentRateIn(priceListId, garmentId, serviceId);
        if (row)
            return row;
        const fb = await this.fallbackListId(priceListId);
        return fb === null ? null : this.garmentRateIn(fb, garmentId, serviceId);
    }
    async universalRateIn(listId, serviceId) {
        const r = await this.db.query(`SELECT plsr.weight_rate, plsr.min_weight_charge, plsr.tax_id, t.tax_name, t.tax_percent, pl.list_type
       FROM price_list_service_rates plsr
       JOIN price_lists pl ON pl.id = plsr.price_list_id
       LEFT JOIN taxes t ON t.id = plsr.tax_id
       WHERE plsr.price_list_id = ? AND plsr.service_id = ? AND plsr.is_active = 1`, [listId, serviceId]);
        return r[0] ?? null;
    }
    async getUniversalRate(priceListId, serviceId) {
        const row = await this.universalRateIn(priceListId, serviceId);
        if (row)
            return row;
        const fb = await this.fallbackListId(priceListId);
        return fb === null ? null : this.universalRateIn(fb, serviceId);
    }
    async isUniversalService(serviceId) {
        const r = await this.db.query('SELECT pricing_scope FROM services WHERE id = ?', [serviceId]);
        return r[0]?.pricing_scope === 'universal';
    }
}
