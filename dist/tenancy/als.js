import { AsyncLocalStorage } from 'node:async_hooks';
/** The business the current request / job iteration belongs to. Empty = classic single-business mode. */
export const tenantStorage = new AsyncLocalStorage();
export const currentTenant = () => tenantStorage.getStore();
