SET FOREIGN_KEY_CHECKS = 0;
INSERT INTO organizations (id, org_name, org_code) VALUES (1, 'Org', 'ORG');
INSERT INTO stores (id, organization_id, store_name, store_type, is_active) VALUES (1, 1, 'Main', 'main', 1);
INSERT INTO roles (id, role_name) VALUES (1, 'Admin');
INSERT INTO users (id, role_id, full_name, username, password_hash, store_id, is_active) VALUES (1, 1, 'Rahul', 'rahul', 'x', 1, 1);
INSERT INTO taxes (id, tax_name, tax_percent) VALUES (1, 'GST 5%', 5.00), (2, 'GST 12%', 12.00);
INSERT INTO price_lists (id, price_list_name, list_type) VALUES (1, 'Default', 'Default'), (2, 'VIP', 'Customer');
INSERT INTO categories (id, category_name, sort_order) VALUES (1, 'Men', 1);
INSERT INTO services (id, service_name, billing_unit, pricing_scope, sort_order) VALUES
  (1, 'Dry Clean', 'piece', 'garment', 1), (2, 'Steam Press', 'piece', 'garment', 2),
  (3, 'Wash N Fold', 'weight', 'universal', 3), (4, 'Carpet Wash', 'weight', 'garment', 4);
INSERT INTO garments (id, garment_name, sku, category_id, default_service_id) VALUES (1, 'Shirt', 'SH1', 1, 1), (2, 'Suit', 'SU1', 1, 1), (3, 'Carpet', 'CA1', 1, 4);
INSERT INTO price_list_items (price_list_id, garment_id, service_id, piece_rate, weight_rate, min_weight_charge, tax_id) VALUES
  (1,1,1,99.99,NULL,NULL,1),(1,1,2,33.33,NULL,NULL,1),(1,2,1,450.50,NULL,NULL,2),(1,2,2,120.00,NULL,NULL,NULL),
  (1,3,4,0,85.00,200.00,2),(2,1,1,79.99,NULL,NULL,1);
INSERT INTO price_list_service_rates (price_list_id, service_id, weight_rate, min_weight_charge, tax_id) VALUES (1,3,61.37,100,NULL);
INSERT INTO urgent_levels (id, level_name, surcharge_percent, day_offset, sort_order) VALUES (1, 'Express', 25.00, 1, 1), (2, 'Same Day', 50.00, 0, 2);
INSERT INTO payment_types (id, type_name, sort_order) VALUES (1, 'Cash', 1), (2, 'UPI', 2), (3, 'Wallet', 3);
INSERT INTO order_statuses (id, status_key, status_label, sort_order, color) VALUES (1, 'order_created', 'Created', 1, '#aaa'), (2, 'cancelled', 'Cancelled', 99, '#f00'), (3, 'in_workshop', 'Workshop', 2, '#bbb'),
  (4, 'received', 'Received', 3, '#111'), (5, 'workshop', 'In Workshop', 4, '#222'), (6, 'processing', 'Processing', 5, '#333'), (7, 'qc', 'QC', 6, '#444'),
  (8, 'rework', 'Rework', 7, '#555'), (9, 'ready', 'Ready', 8, '#666'), (10, 'packed', 'Packed', 9, '#777'), (11, 'out_for_delivery', 'Out', 10, '#888'), (12, 'delivered', 'Delivered', 11, '#999');
INSERT INTO customers (id, customer_code, full_name, mobile, price_list_id) VALUES (1, 'C1', 'Vip Cust', '9999999999', 2), (2, 'C2', 'Plain', '8888888888', NULL);
INSERT INTO customer_wallet (customer_id, balance) VALUES (1, 500.00), (2, 0);
INSERT INTO wallet_transactions (customer_id, txn_type, debit, credit, balance_after, remarks) VALUES (1, 'Deposit', 0, 500, 500, 'seed');
INSERT INTO defects (id, defect_name) VALUES (1, 'Stain'), (2, 'Tear');
INSERT INTO brands (id, brand_name) VALUES (1, 'Raymond');
INSERT INTO colors (id, color_name) VALUES (1, 'Blue');
INSERT INTO settings (setting_key, setting_value) VALUES
  ('default_price_list_id', '1'), ('invoice_prefix', 'INV-'), ('payment_prefix', 'PAY-'), ('refund_prefix', 'REF-'),
  ('customer_prefix', 'CUST-'), ('short_order_code_prefix', 'A'), ('short_order_code_digits', '4'), ('garment_seq_padding', '2'),
  ('max_counter_discount_percent', '10'), ('default_due_days', '2'), ('currency_symbol', 'Rs.'), ('allow_overpayment', '0'), ('pickup_prefix', 'PCK-'), ('delivery_prefix', 'DEL-');
SET FOREIGN_KEY_CHECKS = 1;
