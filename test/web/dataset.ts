import { createHash } from 'node:crypto';
import { buildServices } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import type { Db } from '../../src/db/pool.js';
import { hashPassword } from '../../src/lib/password.js';
import { resetAndSeed } from '../helpers.js';

export const TOKENS = { admin: 'a'.repeat(64), boss: 'b'.repeat(64), ws: 'c'.repeat(64), viewer: 'd'.repeat(64), driver: 'e'.repeat(64), wstaff: 'f'.repeat(64), orphan: '9'.repeat(64) } as const;

/**
 * The shared "rich" fixture: orders in every status, payments/refunds, pickups, deliveries, workshop data, expenses…
 * Users: 1 admin(rahul), 3 boss(Super Admin, no store), 4 ws, 5 viewer, 6 driver, 7 wstaff (workshop 1), 8 orphan.
 * Every user gets `password` and (for the mobile-API tests) a bearer token from `tokens`.
 */
export async function buildDataset(db: Db, env: Env, tokens: Record<keyof typeof TOKENS, string> = TOKENS, password = 'x') {
    await resetAndSeed(db);
    const perms = ['dashboard.view', 'reports.view', 'payments.view', 'payments.collect', 'accounts.view', 'customers.view', 'audit.view', 'pos.create', 'orders.view', 'feedback.manage', 'expenses.manage', 'notifications.manage', 'garment.view', 'garment.create', 'garment.edit', 'garment.delete', 'garments.manage', 'garment_tags.view', 'qc.manage', 'rework.manage', 'packing.manage', 'pickup.manage', 'delivery.manage', 'workshop.manage', 'workshop.billing'];
    await db.execute(`INSERT INTO permissions (id, permission_key, module) VALUES ${perms.map((p, i) => `(${i + 1}, '${p}', 'x')`).join(',')}`);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (3, 'Super Admin'), (4, 'Workshop Staff'), (5, 'Nobody')");
    const rolePerms = [1, 3].flatMap((r) => perms.map((k, i) => ({ r, i: i + 1, k }))).filter((x) => !(x.r === 1 && ['garment.delete', 'garments.manage'].includes(x.k)));
    await db.execute(`INSERT INTO role_permissions (role_id, permission_id) VALUES ${rolePerms.map((x) => `(${x.r}, ${x.i})`).join(',')}, (4, 1)`);
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (3, 3, 'Boss', 'boss', 'x', NULL, 1), (4, 4, 'Ws', 'ws', 'x', 1, 1), (5, 5, 'Nobody', 'nobody', 'x', 1, 1)");
    await db.execute("INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (2, 1, 'Branch', 'branch', 1)");
    const tok = (id: number, t: string) => db.execute("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL 1 DAY)", [id, createHash('sha256').update(t).digest('hex')]);
    await db.execute("INSERT INTO roles (id, role_name) VALUES (6, 'Delivery Driver')");
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (6, 6, 'Driver', 'driver', 'x', 1, 1)");
    await db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 6, id FROM permissions WHERE permission_key IN ('delivery.manage')");
    await tok(6, tokens.driver);
    await db.execute("INSERT INTO workshops (id, workshop_name, commission_workshop_percent, is_active, invoice_prefix, invoice_next_number, payment_terms_days, state_code) VALUES (1, 'Alpha Cleaners', 60.00, 1, 'ALP', 1, 15, '07'), (2, 'Beta Works', 50.00, 1, NULL, 7, 0, NULL), (3, 'Closed', 50.00, 0, NULL, 1, 0, NULL)");
    await db.execute("INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, workshop_id, is_active) VALUES (7, 4, 'Alpha Staff', 'wstaff', 'x', NULL, 1, 1), (8, 4, 'Orphan Staff', 'orphan', 'x', NULL, NULL, 1)");
    await db.execute("INSERT INTO role_permissions (role_id, permission_id) SELECT 4, id FROM permissions WHERE permission_key IN ('workshop.manage','workshop.billing')");
    await tok(7, tokens.wstaff);
    await tok(8, tokens.orphan);
    await tok(1, tokens.admin); await tok(3, tokens.boss); await tok(4, tokens.ws); await tok(5, tokens.viewer);
    await db.execute('UPDATE users SET password_hash = ?', [await hashPassword(password)]);

    const svc = buildServices(env, db);
    const A = { userId: 1 };
    const line = (g: number, s: number, q = 1) => ({ garment_id: g, service_id: s, quantity: q });
    const mk = async (customer: number, items: object[], extra: object = {}, store = 1) => {
      const r = await svc.orders.createOrder({ customer_id: customer, items, ...extra }, A, true, store, true);
      if (!r.success) throw new Error(JSON.stringify(r.errors));
      return r.order_id as number;
    };
    const o1 = await mk(1, [line(1, 1, 3), line(2, 1)], { urgent_level_id: 1, payments: [{ payment_type_id: 1, amount: 300 }] });
    const o2 = await mk(2, [line(1, 2, 4)], { payments: [{ payment_type_id: 2, amount: 100 }] });
    const o3 = await mk(1, [line(2, 2, 2), line(1, 1)]);
    const o4 = await mk(2, [line(2, 1, 2)], { discount_type: 'Percent', discount_value: 5 });
    const o5 = await mk(1, [line(1, 1, 2)], {}, 2);
    const lo = await svc.orders.createLaundryOrder({ customer_id: 2, batches: [{ service_id: 3, weight: 4.2, rate: 61.37, garment_count: 2, garments: [{ garment_id: 1, quantity: 2 }] }] }, A, true, 1);
    await svc.orders.recordPayment(o3, 1, [{ payment_type_id: 1, amount: 50 }], 0, A);
    await svc.orders.processRefund(o1, 20, [{ payment_type_id: 1, amount: 20 }], false, 'damaged', '', A);
    // spread dates / statuses
    await db.execute("UPDATE orders SET status_id = 4, order_date = NOW() - INTERVAL 1 DAY, due_date = CURDATE() WHERE id = ?", [o1]);
    await db.execute("UPDATE orders SET status_id = 12, due_date = CURDATE() - INTERVAL 1 DAY WHERE id = ?", [o2]);
    await db.execute("UPDATE orders SET status_id = 5, order_date = NOW() - INTERVAL 10 DAY, due_date = CURDATE() - INTERVAL 3 DAY WHERE id = ?", [o3]);
    await db.execute("UPDATE order_items SET item_status = 'Workshop' WHERE order_id = ?", [o3]);
    await db.execute("UPDATE orders SET status_id = 9, order_date = NOW() - INTERVAL 40 DAY, due_date = CURDATE() + INTERVAL 2 DAY WHERE id = ?", [o4]);
    await db.execute("UPDATE order_items SET item_status = 'Ready' WHERE order_id = ?", [o4]);
    await db.execute("UPDATE orders SET status_id = 6, due_date = CURDATE() WHERE id = ?", [o5]);
    await db.execute("UPDATE orders SET due_time = '09:00:00' WHERE id = ?", [o1]);
    await db.execute("UPDATE orders SET due_time = '11:30:00' WHERE id = ?", [o5]);
    await db.execute("UPDATE order_items SET item_status = 'Processing' WHERE order_id = ?", [o5]);
    await db.execute("UPDATE orders SET due_date = CURDATE() - INTERVAL 60 DAY WHERE id = ?", [lo.order_id]);
    await db.execute("UPDATE customers SET birthday = DATE_FORMAT(CURDATE() + INTERVAL 2 DAY, '1990-%m-%d'), anniversary = DATE_FORMAT(CURDATE() + INTERVAL 5 DAY, '2015-%m-%d') WHERE id = 1");
    await db.execute("INSERT INTO pickup_orders (pickup_number, customer_id, address, pickup_date, pickup_time, garment_count, status) VALUES ('P1', 1, 'Somewhere', CURDATE(), '10:00', 3, 'Scheduled'), ('P2', 2, 'Elsewhere', CURDATE(), NULL, NULL, 'Requested')");
    await db.execute("INSERT INTO delivery_orders (delivery_number, order_id, customer_id, delivery_date, status, amount_due) VALUES ('D1', ?, 1, CURDATE(), 'Pending', 10), ('D2', ?, 1, CURDATE(), 'Delivered', 0)", [o1, o5]);
    await db.execute("INSERT INTO feedback (customer_id, order_id, rating, comments) VALUES (1, ?, 5, 'great'), (2, NULL, 2, 'slow')", [o1]);
    await db.execute("INSERT INTO qc_records (order_item_id, result, checked_at) VALUES (1, 'Passed', NOW()), (2, 'Failed', NOW()), (3, 'Rework', NOW())");
    await db.execute("INSERT INTO audit_logs (user_id, action, module, record_id, old_value, new_value, ip_address) VALUES (1, 'edit', 'customers', '1', '{\"mobile\":\"9876543210\",\"email\":\"rahul@example.com\",\"address\":\"12 Street\",\"password_hash\":\"$2y$10$abc\",\"nested\":{\"api_key\":\"zzz\",\"note\":\"ok\"},\"list\":[1,{\"token\":\"t\"}],\"empty\":{}}', 'plain text with 9876543210 inside', '10.0.0.1'), (NULL, 'login', 'auth', NULL, NULL, 'Bearer abcdef', NULL), (3, 'delete', 'orders', '99', 'my password is x', '\"just a string\"', '')");
    await db.execute("INSERT INTO expense_categories (id, category_name, is_active) VALUES (1, 'Rent', 1), (2, 'Fuel', 1), (3, 'Old', 0)");
    await db.execute("INSERT INTO expenses (expense_date, category_id, description, amount, payment_mode, vendor, remarks, created_by) VALUES (CURDATE(), 1, 'shop rent', 15000, 'Cash', 'Landlord', NULL, 1), (CURDATE() - INTERVAL 2 DAY, 2, 'diesel', 1234.5, 'UPI', NULL, 'van', 3), (DATE_FORMAT(CURDATE(), '%Y-%m-01'), 1, 'rent adv', 500, NULL, NULL, NULL, 1)");
    await db.execute("INSERT INTO income (income_date, source, description, amount, payment_mode, created_by) VALUES (CURDATE(), 'Scrap', 'hangers', 300, 'Cash', 1), (CURDATE(), 'Scrap', 'boxes', 120.25, NULL, 3)");
    await db.execute("INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, message, status, is_read) VALUES (1, NULL, NULL, 'a', 'In-App', 'shared unread', 'Sent', 0), (1, NULL, 1, 'b', 'In-App', 'mine unread', 'Sent', 0), (2, NULL, 3, 'c', 'In-App', 'boss only', 'Sent', 0), (2, NULL, 1, 'd', 'In-App', 'mine read', 'Sent', 1), (NULL, NULL, NULL, 'e', 'WhatsApp', 'not in-app', 'Sent', 0)");
    await db.execute("INSERT INTO feedback (customer_id, order_id, rating, comments, status) VALUES (2, NULL, 4, 'ok', 'Reviewed'), (1, NULL, 1, 'bad', 'Resolved')");
    // ---- operations data: items waiting at QC / in rework / ready; laundry garments at QC
    await db.execute("UPDATE order_items SET item_status = 'QC' WHERE order_id = ? ", [o3]);          // o3: 2 items at QC
    await db.execute("UPDATE order_items SET item_status = 'Rework' WHERE id = ?", [(await db.query<any>('SELECT MIN(id) AS i FROM order_items WHERE order_id = ?', [o2]))[0].i]);
    await db.execute("UPDATE order_items SET item_status = 'Ready' WHERE order_id = ?", [o4]);
    const rwItem = (await db.query<any>("SELECT id FROM order_items WHERE item_status = 'Rework' LIMIT 1"))[0].id;
    await db.execute("INSERT INTO rework_records (order_item_id, reason, rework_date, status) VALUES (?, 'stain', CURDATE(), 'Pending')", [rwItem]);
    const lgs = await db.query<any>('SELECT id FROM laundry_garments ORDER BY id');
    for (const g of lgs) await db.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, module) VALUES (?, 'Pending', 'QC', 1, NOW() - INTERVAL 1 HOUR, 'workshop')", [g.id]);
    await db.execute("INSERT INTO rework_records (laundry_garment_id, reason, rework_date, status) VALUES (?, 'crease', CURDATE(), 'In Progress')", [lgs[0].id]);
    await db.execute("INSERT INTO garment_status_history (laundry_garment_id, previous_status, new_status, changed_by, changed_at, module) VALUES (?, 'QC', 'Rework', 1, NOW(), 'qc')", [lgs[0].id]);
}
