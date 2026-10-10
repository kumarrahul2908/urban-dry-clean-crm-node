#!/usr/bin/env bash
# Builds a throwaway copy of the PHP app (from the backup repo) wired to a local test database,
# so the Node port can be compared against the REAL PHP OrderService. Not part of the product.
# usage: scripts/make-php-parity-app.sh <path-to-urban-dry-clean-crm-backup> <out-dir>
set -euo pipefail
SRC="${1:?backup repo path}"; OUT="${2:?output dir}"
rm -rf "$OUT" && mkdir -p "$OUT"
cp -r "$SRC/includes" "$OUT/includes"
cp -r "$SRC/api" "$OUT/api"
mkdir -p "$OUT/config"
cat > "$OUT/config/config.php" <<'PHP'
<?php
define('DB_NAME', getenv('UDC_DB_NAME')); define('DB_USER', getenv('UDC_DB_USER')); define('DB_PASS', getenv('UDC_DB_PASS'));
define('DB_HOST', getenv('UDC_DB_HOST') ?: '127.0.0.1'); define('DB_PORT', getenv('UDC_DB_PORT') ?: '3306');
define('APP_NAME', 'URBAN DRY CLEAN'); define('APP_URL', 'https://example.test'); define('APP_ENV', 'development');
define('APP_TIMEZONE', 'Asia/Kolkata'); define('APP_SECRET_KEY', 'parity-test-key');
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
        }
        return self::$pdo;
    }
}
PHP
cp "$(dirname "$0")/../test/parity/run.php" "$OUT/run.php"
cp "$(dirname "$0")/../test/parity/endpoint.php" "$OUT/endpoint.php"
cp "$(dirname "$0")/../test/parity/invoice.php" "$OUT/invoice.php"
echo "PHP parity app ready: $OUT"
