-- Migration: create store_print_settings table
--
-- CORRECTED 2026-09-13: store_id changed from signed INT to INT UNSIGNED to match
-- stores.id (int(10) unsigned) exactly — the original signed version caused a
-- foreign-key errno 150 on test.urbandryclean.in. If this table was already
-- partially created there (columns only, no FK) by the pre-correction version of
-- this file, run 2026_09_13b_fix_store_print_settings_store_id_type.sql instead of
-- re-running this file, so the existing table is repaired via ALTER rather than
-- re-created. Any environment where this file has not run yet (staging,
-- production, fresh installs) can just run this corrected version directly.
--
-- Purpose: REQUIREMENT 1 (configurable garment tag width/height/printer) and
-- REQUIREMENT 2 (configurable invoice/receipt paper width/height/printer type),
-- stored PER STORE so different shops can use different printers/sizes.
--
-- SAFETY:
--   - CREATE TABLE IF NOT EXISTS -> safe to run more than once.
--   - No existing table is dropped, recreated, or altered destructively.
--   - No rows are inserted here. Absence of a row for a store is intentional:
--     PrintConfigService.php falls back to hard-coded defaults that exactly
--     match the app's CURRENT hard-coded behavior (1.5in x 3.1in tag, A4 invoice),
--     so existing stores keep working unchanged until someone explicitly saves
--     a configuration via Admin > Print Settings.
--   - Foreign key is added in a guarded block so re-running this file never
--     errors with "duplicate key name" if the constraint already exists.

CREATE TABLE IF NOT EXISTS store_print_settings (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id INT UNSIGNED NOT NULL,  -- must match stores.id exactly: int(10) unsigned (confirmed via SHOW CREATE TABLE stores)

  -- ---- Tag / label printer (Design Tags) ----
  tag_width_mm DECIMAL(6,2) NOT NULL DEFAULT 38.10,   -- 1.5 in -- matches existing hard-coded tag width
  tag_height_mm DECIMAL(6,2) NOT NULL DEFAULT 78.74,  -- 3.1 in -- matches existing hard-coded tag height
  tag_unit ENUM('in','mm') NOT NULL DEFAULT 'in',     -- display unit only; canonical storage is always mm
  tag_printer_name VARCHAR(100) NULL,

  -- ---- Invoice / receipt printer (Design Invoice) ----
  invoice_printer_type ENUM('thermal','laser') NOT NULL DEFAULT 'laser',
  invoice_width_mm DECIMAL(6,2) NOT NULL DEFAULT 210.00,  -- A4 width  -- matches existing hard-coded invoice.php @page size
  invoice_height_mm DECIMAL(6,2) NULL DEFAULT 297.00,     -- A4 height; NULL = auto/continuous (thermal roll)
  invoice_paper_size VARCHAR(20) NOT NULL DEFAULT 'a4',   -- laser: a4|letter|custom   thermal: 58mm|80mm|custom
  invoice_unit ENUM('in','mm') NOT NULL DEFAULT 'mm',
  invoice_printer_name VARCHAR(100) NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uniq_store_print_settings_store (store_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Guarded FK add (only runs if the constraint doesn't already exist).
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'store_print_settings'
    AND CONSTRAINT_NAME = 'fk_store_print_settings_store'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE store_print_settings ADD CONSTRAINT fk_store_print_settings_store FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
