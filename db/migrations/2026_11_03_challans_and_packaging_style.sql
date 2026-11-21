-- Schema the PHP CRM carries on the live database but that has no migration file in the PHP repo (applied by hand there):
--   * order_items.packaging_style -- per-garment packaging (Fold / Hanger / Half Fold / Hanger + Fold) chosen in the POS / app
--   * challans + challan_orders   -- the customer-facing Challan feature (commits 2026-11-03..05): one challan can cover several orders
-- Everything is IF NOT EXISTS, so it is a no-op on a database where PHP's own hand-applied DDL is already in place.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS packaging_style ENUM('FOLD','HANGER','HALF_FOLD','HANGER_AND_FOLD') NULL DEFAULT NULL;

CREATE TABLE IF NOT EXISTS challans (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  challan_number VARCHAR(30) NOT NULL,
  order_id INT UNSIGNED NULL,
  with_amount TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_challans_number (challan_number),
  KEY idx_challans_order (order_id),
  KEY idx_challans_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS challan_orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  challan_id INT UNSIGNED NOT NULL,
  order_id INT UNSIGNED NOT NULL,
  UNIQUE KEY uq_challan_order (challan_id, order_id),
  KEY idx_challan_orders_order (order_id),
  CONSTRAINT fk_challan_orders_challan FOREIGN KEY (challan_id) REFERENCES challans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
