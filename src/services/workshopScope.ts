import type { Db } from '../db/pool.js';
import { addDays, diffDays } from '../lib/dates.js';

type Raw = Record<string, any>;

/** Port of includes/WorkshopScope.php: a Workshop Staff login only ever sees its own workshop. */
export async function wsScope(db: Db, userId: number, roleName: string): Promise<[boolean, number | null]> {
  if (roleName !== 'Workshop Staff') return [false, null];
  const [r] = await db.query<{ workshop_id: number | null }>('SELECT workshop_id FROM users WHERE id = ?', [userId]);
  return [true, r && r.workshop_id ? Number(r.workshop_id) : null];
}

export async function wsItemBelongs(db: Db, workshopItemId: number, workshopId: number): Promise<boolean> {
  return (await db.query('SELECT 1 FROM workshop_items wi JOIN workshop_challans wc ON wc.id = wi.challan_id WHERE wi.id = ? AND wc.workshop_id = ?', [workshopItemId, workshopId])).length > 0;
}

export async function wsBillingScope(db: Db, userId: number, roleName: string) {
  if (roleName === 'Workshop Staff') {
    const [, wid] = await wsScope(db, userId, roleName);
    return { can_manage: wid !== null, workshop_id: wid, blocked: wid === null };
  }
  return { can_manage: ['Super Admin', 'Admin', 'Store Manager'].includes(roleName), workshop_id: null as number | null, blocked: false };
}

export interface ScheduleData {
  today: Record<string, Record<number, { order_id: number; order_number: string; customer: string; due_time: string | null; garments: number; items: Record<number, number>; statuses: Record<string, true> }>>;
  tomorrow: ScheduleData['today'];
  overdue: Record<string, Raw[]>;
  today_date: string;
  tomorrow_date: string;
}

export async function wsScheduleData(db: Db, workshopId: number | null, today: string): Promise<ScheduleData> {
  const tomorrow = addDays(today, 1);
  const params: unknown[] = [];
  let wsClause = '';
  if (workshopId !== null) { wsClause = ' AND wc.workshop_id = ?'; params.push(workshopId); }
  params.push(tomorrow);
  const rows = await db.query<Raw>(
    `SELECT * FROM (
        SELECT wi.id AS wi_id,
          COALESCE(
            (SELECT h.new_status FROM garment_status_history h
              WHERE h.module = 'workshop'
                AND ((wi.laundry_garment_id IS NOT NULL AND h.laundry_garment_id = wi.laundry_garment_id)
                  OR (wi.laundry_garment_id IS NULL AND h.order_item_id = wi.order_item_id))
              ORDER BY h.changed_at DESC, h.id DESC LIMIT 1),
            wi.status) AS cur_status,
          COALESCE(o1.id, o2.id) AS order_id, COALESCE(o1.order_number, o2.order_number) AS order_number,
          COALESCE(o1.due_date, o2.due_date) AS due_date, COALESCE(o1.due_time, o2.due_time) AS due_time,
          COALESCE(s1.store_name, s2.store_name, 'Unassigned') AS store_name, COALESCE(c1.full_name, c2.full_name) AS customer_name,
          COALESCE(g1.garment_name, g2.garment_name) AS garment_name, COALESCE(oi1.id, oi2.id) AS order_item_id,
          COALESCE(oi1.total, oi2.total) AS item_value,
          CASE WHEN wi.laundry_garment_id IS NOT NULL THEN 1 ELSE COALESCE(oi1.quantity, 1) END AS garments
        FROM workshop_items wi
        JOIN workshop_challans wc ON wc.id = wi.challan_id
        LEFT JOIN order_items oi1 ON oi1.id = wi.order_item_id LEFT JOIN garments g1 ON g1.id = oi1.garment_id LEFT JOIN orders o1 ON o1.id = oi1.order_id
        LEFT JOIN stores s1 ON s1.id = o1.store_id LEFT JOIN customers c1 ON c1.id = o1.customer_id
        LEFT JOIN laundry_garments lg ON lg.id = wi.laundry_garment_id LEFT JOIN garments g2 ON g2.id = lg.garment_id LEFT JOIN order_items oi2 ON oi2.id = lg.order_item_id
        LEFT JOIN orders o2 ON o2.id = oi2.order_id LEFT JOIN stores s2 ON s2.id = o2.store_id LEFT JOIN customers c2 ON c2.id = o2.customer_id
        WHERE wi.status != 'Rejected'${wsClause}
     ) t
     WHERE t.cur_status NOT IN ('Returned','Store Received','Rejected') AND t.due_date IS NOT NULL AND t.due_date <= ?
     ORDER BY t.store_name, t.due_date, t.due_time IS NULL, t.due_time, t.order_number`, params);
  const out: ScheduleData = { today: {}, tomorrow: {}, overdue: {}, today_date: today, tomorrow_date: tomorrow };
  for (const r of rows) {
    const qty = Number(r.garments);
    const store = r.store_name as string;
    if (String(r.due_date) < today) {
      (out.overdue[store] ??= []).push({ order_id: r.order_id, order_number: r.order_number, customer: r.customer_name, garment: r.garment_name, qty, due_date: r.due_date, days: diffDays(today, String(r.due_date)), status: r.cur_status });
      continue;
    }
    const bucket = String(r.due_date) === today ? out.today : out.tomorrow;
    const oid = Number(r.order_id);
    const byStore = (bucket[store] ??= {});
    const o = (byStore[oid] ??= { order_id: oid, order_number: r.order_number, customer: r.customer_name, due_time: r.due_time, garments: 0, items: {}, statuses: {} });
    o.garments += qty;
    o.items[Number(r.order_item_id)] = Number(r.item_value);
    o.statuses[r.cur_status] = true;
  }
  return out;
}
