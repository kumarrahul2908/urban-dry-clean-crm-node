import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, num, numOrNull, ok } from '../../lib/http.js';
import { qInt, qStr } from '../../lib/query.js';
import { listProductsWithRates } from '../../services/catalog.js';

type Q = Record<string, unknown>;

/**
 * Ports of the product / rate endpoints under api/mobile/: pos_categories, pos_brands, pos_colors,
 * pos_defects, pos_services, laundry_services, urgent_levels, payment_types, pos_available_stores,
 * pos_garments, pos_rate, pos_universal_rate, garments_catalog_list — plus NEW `products`
 * (garment list with rates in one call). Each is also served at `<name>.php`.
 */
export async function registerMobileCatalogRoutes(app: FastifyInstance) {
  const { db, pricing, env } = app.services;
  const both = (name: string, handler: (req: FastifyRequest) => Promise<unknown>) => {
    app.get(`/${name}`, handler);
    app.get(`/${name}.php`, handler);
  };
  const posUser = async (req: FastifyRequest) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'pos.create');
    return ctx;
  };

  // ---- simple lookup lists (pos.create) -------------------------------------------------
  const lookups: [string, string, string, (r: any) => unknown][] = [
    ['pos_categories', 'categories', 'SELECT id, category_name FROM categories WHERE is_active=1 ORDER BY sort_order', (r) => r],
    ['pos_brands', 'brands', 'SELECT id, brand_name FROM brands WHERE is_active=1 ORDER BY sort_order', (r) => r],
    ['pos_colors', 'colors', 'SELECT id, color_name FROM colors WHERE is_active=1 ORDER BY sort_order', (r) => r],
    ['pos_defects', 'defects', 'SELECT id, defect_name FROM defects WHERE is_active=1 ORDER BY sort_order', (r) => r],
    ['pos_services', 'services', "SELECT id, service_name FROM services WHERE is_active=1 AND billing_unit='piece' ORDER BY sort_order", (r) => r],
    [
      'laundry_services',
      'services',
      "SELECT id, service_name FROM services WHERE is_active=1 AND billing_unit='weight' AND pricing_scope='universal' ORDER BY sort_order",
      (r) => r,
    ],
    [
      'urgent_levels',
      'urgent_levels',
      'SELECT id, level_name, surcharge_percent, day_offset FROM urgent_levels WHERE is_active=1 ORDER BY sort_order',
      (r) => ({ id: num(r.id), level_name: r.level_name, surcharge_percent: num(r.surcharge_percent), day_offset: num(r.day_offset) }),
    ],
  ];
  for (const [name, key, sql, map] of lookups) {
    both(name, async (req) => {
      await posUser(req);
      const rows = await db.query<Record<string, unknown>>(sql);
      return ok({ [key]: rows.map(map) });
    });
  }

  both('payment_types', async (req) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'payments.collect');
    const rows = await db.query<{ id: number; type_name: string }>(
      "SELECT id, type_name FROM payment_types WHERE is_active = 1 AND type_name != 'Wallet' ORDER BY sort_order, type_name",
    );
    return ok({ payment_types: rows.map((r) => ({ id: num(r.id), type_name: r.type_name })) });
  });

  both('pos_available_stores', async (req) => {
    const ctx = await app.requireToken(req);
    if (ctx.store_id !== null) {
      const rows = await db.query<{ id: number; store_name: string }>('SELECT id, store_name FROM stores WHERE id = ? AND is_active = 1', [ctx.store_id]);
      return ok({ stores: rows.map((r) => ({ id: num(r.id), store_name: r.store_name })), is_fixed: true });
    }
    const rows = await db.query<{ id: number; store_name: string }>('SELECT id, store_name FROM stores WHERE is_active = 1 ORDER BY store_name');
    return ok({ stores: rows.map((r) => ({ id: num(r.id), store_name: r.store_name })), is_fixed: false });
  });

  // ---- garments for POS, with a display rate -------------------------------------------
  both('pos_garments', async (req) => {
    await posUser(req);
    const q = req.query as Q;
    const categoryId = qInt(q.category_id);
    const serviceId = qInt(q.service_id);
    const search = qStr(q.q);
    const priceListId = qInt(q.price_list_id);

    const where = ['g.is_active = 1'];
    const params: unknown[] = [];
    if (categoryId) { where.push('g.category_id = ?'); params.push(categoryId); }
    if (search !== '') { where.push('(g.garment_name LIKE ? OR g.sku LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const garments = await db.query<{ id: number; garment_name: string; sku: string | null; unit: string; default_service_id: number | null }>(
      `SELECT g.id, g.garment_name, g.sku, g.unit, g.default_service_id FROM garments g WHERE ${where.join(' AND ')} ORDER BY g.garment_name LIMIT 100`,
      params,
    );

    const unitCache = new Map<number, string>();
    const billingUnit = async (svcId: number) => {
      if (!unitCache.has(svcId)) {
        const r = await db.query<{ billing_unit: string }>('SELECT billing_unit FROM services WHERE id = ?', [svcId]);
        unitCache.set(svcId, r[0]?.billing_unit || 'piece');
      }
      return unitCache.get(svcId)!;
    };

    const results = [];
    for (const g of garments) {
      const svcId = serviceId || num(g.default_service_id ?? 0);
      const rate = priceListId && svcId ? await pricing.getRate(priceListId, num(g.id), svcId) : null;
      const unit = svcId ? await billingUnit(svcId) : 'piece';
      let hasPrice: boolean;
      let displayRate: number | null;
      if (unit === 'weight') {
        hasPrice = rate !== null && rate.weight_rate !== null;
        displayRate = hasPrice ? num(rate!.weight_rate) : null;
      } else {
        hasPrice = rate !== null && rate.piece_rate !== null && rate.piece_rate !== undefined;
        displayRate = hasPrice ? num(rate!.piece_rate) : null;
      }
      results.push({
        id: num(g.id),
        name: g.garment_name,
        sku: g.sku,
        unit: g.unit,
        default_service_id: num(g.default_service_id ?? 0),
        billing_unit: unit,
        display_rate: displayRate,
        display_has_price: hasPrice,
      });
    }
    return ok({ garments: results });
  });

  // ---- a single rate -------------------------------------------------------------------
  both('pos_rate', async (req) => {
    await posUser(req);
    const q = req.query as Q;
    const garmentId = qInt(q.garment_id);
    const serviceId = qInt(q.service_id);
    const priceListId = qInt(q.price_list_id);
    if (!garmentId || !serviceId || !priceListId) {
      throw new ApiError('invalid_request', 'garment_id, service_id and price_list_id are required.', 422);
    }
    const svc = (await db.query<{ billing_unit: string; service_name: string }>('SELECT billing_unit, service_name FROM services WHERE id = ?', [serviceId]))[0];
    const billingUnit = svc?.billing_unit ?? 'piece';
    const rate = await pricing.getRate(priceListId, garmentId, serviceId);
    if (rate === null) throw new ApiError('no_price_configured', 'No price configured for this garment/service.', 404, { billing_unit: billingUnit });
    if (billingUnit === 'weight' && rate.weight_rate === null) {
      throw new ApiError('no_price_configured', 'This garment/service is not configured for weight-based pricing.', 404, { billing_unit: billingUnit });
    }
    return ok({
      piece_rate: num(rate.piece_rate),
      weight_rate: numOrNull(rate.weight_rate),
      min_weight_charge: numOrNull(rate.min_weight_charge),
      tax_name: rate.tax_name,
      tax_percent: num(rate.tax_percent ?? 0),
      source_list_type: rate.list_type,
      billing_unit: billingUnit,
      service_name: svc?.service_name ?? '',
    });
  });

  both('pos_universal_rate', async (req) => {
    await posUser(req);
    const q = req.query as Q;
    const serviceId = qInt(q.service_id);
    const priceListId = qInt(q.price_list_id);
    if (!serviceId || !priceListId) throw new ApiError('invalid_request', 'service_id and price_list_id are required.', 422);
    const svc = (await db.query<{ billing_unit: string; service_name: string; pricing_scope: string }>(
      'SELECT billing_unit, service_name, pricing_scope FROM services WHERE id = ?',
      [serviceId],
    ))[0];
    if (!svc) throw new ApiError('not_found', 'Service not found.', 404);
    if (svc.pricing_scope !== 'universal') {
      throw new ApiError('invalid_request', `${svc.service_name} is a garment-specific service — use pos_rate.php instead.`, 422);
    }
    const rate = await pricing.getUniversalRate(priceListId, serviceId);
    if (rate === null) {
      throw new ApiError('no_price_configured', `No price configured for ${svc.service_name} in this price list.`, 404, { billing_unit: svc.billing_unit });
    }
    return ok({
      weight_rate: num(rate.weight_rate),
      min_weight_charge: numOrNull(rate.min_weight_charge),
      tax_name: rate.tax_name,
      tax_percent: num(rate.tax_percent ?? 0),
      source_list_type: rate.list_type,
      billing_unit: svc.billing_unit,
      service_name: svc.service_name,
    });
  });

  // ---- garment catalog management list (garment.edit | garments.manage) ----------------
  both('garments_catalog_list', async (req) => {
    const ctx = await app.requireToken(req);
    if (!ctx.permissions.includes('garment.edit') && !ctx.permissions.includes('garments.manage')) {
      throw new ApiError('forbidden', 'You do not have permission to perform this action.', 403);
    }
    const q = req.query as Q;
    const search = qStr(q.q);
    const categoryId = qInt(q.category_id);
    const page = Math.max(1, qInt(q.page));
    const perPage = 50;
    const where = ['1=1'];
    const params: unknown[] = [];
    if (categoryId) { where.push('g.category_id = ?'); params.push(categoryId); }
    if (search !== '') { where.push('(g.garment_name LIKE ? OR g.sku LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const w = where.join(' AND ');
    const [{ n }] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM garments g WHERE ${w}`, params)) as [{ n: number }];
    const rows = await db.query<Record<string, any>>(
      `SELECT g.id, g.garment_name, g.sku, g.image, g.is_active, g.category_id, c.category_name
       FROM garments g LEFT JOIN categories c ON c.id = g.category_id WHERE ${w}
       ORDER BY c.category_name, g.garment_name, g.id LIMIT ? OFFSET ?`,
      [...params, perPage, (page - 1) * perPage],
    );
    const cats = await db.query<{ id: number; category_name: string }>('SELECT id, category_name FROM categories WHERE is_active = 1 ORDER BY sort_order, category_name');
    const base = env.APP_URL.replace(/\/+$/, '');
    return ok({
      garments: rows.map((g) => ({
        id: num(g.id),
        garment_name: g.garment_name,
        sku: g.sku,
        category_id: g.category_id !== null ? num(g.category_id) : null,
        category_name: g.category_name,
        is_active: !!g.is_active,
        image_url: g.image ? `${base}/uploads/garments/${g.image}` : null,
      })),
      categories: cats.map((c) => ({ id: num(c.id), category_name: c.category_name })),
      page,
      per_page: perPage,
      total: num(n),
    });
  });

  // ---- NEW: product list with rates ----------------------------------------------------
  // GET /api/mobile/products?customer_id=&price_list_id=&category_id=&q=&page=&per_page=
  // price list = explicit price_list_id, else the customer's list, else the Default list.
  app.get('/products', async (req) => {
    await posUser(req);
    const q = req.query as Q;
    let priceListId = qInt(q.price_list_id);
    if (!priceListId) priceListId = await pricing.resolvePriceListId(qInt(q.customer_id) || null);
    const perPage = Math.min(500, Math.max(1, qInt(q.per_page) || 100));
    return ok(
      await listProductsWithRates(db, pricing, {
        priceListId,
        categoryId: qInt(q.category_id) || undefined,
        search: qStr(q.q) || undefined,
        page: Math.max(1, qInt(q.page)),
        perPage,
      }),
    );
  });
}
