#!/bin/sh
# Smoke test of a deployed instance: scripts/smoke.sh https://staging.example.com [username password]
# Without credentials only the public/redirect behaviour is checked; with them it logs in and opens every main page.
BASE=${1:?base url}; U=$2; P=$3; fail=0
chk() { code=$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/smoke.jar -c /tmp/smoke.jar "$BASE$1"); [ "$code" = "$2" ] && echo "ok   $code $1" || { echo "FAIL $code (want $2) $1"; fail=1; }; }
rm -f /tmp/smoke.jar
chk /modules/auth/login.php 200
chk /modules/dashboard/index.php 302
chk /api/whatsapp_webhook 403
[ -n "$U" ] && {
  tok=$(curl -s -c /tmp/smoke.jar -b /tmp/smoke.jar "$BASE/modules/auth/login.php" | sed -n 's/.*name="csrf_token" value="\([0-9a-f]*\)".*/\1/p' | head -1)
  curl -s -o /dev/null -c /tmp/smoke.jar -b /tmp/smoke.jar -d "csrf_token=$tok" --data-urlencode "username=$U" --data-urlencode "password=$P" "$BASE/modules/auth/login.php"
  for p in dashboard/index orders/list customers/list pos/index laundry/index payments/list accounts/outstanding qc/index packing/index delivery/index workshop/index barcode/index \
           garments/list pricelist/list master_data/index admin/users admin/settings admin/print_settings audit/index feedback/index notifications/index reports/index reports/whatsapp/analytics; do chk "/modules/$p.php" 200; done
}
exit $fail
