-- Control plane for multi-tenant mode (one database per business). Created by `npm run tenant -- init`.
CREATE TABLE IF NOT EXISTS tenants (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(40) NOT NULL,
  name VARCHAR(150) NOT NULL,
  status ENUM('trial','active','suspended','cancelled') NOT NULL DEFAULT 'active',
  db_host VARCHAR(120) NOT NULL DEFAULT '127.0.0.1',
  db_port INT UNSIGNED NOT NULL DEFAULT 3306,
  db_name VARCHAR(80) NOT NULL,
  db_user VARCHAR(80) NOT NULL,
  db_pass_enc TEXT NOT NULL,
  app_url VARCHAR(200) NOT NULL,
  app_secret_enc TEXT NOT NULL,
  upload_dir VARCHAR(255) NOT NULL,
  timezone VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata',
  trial_ends_at DATETIME NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenants_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_domains (
  hostname VARCHAR(190) NOT NULL PRIMARY KEY,
  tenant_id INT UNSIGNED NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_tenant_domains_tenant (tenant_id),
  CONSTRAINT fk_tenant_domains_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT UNSIGNED NULL,
  event VARCHAR(60) NOT NULL,
  detail VARCHAR(500) NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS signup_requests (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  business_name VARCHAR(150) NOT NULL,
  owner_name VARCHAR(100) NOT NULL,
  mobile VARCHAR(20) NOT NULL,
  email VARCHAR(150) NOT NULL,
  slug VARCHAR(40) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  status ENUM('pending','approved','rejected','failed') NOT NULL DEFAULT 'pending',
  tenant_id INT UNSIGNED NULL,
  note VARCHAR(500) NULL,
  ip VARCHAR(45) NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_signup_slug (slug),
  KEY idx_signup_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plans (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL,
  name VARCHAR(80) NOT NULL,
  price_monthly DECIMAL(10,2) NULL,
  price_yearly DECIMAL(10,2) NULL,
  max_stores INT UNSIGNED NOT NULL DEFAULT 0,
  max_users INT UNSIGNED NOT NULL DEFAULT 0,
  max_orders_month INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_plans_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO plans (code, name, max_stores, max_users, max_orders_month) VALUES ('trial', 'Trial', 1, 3, 200), ('starter', 'Starter', 1, 5, 1000), ('pro', 'Pro', 3, 15, 5000), ('chain', 'Chain', 0, 0, 0);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_id INT UNSIGNED NULL;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_ends_at DATE NULL;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS grace_days INT UNSIGNED NOT NULL DEFAULT 5;
