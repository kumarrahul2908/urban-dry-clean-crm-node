# SaaS design (dry-clean / laundry businesses only)

Status: **S1–S3 built (tenant resolver, control DB, per-business pool/secret/uploads/cron, provisioning from a template DB, migrate-all) — off by default; S4–S6 (signup, billing, super-admin) not started.** Details in §6. Scope is fixed to one industry, so the product itself (orders, garments, QC, workshop,
pickup/delivery, WhatsApp, reports) stays exactly as migrated; SaaS adds *tenancy, signup and billing around it*.

## 1. Tenancy model — recommendation: one database per tenant (shared app)
| | DB per tenant (**chosen**) | `org_id` column in every table |
|---|---|---|
| Code change | Small: resolve tenant → pick its connection pool. All 65 tables / every query stay as parity-tested. | Huge: every query in every page/API gets a filter; one miss = cross-tenant data leak. |
| Isolation | Strong (a bug cannot reach another DB) | Weak (depends on each query) |
| Per-tenant backup / export / delete | Trivial (dump/drop one DB) | Hard |
| Cost | More DBs to migrate/monitor (fine for tens–low hundreds of tenants) | One DB |

The existing `organizations` table (one row today) becomes the **control-plane** `tenants` table in a separate `udc_control` DB.
If tenants ever reach thousands, the same app can move to schema-per-tenant on bigger servers; the code path (tenant → pool) stays.

## 2. Components
1. **Control DB** `udc_control`: `tenants` (id, slug, name, db_name, status trial/active/suspended/cancelled, plan_id, trial_ends_at),
   `domains` (hostname → tenant), `plans` (limits: stores, users, orders/month, WhatsApp), `subscriptions`/`invoices` (gateway ids), `super_admins`, `tenant_audit`.
2. **Tenant resolver** (Fastify hook, first thing per request): `acme.udcrm.in` or custom domain → tenant → `Db` pool from an LRU pool manager
   (`services` are built per tenant lazily and cached). Unknown/suspended host → 404 / "suspended" page. API tokens already carry their user; they resolve through the host too.
3. **Per-tenant isolation of everything outside the DB**
   * Uploads: `UPLOAD_DIR/<tenant_id>/…`; `/uploads/` served by nginx per tenant path; retention job iterates tenants.
   * Secrets: `APP_SECRET_KEY` = HKDF(master key, tenant id) so WhatsApp tokens stay decryptable only per tenant (existing live tenant keeps its current key as an override).
   * Sessions: `web_sessions` live in the tenant DB (cookie scoped to the host) — no cross-tenant session reuse possible.
   * Cron jobs (WhatsApp worker/marketing/photo cleanup): loop over active tenants with a per-tenant lock.
   * WhatsApp webhook: `/api/whatsapp_webhook` routes by host/verify-token to the right tenant.
4. **Provisioning (signup → ready in <1 min):** form (business name, owner, mobile, email, subdomain) → create DB from a **template DB**
   (schema + seed: order statuses, roles/permissions, payment types, taxes, urgent levels, default services/categories/garments, price list)
   → create first Super Admin → send WhatsApp/email welcome with login. Trial starts.
5. **Migrations:** `db/migrations` runner applies to the control DB and then to every tenant DB (idempotent, recorded per tenant, canary tenant first, abort on failure).
6. **Billing:** plans (e.g. Starter 1 store / Pro 3 stores / Chain), monthly/yearly via Razorpay (India) subscriptions + webhook;
   limits enforced in the app (store/user/order caps, WhatsApp quota); dunning → read-only → suspended; GST invoices for our own charges.
7. **Super-admin console** (separate login, separate host): tenants list, impersonate (audited), suspend/resume, plan change, usage, DB size, errors,
   run-migration status, export/delete tenant (DPDP-style data requests).
8. **Branding per tenant:** already per-DB (`settings`: name, logo, GSTIN, prefixes, print settings) — just exposed in the signup/onboarding checklist.
9. **Security/ops:** per-tenant rate limits, login lockout already per DB, nightly per-tenant dumps with retention, uptime/error monitoring,
   a cross-tenant test suite (tenant A user/token/session/upload URL must never reach tenant B).

## 3. Phases (each independently shippable)
| Phase | What | Notes |
|---|---|---|
| S0 | Finish PHP→Node cutover for the existing business | Prerequisite; unchanged behaviour |
| S1 | Tenant resolver + pool manager + control DB; existing business = tenant #1 | No visible change |
| S2 | Per-tenant uploads/secrets/cron/webhook routing | Needed before a 2nd tenant |
| S3 | Template DB + provisioning + migration runner | Manual tenant creation via CLI first |
| S4 | Public signup + onboarding wizard + trial | |
| S5 | Plans, limits, Razorpay billing, dunning | |
| S6 | Super-admin console, backups/monitoring, tenant export/delete | |

