-- Photos attached to a workshop invoice (whole bill: bill_item_id NULL) or to one garment line of it.
CREATE TABLE `workshop_bill_photos` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `bill_id` int(10) UNSIGNED NOT NULL,
  `bill_item_id` int(10) UNSIGNED DEFAULT NULL,
  `file_path` varchar(255) NOT NULL,
  `uploaded_by` int(10) UNSIGNED DEFAULT NULL,
  `uploaded_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_wbph_bill` (`bill_id`),
  KEY `idx_wbph_bill_item` (`bill_item_id`),
  CONSTRAINT `fk_wbph_bill` FOREIGN KEY (`bill_id`) REFERENCES `workshop_bills` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wbph_bill_item` FOREIGN KEY (`bill_item_id`) REFERENCES `workshop_bill_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
