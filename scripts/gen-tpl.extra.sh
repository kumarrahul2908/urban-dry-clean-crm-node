for n in list add edit view; do gen garments/$n.php garments_$n "tplGarments$(echo $n | sed -r 's/^([a-z])/\U\1/')"; done
for n in list add edit; do gen pricelist/$n.php pricelist_$n "tplPricelist$(echo $n | sed -r 's/^([a-z])/\U\1/')"; done
gen pricelist/bulk_update.php pricelist_bulk_update tplPricelistBulkUpdate
