import type { FastifyInstance } from 'fastify';
import { WebText, webPage } from '../context.js';
import { int } from '../format.js';
import { jsonEncode } from '../html.js';

type Row = Record<string, any>;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown) => parseFloat(String(v ?? "")) || 0;

/** Web (session) POS lookup APIs: api/garments_for_pos.php, pos_get_rate.php, pos_get_universal_rate.php. */
export function registerPosApis(app: FastifyInstance) {
  const { db, pricing, wallet } = app.services;
  const json = (d: unknown, status = 200) => new WebText(jsonEncode(d), status, 'application/json');

  webPage(app, '/api/garments_for_pos', { auth: 'pos.create', methods: ['GET'] }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const categoryId = int(q.category_id), serviceId = int(q.service_id), priceListId = int(q.price_list_id);
    const search = clean(q.q);
    let where = 'g.is_active = 1';
    const params: unknown[] = [];
    if (categoryId) { where += ' AND g.category_id = ?'; params.push(categoryId); }
    if (search !== '') { where += ' AND (g.garment_name LIKE ? OR g.sku LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    const garments = await db.query<Row>(`SELECT g.id, g.garment_name, g.sku, g.image, g.unit, g.default_service_id FROM garments g WHERE ${where} ORDER BY g.garment_name LIMIT 100`, params);
    const cache = new Map<number, string>();
    const billingUnit = async (svcId: number) => {
      if (!cache.has(svcId)) {
        const r = (await db.query<Row>('SELECT billing_unit FROM services WHERE id = ?', [svcId]))[0];
        cache.set(svcId, r && r.billing_unit ? String(r.billing_unit) : 'piece');
      }
      return cache.get(svcId)!;
    };
    const results: Row[] = [];
    for (const g of garments) {
      const svcId = serviceId || int(g.default_service_id);
      const rate = priceListId && svcId ? await pricing.getRate(priceListId, Number(g.id), svcId) : null;
      const unit = svcId ? await billingUnit(svcId) : 'piece';
      let hasPrice: boolean, displayRate: number | null;
      if (unit === 'weight') { hasPrice = rate !== null && rate.weight_rate !== null; displayRate = hasPrice ? num(rate!.weight_rate) : null; }
      else { hasPrice = rate !== null && rate.piece_rate !== null; displayRate = hasPrice ? num(rate!.piece_rate) : null; }
      results.push({
        id: g.id, name: g.garment_name, sku: g.sku, image: g.image ? ctx.baseUrl(`uploads/garments/${g.image}`) : null, unit: g.unit,
        default_service_id: int(g.default_service_id), piece_rate: rate ? num(rate.piece_rate) : null,
        weight_rate: rate && rate.weight_rate !== null ? num(rate.weight_rate) : null, has_price: rate !== null,
        billing_unit: unit, display_rate: displayRate, display_has_price: hasPrice,
      });
    }
    return json({ success: true, garments: results });
  });

  webPage(app, '/api/pos_get_rate', { auth: 'pos.create', methods: ['GET'] }, async (_ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const garmentId = int(q.garment_id), serviceId = int(q.service_id), priceListId = int(q.price_list_id);
    if (!garmentId || !serviceId || !priceListId) return json({ success: false, message: 'garment_id, service_id and price_list_id are required.' }, 400);
    const service = (await db.query<Row>('SELECT billing_unit, service_name FROM services WHERE id = ?', [serviceId]))[0];
    const billingUnit = service?.billing_unit ?? 'piece';
    const rate = await pricing.getRate(priceListId, garmentId, serviceId);
    if (rate === null) return json({ success: false, message: 'No price configured for this garment/service.', billing_unit: billingUnit });
    if (billingUnit === 'weight' && rate.weight_rate === null) return json({ success: false, message: 'This garment/service is not configured for weight-based pricing.', billing_unit: billingUnit });
    return json({
      success: true, piece_rate: num(rate.piece_rate), weight_rate: rate.weight_rate !== null ? num(rate.weight_rate) : null,
      min_weight_charge: rate.min_weight_charge !== null ? num(rate.min_weight_charge) : null, tax_name: rate.tax_name,
      tax_percent: num(rate.tax_percent ?? 0) || 0, source_list_type: rate.list_type, billing_unit: billingUnit, service_name: service?.service_name ?? '',
    });
  });

  webPage(app, '/api/pos_get_universal_rate', { auth: 'pos.create', methods: ['GET'] }, async (_ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const serviceId = int(q.service_id), priceListId = int(q.price_list_id);
    if (!serviceId || !priceListId) return json({ success: false, message: 'service_id and price_list_id are required.' }, 400);
    const service = (await db.query<Row>('SELECT billing_unit, service_name, pricing_scope FROM services WHERE id = ?', [serviceId]))[0];
    if (!service) return json({ success: false, message: 'Service not found.' });
    if (service.pricing_scope !== 'universal') return json({ success: false, message: `${service.service_name} is a garment-specific service — use the normal Add Garment flow, not this common-service entry.` });
    const rate = await pricing.getUniversalRate(priceListId, serviceId);
    if (rate === null) return json({ success: false, message: `No price configured for ${service.service_name} in this price list.`, billing_unit: service.billing_unit });
    return json({
      success: true, weight_rate: num(rate.weight_rate), min_weight_charge: rate.min_weight_charge !== null ? num(rate.min_weight_charge) : null,
      tax_name: rate.tax_name, tax_percent: num(rate.tax_percent ?? 0) || 0, source_list_type: rate.list_type, billing_unit: service.billing_unit, service_name: service.service_name,
    });
  });

  webPage(app, '/api/customer_pos_summary', { auth: 'pos.create', methods: ['GET'] }, async (_ctx, req) => {
    const customerId = int((req.query as Record<string, unknown>).customer_id);
    if (!customerId) return json({ success: false, message: 'Customer required.' }, 400);
    const customer = (await db.query<Row>('SELECT c.*, pl.price_list_name FROM customers c LEFT JOIN price_lists pl ON pl.id = c.price_list_id WHERE c.id = ? AND c.is_active = 1', [customerId]))[0];
    if (!customer) return json({ success: false, message: 'Customer not found or inactive.' }, 404);
    const outstanding = num((await db.query<Row>('SELECT COALESCE(SUM(due_amount),0) AS s FROM accounts_receivable WHERE customer_id = ? AND due_amount > 0', [customerId]))[0]!.s);
    const walletBalance = await wallet.getBalance(customerId);
    let resolvedId: number | null = null;
    let resolvedName: string | null = null;
    try {
      resolvedId = await pricing.resolvePriceListId(customerId);
      resolvedName = (await db.query<Row>('SELECT price_list_name, list_type FROM price_lists WHERE id = ?', [resolvedId]))[0]?.price_list_name ?? null;
    } catch { resolvedId = null; resolvedName = null; }
    return json({
      success: true,
      customer: {
        id: customer.id,
        name: `${customer.title ?? ''} ${customer.full_name}`.trim(),
        mobile: customer.mobile,
        address: `${customer.address ?? ''} ${customer.area ?? ''}`.trim(),
        home_delivery: !!customer.home_delivery,
        discount_percent: num(customer.discount_percent),
      },
      price_list_id: resolvedId,
      price_list_name: resolvedName ?? 'No active Default price list configured',
      outstanding,
      wallet_balance: walletBalance,
    });
  });
}
