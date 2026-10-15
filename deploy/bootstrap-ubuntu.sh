#!/usr/bin/env bash
# The repository is PRIVATE, so there are two ways to get the code onto the server:
#   A) tarball (simplest):  scp udc-node.tar.gz root@SERVER:/root/ ; then  SRC_TARBALL=/root/udc-node.tar.gz DOMAIN=... EMAIL=... bash deploy/bootstrap-ubuntu.sh
#      (extract the tarball once first:  mkdir -p /opt/udc && tar xzf /root/udc-node.tar.gz -C /opt/udc && bash /opt/udc/deploy/bootstrap-ubuntu.sh)
#   B) deploy key: ssh-keygen -t ed25519 -f ~/.ssh/udc_deploy -N '' ; add ~/.ssh/udc_deploy.pub as a read-only Deploy key in GitHub → Settings → Deploy keys ;
#      GIT_SSH_COMMAND='ssh -i ~/.ssh/udc_deploy -o StrictHostKeyChecking=accept-new' REPO=git@github.com:kumarrahul2908/urban-dry-clean-crm-node.git bash bootstrap-ubuntu.sh
# One-shot server setup for a fresh Ubuntu 22.04/24.04 VPS (run as root):
#   curl -fsSL https://raw.githubusercontent.com/kumarrahul2908/urban-dry-clean-crm-node/main/deploy/bootstrap-ubuntu.sh | DOMAIN=staging.example.com EMAIL=you@example.com bash
# Idempotent: safe to re-run (pulls, rebuilds, restarts). Does NOT touch your database; fill /opt/udc/.env afterwards.
set -euo pipefail
DOMAIN=${DOMAIN:?set DOMAIN=host.name}; EMAIL=${EMAIL:?set EMAIL=for-letsencrypt}
REPO=${REPO:-https://github.com/kumarrahul2908/urban-dry-clean-crm-node.git}; BRANCH=${BRANCH:-main}
APP=/opt/udc; UPLOADS=/var/www/udc/uploads
PORT=${PORT:-3100}   # 3000 is commonly taken (e.g. a Next.js site on the same VPS) — never reuse a port that is listening
if ss -ltn | awk '{print $4}' | grep -qE "[:.]$PORT\$" && ! systemctl is-active --quiet udc-probe 2>/dev/null && [ ! -f /opt/udc/.env ]; then echo "Port $PORT is already in use — re-run with PORT=<free port>"; exit 1; fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y curl git nginx certbot python3-certbot-nginx rsync mariadb-client
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm i -g pm2

if [ "${INSTALL_DB:-0}" = 1 ] && ! command -v mariadb >/dev/null; then
  apt-get install -y mariadb-server && systemctl enable --now mariadb
  DBPASS=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' ); mariadb -e "CREATE DATABASE IF NOT EXISTS udc_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS 'udc'@'127.0.0.1' IDENTIFIED BY '$DBPASS'; GRANT ALL ON udc_staging.* TO 'udc'@'127.0.0.1'; FLUSH PRIVILEGES;"
  echo "$DBPASS" > /root/.udc_db_pass; chmod 600 /root/.udc_db_pass; echo ">>> MariaDB ready: db udc_staging, user udc, password in /root/.udc_db_pass (import your dump: mariadb udc_staging < dump.sql)"
fi
id udc >/dev/null 2>&1 || useradd -r -m -s /bin/bash udc
mkdir -p "$UPLOADS" && chown -R udc:udc /var/www/udc
if [ -n "${SRC_TARBALL:-}" ]; then mkdir -p "$APP" && tar xzf "$SRC_TARBALL" -C "$APP"
elif [ -f "$APP/package.json" ] && [ ! -d "$APP/.git" ]; then echo "Using the code already extracted in $APP"
elif [ -d "$APP/.git" ]; then git -C "$APP" fetch -q origin "$BRANCH" && git -C "$APP" reset -q --hard "origin/$BRANCH"; else git clone -q -b "$BRANCH" "$REPO" "$APP"; fi
chown -R udc:udc "$APP"
if [ ! -f "$APP/.env" ]; then
  cp "$APP/.env.example" "$APP/.env"
  sed -i "s#^APP_URL=.*#APP_URL=https://$DOMAIN#; s#^TRUST_PROXY=.*#TRUST_PROXY=true#; s#^UPLOAD_DIR=.*#UPLOAD_DIR=$UPLOADS#; s#^PORT=.*#PORT=$PORT#; s#^HOST=.*#HOST=127.0.0.1#" "$APP/.env"
  if [ -f /root/.udc_db_pass ]; then sed -i "s#^DB_HOST=.*#DB_HOST=127.0.0.1#; s#^DB_NAME=.*#DB_NAME=udc_staging#; s#^DB_USER=.*#DB_USER=udc#; s#^DB_PASS=.*#DB_PASS=$(cat /root/.udc_db_pass)#" "$APP/.env"; fi
  chown udc:udc "$APP/.env"; chmod 600 "$APP/.env"
  echo ">>> Edit $APP/.env (DB_*, APP_SECRET_KEY = SAME as PHP) then re-run this script."
  NEED_ENV=1
fi
su - udc -c "cd $APP && npm ci --no-audit --no-fund && npm run build"

# nginx (HTTP first; certbot adds TLS)
sed "s/__DOMAIN__/$DOMAIN/; s/__PORT__/$(grep -E '^PORT=' $APP/.env | cut -d= -f2)/" "$APP/deploy/nginx.conf" > /etc/nginx/sites-available/udc
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
