-- Two-way WhatsApp message log (Rahul, Nov 2026): every message WE send (invoice, challan, replies, media) and every
-- inbound reply / reaction / call event from Meta's webhook, one row per message (call = one row per call id, updated in
-- place). Live-only table in the PHP app (no migration there); recreated here from its SQL usage.
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone_number VARCHAR(32) NOT NULL,
  customer_id INT UNSIGNED NULL,
  direction ENUM('inbound','outbound') NOT NULL,
  message_type VARCHAR(20) NOT NULL DEFAULT 'text',
  message_text TEXT NULL,
  media_url VARCHAR(500) NULL,
  provider_message_id VARCHAR(128) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'sent',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_wm_phone (phone_number, created_at),
  KEY idx_wm_provider (provider_message_id),
  KEY idx_wm_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
