/**
 * Side effects the PHP OrderService fired after an order is committed. WhatsApp queueing belongs to
 * Phase 4 (WhatsAppService port); until then the default is a logged no-op so order creation is
 * never blocked. Replace with the real implementation when WhatsApp is ported.
 */
export interface OrderHooks {
  orderCreated(info: { customerId: number; orderId: number; orderNumber: string; grandTotal: number }): Promise<void>;
}

export const noopOrderHooks: OrderHooks = {
  async orderCreated(info) {
    console.warn(`[order-hooks] WhatsApp order_confirmation NOT queued for order ${info.orderNumber} (Phase 4 not ported yet)`);
  },
};
