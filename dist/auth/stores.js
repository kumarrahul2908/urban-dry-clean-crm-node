import { DELIVERY_MANAGER_ROLES } from './authService.js';
/** Port of ApiAuth::resolveAuthorizedStoreId(): fixed-store users ignore the client's choice. */
export async function resolveAuthorizedStoreId(db, ctx, requested = null) {
    const active = async (id) => (await db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [id])).length > 0;
    if (ctx.store_id !== null) {
        if (!(await active(ctx.store_id))) {
            return { success: false, store_id: null, error: 'Your assigned store is inactive or invalid. Please contact an administrator.', needs_selection: false };
        }
        return { success: true, store_id: ctx.store_id, error: null, needs_selection: false };
    }
    if (requested === null) {
        return { success: false, store_id: null, error: 'Select an operating store to continue.', needs_selection: true };
    }
    if (!(await active(requested))) {
        return { success: false, store_id: null, error: 'Selected store is invalid or inactive.', needs_selection: true };
    }
    return { success: true, store_id: requested, error: null, needs_selection: false };
}
/** Port of ApiAuth::canEditOrderOfStore(). */
export const canEditOrderOfStore = (ctx, orderStoreId) => ctx.store_id === null || ctx.store_id === orderStoreId;
/** Port of ApiAuth::canActAsStoreForOrder() — fails closed for no-fixed-store identities. */
export const canActAsStoreForOrder = (ctx, orderStoreId) => ctx.store_id !== null && ctx.store_id === orderStoreId;
export const isDeliveryManager = (ctx) => DELIVERY_MANAGER_ROLES.includes(ctx.role_name);
/** Port of ApiAuth::canActAsDelivery(). */
export async function canActAsDelivery(db, ctx, deliveryId) {
    if (isDeliveryManager(ctx)) {
        return (await db.query('SELECT id FROM delivery_orders WHERE id = ?', [deliveryId])).length > 0;
    }
    return ((await db.query('SELECT dl.id FROM delivery_orders dl JOIN drivers d ON d.id = dl.driver_id WHERE dl.id = ? AND d.user_id = ?', [deliveryId, ctx.id])).length > 0);
}
