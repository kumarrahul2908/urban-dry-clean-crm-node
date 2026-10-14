for n in list add edit view; do gen garments/$n.php garments_$n "tplGarments$(echo $n | sed -r 's/^([a-z])/\U\1/')"; done
