-- Tag Design (admin-configurable printed garment tag; seeded to the previous hard-coded look).
CREATE TABLE `tag_design_fields` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `field_key` varchar(40) NOT NULL,
  `field_label` varchar(60) NOT NULL,
  `show_field` tinyint(1) NOT NULL DEFAULT 1,
  `font_family` varchar(40) NOT NULL DEFAULT 'Arial',
  `font_size` int(10) UNSIGNED NOT NULL DEFAULT 12,
  `is_bold` tinyint(1) NOT NULL DEFAULT 0,
  `is_italic` tinyint(1) NOT NULL DEFAULT 0,
  `is_underline` tinyint(1) NOT NULL DEFAULT 0,
  `text_align` varchar(10) NOT NULL DEFAULT 'left',
  `has_box` tinyint(1) NOT NULL DEFAULT 0,
  `sort_order` int(10) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tag_design_field_key` (`field_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `tag_design_fields` (field_key, field_label, show_field, font_family, font_size, is_bold, is_italic, is_underline, text_align, has_box, sort_order) VALUES
('logo', 'Logo', 1, 'Arial', 12, 0, 0, 0, 'center', 0, 10),
('brand_name', 'Brand Name', 1, 'Arial', 13, 1, 0, 0, 'left', 0, 20),
('qr_code', 'QR Code', 1, 'Arial', 12, 0, 0, 0, 'center', 0, 30),
('tag_id', 'Tag ID', 1, 'Arial', 12, 0, 0, 0, 'center', 0, 40),
('sequence', 'Sequence (n / total)', 1, 'Arial', 12, 0, 0, 0, 'center', 0, 50),
('customer_name', 'Customer Name', 1, 'Arial', 14, 1, 0, 0, 'center', 0, 60),
('service_name', 'Service Name', 1, 'Arial', 11, 0, 0, 0, 'center', 0, 70),
('remark', 'Remark', 1, 'Arial', 13, 0, 0, 0, 'center', 0, 80),
('create_date', 'Create Date', 1, 'Arial', 11, 0, 0, 0, 'center', 0, 90),
('garment_name', 'Garment Name', 1, 'Arial', 15, 1, 0, 0, 'center', 0, 100),
('due_date', 'Due Date', 1, 'Arial', 17, 1, 0, 0, 'center', 1, 110),
('extra_details', 'Extra Details', 1, 'Arial', 10, 0, 0, 0, 'left', 0, 120),
('piece_of_set', 'Piece of Set', 1, 'Arial', 13, 1, 0, 0, 'left', 0, 130),
('barcode_linear', 'Barcode', 1, 'Arial', 12, 0, 0, 0, 'center', 0, 140);
