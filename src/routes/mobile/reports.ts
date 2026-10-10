import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../db/pool.js';
import { addDays, dayMon, isStrtotimeDate, monthStartIn, todayIn } from '../../lib/dates.js';
import { ApiError, num, ok } from '../../lib/http.js';
import { round2, toFloat } from '../../lib/php.js';
import { qInt, qStr } from '../../lib/query.js';
import { auditOptions, fetchAudit, parseFilters, roleAllowed } from '../../services/auditViewer.js';

type Q = Record<string, unknown>;
type Raw = Record<string, any>;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const scalar = async (db: Db, sql: string, params: unknown[] = []): Promise<any> => {
  const [row] = await db.query<Raw>(sql, params);
  return row ? Object.values(row)[0] : 0;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Ports of the read-only dashboard / report endpoints under api/mobile/. */
export async function registerMobileReportRoutes(app: FastifyInstance) {
  const { db, env } = app.services;
  const tz = env.APP_TIMEZONE;

  const route = (name: string, handler: (req: FastifyRequest) => Promise<unknown>) => {
    app.get(`/${name}`, handler);
    app.get(`/${name}.php`, handler);
  };
  const auth = async (req: FastifyRequest, permission: string) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, permission);
    return ctx;
  };
  /** Store scoping used by all dashboards: fixed-store users only see their store. */
  const storeScope = (storeId: number | null, alias = 'o', allowNull = false): [string, unknown[]] => {
    if (storeId === null) return ['', []];
    return [allowNull ? ` AND (${alias}.store_id IS NULL OR ${alias}.store_id IN (?))` : ` AND ${alias}.store_id IN (?)`, [storeId]];
  };
  const noWorkshop = (role: string) => {
    if (role === 'Workshop Staff') throw new ApiError('forbidden', 'The business dashboard is not available for workshop logins.', 403);
  };

  // ---- audit log (Super Admin / Admin) ---------------------------------------------------
  route('audit_logs', async (req) => {
    const ctx = await app.requireToken(req);
    if (!ctx.permissions.includes('audit.view') || !roleAllowed(ctx.role_name)) {
      throw new ApiError('forbidden', 'Only Super Admin and Admin can view the audit log.', 403);
    }
    const q = req.query as Q;
    const parsed = parseFilters(q);
    if (parsed.errors.length) throw new ApiError('validation_failed', parsed.errors[0]!, 422, { field_errors: parsed.errors });
    const result = await fetchAudit(db, parsed.filters);
    const data: Raw = { entries: result.rows, page: result.page, per_page: result.per_page, total: result.total };
    const opt = q.options;
    if (opt !== undefined && opt !== '' && opt !== '0' && opt !== 0 && opt !== false) data.options = await auditOptions(db);
    return ok(data);
  });

  // ---- customer history -------------------------------------------------------------------
  route('customer_history', async (req) => {
    await auth(req, 'customers.view');
    const id = qInt((req.query as Q).id);
    if (id <= 0) throw new ApiError('invalid_request', 'A valid customer id is required.', 422);
    if (!(await db.query('SELECT id FROM customers WHERE id = ?', [id])).length) throw new ApiError('not_found', 'Customer not found.', 404);
    const q = (sql: string, params: unknown[]) => db.query<Raw>(sql, params);
    const orders = await q(`SELECT o.id, o.order_number, o.order_date, o.due_date, o.grand_total, o.current_due, o.order_mode, os.status_label, os.color
                            FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.customer_id = ? ORDER BY o.order_date DESC LIMIT 50`, [id]);
    const payments = await q('SELECT id, payment_number, order_id, payment_date, payment_kind, total_amount, remarks FROM payments WHERE customer_id = ? ORDER BY payment_date DESC LIMIT 50', [id]);
    const garments = await q(
      `SELECT garment_name, service_name, quantity, rate, weight, order_date, order_number, order_id FROM (
         SELECT g.garment_name, s.service_name, oi.quantity,
         CASE WHEN oi.weight IS NOT NULL THEN oi.weight_rate ELSE oi.unit_price END AS rate,
         oi.weight, o.order_date, o.order_number, o.id AS order_id
         FROM order_items oi JOIN garments g ON g.id=oi.garment_id
         JOIN services s ON s.id=oi.service_id JOIN orders o ON o.id=oi.order_id
         WHERE o.customer_id=? AND o.order_mode = 'piece'
         UNION ALL
         SELECT g.garment_name, s.service_name, 1 AS quantity, NULL AS rate, NULL AS weight, o.order_date, o.order_number, o.id AS order_id
         FROM laundry_garments lg
         JOIN order_items oi ON oi.id = lg.order_item_id
         JOIN garments g ON g.id = lg.garment_id
         JOIN services s ON s.id = oi.service_id
         JOIN orders o ON o.id = oi.order_id
         WHERE o.customer_id=?
       ) combined ORDER BY order_date DESC LIMIT 50`, [id, id]);
    const wallet = await q('SELECT id, created_at, txn_type, debit, credit, balance_after, remarks, order_id FROM wallet_transactions WHERE customer_id = ? ORDER BY created_at DESC LIMIT 30', [id]);
    const deliveries = await q('SELECT id, delivery_number, order_id, delivery_date, time_slot, status, amount_due FROM delivery_orders WHERE customer_id = ? ORDER BY delivery_date DESC LIMIT 30', [id]);
    const feedback = await q(`SELECT f.id, f.order_id, o.order_number, f.rating, f.comments, f.status, f.created_at
                              FROM feedback f LEFT JOIN orders o ON o.id = f.order_id WHERE f.customer_id = ? ORDER BY f.created_at DESC LIMIT 20`, [id]);
    const ledger: { date: string; description: string; debit: number; credit: number; order_id: number | null }[] = [];
    for (const o of orders) ledger.push({ date: o.order_date, description: `Order ${o.order_number}`, debit: num(o.grand_total), credit: 0, order_id: num(o.id) });
    for (const p of payments) ledger.push({ date: p.payment_date, description: `Payment ${p.payment_number}`, debit: 0, credit: num(p.total_amount), order_id: p.order_id !== null ? num(p.order_id) : null });
    const ts = (d: string) => Date.parse(d.replace(' ', 'T') + 'Z');
    ledger.sort((a, b) => ts(b.date) - ts(a.date));
    const outstanding = await scalar(db, 'SELECT COALESCE(SUM(due_amount),0) FROM accounts_receivable WHERE customer_id=? AND due_amount>0', [id]);
    const walletBal = await scalar(db, 'SELECT balance FROM customer_wallet WHERE customer_id=?', [id]);
    return ok({ customer_id: id, outstanding: round2(toFloat(outstanding)), wallet_balance: round2(toFloat(walletBal || 0)), orders, payments, garments, wallet, deliveries, feedback, ledger });
  });

  // ---- daily collection -------------------------------------------------------------------
  route('daily_collection', async (req) => {
    await auth(req, 'payments.view');
    const q = req.query as Q;
    let date = qStr(q.date ?? todayIn(tz));
    if (!ISO.test(date)) date = todayIn(tz);
    const methodFilter = qInt(q.payment_type_id);
    const staffFilter = qInt(q.staff_id);
    const orderSearch = qStr(q.order);
    const customerSearch = qStr(q.customer);

    let fw = 'DATE(p.payment_date) = ?';
    const fp: unknown[] = [date];
    if (methodFilter) { fw += ' AND ptx.payment_type_id = ?'; fp.push(methodFilter); }
    if (staffFilter) { fw += ' AND p.created_by = ?'; fp.push(staffFilter); }
    if (orderSearch !== '') { fw += ' AND o.order_number LIKE ?'; fp.push(`%${orderSearch}%`); }
    if (customerSearch !== '') { fw += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; fp.push(`%${customerSearch}%`, `%${customerSearch}%`); }

    const byMethod = async (kind: string) =>
      (await db.query<Raw>(
        `SELECT pt.type_name, COALESCE(SUM(ptx.amount),0) AS total
         FROM payment_transactions ptx
         JOIN payments p ON p.id = ptx.payment_id
         JOIN payment_types pt ON pt.id = ptx.payment_type_id
         JOIN customers c ON c.id = p.customer_id
         LEFT JOIN orders o ON o.id = p.order_id
         WHERE ${fw} AND ${kind} GROUP BY pt.id ORDER BY pt.sort_order`, fp)).map((r) => ({ type_name: r.type_name, total: num(r.total) }));
    const collections = await byMethod("p.payment_kind != 'Refund'");
    const refunds = await byMethod("p.payment_kind = 'Refund'");
    const totalCollections = round2(sum(collections.map((c) => c.total)));
    const totalRefunds = round2(sum(refunds.map((c) => c.total)));
    const advanceReceived = round2(toFloat(await scalar(db, "SELECT COALESCE(SUM(credit),0) FROM wallet_transactions WHERE DATE(created_at) = ? AND txn_type = 'Deposit'", [date])));
    const [counts] = await db.query<Raw>(
      `SELECT SUM(due_amount <= 0.01) AS paid_count, SUM(due_amount > 0.01 AND paid_amount > 0.01) AS partial_count,
              SUM(due_amount > 0.01 AND paid_amount <= 0.01) AS unpaid_count, COALESCE(SUM(due_amount), 0) AS total_outstanding
       FROM accounts_receivable WHERE status = 'Open'`);
    const types = await db.query<Raw>('SELECT id, type_name FROM payment_types ORDER BY sort_order');
    const staff = await db.query<Raw>('SELECT DISTINCT u.id, u.full_name FROM payments p JOIN users u ON u.id = p.created_by ORDER BY u.full_name');
    const details = await db.query<Raw>(
      `SELECT p.payment_number, p.payment_date, p.payment_kind, p.total_amount, c.full_name, c.mobile, o.order_number, u.full_name AS created_by_name,
              GROUP_CONCAT(CONCAT(pt.type_name, ': ', ptx.amount) SEPARATOR ', ') AS breakdown
       FROM payments p JOIN customers c ON c.id = p.customer_id LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.created_by
       JOIN payment_transactions ptx ON ptx.payment_id = p.id JOIN payment_types pt ON pt.id = ptx.payment_type_id
       WHERE ${fw} GROUP BY p.id ORDER BY p.payment_date DESC`, fp);
    return ok({
      date, collections, refunds, total_collections: totalCollections, total_refunds: totalRefunds,
      net_collection: round2(totalCollections - totalRefunds), advance_received: advanceReceived,
      paid_count: num(counts?.paid_count ?? 0), partial_count: num(counts?.partial_count ?? 0), unpaid_count: num(counts?.unpaid_count ?? 0),
      total_outstanding: num(counts?.total_outstanding ?? 0),
      payment_types: types.map((r) => ({ id: num(r.id), type_name: r.type_name })),
      staff: staff.map((r) => ({ id: num(r.id), full_name: r.full_name })),
      details: details.map((d) => ({
        payment_number: d.payment_number, payment_date: d.payment_date, payment_kind: d.payment_kind, total_amount: num(d.total_amount),
        customer_name: d.full_name, order_number: d.order_number, created_by_name: d.created_by_name, breakdown: d.breakdown,
      })),
    });
  });

  // ---- outstanding / ageing ---------------------------------------------------------------
  route('outstanding_list', async (req) => {
    await auth(req, 'accounts.view');
    const q = req.query as Q;
    const customerSearch = qStr(q.customer);
    const orderSearch = qStr(q.order);
    const dueDate = qStr(q.due_date);
    const ageing = qStr(q.ageing);
    const minAmount = qStr(q.min_amount);
    let where = "ar.status = 'Open' AND ar.due_amount > 0.01";
    const params: unknown[] = [];
    if (customerSearch !== '') { where += ' AND (c.full_name LIKE ? OR c.mobile LIKE ?)'; params.push(`%${customerSearch}%`, `%${customerSearch}%`); }
    if (orderSearch !== '') { where += ' AND o.order_number LIKE ?'; params.push(`%${orderSearch}%`); }
    if (dueDate !== '') { where += ' AND ar.due_date = ?'; params.push(dueDate); }
    if (minAmount !== '' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(minAmount)) { where += ' AND ar.due_amount >= ?'; params.push(toFloat(minAmount)); }
    const ageingCase = `CASE
      WHEN DATEDIFF(CURDATE(), ar.due_date) <= 0 THEN 'Current'
      WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 1 AND 7 THEN '1-7 days'
      WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 8 AND 30 THEN '8-30 days'
      WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 31 AND 60 THEN '31-60 days'
      WHEN DATEDIFF(CURDATE(), ar.due_date) BETWEEN 61 AND 90 THEN '61-90 days'
      ELSE '90+ days' END`;
    if (ageing !== '') { where += ` AND (${ageingCase}) = ?`; params.push(ageing); }
    const rows = await db.query<Raw>(
      `SELECT ar.order_id, ar.total_amount, ar.paid_amount, ar.due_amount, ar.due_date,
              c.full_name AS customer_name, c.mobile, o.order_number, o.order_date, ${ageingCase} AS ageing_bucket,
              (SELECT MAX(p.payment_date) FROM payments p WHERE p.order_id = ar.order_id AND p.payment_kind != 'Refund') AS last_payment_date
       FROM accounts_receivable ar JOIN orders o ON o.id = ar.order_id JOIN customers c ON c.id = ar.customer_id
       WHERE ${where} ORDER BY ar.due_date`, params);
    const bucketTotals: Record<string, number> = { Current: 0, '1-7 days': 0, '8-30 days': 0, '31-60 days': 0, '61-90 days': 0, '90+ days': 0 };
    let grand = 0;
    const byCustomer = new Map<string, { name: string; mobile: string; orders: number; total_due: number }>();
    for (const r of rows) {
      bucketTotals[r.ageing_bucket] = (bucketTotals[r.ageing_bucket] ?? 0) + num(r.due_amount);
      grand += num(r.due_amount);
      const key = `${r.customer_name}|${r.mobile}`;
      const c = byCustomer.get(key) ?? { name: r.customer_name, mobile: r.mobile, orders: 0, total_due: 0 };
      c.orders++; c.total_due += num(r.due_amount);
      byCustomer.set(key, c);
    }
    return ok({
      receivables: rows.map((r) => ({
        order_id: num(r.order_id), order_number: r.order_number, order_date: r.order_date, customer_name: r.customer_name, mobile: r.mobile,
        total_amount: num(r.total_amount), paid_amount: num(r.paid_amount), due_amount: num(r.due_amount), due_date: r.due_date,
        ageing_bucket: r.ageing_bucket, last_payment_date: r.last_payment_date,
      })),
      bucket_totals: bucketTotals,
      grand_outstanding: grand,
      by_customer: [...byCustomer.values()].sort((a, b) => b.total_due - a.total_due),
    });
  });

  // ---- dashboard summary -------------------------------------------------------------------
  route('dashboard_summary', async (req) => {
    const ctx = await auth(req, 'dashboard.view');
    noWorkshop(ctx.role_name);
    const today = todayIn(tz);
    const [sf, sfp] = storeScope(ctx.store_id);
    const [sfn, sfnp] = storeScope(ctx.store_id, 'o', true);
    const statusCount = async (keys: string) =>
      num(await scalar(db, `SELECT COUNT(*) FROM orders o JOIN order_statuses s ON s.id=o.status_id WHERE s.status_key IN (${keys})${sf}`, sfp));

    const cards = {
      todays_orders: num(await scalar(db, `SELECT COUNT(*) FROM orders o WHERE DATE(order_date) = ?${sf}`, [today, ...sfp])),
      pending_orders: await statusCount("'received'"),
      processing: await statusCount("'workshop','processing'"),
      qc_pending: await statusCount("'qc'"),
      rework: await statusCount("'rework'"),
      ready: await statusCount("'ready'"),
      packed: await statusCount("'packed'"),
      out_for_delivery: await statusCount("'out_for_delivery'"),
      delivered_today: num(await scalar(db, `SELECT COUNT(*) FROM orders o JOIN order_statuses s ON s.id=o.status_id WHERE s.status_key='delivered' AND DATE(o.updated_at)=?${sf}`, [today, ...sfp])),
      todays_sales: toFloat(await scalar(db, `SELECT COALESCE(SUM(grand_total),0) FROM orders o WHERE DATE(order_date) = ?${sf}`, [today, ...sfp])),
      todays_collection: toFloat(await scalar(db, `SELECT COALESCE(SUM(p.total_amount),0) FROM payments p JOIN orders o ON o.id = p.order_id WHERE DATE(p.payment_date) = ?${sf}`, [today, ...sfp])),
      outstanding: toFloat(await scalar(db, `SELECT COALESCE(SUM(ar.due_amount),0) FROM accounts_receivable ar JOIN orders o ON o.id = ar.order_id WHERE ar.due_amount > 0${sf}`, sfp)),
      pickup_pending: num(await scalar(db, `SELECT COUNT(*) FROM pickup_orders po LEFT JOIN orders o ON o.id = po.order_id WHERE po.status IN ('Requested','Scheduled','Assigned')${sfn}`, sfnp)),
      delivery_pending: num(await scalar(db, `SELECT COUNT(*) FROM delivery_orders do_ JOIN orders o ON o.id = do_.order_id WHERE do_.status IN ('Pending','Assigned','Out for Delivery')${sf}`, sfp)),
    };

    const salesRows = await db.query<Raw>(
      `SELECT DATE(order_date) d, COALESCE(SUM(grand_total),0) total FROM orders o WHERE order_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)${sf} GROUP BY DATE(order_date) ORDER BY d`, sfp);
    const salesByDate = new Map(salesRows.map((r) => [String(r.d), num(r.total)]));
    const sales7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      sales7.push({ date: d, label: dayMon(d), total: salesByDate.get(d) ?? 0 });
    }
    const byStatus = (await db.query<Raw>(`SELECT os.status_label, os.color, COUNT(o.id) cnt FROM order_statuses os LEFT JOIN orders o ON o.status_id = os.id${sf} GROUP BY os.id ORDER BY os.sort_order`, sfp))
      .map((r) => ({ label: r.status_label, color: r.color, count: num(r.cnt) }));
    const byMode = (await db.query<Raw>(
      `SELECT pt.type_name, COALESCE(SUM(ptx.amount),0) total FROM payment_transactions ptx
       JOIN payment_types pt ON pt.id = ptx.payment_type_id JOIN payments p ON p.id = ptx.payment_id JOIN orders o ON o.id = p.order_id
       WHERE p.payment_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${sf} GROUP BY pt.id ORDER BY total DESC`, sfp)).map((r) => ({ label: r.type_name, total: num(r.total) }));
    const topGarments = (await db.query<Raw>(
      `SELECT garment_name, SUM(qty) AS qty FROM (
         SELECT g.garment_name, oi.quantity AS qty FROM order_items oi JOIN garments g ON g.id = oi.garment_id JOIN orders o ON o.id = oi.order_id
         WHERE o.order_mode = 'piece' AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${sf}
         UNION ALL
         SELECT g.garment_name, 1 AS qty FROM laundry_garments lg JOIN garments g ON g.id = lg.garment_id
         JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id
         WHERE o.order_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)${sf}
       ) combined GROUP BY garment_name ORDER BY qty DESC LIMIT 5`, [...sfp, ...sfp])).map((r) => ({ name: r.garment_name, qty: Math.trunc(num(r.qty)) }));
    const topCustomers = (await db.query<Raw>(
      `SELECT c.id, c.full_name, c.mobile, SUM(o.grand_total) total FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.order_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)${sf} GROUP BY c.id ORDER BY total DESC LIMIT 5`, sfp))
      .map((r) => ({ id: num(r.id), name: r.full_name, mobile: r.mobile, total: num(r.total) }));

    return ok({
      date: today, store_scoped: ctx.store_id !== null, cards, sales_7_days: sales7, orders_by_status: byStatus,
      payments_by_mode_30_days: byMode, top_garments_30_days: topGarments, top_customers_90_days: topCustomers,
    });
  });

  // ---- daily dashboard ----------------------------------------------------------------------
  route('daily_dashboard', async (req) => {
    const ctx = await auth(req, 'dashboard.view');
    noWorkshop(ctx.role_name);
    const today = todayIn(tz);
    let selected = String((req.query as Q).date ?? today).trim();
    if (!ISO.test(selected) || !isStrtotimeDate(selected)) selected = today;
    const [sf, sfp] = storeScope(ctx.store_id);

    const fetchOrderRows = async (whereClause: string, params: unknown[]) =>
      (await db.query<Raw>(
        `SELECT o.id, o.order_number, o.due_time, o.due_date, c.full_name AS customer_name, c.mobile, o.grand_total, o.total_paid, o.current_due,
                COALESCE(SUM(oi.quantity),0) AS pcs, COUNT(DISTINCT oi.garment_id) AS garment_types
         FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN order_items oi ON oi.order_id = o.id
         WHERE ${whereClause} GROUP BY o.id ORDER BY o.due_time IS NULL, o.due_time`, params)).map((r) => ({
        id: num(r.id), order_number: r.order_number, due_date: r.due_date, due_time: r.due_time, customer_name: r.customer_name, mobile: r.mobile,
        grand_total: num(r.grand_total), total_paid: num(r.total_paid), current_due: num(r.current_due),
        pcs: Math.trunc(num(r.pcs)), garment_types: Math.trunc(num(r.garment_types)),
      }));

    const pickups = (await db.query<Raw>(
      `SELECT po.id, po.pickup_number, po.pickup_date, po.pickup_time, po.status, po.garment_count, c.full_name AS customer_name, c.mobile, po.address, po.order_id
       FROM pickup_orders po JOIN customers c ON c.id = po.customer_id WHERE po.pickup_date = ? ORDER BY po.pickup_time IS NULL, po.pickup_time`, [selected]))
      .map((r) => ({
        id: num(r.id), pickup_number: r.pickup_number, pickup_time: r.pickup_time, status: r.status,
        garment_count: r.garment_count !== null ? num(r.garment_count) : null, customer_name: r.customer_name, mobile: r.mobile,
        address: r.address, order_id: r.order_id !== null ? num(r.order_id) : null,
      }));

    const open = "o.id IN (SELECT o2.id FROM orders o2 JOIN order_statuses os ON os.id=o2.status_id WHERE os.status_key NOT IN ('delivered','cancelled'))";
    const urgent = await fetchOrderRows(`o.urgent_level_id IS NOT NULL AND o.due_date = ? AND ${open}${sf}`, [selected, ...sfp]);
    const deliveries = await fetchOrderRows(`o.due_date = ? AND ${open}${sf}`, [selected, ...sfp]);

    const workshop = (await db.query<Raw>(
      `SELECT g.garment_name, s.service_name, COUNT(oi.id) AS item_count, oi.item_status
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id
       WHERE oi.item_status IN ('Workshop','Processing')${sf} GROUP BY g.id, s.id, oi.item_status ORDER BY item_count DESC LIMIT 15`, sfp))
      .map((r) => ({ garment_name: r.garment_name, service_name: r.service_name, item_status: r.item_status, item_count: num(r.item_count) }));
    const ready = (await db.query<Raw>(
      `SELECT os.status_label, COUNT(DISTINCT o.id) AS order_count FROM orders o JOIN order_statuses os ON os.id = o.status_id
       WHERE os.status_key IN ('ready','packed','out_for_delivery','delivered')${sf} AND DATE(o.updated_at) = ? GROUP BY os.id ORDER BY os.sort_order`, [...sfp, selected]))
      .map((r) => ({ label: r.status_label, count: num(r.order_count) }));

    const pend = await db.query<Raw>(
      `SELECT o.id, o.order_number, o.due_date, c.full_name AS customer_name, c.mobile, COALESCE(SUM(oi.quantity),0) AS pcs
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items oi ON oi.order_id = o.id JOIN order_statuses os ON os.id = o.status_id
       WHERE oi.item_status NOT IN ('Ready','Packed','Delivered','Damaged','Missing') AND os.status_key NOT IN ('delivered','cancelled')${sf}
       GROUP BY o.id ORDER BY o.due_date`, sfp);
    const overdue: Raw[] = [], todayList: Raw[] = [], future: Raw[] = [];
    for (const r of pend) {
      const row = { id: num(r.id), order_number: r.order_number, due_date: r.due_date, customer_name: r.customer_name, mobile: r.mobile, pcs: Math.trunc(num(r.pcs)) };
      if (String(r.due_date) < selected) overdue.push(row);
      else if (String(r.due_date) === selected) todayList.push(row);
      else future.push(row);
    }
    const upcoming = async (column: 'birthday' | 'anniversary') =>
      (await db.query<Raw>(
        `SELECT id, full_name, mobile, ${column} AS the_date FROM customers
         WHERE is_active = 1 AND ${column} IS NOT NULL
           AND DATE_FORMAT(${column}, '%m-%d') BETWEEN DATE_FORMAT(?, '%m-%d') AND DATE_FORMAT(DATE_ADD(?, INTERVAL 7 DAY), '%m-%d')
         ORDER BY DATE_FORMAT(${column}, '%m-%d') LIMIT 20`, [selected, selected])).map((r) => ({ id: num(r.id), name: r.full_name, mobile: r.mobile, date: r.the_date }));

    return ok({
      date: selected, prev_date: addDays(selected, -1), next_date: addDays(selected, 1), is_today: selected === today,
      kpis: { pickups: pickups.length, urgent: urgent.length, deliveries: deliveries.length, overdue: overdue.length, balance_due: sum(deliveries.map((d) => d.current_due)) },
      pickups, urgent_orders: urgent, deliveries, workshop_workload: workshop, ready_status: ready,
      pending_work: { overdue, today: todayList, future },
      upcoming_birthdays: await upcoming('birthday'), upcoming_anniversaries: await upcoming('anniversary'),
    });
  });

  // ---- reports summary -----------------------------------------------------------------------
  route('reports_summary', async (req) => {
    const ctx = await auth(req, 'reports.view');
    const q = req.query as Q;
    let dateFrom = qStr(q.date_from ?? monthStartIn(tz));
    let dateTo = qStr(q.date_to ?? todayIn(tz));
    if (!ISO.test(dateFrom)) dateFrom = monthStartIn(tz);
    if (!ISO.test(dateTo)) dateTo = todayIn(tz);
    const [sf, sfp] = storeScope(ctx.store_id);
    const range = [dateFrom, dateTo];
    const run = (sql: string, params: unknown[]) => db.query<Raw>(sql, params);

    const [orderStats] = await run(`SELECT COUNT(*) AS order_count, COALESCE(SUM(grand_total),0) AS order_value, COALESCE(AVG(grand_total),0) AS avg_order_value FROM orders o WHERE DATE(order_date) BETWEEN ? AND ?${sf}`, [...range, ...sfp]);
    const byStatus = await run(`SELECT os.status_label, os.color, COUNT(*) AS cnt FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE DATE(o.order_date) BETWEEN ? AND ?${sf} GROUP BY os.id ORDER BY os.sort_order`, [...range, ...sfp]);
    const byService = await run(`SELECT s.service_name, s.billing_unit, COUNT(*) AS item_count, COALESCE(SUM(oi.total),0) AS revenue FROM order_items oi JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = oi.order_id WHERE DATE(o.order_date) BETWEEN ? AND ?${sf} GROUP BY s.id ORDER BY revenue DESC`, [...range, ...sfp]);
    const byGarment = await run(
      `SELECT garment_name, SUM(item_count) AS item_count, SUM(revenue) AS revenue FROM (
         SELECT g.garment_name, 1 AS item_count, oi.total AS revenue FROM order_items oi JOIN garments g ON g.id = oi.garment_id JOIN orders o ON o.id = oi.order_id
         WHERE o.order_mode = 'piece' AND DATE(o.order_date) BETWEEN ? AND ?${sf}
         UNION ALL
         SELECT g.garment_name, 1 AS item_count, NULL AS revenue FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN garments g ON g.id = lg.garment_id JOIN orders o ON o.id = oi.order_id
         WHERE DATE(o.order_date) BETWEEN ? AND ?${sf}
       ) combined GROUP BY garment_name ORDER BY item_count DESC LIMIT 15`, [...range, ...sfp, ...range, ...sfp]);

    const collections = new Map<string, number>();
    const refunds = new Map<string, number>();
    for (const r of await run(
      `SELECT pt.type_name, COALESCE(SUM(ptx.amount),0) AS total, p.payment_kind FROM payment_transactions ptx JOIN payments p ON p.id = ptx.payment_id
       JOIN payment_types pt ON pt.id = ptx.payment_type_id JOIN orders o ON o.id = p.order_id
       WHERE DATE(p.payment_date) BETWEEN ? AND ?${sf} GROUP BY pt.id, p.payment_kind ORDER BY pt.sort_order`, [...range, ...sfp])) {
      const m = r.payment_kind === 'Refund' ? refunds : collections;
      m.set(r.type_name, (m.get(r.type_name) ?? 0) + num(r.total));
    }
    const advance = round2(toFloat(await scalar(db, "SELECT COALESCE(SUM(credit),0) FROM wallet_transactions WHERE DATE(created_at) BETWEEN ? AND ? AND txn_type = 'Deposit'", range)));
    const [paid] = await run(`SELECT SUM(ar.due_amount <= 0.01) AS paid, SUM(ar.due_amount > 0.01 AND ar.paid_amount > 0.01) AS partial, SUM(ar.due_amount > 0.01 AND ar.paid_amount <= 0.01) AS unpaid FROM accounts_receivable ar JOIN orders o ON o.id = ar.order_id WHERE ar.status = 'Open'${sf}`, sfp);
    const newCustomers = num(await scalar(db, 'SELECT COUNT(*) FROM customers WHERE DATE(created_at) BETWEEN ? AND ?', range));
    const topCustomers = await run(
      `SELECT c.full_name, c.mobile, COUNT(o.id) AS order_count, COALESCE(SUM(o.grand_total),0) AS revenue, COALESCE(SUM(o.current_due),0) AS outstanding
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE DATE(o.order_date) BETWEEN ? AND ?${sf} GROUP BY c.id ORDER BY revenue DESC LIMIT 15`, [...range, ...sfp]);
    const returning = num(await scalar(db, `SELECT COUNT(*) FROM (SELECT o.customer_id FROM orders o WHERE DATE(o.order_date) BETWEEN ? AND ?${sf} GROUP BY o.customer_id HAVING COUNT(*) > 1) t`, [...range, ...sfp]));
    const [op] = await run(
      `SELECT SUM(oi.item_status = 'Workshop') AS in_workshop, SUM(oi.item_status = 'Processing') AS processing, SUM(oi.item_status = 'QC') AS qc_pending,
              SUM(oi.item_status = 'Rework') AS in_rework, SUM(oi.item_status = 'Ready') AS ready_to_pack, SUM(oi.item_status = 'Packed') AS packed
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE 1=1${sf}`, sfp);
    const qcSf = sf !== '' ? sf.replace('o.store_id', 'COALESCE(o1.store_id, o2.store_id)') : '';
    const [qc] = await run(
      `SELECT SUM(qr.result='Passed') AS passed, SUM(qr.result IN ('Rework','Failed')) AS failed FROM qc_records qr
       LEFT JOIN order_items oi1 ON oi1.id = qr.order_item_id LEFT JOIN orders o1 ON o1.id = oi1.order_id
       LEFT JOIN laundry_garments lg ON lg.id = qr.laundry_garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id LEFT JOIN orders o2 ON o2.id = oi2.order_id
       WHERE DATE(qr.checked_at) BETWEEN ? AND ?${qcSf}`, [...range, ...sfp]);
    const overdue = num(await scalar(db, `SELECT COUNT(DISTINCT o.id) FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE os.status_key NOT IN ('delivered','cancelled') AND o.due_date < CURDATE()${sf}`, sfp));
    const urgent = num(await scalar(db, `SELECT COUNT(DISTINCT o.id) FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE os.status_key NOT IN ('delivered','cancelled') AND o.urgent_level_id IS NOT NULL${sf}`, sfp));

    const kv = (m: Map<string, number>) => [...m].map(([k, v]) => ({ type_name: k, total: round2(v) }));
    const money = (v: unknown) => round2(toFloat(v));
    return ok({
      date_from: dateFrom, date_to: dateTo, store_scoped: ctx.store_id !== null,
      sales: {
        order_count: num(orderStats!.order_count), order_value: money(orderStats!.order_value), avg_order_value: money(orderStats!.avg_order_value),
        by_status: byStatus.map((r) => ({ status_label: r.status_label, color: r.color, count: num(r.cnt) })),
        by_service: byService.map((r) => ({ service_name: r.service_name, billing_unit: r.billing_unit, item_count: num(r.item_count), revenue: money(r.revenue) })),
        top_garments: byGarment.map((r) => ({ garment_name: r.garment_name, item_count: Math.trunc(num(r.item_count)), revenue: r.revenue !== null ? money(r.revenue) : null })),
      },
      payments: {
        collections: kv(collections), refunds: kv(refunds),
        total_collected: round2(sum([...collections.values()])), total_refunded: round2(sum([...refunds.values()])),
        advance_deposits: advance,
        open_receivables: { paid: num(paid?.paid ?? 0), partial: num(paid?.partial ?? 0), unpaid: num(paid?.unpaid ?? 0) },
      },
      customers: {
        new_customers: newCustomers, returning_customers: returning,
        top_customers: topCustomers.map((c) => ({ full_name: c.full_name, mobile: c.mobile, order_count: num(c.order_count), revenue: money(c.revenue), outstanding: money(c.outstanding) })),
      },
      operations: {
        in_workshop: num(op?.in_workshop ?? 0), processing: num(op?.processing ?? 0), qc_pending: num(op?.qc_pending ?? 0),
        in_rework: num(op?.in_rework ?? 0), ready_to_pack: num(op?.ready_to_pack ?? 0), packed: num(op?.packed ?? 0),
        qc_passed: num(qc?.passed ?? 0), qc_failed: num(qc?.failed ?? 0), overdue_orders: overdue, urgent_orders: urgent,
      },
    });
  });
}
