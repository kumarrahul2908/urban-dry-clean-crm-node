import type { Db } from '../db/pool.js';
import { DELIVERY_MANAGER_ROLES } from './authService.js';
import type { UserContext } from './apiAuth.js';

export interface StoreResolution {
  success: boolean;
  store_id: number | null;
  error: string | null;
  needs_selection: boolean;
}

/** Port of ApiAuth::resolveAuthorizedStoreId(): fixed-store users ignore the client's choice. */
export async function resolveAuthorizedStoreId(db: Db, ctx: UserContext, requested: number | null = null): Promise<StoreResolution> {
  const active = async (id: number) => (await db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [id])).length > 0;

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
export const canEditOrderOfStore = (ctx: UserContext, orderStoreId: number) =>
  ctx.store_id === null || ctx.store_id === orderStoreId;

/**
 * Port of ApiAuth::canActAsStoreForOrder(). A fixed-store user acts for their own store only (any client value is ignored). A
 * no-fixed-store identity (Super Admin / Admin) proves the store with the "Operating store" the app sends as store_id on
 * payment/refund: it must be an ACTIVE store AND the order's own store. Nothing sent -> fails closed (old app versions unaffected).
 */
export async function canActAsStoreForOrder(db: Db, ctx: UserContext, orderStoreId: number, requestedStoreId: number | null = null): Promise<boolean> {
  if (ctx.store_id !== null) return ctx.store_id === orderStoreId;
  if (requestedStoreId === null || requestedStoreId !== orderStoreId) return false;
  return (await db.query('SELECT id FROM stores WHERE id = ? AND is_active = 1', [requestedStoreId])).length > 0;
}

export const isDeliveryManager = (ctx: UserContext) => DELIVERY_MANAGER_ROLES.includes(ctx.role_name);

/** Port of ApiAuth::canActAsDelivery(). */
export async function canActAsDelivery(db: Db, ctx: UserContext, deliveryId: number): Promise<boolean> {
  if (isDeliveryManager(ctx)) {
    return (await db.query('SELECT id FROM delivery_orders WHERE id = ?', [deliveryId])).length > 0;
  }
  return (
    (
      await db.query(
        'SELECT dl.id FROM delivery_orders dl JOIN drivers d ON d.id = dl.driver_id WHERE dl.id = ? AND d.user_id = ?',
        [deliveryId, ctx.id],
      )
    ).length > 0
  );
}
