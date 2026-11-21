-- Rahul: "delivery chalan, isme order ka final amount bhi rahega" -- third challan layout.
-- Additive only: widens the ENUM, existing rows untouched.
ALTER TABLE challans MODIFY combine_format ENUM('aggregated','order_wise','delivery') NOT NULL DEFAULT 'aggregated';
