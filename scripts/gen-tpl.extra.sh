for n in list add edit view; do gen garments/$n.php garments_$n "tplGarments$(echo $n | sed -r 's/^([a-z])/\U\1/')"; done
for n in list add edit; do gen pricelist/$n.php pricelist_$n "tplPricelist$(echo $n | sed -r 's/^([a-z])/\U\1/')"; done
gen pricelist/bulk_update.php pricelist_bulk_update tplPricelistBulkUpdate
gen admin/users.php admin_users tplAdminUsers
# settings.php uses a bare constant in its template: substitute a variable first (same line numbers)
PRE=$(mktemp -d); mkdir -p "$PRE/modules/admin"; sed 's/(int)MAX_UPLOAD_SIZE_MB/(int)$MAX_UPLOAD_SIZE_MB/' "$ROOT/modules/admin/settings.php" > "$PRE/modules/admin/settings.php"
( ROOT=$PRE; gen admin/settings.php admin_settings tplAdminSettings )
rm -rf "$PRE"
gen admin/print_settings.php admin_print_settings tplAdminPrintSettings 87 424
# pages whose template calls a closure/constant: substitute a helper call first (same line numbers)
genpre() { # file sed-expr out export
  PRE=$(mktemp -d); mkdir -p "$PRE/modules/$(dirname "$1")"; sed "$2" "$ROOT/modules/$1" > "$PRE/modules/$1"
  ( ROOT=$PRE; gen "$1" "$3" "$4" $5 $6 ); rm -rf "$PRE"
}
genpre audit/index.php 's/\$qs(/qsHelper(/g' audit_index tplAuditIndex
gen notifications/index.php notifications_index tplNotificationsIndex
genpre feedback/index.php 's/for (\$i=5;\$i>=1;\$i--):/foreach ([5,4,3,2,1] as $i):/' feedback_index tplFeedbackIndex
