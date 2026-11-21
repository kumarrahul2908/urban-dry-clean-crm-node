import type { WebCtx } from './context.js';
import type { TplHelpers } from './phpRuntime.js';
import { S } from './phpRuntime.js';
import { wallDate } from './format.js';

/** The context-bound helpers (base_url, format_currency, csrf_field, Auth::can …) that generated templates call. Await ctx.loadMoney() first. */
export async function tplHelpers(ctx: WebCtx, extra: Record<string, any> = {}): Promise<TplHelpers> {
  const money = await ctx.loadMoney();
  return {
    u: (p: string) => ctx.baseUrl(p),
    money: (v: unknown) => money(v),
    fdate: (v: unknown, fmt?: string) => ctx.date(v, fmt),
    fdatetime: (v: unknown, fmt?: string) => ctx.datetime(v, fmt),
    csrfField: () => String(ctx.csrfField()),
    csrfToken: () => S(ctx.data.csrf_token),
    can: (k: string) => ctx.can(k),
    isDeliveryManager: () => ['Super Admin', 'Admin', 'Store Manager', 'Delivery Manager'].includes(ctx.roleName()),
    fixedStoreId: () => ctx.fixedStoreId(),
    activeStoreId: () => ctx.activeStoreId(),
    wallDate,
    phpDate: (fmt: string) => ctx.date(Math.floor(Date.now() / 1000), fmt),
    getSetting: (k: string, d: any = null) => ctx.settingSync(k, d),
    ...extra,
  } as TplHelpers;
}
