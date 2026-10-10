-- Migration: create printers table
--
-- Purpose: a manageable list of printer names (Super Admin adds them once under
-- Master Data > Printers), used to populate the Printer dropdown on
-- Admin > Print Settings — replacing the free-text field, matching the QDC
-- reference screenshot's dropdown UX.
--
-- NOTE: browsers do not expose the OS's installed-printer list to any website
-- for security/privacy reasons (not even QDC's own dropdown does this — see
-- chat explanation). This table is a manually-maintained reference list, the
-- same pattern already used for brands/colors/categories in this codebase.
--
-- store_print_settings.tag_printer_name / invoice_printer_name remain plain
-- VARCHAR columns (no schema change there, no new FK) — the dropdown's
-- selected value is just written into those same columns as text, exactly as
-- the free-text field did.
--
-- SAFETY: CREATE TABLE IF NOT EXISTS — safe to run more than once. No
-- existing table is touched.

CREATE TABLE IF NOT EXISTS printers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  printer_name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_printers_name (printer_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
