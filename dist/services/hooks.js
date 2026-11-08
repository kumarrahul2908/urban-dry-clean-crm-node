export const noopOrderHooks = {
    async orderCreated(info) {
        console.warn(`[order-hooks] WhatsApp order_confirmation NOT queued for order ${info.orderNumber} (Phase 4 not ported yet)`);
    },
    async pickupScheduled(info) {
        console.warn(`[order-hooks] WhatsApp pickup_scheduled NOT queued for order ${info.orderNumber} (Phase 4 not ported yet)`);
    },
    async workshopCompleted(id) {
        console.warn(`[order-hooks] WhatsApp workshop_completed NOT queued for workshop item ${id} (Phase 4 not ported yet)`);
    },
    async orderReady(orderId) {
        console.warn(`[order-hooks] WhatsApp order_ready NOT queued for order ${orderId} (Phase 4 not ported yet)`);
    },
};
