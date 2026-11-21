#!/usr/bin/env bash
# Builds a throwaway copy of the PHP app (from the backup repo) wired to a local test database,
# so the Node port can be compared against the REAL PHP OrderService. Not part of the product.
# usage: scripts/make-php-parity-app.sh <path-to-urban-dry-clean-crm-backup> <out-dir>
set -euo pipefail
SRC="${1:?backup repo path}"; OUT="${2:?output dir}"
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r "$SRC/includes" "$OUT/includes"
cp -r "$SRC/api" "$OUT/api"
cp -r "$SRC/modules" "$OUT/modules"
cp -r "$SRC/assets" "$OUT/assets"
cp "$SRC/index.php" "$OUT/index.php"; cp "$SRC/track.php" "$OUT/track.php"
# The live CRM's mobile pos_garments.php also returns pieces_per_unit (changelog 2026-10-22, section 9) but the backup repo predates that
# edit, so mirror it in this throwaway copy; the Node port follows the changelog.
sed -i "s/g\.unit, g\.default_service_id FROM garments g/g.unit, g.pieces_per_unit, g.default_service_id FROM garments g/; s/'unit' => \$g\['unit'\],/'unit' => \$g['unit'], 'pieces_per_unit' => max(1, (int)\$g['pieces_per_unit']),/" "$OUT/api/mobile/pos_garments.php"
# PHP leaves the order of tied rows unspecified (MariaDB may flip it between two executions as table statistics change), so add the same
# explicit tie-breakers to this throwaway copy that the Node port has; otherwise a parity run could flake on ordering alone.
sed -i "s/ORDER BY t.store_name, t.due_date, t.due_time IS NULL, t.due_time, t.order_number\"/ORDER BY t.store_name, t.due_date, t.due_time IS NULL, t.due_time, t.order_number, t.wi_id\"/" "$OUT/includes/WorkshopScope.php"
sed -i "s/ORDER BY store_name, order_number\"/ORDER BY store_name, order_number, oi.id\"/" "$OUT/includes/WorkshopInvoice.php"
sed -i "s/ORDER BY store_name, o.order_number\"/ORDER BY store_name, o.order_number, oi.id\"/" "$OUT/includes/WorkshopInvoice.php"
sed -i "s/WHERE wbi.bill_id = ? ORDER BY o.order_number\"/WHERE wbi.bill_id = ? ORDER BY o.order_number, wbi.id\"/" "$OUT/api/mobile/workshop_billing_detail.php"
sed -i "s/     ORDER BY ar.due_date\"/     ORDER BY ar.due_date, ar.id\"/" "$OUT/api/mobile/outstanding_list.php"
mkdir -p "$OUT/config"
cat > "$OUT/config/config.php" <<'PHP'
<?php
define('DB_NAME', getenv('UDC_DB_NAME')); define('DB_USER', getenv('UDC_DB_USER')); define('DB_PASS', getenv('UDC_DB_PASS'));
define('DB_HOST', getenv('UDC_DB_HOST') ?: '127.0.0.1'); define('DB_PORT', getenv('UDC_DB_PORT') ?: '3306');
define('APP_NAME', 'URBAN DRY CLEAN'); define('APP_URL', 'https://example.test'); define('APP_ENV', 'development');
define('APP_TIMEZONE', 'Asia/Kolkata'); define('APP_SECRET_KEY', 'parity-test-key');
define('MAX_UPLOAD_SIZE_MB', 5); define('ALLOWED_IMAGE_TYPES', ['jpg','jpeg','png','webp']);
define('SESSION_LIFETIME_MINUTES', 120); define('MAX_LOGIN_ATTEMPTS', 5); define('LOGIN_LOCKOUT_MINUTES', 15);
date_default_timezone_set(APP_TIMEZONE);
PHP
cat > "$OUT/config/database.php" <<'PHP'
<?php
class Database {
    private static $pdo = null;
    public static function getConnection(): PDO {
        if (!self::$pdo) {
            self::$pdo = new PDO('mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';charset=utf8mb4', DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
            self::$pdo->exec("SET time_zone = '+05:30'");  // same as the real config/database.php (21 Nov 2026)
        }
        return self::$pdo;
    }
}
PHP
cp "$(dirname "$0")/../test/parity/run.php" "$OUT/run.php"
cp "$(dirname "$0")/../test/parity/endpoint.php" "$OUT/endpoint.php"
cp "$(dirname "$0")/../test/parity/invoice.php" "$OUT/invoice.php"
cp "$(dirname "$0")/../test/parity/workshop_bill.php" "$OUT/workshop_bill.php"
cp "$(dirname "$0")/../test/parity/challan.php" "$OUT/challan.php"
mkdir -p "$OUT/uploads/tmp"
echo "PHP parity app ready: $OUT"
