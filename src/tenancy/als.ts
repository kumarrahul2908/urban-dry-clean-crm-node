import { AsyncLocalStorage } from 'node:async_hooks';
import type { Services } from '../app.js';

export interface TenantLimits { stores: number; users: number; ordersPerMonth: number } // 0 = unlimited
export interface TenantInfo { id: number; slug: string; name: string; status: string; appUrl: string; access: 'full' | 'readonly'; planCode: string | null; limits: TenantLimits }
export interface TenantStore { tenant: TenantInfo; services: Services }

/** The business the current request / job iteration belongs to. Empty = classic single-business mode. */
export const tenantStorage = new AsyncLocalStorage<TenantStore>();
export const currentTenant = () => tenantStorage.getStore();
