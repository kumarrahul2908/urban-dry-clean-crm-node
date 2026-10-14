for n in list add edit view; do gen garments/$n.php garments_$n "tplGarments$(echo $n | sed -r 's/^([a-z])/\U\1/')"; done
for n in list add edit; do gen pricelist/$n.php pricelist_$n "tplPricelist$(echo $n | sed -r 's/^([a-z])/\U\1/')"; done
gen pricelist/bulk_update.php pricelist_bulk_update tplPricelistBulkUpdate
gen admin/users.php admin_users tplAdminUsers
# settings.php uses a bare constant in its template: substitute a variable first (same line numbers)
PRE=$(mktemp -d); mkdir -p "$PRE/modules/admin"; sed 's/(int)MAX_UPLOAD_SIZE_MB/(int)$MAX_UPLOAD_SIZE_MB/' "$ROOT/modules/admin/settings.php" > "$PRE/modules/admin/settings.php"
( ROOT=$PRE; gen admin/settings.php admin_settings tplAdminSettings )
rm -rf "$PRE"
gen admin/print_settings.php admin_print_settings tplAdminPrintSettings 87 424
