import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool } from '../db/pool.js';
import { hashPassword } from '../lib/password.js';
export const adminEnv = (env, database = 'information_schema') => ({
    ...env, DB_NAME: database, DB_HOST: env.PROVISION_DB_HOST ?? env.DB_HOST, DB_PORT: env.PROVISION_DB_PORT ?? env.DB_PORT, DB_USER: env.PROVISION_DB_USER ?? env.DB_USER, DB_PASS: env.PROVISION_DB_PASS ?? env.DB_PASS,
});
/** Always copied from the template database. */
export const CORE_TABLES = ['roles', 'permissions', 'role_permissions', 'order_statuses', 'payment_types', 'urgent_levels', 'taxes', 'notification_templates', 'tag_design_fields', 'invoice_design_fields', 'invoice_design_toggles'];
/** Default dry-clean catalogue (copied unless `catalog: false`). */
export const CATALOG_TABLES = ['categories', 'services', 'garments', 'brands', 'colors', 'defects', 'discounts', 'expense_categories', 'price_lists', 'price_list_items', 'price_list_service_rates'];
/** Settings that must start fresh for a new business. */
const RESET_SETTINGS = { invoice_prefix_counter: '0', order_number_counter: '0', payment_prefix_counter: '0', refund_prefix_counter: '0', short_order_seq_counter: '0', logo_path: '' };
const SKIP_SETTINGS = ['order_photo_retention_days'];
const ident = (s) => '`' + s.replace(/`/g, '') + '`';
const q = (s) => "'" + s.replace(/'/g, '') + "'";
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
/**
 * Creates a ready-to-use business: its own database + DB user, schema and reference data cloned from a template database,
 * default store, first Super Admin, then registers it in the control DB. Any failure drops what was created.
 */
export async function provisionTenant(env, registry, input) {
    if (!SLUG.test(input.slug))
        throw new Error('slug: 3-30 chars, a-z 0-9 and "-"');
    const host = input.host.toLowerCase();
    if (!HOST.test(host))
        throw new Error('invalid host name');
    if (!input.admin.passwordHash && (input.admin.password ?? '').length < 8)
        throw new Error('admin password must be at least 8 characters');
    if ((await registry.control.query('SELECT id FROM tenants WHERE slug = ?', [input.slug])).length)
        throw new Error(`slug "${input.slug}" already exists`);
    if ((await registry.control.query('SELECT hostname FROM tenant_domains WHERE hostname = ?', [host])).length)
        throw new Error(`host "${host}" already registered`);
    const dbName = `udc_t_${input.slug.replace(/-/g, '_')}`, dbUser = `udc_${input.slug.replace(/-/g, '_')}`.slice(0, 32);
    const dbPass = randomBytes(18).toString('base64url'), secret = randomBytes(32).toString('hex');
    const adm = createPool(adminEnv(env));
    const a = adm.db;
    let created = false, userCreated = false;
    try {
        if ((await a.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?', [dbName])).length)
            throw new Error(`database ${dbName} already exists`);
        await a.execute(`CREATE DATABASE ${ident(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        created = true;
        // a TCP client on the same machine shows up as 'localhost' (not '%'), so grant for every host form that can reach this server
        const dbHost = env.PROVISION_DB_HOST ?? env.DB_HOST;
        const local = ['localhost', '127.0.0.1', '::1'].includes(dbHost);
        const grantHosts = local ? ['localhost', '127.0.0.1'] : ['%'];
        for (const gh of grantHosts) {
            await a.execute(`CREATE USER ${q(dbUser)}@'${gh}' IDENTIFIED BY ?`, [dbPass]);
            userCreated = true;
            await a.execute(`GRANT ALL PRIVILEGES ON ${ident(dbName)}.* TO ${q(dbUser)}@'${gh}'`);
        }
        // 1. schema = the template's schema (all base tables), FK checks off so order does not matter
        const tables = (await a.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = "BASE TABLE" ORDER BY table_name', [input.templateDb])).map((r) => r.t);
        if (!tables.length)
            throw new Error(`template database ${input.templateDb} has no tables`);
        await a.tx(async (t) => {
            await t.execute('SET FOREIGN_KEY_CHECKS = 0');
            for (const tb of tables) {
                const ddl = (await t.query(`SHOW CREATE TABLE ${ident(input.templateDb)}.${ident(tb)}`))[0]['Create Table'];
                await t.execute(`USE ${ident(dbName)}`);
                await t.execute(ddl);
                await t.execute(`USE ${ident(input.templateDb)}`);
            }
            // 2. reference data
            const want = [...CORE_TABLES, ...(input.catalog === false ? [] : CATALOG_TABLES)].filter((x) => tables.includes(x));
            for (const tb of want)
                await t.execute(`INSERT INTO ${ident(dbName)}.${ident(tb)} SELECT * FROM ${ident(input.templateDb)}.${ident(tb)}`);
            // 3. settings: template defaults, counters/branding reset, business name set
            await t.execute(`INSERT INTO ${ident(dbName)}.settings SELECT * FROM ${ident(input.templateDb)}.settings WHERE setting_key NOT IN (${SKIP_SETTINGS.map(() => '?').join(',')})`, SKIP_SETTINGS);
            for (const [k, v] of Object.entries({ ...RESET_SETTINGS, business_name: input.name })) {
                await t.execute(`INSERT INTO ${ident(dbName)}.settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [k, v]);
            }
            await t.execute('SET FOREIGN_KEY_CHECKS = 1');
        });
        // 4. organisation, default store, first Super Admin — on the new database through its own account
        const tenv = { ...env, DB_HOST: env.PROVISION_DB_HOST ?? env.DB_HOST, DB_PORT: env.PROVISION_DB_PORT ?? env.DB_PORT, DB_NAME: dbName, DB_USER: dbUser, DB_PASS: dbPass };
        const tp = createPool(tenv);
        try {
            const org = await tp.db.execute('INSERT INTO organizations (org_name, org_code) VALUES (?, ?)', [input.name, input.slug.toUpperCase().slice(0, 30)]);
            await tp.db.execute("INSERT INTO stores (organization_id, store_name, store_type, is_active) VALUES (?, 'Main', 'main', 1)", [org.insertId]);
            const role = (await tp.db.query("SELECT id FROM roles WHERE role_name = 'Super Admin' LIMIT 1"))[0];
            if (!role)
                throw new Error('template has no "Super Admin" role');
            await tp.db.execute('INSERT INTO users (role_id, full_name, username, email, mobile, password_hash, store_id, is_active) VALUES (?,?,?,?,?,?,NULL,1)', [role.id, input.admin.fullName, input.admin.username, input.admin.email ?? null, input.admin.mobile ?? '', input.admin.passwordHash ?? await hashPassword(input.admin.password)]);
            await tp.db.execute('CREATE TABLE IF NOT EXISTS udc_migrations (name VARCHAR(190) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, note VARCHAR(255) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        }
        finally {
            await tp.close();
        }
        // 5. register
        const uploadDir = join(env.TENANT_UPLOAD_ROOT, input.slug);
        await mkdir(uploadDir, { recursive: true }).catch(() => { }); // best effort (nginx user / permissions are an ops matter)
        const planId = input.planCode ? (await registry.control.query('SELECT id FROM plans WHERE code = ?', [input.planCode]))[0]?.id ?? null : null;
        if (input.planCode && planId === null)
            throw new Error(`unknown plan "${input.planCode}"`);
        const trialEnds = input.status === 'trial' ? new Date(Date.now() + (input.trialDays ?? 14) * 86400_000).toISOString().slice(0, 19).replace('T', ' ') : null;
        const r = await registry.control.execute('INSERT INTO tenants (slug, name, status, db_host, db_port, db_name, db_user, db_pass_enc, app_url, app_secret_enc, upload_dir, timezone, trial_ends_at, plan_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [input.slug, input.name, input.status ?? 'active', tenv.DB_HOST, tenv.DB_PORT, dbName, dbUser, registry.encrypt(dbPass), `https://${host}`, registry.encrypt(secret), uploadDir, input.timezone ?? 'Asia/Kolkata', trialEnds, planId]);
        await registry.control.execute('INSERT INTO tenant_domains (hostname, tenant_id, is_primary) VALUES (?,?,1)', [host, r.insertId]);
        await registry.control.execute('INSERT INTO tenant_events (tenant_id, event, detail) VALUES (?,?,?)', [r.insertId, 'provisioned', `db=${dbName} template=${input.templateDb}`]);
        registry.invalidate();
        return { tenantId: r.insertId, dbName, dbUser, host };
    }
    catch (e) {
        if (created)
            await a.execute(`DROP DATABASE IF EXISTS ${ident(dbName)}`).catch(() => { });
        if (userCreated)
            for (const gh of ['%', 'localhost', '127.0.0.1'])
                await a.execute(`DROP USER IF EXISTS ${q(dbUser)}@'${gh}'`).catch(() => { });
        throw e;
    }
    finally {
        await adm.close();
    }
}
