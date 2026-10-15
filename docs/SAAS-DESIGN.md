# SaaS design (dry-clean / laundry businesses only)

Status: **plan only — nothing built.** Scope is fixed to one industry, so the product itself (orders, garments, QC, workshop,
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
