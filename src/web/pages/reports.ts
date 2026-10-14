import type { FastifyInstance } from 'fastify';
import { phpRound, toFloat } from '../../lib/php.js';
import { WebText, webPage } from '../context.js';
import { csvBody } from '../csv.js';
import { httpBuildQuery } from '../format.js';
import { raw } from '../html.js';
import { layout } from '../layout.js';
import { tplHelpers } from '../tplHelpers.js';
import { tplReportsIndex } from '../tpl/reports_index.js';

type Row = Record<string, any>;
const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerReportPages(app: FastifyInstance) {
  const { db } = app.services;
  webPage(app, '/modules/reports/index', { auth: 'reports.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const today = ctx.today;
    const monthStart = today.slice(0, 8) + '01';
    let dateFrom = 'date_from' in q ? clean(q.date_from) : monthStart;
    let dateTo = 'date_to' in q ? clean(q.date_to) : today;
    if (!DATE_RE.test(dateFrom)) dateFrom = monthStart;
    if (!DATE_RE.test(dateTo)) dateTo = today;

    const fixed = ctx.fixedStoreId();
    const allowed = fixed !== null ? [fixed] : null;
    const sfSql = allowed ? ` AND o.store_id IN (${allowed.map(() => '?').join(',')})` : '';
    const sfParams: unknown[] = allowed ?? [];
    const one = async (sql: string, params: unknown[]) => (await db.query<Row>(sql, params))[0]!;
    const range: unknown[] = [dateFrom, dateTo];

    const orderStats = await one(`SELECT COUNT(*) AS order_count, COALESCE(SUM(grand_total),0) AS order_value, COALESCE(AVG(grand_total),0) AS avg_order_value FROM orders o WHERE DATE(order_date) BETWEEN ? AND ?${sfSql}`, [...range, ...sfParams]);
    const byStatus = await db.query<Row>(`SELECT os.status_label, os.color, COUNT(*) AS cnt FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE DATE(o.order_date) BETWEEN ? AND ?${sfSql} GROUP BY os.id ORDER BY os.sort_order`, [...range, ...sfParams]);
    const byService = await db.query<Row>(`SELECT s.service_name, s.billing_unit, COUNT(*) AS item_count, COALESCE(SUM(oi.total),0) AS revenue FROM order_items oi JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = oi.order_id WHERE DATE(o.order_date) BETWEEN ? AND ?${sfSql} GROUP BY s.id ORDER BY revenue DESC`, [...range, ...sfParams]);
    const byGarment = await db.query<Row>(
      `SELECT garment_name, SUM(item_count) AS item_count, SUM(revenue) AS revenue FROM (
         SELECT g.garment_name, 1 AS item_count, oi.total AS revenue FROM order_items oi JOIN garments g ON g.id = oi.garment_id JOIN orders o ON o.id = oi.order_id
         WHERE o.order_mode = 'piece' AND DATE(o.order_date) BETWEEN ? AND ?${sfSql}
         UNION ALL
         SELECT g.garment_name, 1 AS item_count, NULL AS revenue FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN garments g ON g.id = lg.garment_id JOIN orders o ON o.id = oi.order_id
         WHERE DATE(o.order_date) BETWEEN ? AND ?${sfSql}
       ) combined GROUP BY garment_name ORDER BY item_count DESC LIMIT 15`, [...range, ...sfParams, ...range, ...sfParams]);

    const collectionRows = await db.query<Row>(
      `SELECT pt.type_name, COALESCE(SUM(ptx.amount),0) AS total, p.payment_kind FROM payment_transactions ptx JOIN payments p ON p.id = ptx.payment_id JOIN payment_types pt ON pt.id = ptx.payment_type_id
       JOIN orders o ON o.id = p.order_id WHERE DATE(p.payment_date) BETWEEN ? AND ?${sfSql} GROUP BY pt.id, p.payment_kind ORDER BY pt.sort_order`, [...range, ...sfParams]);
    const collections = new Map<string, number>(), refunds = new Map<string, number>();
    for (const r of collectionRows) {
      const m = r.payment_kind === 'Refund' ? refunds : collections;
      m.set(r.type_name, (m.get(r.type_name) ?? 0) + toFloat(r.total));
    }
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const totalCollected = phpRound(sum(collections), 2), totalRefunded = phpRound(sum(refunds), 2);
    const advanceDeposits = phpRound(toFloat((await one("SELECT COALESCE(SUM(credit),0) AS v FROM wallet_transactions WHERE DATE(created_at) BETWEEN ? AND ? AND txn_type = 'Deposit'", range)).v), 2);
    const paidStatus = await one(`SELECT SUM(ar.due_amount <= 0.01) AS paid, SUM(ar.due_amount > 0.01 AND ar.paid_amount > 0.01) AS partial, SUM(ar.due_amount > 0.01 AND ar.paid_amount <= 0.01) AS unpaid FROM accounts_receivable ar JOIN orders o ON o.id = ar.order_id WHERE ar.status = 'Open'${sfSql}`, sfParams);

    const newCustomers = Number((await one('SELECT COUNT(*) AS n FROM customers WHERE DATE(created_at) BETWEEN ? AND ?', range)).n);
    const topCustomers = await db.query<Row>(
      `SELECT c.full_name, c.mobile, COUNT(o.id) AS order_count, COALESCE(SUM(o.grand_total),0) AS revenue, COALESCE(SUM(o.current_due),0) AS outstanding
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE DATE(o.order_date) BETWEEN ? AND ?${sfSql} GROUP BY c.id ORDER BY revenue DESC LIMIT 15`, [...range, ...sfParams]);
    const returningCustomers = Number((await one(`SELECT COUNT(*) AS n FROM (SELECT o.customer_id FROM orders o WHERE DATE(o.order_date) BETWEEN ? AND ?${sfSql} GROUP BY o.customer_id HAVING COUNT(*) > 1) t`, [...range, ...sfParams])).n);

    const op = await one(
      `SELECT SUM(oi.item_status = 'Workshop') AS in_workshop, SUM(oi.item_status = 'Processing') AS processing, SUM(oi.item_status = 'QC') AS qc_pending, SUM(oi.item_status = 'Rework') AS in_rework,
       SUM(oi.item_status = 'Ready') AS ready_to_pack, SUM(oi.item_status = 'Packed') AS packed FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE 1=1${sfSql}`, sfParams);
    const qcResult = await one(
      `SELECT SUM(qr.result='Passed') AS passed, SUM(qr.result IN ('Rework','Failed')) AS failed FROM qc_records qr
       LEFT JOIN order_items oi1 ON oi1.id = qr.order_item_id LEFT JOIN orders o1 ON o1.id = oi1.order_id LEFT JOIN laundry_garments lg ON lg.id = qr.laundry_garment_id
       LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id LEFT JOIN orders o2 ON o2.id = oi2.order_id
       WHERE DATE(qr.checked_at) BETWEEN ? AND ?` + (sfSql !== '' ? sfSql.replaceAll('o.store_id', 'COALESCE(o1.store_id, o2.store_id)') : ''), [...range, ...sfParams]);
    const overdueCount = Number((await one(`SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE os.status_key NOT IN ('delivered','cancelled') AND o.due_date < CURDATE()${sfSql}`, sfParams)).n);
    const urgentCount = Number((await one(`SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE os.status_key NOT IN ('delivered','cancelled') AND o.urgent_level_id IS NOT NULL${sfSql}`, sfParams)).n);

    if ('export' in q) {
      const exportType = clean(q.export);
      const dl = (name: string, headers: string[], rows: unknown[][]) => new WebText(csvBody(headers, rows), 200, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
      if (exportType === 'garments') return dl(`garment_report_${dateFrom}_${dateTo}.csv`, ['Garment', 'Item Count', 'Revenue'], byGarment.map((g) => [g.garment_name, g.item_count, g.revenue]));
      if (exportType === 'customers') return dl(`customer_report_${dateFrom}_${dateTo}.csv`, ['Customer', 'Mobile', 'Orders', 'Revenue', 'Outstanding'], topCustomers.map((c) => [c.full_name, c.mobile, c.order_count, c.revenue, c.outstanding]));
    }

    const exportQs = (type: string) => httpBuildQuery({ ...q, export: type });
    const h = await tplHelpers(ctx, { exportQs });
    return layout(ctx, { title: 'Reports' }, raw(tplReportsIndex({
      advanceDeposits, byGarment, byService, byStatus, collections, dateFrom, dateTo, newCustomers, op, orderStats, overdueCount, paidStatus, qcResult, returningCustomers, topCustomers, totalCollected, totalRefunded, urgentCount,
    }, h)));
  });
}
