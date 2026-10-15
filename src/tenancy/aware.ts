import type { Services } from '../app.js';
import { currentTenant } from './als.js';

const opaque = (v: object) => v instanceof Set || v instanceof Map || v instanceof Date || v instanceof RegExp || v instanceof Promise || Array.isArray(v) || Buffer.isBuffer(v) || ArrayBuffer.isView(v);

/**
 * `app.services` is destructured all over the code base at registration time (`const { db, audit } = app.services`), and nested
 * members are captured the same way (`svc.web.sessions`). In multi-tenant mode every object reachable from it is therefore a
 * forwarding proxy that, on EACH property access / call, walks the same path inside the CURRENT business's Services
 * (AsyncLocalStorage) — so no page or API had to change. Outside a tenant context (startup) the base services are used.
 */
export function tenantAwareServices(base: Services): Services {
  const resolve = (path: string[]): object => {
    let cur: unknown = currentTenant()?.services ?? base;
    for (const k of path) cur = (cur as Record<string, unknown>)[k];
    return cur as object;
  };
  const wrap = (initial: object, path: string[]): object =>
    new Proxy(initial, {
      get(_t, prop) {
        const target = resolve(path);
        const val = Reflect.get(target, prop, target);
        if (typeof val === 'function') return val.bind(target);
        if (val !== null && typeof val === 'object' && !opaque(val)) return wrap(val, [...path, String(prop)]);
        return val;
      },
      has(_t, prop) { return Reflect.has(resolve(path), prop); },
      set(_t, prop, value) { const target = resolve(path); return Reflect.set(target, prop, value, target); },
      ownKeys() { return Reflect.ownKeys(resolve(path)); },
      getOwnPropertyDescriptor(_t, prop) { const d = Reflect.getOwnPropertyDescriptor(resolve(path), prop); return d ? { ...d, configurable: true } : d; },
    });
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base) as (keyof Services)[]) {
    const v = base[key] as unknown;
    out[key] = v !== null && typeof v === 'object' && !opaque(v) ? wrap(v, [key as string]) : v;
  }
  return out as unknown as Services;
}
