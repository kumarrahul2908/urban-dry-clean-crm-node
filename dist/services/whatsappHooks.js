import { numberFormat2, phpEmpty } from '../lib/php.js';
import { getSetting } from './settings.js';
/**
 * Real OrderHooks: what OrderService / QcService / pickup_action / workshop_action fired through
 * WhatsAppService::enqueue() & friends in PHP. Failures are logged, never thrown (commit-first discipline).
 */
export function whatsappOrderHooks(db, wa, appName, log = console.error) {
    const business = async () => getSetting(db, 'business_name', appName);
    return {
        async orderCreated({ customerId, orderId, orderNumber, grandTotal }) {
            try {
                const c = (await db.query('SELECT mobile, full_name FROM customers WHERE id = ?', [customerId]))[0];
                if (c && !phpEmpty(c.mobile)) {
                    await wa.enqueue(customerId, orderId, c.mobile, 'order_confirmation', { customer_name: c.full_name, order_number: orderNumber, grand_total: numberFormat2(Number(grandTotal)), business_name: await business() }, `order_confirmation:${orderId}`);
                }
            }
            catch (e) {
                log(`WhatsApp order_confirmation enqueue failed: ${e.message}`);
            }
        },
        async pickupScheduled({ customerId, orderId, orderNumber, customerName, mobile, pickupDate }) {
            try {
                // event_ref carries today's date in PHP's date('Y-m-d') (APP_TIMEZONE); the caller supplies pickupDate only.
                await wa.enqueue(customerId, orderId, mobile, 'pickup_scheduled', { customer_name: customerName, order_number: orderNumber, pickup_date: pickupDate, business_name: await business() }, `pickup_scheduled:${orderId}:${wa.today()}`);
            }
            catch (e) {
                log(`WhatsApp pickup_scheduled enqueue failed: ${e.message}`);
            }
        },
        workshopCompleted: (id) => wa.notifyWorkshopCompleted(id),
        orderReady: (orderId) => wa.maybeNotifyOrderReady(orderId),
    };
}
