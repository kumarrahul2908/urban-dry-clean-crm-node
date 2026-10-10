# urban-dry-clean-crm-node

Node.js (TypeScript, Fastify, MySQL/MariaDB) port of the PHP CRM backed up in
`urban-dry-clean-crm-backup`. Strangler migration: same database, same API contract, module by module.

## Phase status
| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | env config, DB pool, crypto, password, audit log, per-IP + per-account login limiter, bearer-token auth (`api_tokens`), RBAC, store/delivery authorization helpers, `POST /api/mobile/login`, `POST /api/mobile/logout`, `GET /api/mobile/me`, `/health`, Docker, CI, tests | **done (code)** |
| 2 Core domain services | customers, wallet, orders, pricing, finance, garments, price list, master data | next |
| 3 REST API | remaining `api/mobile/*` (78) + `api/*` (27) | |
| 4 Ops modules + integrations | workshop, QC, packing, delivery, WhatsApp, cron, PDF, barcode/QR | |
| 5 Web UI + cutover | | |

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