## 4. What the parity suite gives us
Every tenant runs the same, PHP-verified code; tenancy tests are added on top (two seeded tenants, assert no leakage on every route family:
web pages, `api/*.php`, `api/mobile/*`, uploads, WhatsApp webhook, cron).

## 5. Open decisions (need the owner's answer before S1)
1. Expected size: tens or thousands of businesses? (decides DB-per-tenant vs schema-per-tenant hosting.)
2. Pricing/plans and whether a free trial is wanted; payment gateway (Razorpay assumed).
3. Domain: `*.something.in` subdomains and/or customers' own domains.
4. Is the existing Urban Dry Clean data tenant #1 (recommended) and does it keep its own domain?
5. Support model: self-serve only, or onboarding help (affects the super-admin console scope).

## 6. S1 as built
* **Off unless `CONTROL_DB_NAME` is set** → the app behaves exactly as before (single business, all 231 tests unchanged). Set `CONTROL_DB_NAME`, `CONTROL_MASTER_KEY` (encrypts per-business DB password/app secret) and optionally `CONTROL_DB_HOST/PORT/USER/PASS`.
* `npm run tenant -- init | add | list | suspend | resume | cancel | host-add` (control tables in `db/control/schema.sql`: `tenants`, `tenant_domains`, `tenant_events`).
  `add` needs the business's database to exist already (S3 will create + seed it).
* Request → business by hostname (`onRequest` hook + AsyncLocalStorage). Unknown host 404, `suspended` 402, `cancelled` 404. Host lookups cached 60 s; up to 50 live pools (LRU).
* `src/tenancy/aware.ts`: every object reachable from `app.services` (db, audit, orders, `web.sessions`, `env`, crypto, storage …) is a forwarding proxy resolved per call against the current business, so none of the ~100 pages/APIs changed.
  (First version only proxied top-level members; the isolation test caught `svc.web.sessions` captured at registration time still pointing at the base DB — fixed by proxying the whole object path.)
* Per business: database, `APP_URL`, `APP_SECRET_KEY` (WhatsApp tokens), `UPLOAD_DIR`, timezone, sessions (table lives in its DB), API tokens, WhatsApp webhook (by host).
* Cron jobs (`whatsappWorker`, `whatsappMarketing`, `photoCleanup`) run once per active business via `forEachBusiness()`.
* `test/tenancy.test.ts` (needs `TEST_DB2_NAME` + `TEST_CONTROL_DB_NAME`): two businesses behind one app — own data per host, users don't exist across businesses, a session cookie from A is rejected by B, unknown/suspended hosts, 24 concurrent mixed requests never mix, db/uploads/secret/URL per business.
* Still open for S2+: tenant-aware `APP_NAME` captured at construction in a few services (falls back to the `business_name` setting everywhere it matters), nginx uploads path per business, provisioning, signup, billing, super-admin.

## 7. S3 as built — `npm run tenant -- create`
`create --slug acme --name "Acme Dry Clean" --host acme.udcrm.in --template-db <db> --admin-user owner --admin-pass '…' [--admin-name --admin-mobile --admin-email --no-catalog --trial-days 14]`
needs an admin MariaDB account (`PROVISION_DB_USER/PASS[/HOST/PORT]`: CREATE DATABASE, CREATE USER, GRANT) and a **template database** (any business DB whose reference data you want to hand out — typically a cleaned copy of the live one).
1. `udc_t_<slug>` database + its own DB user (granted on that database only) with a random password; both encrypted into the control DB.
2. Schema cloned table-by-table from the template (`SHOW CREATE TABLE`); reference data copied: roles, permissions, role_permissions, order_statuses, payment_types, urgent_levels, taxes, notification_templates, and (unless `--no-catalog`) categories, services, garments, brands, colors, defects, discounts, expense_categories, price lists + rates. **No customers/orders/users/payments are copied.**
3. Settings copied from the template; document counters reset to 0, logo cleared, `business_name` = the new name.
4. Organisation + default store "Main" + first Super Admin (bcrypt) created through the new business's own DB account.
5. Registered in the control DB (own random `APP_SECRET_KEY`, upload folder `TENANT_UPLOAD_ROOT/<slug>`), trial end if `--trial-days`.
Any failure drops the new database and user. `npm run tenant -- migrate-all [--dry]` applies `db/migrations` to every business (stops at the first failure).
`test/provision.test.ts` covers clone contents, per-business DB-user isolation, a real login on the new host, duplicates and rollback.
