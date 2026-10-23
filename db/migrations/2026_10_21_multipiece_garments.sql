-- Multi-piece "Set" garments (PHP changelog 2026-10-20..22, section 3).
-- garments.pieces_per_unit: physical pieces per ordered unit (1 = ordinary garment).
-- order_items.* are copied from the garment at order time so an order stays correct if the master changes later.
-- barcodes.piece_index: which physical piece a tag is for; the old 1:1 unique on order_item_id becomes (order_item_id, piece_index).
ALTER TABLE `garments` ADD COLUMN `pieces_per_unit` int(10) UNSIGNED NOT NULL DEFAULT 1 AFTER `unit`;
ALTER TABLE `garments` ADD COLUMN `piece_names` varchar(255) DEFAULT NULL AFTER `pieces_per_unit`;
ALTER TABLE `order_items` ADD COLUMN `pieces_per_unit` int(10) UNSIGNED NOT NULL DEFAULT 1 AFTER `unit`;
ALTER TABLE `order_items` ADD COLUMN `piece_names` varchar(255) DEFAULT NULL AFTER `pieces_per_unit`;
ALTER TABLE `barcodes` ADD COLUMN `piece_index` int(10) UNSIGNED NOT NULL DEFAULT 1 AFTER `item_sequence`;
-- composite unique first: the order_item_id FK keeps an index to lean on while the old single-column unique is dropped
ALTER TABLE `barcodes` ADD UNIQUE KEY `uq_barcodes_item_piece` (`order_item_id`, `piece_index`);
ALTER TABLE `barcodes` DROP INDEX `order_item_id`;
