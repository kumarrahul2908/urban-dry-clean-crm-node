-- Schema catch-up for the live-CRM changelog covering late Oct through 6 Nov 2026: the Challan
-- (delivery/packing-note) feature, and the dedicated packaging_style field that replaces the
-- three ad-hoc "Hanger"/"Fold"/"Hanger and Fold" defect rows added by the 2026-10-30 migration.

-- challan_orders is the SOURCE OF TRUTH for which orders a challan covers, for single-order
-- challans too, not just combined ones. challans.order_id is kept only as a convenience pointer
-- to the first/only order for quick joins; it is never authoritative (see ChallanService).
CREATE TABLE IF NOT EXISTS challans (
  id INT(10) UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  challan_number VARCHAR(30) NOT NULL UNIQUE,
  order_id INT(10) UNSIGNED NULL,
  with_amount TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT(10) UNSIGNED NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS challan_orders (
  id INT(10) UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  challan_id INT(10) UNSIGNED NOT NULL,
  order_id INT(10) UNSIGNED NOT NULL,
  UNIQUE KEY uniq_challan_order (challan_id, order_id),
  INDEX idx_challan (challan_id),
  INDEX idx_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Packaging (section 2): own single-choice field, separate from the multi-select Defects list.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS packaging_style ENUM('FOLD','HANGER','HALF_FOLD','HANGER_AND_FOLD') NULL DEFAULT NULL AFTER item_status;

-- Migrate any order_item already tagged with the ad-hoc Hanger/Fold/Hanger-and-Fold defects
-- (added by 2026_10_30_qc_flow_misc_schema.sql, before this dedicated field existed) onto the
-- new column, then drop those now-redundant link rows so the same thing doesn't show twice
-- (once as packaging_style, once as a leftover "defect"). No-op on a fresh install with no such
-- order_item_defects rows yet.
UPDATE order_items oi
JOIN order_item_defects oid ON oid.order_item_id = oi.id
JOIN defects d ON d.id = oid.defect_id AND d.defect_name = 'Hanger'
SET oi.packaging_style = 'HANGER';

UPDATE order_items oi
JOIN order_item_defects oid ON oid.order_item_id = oi.id
JOIN defects d ON d.id = oid.defect_id AND d.defect_name = 'Fold'
SET oi.packaging_style = 'FOLD';

UPDATE order_items oi
JOIN order_item_defects oid ON oid.order_item_id = oi.id
JOIN defects d ON d.id = oid.defect_id AND d.defect_name = 'Hanger and Fold'
SET oi.packaging_style = 'HANGER_AND_FOLD';

DELETE oid FROM order_item_defects oid
JOIN defects d ON d.id = oid.defect_id
WHERE d.defect_name IN ('Hanger', 'Fold', 'Hanger and Fold');

-- The three defect rows stay (is_active=0), kept for any historical order_item_defects
-- references pre-dating this migration, rather than deleted outright.
UPDATE defects SET is_active = 0 WHERE defect_name IN ('Hanger', 'Fold', 'Hanger and Fold');
