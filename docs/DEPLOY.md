# Deploy notes (VPS)

## Uploads (order photos, garment images)
Files live on the VPS disk in `UPLOAD_DIR` (`order_photos/`, `garments/`), exactly the layout of the PHP app's
`uploads/`, so the old files can simply be copied in:

```bash
rsync -a old-server:/path/to/public_html/uploads/ /var/www/udc/uploads/     # one time
chown -R udc:udc /var/www/udc/uploads
```

* Photos are stored **exactly as uploaded** (no resize, no recompression). The only limit is the safety ceiling
  `UPLOAD_MAX_MB` (default 100, `0` = none). Keep nginx's `client_max_body_size` at least as large.
* nginx serves the files directly (do not let Node serve them in production):

```nginx
client_max_body_size 110m;
location /uploads/ {
    alias /var/www/udc/uploads/;
    add_header X-Content-Type-Options nosniff;
    add_header Cross-Origin-Resource-Policy cross-origin;
    autoindex off;
    location ~* \.(php|phtml|sh|py|cgi)$ { deny all; }
}
location / { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $remote_addr; }
```

## Order-photo retention (auto-delete after 30 days)
* Daily job: `npm run job:photo-cleanup` (after `npm run build`). Crontab example:
  `15 3 * * * cd /opt/udc && /usr/bin/node dist/jobs/photoCleanup.js >> /var/log/udc-photo-cleanup.log 2>&1`
* Days: `PHOTO_RETENTION_DAYS` (default 30), overridable from the CRM with the settings key
  `order_photo_retention_days`. `0` = never auto-delete.
* Manual "delete old images" for the CRM screen (permission `admin.settings`):
  * `GET  /api/mobile/order_photos_stats?older_than_days=30` → totals and how many are older than N days.
  * `POST /api/mobile/order_photos_cleanup {"older_than_days":30}` → **dry run** (counts + bytes that would be freed).
  * `POST /api/mobile/order_photos_cleanup {"older_than_days":30,"dry_run":false,"confirm":true}` → really deletes
    the files and rows. Irreversible; every run is written to the audit log.

## WhatsApp (queue worker, marketing, webhook)
* Accounts/templates stay in the existing tables (`whatsapp_accounts`, `notification_templates`); tokens/secrets are
  AES-GCM encrypted with `APP_SECRET_KEY` — **use the same key as the PHP app** or they cannot be decrypted.
* Outbound queue worker (every minute) and marketing automation (daily):
  ```
  * * * * *  cd /opt/udc && /usr/bin/node dist/jobs/whatsappWorker.js    >> /var/log/udc-wa-worker.log 2>&1
  30 9 * * * cd /opt/udc && /usr/bin/node dist/jobs/whatsappMarketing.js >> /var/log/udc-wa-marketing.log 2>&1
  ```
  Stop the equivalent PHP cron jobs (`cron/whatsapp_worker.php`, `cron/whatsapp_marketing_automation.php`) first —
  two workers would both send. (The queue claims rows, so overlap is safe against double-sending, but keep one.)
* Meta webhook URL: `https://<host>/api/whatsapp_webhook` (same verify token and app secret as before). nginx must pass the
  body through unchanged (it does by default); the HMAC is checked on the raw bytes.
* Invoice PDFs are generated in the OS temp dir and deleted right after upload.
