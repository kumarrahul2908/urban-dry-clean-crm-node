#!/bin/sh
# Regenerates src/web/tpl/*.ts from the PHP pages. usage: scripts/gen-tpl.sh <php-backup-root>
# Each entry: <php path under modules/> <out name> <export name> [first-line last-line]  (default region = after header.php's "?>" to before footer.php)
ROOT=${1:?php root}
gen() { # file out export [first last]
  f="$ROOT/modules/$1"
  if [ -n "$4" ]; then a=$4; b=$5; else
    h=$(grep -n "includes/header.php" "$f" | head -1 | cut -d: -f1); ft=$(grep -n "includes/footer.php" "$f" | tail -1 | cut -d: -f1); a=$((h+2)); b=$((ft-1)); fi
  python3 "$(dirname "$0")/php-tpl.py" "$f" "$a" "$b" "$3" > "$(dirname "$0")/../src/web/tpl/$2.ts" || echo "FAILED $1"
}
for n in categories stores workshops services taxes discounts urgent_levels payment_types brands colors defects; do
  gen master_data/$n.php master_$n "tpl$(echo $n | sed -r 's/(^|_)([a-z])/\U\2/g')"
done
[ ! -f "$(dirname "$0")/gen-tpl.extra.sh" ] || . "$(dirname "$0")/gen-tpl.extra.sh"
