-- Master A4: per-IP login rate limit (approved 24 Sep 2026).
-- Adds ONE table. No existing table is altered. Staging first; production only on explicit approval.
--
-- One row per client IP. failed_count counts failed logins (unknown user or wrong password,
-- any username) inside the current window; blocked_until is set once the threshold is hit.
-- Existing per-account lockout (users.failed_login_count / users.locked_until) is unchanged.

CREATE TABLE IF NOT EXISTS login_ip_attempts (
    ip_address     VARCHAR(45)  NOT NULL,
    window_start   DATETIME     NOT NULL,
    failed_count   INT UNSIGNED NOT NULL DEFAULT 0,
    blocked_until  DATETIME     NULL DEFAULT NULL,
    updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (ip_address),
    KEY idx_login_ip_attempts_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rollback:
-- DROP TABLE IF EXISTS login_ip_attempts;
