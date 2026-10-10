-- Migration: add Delivery Slip print columns to store_print_settings
--
-- Purpose: a THIRD independently-configurable print document (Delivery Slip,
-- modules/delivery/slip_print.php) alongside the existing Tag and Order
-- Invoice configs already on this table — mirrors the reference system's
-- separate "Printer configurations - Order" / "- Delivery" panels.
--
-- SAFETY:
--   - Only ADDS columns to the existing store_print_settings table — does not
--     touch tag_* or invoice_* columns, does not drop/recreate the table.
--   - Uses `ADD COLUMN IF NOT EXISTS` (supported on this server: MariaDB
--     11.8), so this file is safe to run more than once.
--   - No rows are inserted/updated. A store with no row (or an existing row
--     from before this migration) reads delivery_printer_type as NULL via a
--     plain SELECT; PrintConfigService::getDeliveryConfig() treats that the
--     same as "no row at all" and returns DEFAULT_DELIVERY, so nothing
--     changes for any store until someone explicitly saves a Delivery Slip
--     configuration.

ALTER TABLE store_print_settings
  ADD COLUMN IF NOT EXISTS delivery_printer_type ENUM('thermal','laser') NULL DEFAULT NULL AFTER invoice_printer_name,
  ADD COLUMN IF NOT EXISTS delivery_width_mm DECIMAL(6,2) NULL DEFAULT NULL AFTER delivery_printer_type,
  ADD COLUMN IF NOT EXISTS delivery_height_mm DECIMAL(6,2) NULL DEFAULT NULL AFTER delivery_width_mm,
  ADD COLUMN IF NOT EXISTS delivery_paper_size VARCHAR(20) NULL DEFAULT NULL AFTER delivery_height_mm,
  ADD COLUMN IF NOT EXISTS delivery_unit ENUM('in','mm') NULL DEFAULT NULL AFTER delivery_paper_size,
  ADD COLUMN IF NOT EXISTS delivery_printer_name VARCHAR(100) NULL DEFAULT NULL AFTER delivery_unit;
