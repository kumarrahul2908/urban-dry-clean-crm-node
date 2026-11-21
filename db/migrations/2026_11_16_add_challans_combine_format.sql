-- Migration: add combine_format column to challans
--
-- Purpose: Rahul: "Chalan ka ek aur format banao jaha order wise garments
-- details ho, ye bhi dono tarike se ho with amount and without amount" --
-- a second layout for a combined (multiple-orders) challan. Until now, a
-- combined challan always clubbed every order's garments together and
-- summed them by name ("aggregated"). This adds an "order_wise" option
-- that instead keeps each order's garments in that order's own section
-- (see ChallanPdfService::renderCombinedOrderWise). Only meaningful for a
-- multi-order challan, but stored for every challan (including
-- single-order ones) so a challan's own saved format is always what gets
-- reproduced on view/edit/WhatsApp-resend, never re-derived.
--
-- Applied live on 2026-11-16 via a one-time temp script (same pattern as
-- every other ad-hoc migration in this project -- Hostinger shared hosting
-- has no migration runner): ALTER TABLE challans ADD COLUMN combine_format
-- ENUM('aggregated','order_wise') NOT NULL DEFAULT 'aggregated' AFTER
-- with_amount. Recorded here for the repo/history and for the parallel
-- Node.js migration.
--
-- SAFETY: ADD COLUMN IF NOT EXISTS -- additive only, safe to run more than
-- once, default keeps every existing challan's current (aggregated)
-- rendering unchanged.

ALTER TABLE challans
  ADD COLUMN IF NOT EXISTS combine_format ENUM('aggregated','order_wise') NOT NULL DEFAULT 'aggregated' AFTER with_amount;
