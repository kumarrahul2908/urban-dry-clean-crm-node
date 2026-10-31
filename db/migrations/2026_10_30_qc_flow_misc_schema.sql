-- Schema catch-up for the live-CRM changelog 2026-10-23..30 (QC/Ironing/Packaging redesign,
-- per-store order code prefix, store name on tags, new workshop defects). order_items.item_status
-- already has 'QC'/'Ready'/'Packed' in this port's base schema (the QC/Packing modules already
-- used them), so no change needed there -- only the net-new columns/rows below.

-- Per-store order-code prefix (section 8): falls back to the global short_order_code_prefix
-- setting when NULL/empty -- see generate_short_order_code() in documentNumber.ts.
ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS code_prefix VARCHAR(5) NULL DEFAULT NULL AFTER store_name;

-- Store name now prints on garment tags (section 1/9); idempotent on field_key.
INSERT IGNORE INTO tag_design_fields (field_key, field_label, show_field, font_family, font_size, is_bold, is_italic, is_underline, text_align, has_box, sort_order)
VALUES ('store_name', 'Store Name', 1, 'Arial', 11, 0, 0, 0, 'center', 0, 65);

-- New defects used on tags + the Send-to-Workshop report (section 1); idempotent on defect_name
-- (unique key), sort_order continues after whatever is already there.
INSERT IGNORE INTO defects (defect_name, sort_order) SELECT 'Hanger', COALESCE(MAX(sort_order), 0) + 1 FROM defects;
INSERT IGNORE INTO defects (defect_name, sort_order) SELECT 'Fold', COALESCE(MAX(sort_order), 0) + 1 FROM defects;
INSERT IGNORE INTO defects (defect_name, sort_order) SELECT 'Hanger and Fold', COALESCE(MAX(sort_order), 0) + 1 FROM defects;
