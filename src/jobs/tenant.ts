import { loadEnv } from '../config/env.js';
import { createPool } from '../db/pool.js';
import { TenantRegistry, controlEnv, initControlSchema } from '../tenancy/registry.js';

/**
 * `npm run tenant -- <command>` — manage businesses in SaaS mode (needs CONTROL_DB_NAME + CONTROL_MASTER_KEY).
 *   init                                  create the control tables
 *   add --slug s --name "N" --host h --db-name d --db-user u --db-pass p --secret K [--db-host --db-port --app-url --upload-dir --timezone --status]
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
    } else console.log('commands: init | add | list | suspend | resume | cancel | host-add');
  }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; } finally { await control.close(); }
