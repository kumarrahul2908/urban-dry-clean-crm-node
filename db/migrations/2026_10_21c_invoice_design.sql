-- Invoice Design (header text styling, content toggles, Terms & Conditions); seeded to the previous hard-coded invoice.
CREATE TABLE `invoice_design_fields` (
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
  `sort_order` int(10) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_design_field_key` (`field_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `invoice_design_fields` (field_key, field_label, show_field, font_family, font_size, is_bold, is_italic, is_underline, text_align, sort_order) VALUES
('store_name', 'Store Name', 1, 'Arial', 24, 1, 0, 0, 'left', 10),
('store_address', 'Store Address / Contact', 1, 'Arial', 13, 0, 0, 0, 'left', 20),
('footer_note', 'Footer Note', 1, 'Arial', 12, 0, 0, 0, 'left', 30);
CREATE TABLE `invoice_design_toggles` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `toggle_key` varchar(40) NOT NULL,
  `toggle_label` varchar(80) NOT NULL,
  `is_on` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(10) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoice_design_toggle_key` (`toggle_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO `invoice_design_toggles` (toggle_key, toggle_label, is_on, sort_order) VALUES
('show_logo', 'Print Logo', 1, 10),
('show_phone_on_invoice', 'Print Phone / WhatsApp number', 1, 20),
('show_due_date', 'Print Due Date', 1, 30),
('show_urgent_level', 'Print Urgent Level', 1, 40),
('show_home_delivery', 'Print Home Delivery', 1, 50),
('show_packaging', 'Print Packaging Preference', 1, 60),
('show_order_create_time', 'Print Order Create Time', 0, 70),
('show_tax_breakdown', 'Print Tax % / Tax Amount columns', 1, 80),
('show_barcode', 'Print Barcode', 0, 90),
('show_signature_box', 'Print Customer Signature Box', 0, 100),
('show_terms', 'Print Terms & Conditions', 0, 110);
CREATE TABLE `invoice_terms_conditions` (
  `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT,
  `line_text` varchar(500) NOT NULL,
  `sort_order` int(10) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
