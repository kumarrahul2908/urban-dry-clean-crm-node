/**
 * Side effects the PHP OrderService fired after an order is committed. WhatsApp queueing belongs to
 * Phase 4 (WhatsAppService port); until then the default is a logged no-op so order creation is
 * never blocked. Replace with the real implementation when WhatsApp is ported.
 */
export interface OrderHooks {
  orderCreated(info: { customerId: number; orderId: number; orderNumber: string; grandTotal: number }): Promise<void>;
  /** WhatsAppService::maybeNotifyOrderReady(): fired when QC passes an item / a laundry batch becomes fully Ready. */
  orderReady(orderId: number): Promise<void>;
}

export const noopOrderHooks: OrderHooks = {
  async orderCreated(info) {
    console.warn(`[order-hooks] WhatsApp order_confirmation NOT queued for order ${info.orderNumber} (Phase 4 not ported yet)`);
  },
  async orderReady(orderId) {
    console.warn(`[order-hooks] WhatsApp order_ready NOT queued for order ${orderId} (Phase 4 not ported yet)`);
  },
};
