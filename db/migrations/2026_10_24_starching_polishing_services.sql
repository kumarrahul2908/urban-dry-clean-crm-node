-- New services: Starching, Polishing (changelog 2026-10-23..24, section 6). Piece-based, garment-scoped --
-- same shape as "Dry Cleaning", explicitly NOT weight-based like "Laundry". Pure data: the app already
-- generically supports any number of services from this table, no code change needed for these two.
-- Every existing garment, in every existing price list, gets a row seeded at piece_rate = 0.00
-- ("price at counter" -- same as any other unpriced garment already works via the Price List admin UI).
-- Idempotent: INSERT IGNORE against services.service_name and price_list_items' (price_list_id, garment_id,
-- service_id) unique keys, so a DB that already has these (imported from the live dump) is a no-op, and a
-- later-added garment or price list still gets backfilled on the next run.
INSERT IGNORE INTO services (service_name, description, billing_unit, pricing_scope, sort_order)
SELECT 'Starching', 'Starching (Dry Cleaning only -- not weight-based like Laundry)', 'piece', 'garment', COALESCE(MAX(sort_order), 0) + 1 FROM services;

INSERT IGNORE INTO services (service_name, description, billing_unit, pricing_scope, sort_order)
SELECT 'Polishing', 'Polishing (Dry Cleaning only -- not weight-based like Laundry)', 'piece', 'garment', COALESCE(MAX(sort_order), 0) + 1 FROM services;

INSERT IGNORE INTO price_list_items (price_list_id, garment_id, service_id, piece_rate)
SELECT pl.id, g.id, s.id, 0.00
FROM price_lists pl
JOIN garments g
JOIN services s ON s.service_name IN ('Starching', 'Polishing');
