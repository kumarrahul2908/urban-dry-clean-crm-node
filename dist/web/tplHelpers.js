import { S } from './phpRuntime.js';
/** The context-bound helpers (base_url, format_currency, csrf_field, Auth::can …) that generated templates call. Await ctx.loadMoney() first. */
export async function tplHelpers(ctx, extra = {}) {
    const money = await ctx.loadMoney();
    return {
        u: (p) => ctx.baseUrl(p),
        money: (v) => money(v),
        fdate: (v, fmt) => ctx.date(v, fmt),
        fdatetime: (v, fmt) => ctx.datetime(v, fmt),
        csrfField: () => String(ctx.csrfField()),
        csrfToken: () => S(ctx.data.csrf_token),
        can: (k) => ctx.can(k),
        isDeliveryManager: () => ['Super Admin', 'Admin', 'Store Manager', 'Delivery Manager'].includes(ctx.roleName()),
        fixedStoreId: () => ctx.fixedStoreId(),
        activeStoreId: () => ctx.activeStoreId(),
        phpDate: (fmt) => ctx.date(Math.floor(Date.now() / 1000), fmt),
        getSetting: (k, d = null) => ctx.settingSync(k, d),
        ...extra,
    };
}
