#!/usr/bin/env bash
# One-shot server setup for a fresh Ubuntu 22.04/24.04 VPS (run as root):
#   curl -fsSL https://raw.githubusercontent.com/kumarrahul2908/urban-dry-clean-crm-node/main/deploy/bootstrap-ubuntu.sh | DOMAIN=staging.example.com EMAIL=you@example.com bash
# Idempotent: safe to re-run (pulls, rebuilds, restarts). Does NOT touch your database; fill /opt/udc/.env afterwards.
set -euo pipefail
DOMAIN=${DOMAIN:?set DOMAIN=host.name}; EMAIL=${EMAIL:?set EMAIL=for-letsencrypt}
REPO=${REPO:-https://github.com/kumarrahul2908/urban-dry-clean-crm-node.git}; BRANCH=${BRANCH:-main}
APP=/opt/udc; UPLOADS=/var/www/udc/uploads

export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y curl git nginx certbot python3-certbot-nginx rsync mariadb-client
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm i -g pm2

id udc >/dev/null 2>&1 || useradd -r -m -s /bin/bash udc
mkdir -p "$UPLOADS" && chown -R udc:udc /var/www/udc
if [ -d "$APP/.git" ]; then git -C "$APP" fetch -q origin "$BRANCH" && git -C "$APP" reset -q --hard "origin/$BRANCH"; else git clone -q -b "$BRANCH" "$REPO" "$APP"; fi
chown -R udc:udc "$APP"
if [ ! -f "$APP/.env" ]; then
  cp "$APP/.env.example" "$APP/.env"
  sed -i "s#^APP_URL=.*#APP_URL=https://$DOMAIN#; s#^TRUST_PROXY=.*#TRUST_PROXY=true#; s#^UPLOAD_DIR=.*#UPLOAD_DIR=$UPLOADS#; s#^PORT=.*#PORT=3000#; s#^HOST=.*#HOST=127.0.0.1#" "$APP/.env"
  chown udc:udc "$APP/.env"; chmod 600 "$APP/.env"
  echo ">>> Edit $APP/.env (DB_*, APP_SECRET_KEY = SAME as PHP) then re-run this script."
  NEED_ENV=1
fi
su - udc -c "cd $APP && npm ci --no-audit --no-fund && npm run build"

# nginx (HTTP first; certbot adds TLS)
sed "s/test.urbandryclean.in/$DOMAIN/" "$APP/deploy/nginx.conf" > /etc/nginx/sites-available/udc
ln -sf /etc/nginx/sites-available/udc /etc/nginx/sites-enabled/udc   # existing sites are left untouched (only our own vhost is added)
nginx -t && systemctl reload nginx
# firewall: only open ports if ufw is already active; never switch it on from here (could lock you out)
if ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; fi
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --no-eff-email --redirect -n || echo "certbot failed — point DNS at this server and re-run"

[ -n "${NEED_ENV:-}" ] && exit 0
su - udc -c "cd $APP && npm run preflight" || { echo "Preflight failed — fix the items above, then re-run."; exit 1; }
su - udc -c "cd $APP && npm run migrate"
su - udc -c "cd $APP && pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save"
env PATH=$PATH pm2 startup systemd -u udc --hp /home/udc >/dev/null || true
echo ">>> Up. Check:  $APP/scripts/smoke.sh https://$DOMAIN   (crontab for WhatsApp/photo jobs: deploy/crontab, install only at cutover)"
