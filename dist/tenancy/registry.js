import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Crypto } from '../lib/crypto.js';
import { createPool } from '../db/pool.js';
import { buildServices } from '../app.js';
const SERVICE_TTL_MS = 60_000;
const MAX_POOLS = 50;
export const controlEnv = (env) => ({
    ...env,
    DB_NAME: env.CONTROL_DB_NAME,
    DB_HOST: env.CONTROL_DB_HOST ?? env.DB_HOST,
    DB_PORT: env.CONTROL_DB_PORT ?? env.DB_PORT,
    DB_USER: env.CONTROL_DB_USER ?? env.DB_USER,
    DB_PASS: env.CONTROL_DB_PASS ?? env.DB_PASS,
});
/** Looks up businesses (by hostname) in the control DB and keeps one lazily-created pool + Services per business. */
export class TenantRegistry {
    env;
    control;
    options;
    sharedPages;
    master;
    hostCache = new Map();
    runtimes = new Map();
    constructor(env, control, options = {}, sharedPages) {
        this.env = env;
        this.control = control;
        this.options = options;
        this.sharedPages = sharedPages;
        if (!env.CONTROL_MASTER_KEY)
            throw new Error('CONTROL_MASTER_KEY is required in multi-tenant mode.');
        this.master = new Crypto(env.CONTROL_MASTER_KEY);
    }
    encrypt(plain) { return this.master.encrypt(plain); }
    async resolveHost(hostname) {
        const host = hostname.toLowerCase().replace(/:\d+$/, '');
        const hit = this.hostCache.get(host);
        if (hit && Date.now() - hit.at < SERVICE_TTL_MS)
            return hit.row;
        const row = (await this.control.query('SELECT t.*, p.code AS plan_code, p.max_stores, p.max_users, p.max_orders_month FROM tenants t JOIN tenant_domains d ON d.tenant_id = t.id LEFT JOIN plans p ON p.id = t.plan_id WHERE d.hostname = ?', [host]))[0] ?? null;
        this.hostCache.set(host, { at: Date.now(), row });
        return row;
    }
    /** Per-request view of a business: plan limits (0 = unlimited) and whether the subscription still allows changes. */
    infoFor(row, now = Date.now()) {
        const day = 86400_000;
        let access = 'full';
        if (row.status === 'trial' && row.trial_ends_at && now > Date.parse(row.trial_ends_at.replace(' ', 'T') + 'Z'))
            access = 'readonly';
        if (row.status === 'active' && row.plan_ends_at && now > Date.parse(String(row.plan_ends_at).slice(0, 10) + 'T23:59:59Z') + (row.grace_days ?? 0) * day)
            access = 'readonly';
        return { id: row.id, slug: row.slug, name: row.name, status: row.status, appUrl: row.app_url, access, planCode: row.plan_code ?? null,
            limits: { stores: Number(row.max_stores ?? 0), users: Number(row.max_users ?? 0), ordersPerMonth: Number(row.max_orders_month ?? 0) } };
    }
    invalidate() { this.hostCache.clear(); }
    async list() { return this.control.query('SELECT * FROM tenants ORDER BY id'); }
    /** Env of one business: same code/config, its own database, secret, URL and upload folder. */
    tenantEnv(row) {
        return {
            ...this.env,
            DB_HOST: row.db_host, DB_PORT: row.db_port, DB_NAME: row.db_name, DB_USER: row.db_user, DB_PASS: this.master.decrypt(row.db_pass_enc),
            APP_URL: row.app_url, APP_SECRET_KEY: this.master.decrypt(row.app_secret_enc), UPLOAD_DIR: row.upload_dir, APP_TIMEZONE: row.timezone, APP_NAME: row.name,
        };
    }
    async runtimeFor(row) {
        const have = this.runtimes.get(row.id);
        if (have) {
            have.used = Date.now();
            return have.rt;
        }
        const env = this.tenantEnv(row);
        const { db, close } = createPool(env);
        const services = buildServices(env, db, this.options);
        if (this.sharedPages)
            services.web.pages = this.sharedPages; // registered page list is global, not per business
        const rt = { info: this.infoFor(row), services, row };
        this.runtimes.set(row.id, { rt, close, used: Date.now() });
        if (this.runtimes.size > MAX_POOLS)
            await this.evict();
        return rt;
    }
    async evict() {
        const oldest = [...this.runtimes.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (oldest) {
            this.runtimes.delete(oldest[0]);
            await oldest[1].close().catch(() => { });
        }
    }
    async closeAll() { for (const r of this.runtimes.values())
        await r.close().catch(() => { }); this.runtimes.clear(); }
}
export async function initControlSchema(db) {
    const sql = await readFile(fileURLToPath(new URL('../../db/control/schema.sql', import.meta.url)), 'utf8');
    for (const st of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean))
        await db.execute(st);
}
