import type { Db } from '../db/pool.js';

type Row = Record<string, any>;

/**
 * Port of includes/CustomerSegments.php. The only caller outside a web session is the marketing cron,
 * where Auth::allowedStoreIds() is null (no fixed store), so a store filter applies only when a rule names a store.
 */
export class CustomerSegments {
  /** `fixedStoreId` is the calling web user's own store (Auth::fixedStoreId()); null for Super Admin / the cron job. */
  constructor(private readonly db: Db, private readonly fixedStoreId: number | null = null) {}

  /** The same segments, evaluated for a web session whose user may be pinned to one store. */
  forUser(fixedStoreId: number | null): CustomerSegments { return new CustomerSegments(this.db, fixedStoreId); }

  static readonly available: Record<string, string> = {
    '30_day_inactive': '30 Days Inactive',
    '60_day_inactive': '60 Days Inactive',
    '90_day_inactive': '90 Days Inactive',
    '90plus_day_inactive': '90+ Days Inactive',
    '120_day_inactive': '120 Days Inactive',
    '180plus_day_inactive': '180+ Days Inactive',
    top_10_revenue: 'Top 10 by Revenue',
    top_25_revenue: 'Top 25 by Revenue',
    birthday_today: 'Birthday Today',
    birthday_this_week: 'Birthday This Week',
    new_customers: 'New Customers (30 days)',
  };

  private async storeFilter(alias: string, storeId: number | null): Promise<[string, unknown[]]> {
    if (storeId !== null) {
      // Auth::canActAsStore(): a fixed-store user may only act as their own store
      const ok = this.fixedStoreId !== null ? this.fixedStoreId === storeId : (await this.db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [storeId])).length > 0;
      return ok ? [` AND ${alias}.store_id = ?`, [storeId]] : [` AND ${alias}.store_id = -1`, []];
    }
    if (this.fixedStoreId !== null) return [` AND ${alias}.store_id IN (?)`, [this.fixedStoreId]];
    return ['', []];
  }

  /** WhatsApp Campaign Console: only customers reachable on WhatsApp (sending is its whole purpose); most dormant first. */
  async inactiveDays(min: number, max: number | null = null, storeId: number | null = null): Promise<Row[]> {
    return this.inactive(min, max, storeId, true);
  }

  /** Dormant Customers report: EVERY dormant customer, whether or not they opted into WhatsApp. Same DATEDIFF logic, no preference filter. */
  async inactiveDaysReport(min: number, max: number | null = null, storeId: number | null = null): Promise<Row[]> {
    return this.inactive(min, max, storeId, false);
  }

  private async inactive(min: number, max: number | null, storeId: number | null, whatsAppOnly: boolean): Promise<Row[]> {
    const [sf, sfp] = await this.storeFilter('o', storeId);
    const upper = max !== null ? 'AND DATEDIFF(CURDATE(), MAX(o.order_date)) <= ?' : '';
    return this.db.query(
      `SELECT c.id, c.full_name, c.mobile, c.communication_preference, MAX(o.order_date) AS last_order_date,
             DATEDIFF(CURDATE(), MAX(o.order_date)) AS days_inactive
             FROM customers c JOIN orders o ON o.customer_id = c.id
             WHERE c.is_active = 1${whatsAppOnly ? " AND c.communication_preference = 'WhatsApp'" : ''}${sf}
             GROUP BY c.id
             HAVING DATEDIFF(CURDATE(), MAX(o.order_date)) >= ? ${upper}
             ORDER BY days_inactive DESC`,
      [...sfp, min, ...(max !== null ? [max] : [])]);
  }

  /** Days since one customer's last order, across every store (null = never ordered, which is not the same as 0 = "ordered today"). */
  async daysSinceLastOrder(customerId: number): Promise<{ last_order_date: string; days_inactive: number } | null> {
    const [r] = await this.db.query<Row>('SELECT MAX(order_date) AS last_order_date, DATEDIFF(CURDATE(), MAX(order_date)) AS days_inactive FROM orders WHERE customer_id = ?', [customerId]);
    if (!r || r.last_order_date === null || r.last_order_date === undefined) return null;
    return r as { last_order_date: string; days_inactive: number };
  }

  async topByRevenue(limit = 10, withinDays = 365, storeId: number | null = null): Promise<Row[]> {
    const [sf, sfp] = await this.storeFilter('o', storeId);
    return this.db.query(
      `SELECT c.id, c.full_name, c.mobile, c.communication_preference, SUM(o.grand_total) AS total_revenue
       FROM customers c JOIN orders o ON o.customer_id = c.id
       WHERE c.is_active = 1 AND c.communication_preference = 'WhatsApp' AND o.order_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)${sf}
       GROUP BY c.id ORDER BY total_revenue DESC LIMIT ?`,
      [withinDays, ...sfp, limit]);
  }

  birthdayInRange(daysAhead = 0): Promise<Row[]> {
    return this.db.query(
      `SELECT id, full_name, mobile, communication_preference, birthday
       FROM customers
       WHERE is_active = 1 AND communication_preference = 'WhatsApp' AND birthday IS NOT NULL
       AND DATEDIFF(
             DATE(CONCAT(YEAR(CURDATE()) + IF(DATE_FORMAT(birthday,'%m%d') < DATE_FORMAT(CURDATE(),'%m%d'), 1, 0), '-', MONTH(birthday), '-', DAY(birthday))),
             CURDATE()
           ) BETWEEN 0 AND ?`, [daysAhead]);
  }

  newCustomers(withinDays = 30): Promise<Row[]> {
    return this.db.query(
      "SELECT id, full_name, mobile, communication_preference FROM customers WHERE is_active = 1 AND communication_preference = 'WhatsApp' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)",
      [withinDays]);
  }

  resolve(key: string, storeId: number | null = null): Promise<Row[]> {
    switch (key) {
      case '30_day_inactive': return this.inactiveDays(30, 59, storeId);
      case '60_day_inactive': return this.inactiveDays(60, 89, storeId);
      case '90_day_inactive': return this.inactiveDays(90, 119, storeId);
      case '90plus_day_inactive': return this.inactiveDays(120, null, storeId);
      case '120_day_inactive': return this.inactiveDays(120, 179, storeId);
      case '180plus_day_inactive': return this.inactiveDays(180, null, storeId);
      case 'top_10_revenue': return this.topByRevenue(10, 365, storeId);
      case 'top_25_revenue': return this.topByRevenue(25, 365, storeId);
      case 'birthday_today': return this.birthdayInRange(0);
      case 'birthday_this_week': return this.birthdayInRange(7);
      case 'new_customers': return this.newCustomers(30);
      default: return Promise.resolve([]);
    }
  }
}
