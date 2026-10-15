import type { FastifyInstance } from 'fastify';
import { WebText, webPage } from '../context.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplTrackPage } from '../tpl/track_page.js';

type Row = Record<string, any>;

/** track.php — public QR landing page (token only, no login, no sensitive data). */
export function registerTrackPage(app: FastifyInstance) {
  const { db, audit } = app.services;
  webPage(app, '/track', { auth: 'public', methods: ['GET'] }, async (ctx, req) => {
    const t = (req.query as Record<string, unknown>).token;
    const token = typeof t === 'string' ? t.trim() : '';
    let order: Row | null = null;
    let items: Row[] = [];
    if (token !== '' && /^[a-f0-9]{32}$/.test(token)) {
      order = (await db.query<Row>(
        `SELECT o.id, o.order_number, o.order_date, o.due_date, o.due_time, os.status_label, os.color AS status_color, o.order_mode, c.full_name AS customer_name
         FROM barcodes bc JOIN orders o ON o.id = bc.order_id JOIN order_statuses os ON os.id = o.status_id JOIN customers c ON c.id = o.customer_id WHERE bc.qr_token = ?`, [token]))[0] ?? null;
      if (order && order.order_mode === 'weight') {
        items = await db.query<Row>(
          `SELECT lg.id, g.garment_name, s.service_name, s.billing_unit, oi.weight, oi.weight_rate, oi.item_status, bc.item_sequence, oi.quantity AS total_garments
           FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id
           LEFT JOIN barcodes bc ON bc.laundry_garment_id = lg.id WHERE oi.order_id = ? ORDER BY oi.id, bc.item_sequence`, [order.id]);
      } else if (order) {
        items = await db.query<Row>(
          `SELECT oi.id, oi.quantity, oi.weight, oi.unit, oi.item_status, oi.remarks, g.garment_name, s.service_name, s.billing_unit, col.color_name, br.brand_name
           FROM order_items oi JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN colors col ON col.id = oi.color_id LEFT JOIN brands br ON br.id = oi.brand_id
           WHERE oi.order_id = ? ORDER BY oi.id`, [order.id]);
      }
      await audit.record({ action: 'lookup', module: 'track', recordId: String(order?.id ?? 'qr:' + token.slice(0, 8)), newValue: { found: !!order }, userId: ctx.data.user_id ?? null, ip: req.ip });
    }
    const businessName = (await ctx.setting('business_name', ctx.svc.env.APP_NAME || 'Urban Dry Clean')) ?? '';
    const logoPath = (await ctx.setting('logo_path', '')) ?? '';
    const h = await tplHelpers(ctx, { phpDate: (fmt: string) => ctx.date(Math.floor(Date.now() / 1000), fmt) });
    return new WebText(tplTrackPage({ businessName, items, logoPath, order }, h), 200, 'text/html; charset=utf-8');
  });
}
