-- Migration (correction): fix store_print_settings.store_id type mismatch (errno 150)
--
-- ROOT CAUSE: stores.id is `int(10) unsigned`. The original migration
-- (2026_09_13_create_store_print_settings_table.sql) created store_id as plain
-- `INT` (signed). MySQL/InnoDB refuses a foreign key between a signed and an
-- unsigned INT column, even though both are "INT" — this is exactly why the
-- ADD CONSTRAINT step failed with errno 150 while the base CREATE TABLE
-- (columns only, no FK yet) succeeded.
--
-- SAFETY:
--   - Does NOT drop or recreate store_print_settings or any other table.
--   - MODIFY COLUMN only changes the type/signedness; the column already
--     contains no rows (the FK step failed before anything could be
--     inserted), so there is no data to lose or convert.
--   - The FK-add block is guarded exactly as in the original migration, so
--     this file is safe to run more than once.

ALTER TABLE store_print_settings
  MODIFY COLUMN store_id INT UNSIGNED NOT NULL;

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
