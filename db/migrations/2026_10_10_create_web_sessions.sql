-- Node web UI sessions (replaces PHP's file-based $_SESSION for the server-rendered pages).
-- The raw session id lives only in the browser cookie; this table stores its SHA-256 hash.
CREATE TABLE IF NOT EXISTS web_sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  data MEDIUMTEXT NOT NULL,
  last_activity INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_web_sessions_user (user_id),
  KEY idx_web_sessions_activity (last_activity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
