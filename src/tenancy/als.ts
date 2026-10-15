import { AsyncLocalStorage } from 'node:async_hooks';
import type { Services } from '../app.js';

export interface TenantInfo { id: number; slug: string; name: string; status: string; appUrl: string }
export interface TenantStore { tenant: TenantInfo; services: Services }

/** The business the current request / job iteration belongs to. Empty = classic single-business mode. */
export const tenantStorage = new AsyncLocalStorage<TenantStore>();
export const currentTenant = () => tenantStorage.getStore();
