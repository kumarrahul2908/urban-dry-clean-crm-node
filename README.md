# urban-dry-clean-crm-node

Node.js (TypeScript, Fastify, MySQL/MariaDB) port of the PHP CRM backed up in
`urban-dry-clean-crm-backup`. Strangler migration: same database, same API contract, module by module.

## Phase status
| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | env config, DB pool, crypto, password, audit log, per-IP + per-account login limiter, bearer-token auth (`api_tokens`), RBAC, store/delivery authorization helpers, `POST /api/mobile/login`, `POST /api/mobile/logout`, `GET /api/mobile/me`, `/health`, Docker, CI, tests | **done (code)** |
| 2 Core domain services + mobile endpoints | **2a done:** product catalog + rates (PricingEngine, `pos_*` lookups, `pos_rate`, `pos_universal_rate`, `pos_garments`, `garments_catalog_list`, NEW `products`). **2b done:** customers (CRUD, duplicate rules), wallet (ledger, idempotent adjust). **2c done:** orders (POS + laundry create, list/detail/search, edit, item add/remove, cancel), payments (record, refund, list), OrderFinance, garment tags/barcodes — verified against the real PHP code (see `docs/PARITY.md`) | done |
| 3 REST API (non-operations) | **done:** dashboards (`dashboard_summary`, `daily_dashboard`), `reports_summary`, `daily_collection`, `outstanding_list`, `customer_history`, `audit_logs` (with redaction), feedback, expenses/income, in-app notifications, garment manage/save, barcode + QR lookup — each checked against the real `api/mobile/*.php` (see `docs/PARITY.md`) | done |
| 4 Ops modules + integrations | **4a done:** file uploads (`order_photo_*`, `garment_image`, retention + CRM cleanup). **4b done:** QC / rework / packing, pickup + delivery, workshop (challans, item lifecycle, schedule, report) + workshop billing. **4c done:** WhatsApp (Meta Cloud provider, outbound queue + worker, delivery-status/inbound webhook, template rendering), real order hooks (`order_confirmation`, `order_ready`, `pickup_scheduled`, `workshop_completed`), `password_reset_request`, `whatsapp_send_invoice`, marketing automation job, invoice PDF (FPDF-compatible renderer). All checked against the real PHP (see `docs/PARITY.md`). Barcode/QR *images* and print settings belong to the web print pages → Phase 5 | done |
| 5 Web UI + cutover | **5a done:** sessions, layout, login/landing. **5b done:** dashboards, customers (+import/export), orders (list/view/edit/payment/refund/receipt/invoice/add-items/import/export). **5d done:** QC, rework, packing, home pickup, delivery (+ drivers, my deliveries, slips), Workshop (dashboard, queue, receiving, challans, settings, report, billing, invoice print), Barcode (search, scan, tags list/print, garment detail, package stickers; QR + Code128 encoders ported byte-identically). **5c done:** POS + Laundry order screens and submit, Payments, Wallet history, Accounts (expenses, income, daily collection, outstanding, wallet adjustment). **5e done:** Master data, Garments (+bulk import / bulk image), Price lists (+CSV import, bulk update, rate APIs), Admin (users, settings + logo, print settings), audit log, notifications, feedback, Reports (+CSV export), WhatsApp admin screens (analytics, marketing, rate list, templates, API settings, inbox, campaigns) the public QR landing page `track.php`, and the remaining web `api/*.php` (barcode/QR lookup, order photos, WhatsApp senders). All compared page-by-page (HTML + whole-DB state) with the real PHP app. **Changelog 2026-10-23..24 ported** (tag renumbering on item removal, tag/piece-count fixes, workshop piece-vs-line fix across dashboard/challans/report, invoice PDF download, Send-Invoice-on-WhatsApp from Order Details, Starching/Polishing services; see `docs/PARITY.md`). **Changelog 2026-10-20..22 ported** (short order codes, Set garments, item edit, Tag/Invoice Design, Dormant Customers, workshop Whole-Bill billing + photos; see `docs/PARITY.md`). **5f ready:** `docs/CUTOVER.md` runbook, `deploy/` (pm2, nginx, crontab), `scripts/smoke.sh`; waits only for the VPS staging deploy | in progress |

## Compatibility guarantees (Phase 1)
- Response envelope identical: `{"success":true,"data":...}` / `{"success":false,"error":{"code","message"}}`.
- `/api/mobile/login.php` etc. are kept as aliases so the Android app needs no change.
- Same tables: `users`, `roles`, `permissions`, `role_permissions`, `api_tokens`, `login_ip_attempts`, `audit_logs`, `stores`.
  Tokens issued by PHP stay valid; bcrypt `$2y$` password hashes verify unchanged.
- `Crypto` is wire-compatible with PHP `Crypto.php` (AES-256-GCM, key = SHA-256(`APP_SECRET_KEY`)) —
  use the **same** `APP_SECRET_KEY` as the PHP app.

## Run
```bash
cp .env.example .env   # fill DB_* and APP_SECRET_KEY
npm ci
npm run dev            # or: npm run build && npm start
npm test && npm run typecheck
```

## Deploy on the VPS (planned)
Node 22 + pm2 (or `docker compose up -d`) behind nginx with TLS; set `TRUST_PROXY=true` so the
IP limiter sees the real client IP. Run it on a new subdomain alongside the PHP site, pointing at
the same MySQL, then switch routes over phase by phase.

## Database
`db/migrations/` holds the 7 migrations found in the PHP backup. The **base schema (users, roles,
orders, …) is not in the repo** — it must come from a `mysqldump --no-data` of the live DB
(see `db/schema/README`). Phase 2 will generate typed models from it.

## Schema (added)
`db/schema/schema.sql` = structure-only export (64 tables, no data) of the live test DB
(MariaDB 11.8, phpMyAdmin dump, 10 Oct 2026). Load it into an empty database:
```bash
mariadb -e "CREATE DATABASE udc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mariadb udc < db/schema/schema.sql
TEST_DB_NAME=udc TEST_DB_USER=... TEST_DB_PASS=... TEST_DB_PORT=3306 npm test   # also runs integration tests
```
Never commit data dumps (customers, password hashes, tokens, WhatsApp secrets).

## Product list with rates (new endpoint)
`GET /api/mobile/products?customer_id=&price_list_id=&category_id=&q=&page=&per_page=` (permission `pos.create`)
returns every active garment with all its piece-service rates, plus the universal (weight) services,
for the price list of the given customer (or `price_list_id`, or the Default list). A rate missing in the
customer's list falls back to the Default list per garment/service (same rule as `PricingEngine::getRate`);
`source_list_type` says which list each rate came from. Unpriced pairs are omitted, never returned as 0.

## Response types
Integers are JSON numbers. Fields the PHP endpoints cast with `(float)` are numbers; raw `DECIMAL` columns that PHP
passed through (e.g. `discount_percent` in `customers_list`) stay strings like `"10.00"`, as before.

## Known intentional differences
- Barcode / code generation is byte-compatible with PHP (`prefix + padded counter` under a row lock).
- `similar_text` (duplicate-name check) is ported char-wise; PHP's is byte-wise, so results can differ only for non-ASCII names.
