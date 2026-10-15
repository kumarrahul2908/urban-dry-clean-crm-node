# Cutover runbook: PHP → Node (strangler, same database)

State: every PHP page and `api/*.php` / `api/mobile/*.php` endpoint has a Node twin (same URL incl. the `.php` alias, same markup/JSON),
verified against the real PHP app on the same DB (`docs/PARITY.md`, `npm test`). Nothing in the live database schema is changed except one
additive table, `web_sessions` (`db/migrations`).

## 0. Fast path (fresh Ubuntu VPS)
```bash
# as root on the VPS (DNS A record of DOMAIN must already point to it)
curl -fsSL https://raw.githubusercontent.com/kumarrahul2908/urban-dry-clean-crm-node/main/deploy/bootstrap-ubuntu.sh | DOMAIN=staging.example.com EMAIL=you@example.com bash
nano /opt/udc/.env          # DB_*, APP_SECRET_KEY (same as PHP). Re-run the command above.
```
The script installs Node 22/nginx/pm2/certbot, builds the app, issues TLS, then runs **`npm run preflight`** (read-only checks: env, uploads dir,
assets, required tables, permission keys, bcrypt hashes, WhatsApp tokens decryptable with the key), **`npm run migrate`** (additive `db/migrations`,
recorded in `udc_migrations`; `--dry` previews, `--baseline` marks all as applied) and starts pm2. Crontab (`deploy/crontab`) is installed only at cutover.

## 0b. Prerequisites (manual route)
Node 22, nginx, pm2, MariaDB access (or the same Hostinger DB over remote access), a copy of the PHP `config/config.php` values.
`/opt/udc` = this repo (`npm ci && npm run build`), `/opt/udc/.env` from `.env.example` — **`APP_SECRET_KEY` identical to PHP**, `TRUST_PROXY=true`.
Apply the migration(s) in `db/migrations` once. `rsync` the PHP `uploads/` to `UPLOAD_DIR`. Then `deploy/ecosystem.config.cjs`, `deploy/nginx.conf`.

## 1. Staging / parallel run (days 1–N)
* Run Node on a *staging hostname* against a **copy** of the live DB (`mysqldump | mysql`). Run `scripts/smoke.sh https://staging… user pass`.
* Staff do real work on staging for a few days; compare daily totals (Reports, Daily Collection, Outstanding) with the PHP site for the same dates.
* Mobile app: point a test build/`API_BASE_URL` at staging; log in, create an order, upload a photo, record a payment.
* Cron: keep PHP cron on the live site only; enable `deploy/crontab` on staging with WhatsApp **account inactive** (or a test account) so no duplicate sends.

## 2. Cutover (low-traffic window, ~15 min)
1. Announce; stop staff entry. Put PHP site in maintenance (or just stop nginx php-fpm vhost).
2. Final DB sync is unnecessary if Node already points at the **live** DB: set `.env` DB_* to live, `pm2 restart udc-crm`.
3. Disable PHP crons (`cron/whatsapp_worker.php`, `cron/whatsapp_marketing_automation.php`, retention); install `deploy/crontab`.
4. Switch the domain's nginx `location /` to `proxy_pass http://127.0.0.1:3000` (keep `/uploads/` alias). `nginx -t && systemctl reload nginx`.
5. `scripts/smoke.sh https://test.urbandryclean.in <admin> <pw>`; place one test order + payment + print invoice; check Meta webhook (`/api/whatsapp_webhook`) verify.
6. **Sessions:** PHP and Node sessions are separate — everybody logs in once again (mobile tokens are DB-backed and keep working).

## 3. Rollback (any time within the first week)
Point nginx back to PHP and re-enable the PHP crons, disable Node crons. Same database, so no data conversion. (Rows written by Node
are readable by PHP; audit JSON differs only in `\/` escaping.)

## 4. PHP retirement (after ~2 clean weeks)
Archive the PHP repo (`urban-dry-clean-crm-backup` stays as the reference), remove its vhost/cron, delete `whatsapp_media_tmp/`, keep a DB backup.

## Known caveats
* Photo auto-delete (30 days) removes dispute evidence by design; `PHOTO_RETENTION_DAYS=0` turns it off.
* Invalid JSON bodies on some JSON actions return Fastify's generic 400 envelope instead of PHP's envelope.
* PHP defects that Node deliberately does not copy are listed in `docs/PARITY.md` (customer/order import abort, laundry garment detail 500).
