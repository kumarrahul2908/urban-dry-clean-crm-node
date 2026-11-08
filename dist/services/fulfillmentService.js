import { BusinessError } from '../lib/errors.js';
import { generateDocumentNumber } from './documentNumber.js';
/** Port of includes/FulfillmentService.php: pickups, deliveries, driver assignment, delivered/fulfilled sync. */
export class FulfillmentService {
    db;
    audit;
    notifications;
    log;
    constructor(db, audit, notifications, log = console.error) {
        this.db = db;
        this.audit = audit;
        this.notifications = notifications;
        this.log = log;
    }
    fail(e) {
        if (e instanceof BusinessError)
            return { success: false, errors: [e.message] };
        this.log(`[fulfillment] unexpected: ${e?.stack ?? e}`);
        return { success: false, errors: ['An unexpected error occurred.'] };
    }
    async assertOrderFullyPacked(db, orderId) {
        const [row] = await db.query("SELECT COUNT(*) AS total, SUM(item_status = 'Packed') AS packed FROM order_items WHERE order_id = ?", [orderId]);
        if (!row || Number(row.total) === 0 || Number(row.packed ?? 0) !== Number(row.total)) {
            throw new BusinessError('This order is not fully packed yet — every garment must be Packed before pickup/delivery can be arranged.');
        }
        const [os] = await db.query('SELECT os.status_key FROM orders o JOIN order_statuses os ON os.id = o.status_id WHERE o.id = ?', [orderId]);
        if (os?.status_key === 'cancelled')
            throw new BusinessError('This order has been cancelled.');
    }
    async assertNoActiveFulfillment(db, orderId) {
        if ((await db.query("SELECT id FROM pickup_orders WHERE order_id = ? AND status NOT IN ('Picked Up','Cancelled','Completed')", [orderId])).length)
            throw new BusinessError('This order already has an active pickup arrangement.');
        if ((await db.query("SELECT id FROM delivery_orders WHERE order_id = ? AND status NOT IN ('Delivered','Cancelled')", [orderId])).length)
            throw new BusinessError('This order already has an active delivery arrangement.');
    }
    async createPickup(orderId, pickupDate, pickupTime, notes, a) {
        let o;
        try {
            await this.assertOrderFullyPacked(this.db, orderId);
            await this.assertNoActiveFulfillment(this.db, orderId);
            const [row] = await this.db.query('SELECT o.customer_id, c.address, c.area, c.pincode, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS garment_count FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]);
            if (!row)
                throw new BusinessError('Order not found.');
            if (!row.address)
                throw new BusinessError('This customer has no saved address on file — cannot schedule pickup.');
            o = row;
        }
        catch (e) {
            return this.fail(e);
        }
        const pickupNumber = await generateDocumentNumber(this.db, 'pickup_prefix', 6);
        try {
            const pickupId = await this.db.tx(async (t) => {
                await t.query('SELECT id FROM orders WHERE id = ? FOR UPDATE', [orderId]);
                await this.assertOrderFullyPacked(t, orderId);
                await this.assertNoActiveFulfillment(t, orderId);
                const r = await t.execute(`INSERT INTO pickup_orders (pickup_number, customer_id, order_id, address, area, pincode, pickup_date, pickup_time, garment_count, notes, status, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'Scheduled', ?)`, [pickupNumber, o.customer_id, orderId, o.address, o.area, o.pincode, pickupDate, pickupTime, o.garment_count, notes !== '' ? notes : null, a.userId]);
                await this.audit.using(t).record({ action: 'create', module: 'pickup_orders', recordId: String(r.insertId), newValue: { order_id: orderId, pickup_number: pickupNumber }, userId: a.userId, ip: a.ip });
                return r.insertId;
            });
            return { success: true, pickup_id: pickupId };
        }
        catch (e) {
            return this.fail(e);
        }
    }
    assignPickupDriver(pickupId, driverId, a) { return this.assignDriver('pickup_orders', pickupId, driverId, ['Scheduled'], 'Assigned', a); }
    async markPickedUp(pickupId, a) {
        let pickup;
        try {
            pickup = await this.db.tx(async (t) => {
                const [p] = await t.query('SELECT * FROM pickup_orders WHERE id = ? FOR UPDATE', [pickupId]);
                if (!p)
                    throw new BusinessError('Pickup record not found.');
                if (['Picked Up', 'Cancelled', 'Completed'].includes(p.status))
                    throw new BusinessError(`This pickup is already at status "${p.status}" — cannot mark picked up again.`);
                await t.execute("UPDATE pickup_orders SET status = 'Picked Up' WHERE id = ?", [pickupId]);
                await this.syncOrderAsFulfilled(t, Number(p.order_id), a.userId, 'pickup');
                await this.audit.using(t).record({ action: 'edit', module: 'pickup_orders', recordId: String(pickupId), oldValue: { status: p.status }, newValue: { status: 'Picked Up' }, userId: a.userId, ip: a.ip });
                return p;
            });
        }
        catch (e) {
            return this.fail(e);
        }
        const [o] = await this.db.query('SELECT order_number FROM orders WHERE id = ?', [pickup.order_id]);
        await this.notifications.notify('order_picked_up', `Order ${o?.order_number} picked up by customer.`, Number(pickup.customer_id), Number(pickup.order_id));
        return { success: true };
    }
    async createDelivery(orderId, deliveryDate, timeSlot, remarks, a) {
        try {
            await this.assertOrderFullyPacked(this.db, orderId);
            await this.assertNoActiveFulfillment(this.db, orderId);
        }
        catch (e) {
            return this.fail(e);
        }
        const [o] = await this.db.query('SELECT o.customer_id, o.current_due, c.mobile, c.address FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]);
        if (!o)
            return { success: false, errors: ['Order not found.'] };
        if (!o.address)
            return { success: false, errors: ['This customer has no saved address on file — cannot schedule delivery.'] };
        const deliveryNumber = await generateDocumentNumber(this.db, 'delivery_prefix', 6);
        try {
            const id = await this.db.tx(async (t) => {
                await t.query('SELECT id FROM orders WHERE id = ? FOR UPDATE', [orderId]);
                await this.assertOrderFullyPacked(t, orderId);
                await this.assertNoActiveFulfillment(t, orderId);
                const r = await t.execute(`INSERT INTO delivery_orders (delivery_number, order_id, customer_id, phone, address, amount_due, delivery_date, time_slot, status, remarks, created_by)
           VALUES (?,?,?,?,?,?,?,?, 'Pending', ?, ?)`, [deliveryNumber, orderId, o.customer_id, o.mobile, o.address, o.current_due, deliveryDate, timeSlot, remarks !== '' ? remarks : null, a.userId]);
                await this.audit.using(t).record({ action: 'create', module: 'delivery_orders', recordId: String(r.insertId), newValue: { order_id: orderId, delivery_number: deliveryNumber }, userId: a.userId, ip: a.ip });
                return r.insertId;
            });
            return { success: true, delivery_id: id };
        }
        catch (e) {
            return this.fail(e);
        }
    }
    assignDeliveryDriver(deliveryId, driverId, a) { return this.assignDriver('delivery_orders', deliveryId, driverId, ['Pending', 'Assigned'], 'Assigned', a); }
    markOutForDelivery(deliveryId, a) { return this.deliveryTransition(deliveryId, ['Pending', 'Assigned'], 'Out for Delivery', a, false); }
    markDelivered(deliveryId, a) { return this.deliveryTransition(deliveryId, ['Out for Delivery', 'Assigned', 'Pending'], 'Delivered', a, true); }
    async deliveryTransition(deliveryId, allowedFrom, newStatus, a, isFinal) {
        let delivery;
        try {
            delivery = await this.db.tx(async (t) => {
                const [d] = await t.query('SELECT * FROM delivery_orders WHERE id = ? FOR UPDATE', [deliveryId]);
                if (!d)
                    throw new BusinessError('Delivery record not found.');
                if (!allowedFrom.includes(d.status))
                    throw new BusinessError(`This delivery is at status "${d.status}" — cannot perform this action from its current state.`);
                if (d.status === newStatus)
                    throw new BusinessError(`Already at status "${newStatus}".`);
                await t.execute(`UPDATE delivery_orders SET status = ?${isFinal ? ', delivered_at = NOW()' : ''} WHERE id = ?`, [newStatus, deliveryId]);
                const [os] = await t.query('SELECT id FROM order_statuses WHERE status_key = ?', [isFinal ? 'delivered' : 'out_for_delivery']);
                if (os)
                    await t.execute('UPDATE orders SET status_id = ? WHERE id = ?', [os.id, d.order_id]);
                if (isFinal)
                    await this.markAllItemsDelivered(t, Number(d.order_id), a.userId, 'delivery');
                else {
                    await t.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, remarks, module) SELECT id, item_status, item_status, ?, NOW(), 'Order out for delivery', 'delivery' FROM order_items WHERE order_id = ?", [a.userId, d.order_id]);
                }
                await this.audit.using(t).record({ action: 'edit', module: 'delivery_orders', recordId: String(deliveryId), oldValue: { status: d.status }, newValue: { status: newStatus }, userId: a.userId, ip: a.ip });
                return d;
            });
        }
        catch (e) {
            return this.fail(e);
        }
        const [o] = await this.db.query('SELECT order_number FROM orders WHERE id = ?', [delivery.order_id]);
        await this.notifications.notify(isFinal ? 'order_delivered' : 'out_for_delivery', isFinal ? `Order ${o?.order_number} has been delivered.` : `Order ${o?.order_number} is out for delivery.`, Number(delivery.customer_id), Number(delivery.order_id));
        return { success: true };
    }
    async syncOrderAsFulfilled(db, orderId, userId, module) {
        const [os] = await db.query("SELECT id FROM order_statuses WHERE status_key = 'delivered'");
        if (os)
            await db.execute('UPDATE orders SET status_id = ? WHERE id = ?', [os.id, orderId]);
        await this.markAllItemsDelivered(db, orderId, userId, module);
    }
    async markAllItemsDelivered(db, orderId, userId, module) {
        const items = await db.query('SELECT id, item_status FROM order_items WHERE order_id = ?', [orderId]);
        for (const it of items) {
            await db.execute("UPDATE order_items SET item_status = 'Delivered' WHERE id = ?", [it.id]);
            await db.execute("INSERT INTO garment_status_history (order_item_id, previous_status, new_status, changed_by, changed_at, module) VALUES (?,?,'Delivered',?,NOW(),?)", [it.id, it.item_status, userId, module]);
        }
    }
    async assignDriver(table, recordId, driverId, allowedFrom, newStatus, a) {
        try {
            await this.db.tx(async (t) => {
                const [driver] = await t.query('SELECT id, driver_name FROM drivers WHERE id = ? AND is_active = 1', [driverId]);
                if (!driver)
                    throw new BusinessError('Selected driver is invalid or inactive.');
                const [rec] = await t.query(`SELECT * FROM \`${table}\` WHERE id = ? FOR UPDATE`, [recordId]);
                if (!rec)
                    throw new BusinessError('Record not found.');
                if (![...allowedFrom, newStatus].includes(rec.status))
                    throw new BusinessError(`Cannot assign a driver while this record is at status "${rec.status}".`);
                await t.execute(`UPDATE \`${table}\` SET driver_id = ?, status = ? WHERE id = ?`, [driverId, newStatus, recordId]);
                await this.audit.using(t).record({ action: 'edit', module: table, recordId: String(recordId), oldValue: { driver_id: rec.driver_id }, newValue: { driver_id: driverId, driver_name: driver.driver_name }, userId: a.userId, ip: a.ip });
            });
        }
        catch (e) {
            return this.fail(e);
        }
        return { success: true };
    }
}
