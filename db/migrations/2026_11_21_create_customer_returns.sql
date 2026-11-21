-- Customer returns (delivered garments brought back, e.g. not cleaned properly).
-- Reasons are admin-editable; each returned garment also gets a rework_records row so it flows
-- through the existing Rework -> QC -> Ready -> Packed -> Delivered pipeline.
CREATE TABLE IF NOT EXISTS return_reasons (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reason_name VARCHAR(120) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO return_reasons (reason_name, sort_order)
SELECT * FROM (
  SELECT 'Saaf nahi hua (not clean)' AS n, 1 AS s UNION ALL
  SELECT 'Daag nahi gaya (stain remains)', 2 UNION ALL
  SELECT 'Badbu / smell', 3 UNION ALL
  SELECT 'Press / finishing kharab', 4 UNION ALL
  SELECT 'Rang ya damage', 5 UNION ALL
  SELECT 'Item missing', 6 UNION ALL
  SELECT 'Other', 7
) t WHERE NOT EXISTS (SELECT 1 FROM return_reasons);

CREATE TABLE IF NOT EXISTS customer_returns (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id INT UNSIGNED NOT NULL,
  order_item_id INT UNSIGNED NOT NULL,
  reason_id INT UNSIGNED NULL,
  reason_text VARCHAR(160) NOT NULL,
  note VARCHAR(500) NULL,
  photo_id INT UNSIGNED NULL,
  rework_id INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cr_order (order_id),
  KEY idx_cr_item (order_item_id),
  KEY idx_cr_created (created_at),
  CONSTRAINT fk_cr_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_cr_item FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_cr_reason FOREIGN KEY (reason_id) REFERENCES return_reasons(id) ON DELETE SET NULL,
  CONSTRAINT fk_cr_photo FOREIGN KEY (photo_id) REFERENCES order_photos(id) ON DELETE SET NULL,
  CONSTRAINT fk_cr_rework FOREIGN KEY (rework_id) REFERENCES rework_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_cr_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
