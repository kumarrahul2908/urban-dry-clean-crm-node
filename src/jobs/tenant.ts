import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { applyMigrations } from '../db/migrations.js';
import { provisionTenant } from '../tenancy/provision.js';
import { approveSignup } from '../tenancy/signup.js';
import { TenantRegistry, controlEnv, initControlSchema } from '../tenancy/registry.js';

/**
 * `npm run tenant -- <command>` — manage businesses in SaaS mode (needs CONTROL_DB_NAME + CONTROL_MASTER_KEY).
 *   init                                  create the control tables
 *   add --slug s --name "N" --host h --db-name d --db-user u --db-pass p --secret K [--db-host --db-port --app-url --upload-dir --timezone --status]
 *   create --slug s --name "N" --host h --template-db DB --admin-user u --admin-pass p [--admin-name --admin-mobile --admin-email --no-catalog --trial-days 14 --timezone]
 *          (new database + DB user, schema + reference data cloned from the template DB, default store, first Super Admin; needs PROVISION_DB_* admin account)
 *   requests | approve <id> | reject <id> [note]   signup requests (public /signup page; see SIGNUP_* env)
 *   migrate-all [--dry]                   apply db/migrations to the control-plane-listed businesses (stops at the first failing business)
 *   list | suspend <slug> | resume <slug> | cancel <slug> | host-add <slug> <hostname>
 */
const env = loadEnv();
if (!env.CONTROL_DB_NAME) { console.error('Set CONTROL_DB_NAME (and CONTROL_MASTER_KEY) first.'); process.exit(1); }
const control = createPool(controlEnv(env));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };
const need = (n: string) => flag(n) ?? (() => { throw new Error(`--${n} is required`); })();
try {
  if (cmd === 'init') { await initControlSchema(control.db); console.log('control schema ready'); }
  else {
    const reg = new TenantRegistry(env, control.db);
    if (cmd === 'add') {
      const host = need('host').toLowerCase();
      const r = await control.db.execute(
        'INSERT INTO tenants (slug, name, status, db_host, db_port, db_name, db_user, db_pass_enc, app_url, app_secret_enc, upload_dir, timezone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [need('slug'), need('name'), flag('status') ?? 'active', flag('db-host') ?? '127.0.0.1', Number(flag('db-port') ?? 3306), need('db-name'), need('db-user'), reg.encrypt(need('db-pass')),
          flag('app-url') ?? `https://${host}`, reg.encrypt(need('secret')), flag('upload-dir') ?? `/var/www/udc/uploads/${need('slug')}`, flag('timezone') ?? 'Asia/Kolkata']);
      await control.db.execute('INSERT INTO tenant_domains (hostname, tenant_id, is_primary) VALUES (?,?,1)', [host, r.insertId]);
      await control.db.execute('INSERT INTO tenant_events (tenant_id, event, detail) VALUES (?,?,?)', [r.insertId, 'created', host]);
      console.log(`tenant #${r.insertId} added → ${host}`);
    } else if (cmd === 'create') {
      const trial = flag('trial-days');
      const r = await provisionTenant(env, reg, {
        slug: need('slug'), name: need('name'), host: need('host'), templateDb: need('template-db'),
        admin: { username: need('admin-user'), password: need('admin-pass'), fullName: flag('admin-name') ?? 'Owner', mobile: flag('admin-mobile'), email: flag('admin-email') },
        catalog: !rest.includes('--no-catalog'), timezone: flag('timezone'), status: trial ? 'trial' : 'active', trialDays: trial ? Number(trial) : undefined,
      });
      console.log(`business #${r.tenantId} ready → https://${r.host}  (database ${r.dbName})`);
    } else if (cmd === 'requests') {
      for (const r of await control.db.query<any>("SELECT id, status, slug, business_name, owner_name, mobile, email, created_at, note FROM signup_requests ORDER BY id DESC LIMIT 50")) console.log(`#${r.id} ${r.status.padEnd(8)} ${r.slug.padEnd(20)} ${r.business_name} · ${r.owner_name} · ${r.mobile} · ${r.email} · ${r.created_at}${r.note ? ' · ' + r.note : ''}`);
    } else if (cmd === 'approve') {
      const out = await approveSignup(env, reg, Number(rest[0]));
      console.log(`approved → https://${out.host} (owner login: username "owner" + the password chosen at signup)`);
    } else if (cmd === 'reject') {
      const r = await control.db.execute("UPDATE signup_requests SET status = 'rejected', note = ? WHERE id = ? AND status IN ('pending','failed')", [rest.slice(1).join(' ') || null, Number(rest[0])]);
      console.log(r.affectedRows ? 'rejected' : 'no such pending request');
    } else if (cmd === 'migrate-all') {
      for (const t of await reg.list()) {
        if (t.status === 'cancelled') continue;
        const { db, close } = createPool(reg.tenantEnv(t));
        try { const m = await applyMigrations(db, { dry: rest.includes('--dry'), log: (x) => console.log(`[${t.slug}] ${x}`) }); console.log(`[${t.slug}] ok (${m.applied} applied)`); }
        catch (e) { console.error(`[${t.slug}] FAILED: ${(e as Error).message}`); process.exitCode = 1; await close(); break; }
        await close();
      }
    } else if (cmd === 'list') {
      for (const t of await reg.list()) console.log(`#${t.id} ${t.slug.padEnd(16)} ${t.status.padEnd(10)} ${t.db_name}  ${t.app_url}`);
    } else if (cmd === 'suspend' || cmd === 'resume' || cmd === 'cancel') {
      const status = cmd === 'suspend' ? 'suspended' : cmd === 'cancel' ? 'cancelled' : 'active';
      const r = await control.db.execute('UPDATE tenants SET status = ? WHERE slug = ?', [status, rest[0]]);
      console.log(r.affectedRows ? `${rest[0]} → ${status} (takes effect within a minute)` : 'no such tenant');
    } else if (cmd === 'host-add') {
      const t = (await control.db.query<{ id: number }>('SELECT id FROM tenants WHERE slug = ?', [rest[0]]))[0];
      if (!t) throw new Error('no such tenant');
      await control.db.execute('INSERT INTO tenant_domains (hostname, tenant_id) VALUES (?,?)', [String(rest[1]).toLowerCase(), t.id]);
      console.log('host added');
    } else console.log('commands: init | add | create | migrate-all | list | suspend | resume | cancel | host-add');
  }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; } finally { await control.close(); }
