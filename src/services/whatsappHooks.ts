import type { Db } from '../db/pool.js';
import { numberFormat2, phpEmpty } from '../lib/php.js';
import { getSetting } from './settings.js';
import type { OrderHooks } from './hooks.js';
import type { WhatsAppService } from './whatsappService.js';

/**
 * Real OrderHooks: what OrderService / QcService / pickup_action / workshop_action fired through
 * WhatsAppService::enqueue() & friends in PHP. Failures are logged, never thrown (commit-first discipline).
 */
export function whatsappOrderHooks(db: Db, wa: WhatsAppService, appName: string, log: (m: string) => void = console.error): OrderHooks {
  const business = async () => getSetting(db, 'business_name', appName);
  return {
    async orderCreated({ customerId, orderId, orderNumber, grandTotal }) {
      try {
        const c = (await db.query<{ mobile: string | null; full_name: string }>('SELECT mobile, full_name FROM customers WHERE id = ?', [customerId]))[0];
        if (c && !phpEmpty(c.mobile)) {
          await wa.enqueue(customerId, orderId, c.mobile as string, 'order_confirmation',
            { customer_name: c.full_name, order_number: orderNumber, grand_total: numberFormat2(Number(grandTotal)), business_name: await business() },
            `order_confirmation:${orderId}`);
        }
      } catch (e) {
        log(`WhatsApp order_confirmation enqueue failed: ${(e as Error).message}`);
      }
    },
    async pickupScheduled({ customerId, orderId, orderNumber, customerName, mobile, pickupDate }) {
      try {
        // event_ref carries today's date in PHP's date('Y-m-d') (APP_TIMEZONE); the caller supplies pickupDate only.
        await wa.enqueue(customerId, orderId, mobile, 'pickup_scheduled',
          { customer_name: customerName, order_number: orderNumber, pickup_date: pickupDate, business_name: await business() },
          `pickup_scheduled:${orderId}:${wa.today()}`);
      } catch (e) {
        log(`WhatsApp pickup_scheduled enqueue failed: ${(e as Error).message}`);
      }
    },
    workshopCompleted: (id) => wa.notifyWorkshopCompleted(id),
    orderReady: (orderId) => wa.maybeNotifyOrderReady(orderId),
  };
}
