-- Urban Dry Clean — Phase 1A: Mobile API + Auth Foundation
-- New table: api_tokens
--
-- Purpose: bearer-token storage for the Android app's mobile API (see includes/ApiAuth.php,
-- api/mobile/login.php, logout.php, me.php). This is NEW infrastructure for a new transport on
-- top of the EXISTING users/roles/permissions tables — it does not duplicate or replace them,
-- and no existing table is modified by this migration.
--
-- Column documentation:
--   id            — surrogate PK, same int(10) UNSIGNED AUTO_INCREMENT convention as every other
--                   table in this schema.
--   user_id       — FK to users.id (ON DELETE CASCADE: deleting a user removes their tokens too,
--                   same cascade behavior intent as the rest of the schema's ownership FKs).
--   token_hash    — SHA-256 hex digest (64 chars) of the raw bearer token. The RAW token is never
--                   stored anywhere, on this table or any other — only this hash. Mirrors the
--                   existing users.reset_token pattern (Auth::requestPasswordReset()), which
--                   already hashes single-use tokens the same way before persisting them.
--   device_name   — optional human-readable device label sent by the app at login (e.g.
--                   "Pixel 8 / Android 15"), for the user/admin to recognize a session later.
--   device_id     — optional stable per-install identifier the app sends, for future
--                   "manage my devices" / targeted-revocation UI. Not used for authorization.
--   ip_address    — IP address the token was ISSUED from (informational/audit only — every
--                   request is still authorized purely by a valid, unrevoked, unexpired token,
--                   never by IP).
--   last_used_at  — updated (best-effort) on every successful validation; NULL until first use.
--   expires_at    — absolute expiry. Checked on every request; nothing here is refreshed
--                   implicitly by use — a new login/token issuance is required after expiry
--                   (a refresh-token flow, if wanted, is left for a later phase).
--   revoked_at    — NULL while active; set the moment logout/revocation happens. A revoked token
--                   is never deleted, so audit history ("this device was logged out at ...")
--                   survives.
--   created_at    — standard created_at, same DEFAULT CURRENT_TIMESTAMP convention as every
--                   other table.
--
-- Indexes:
--   uniq_token_hash        — token lookup during validation is the hottest query path; also
--                             guarantees no accidental hash collision is ever silently accepted.
--   idx_api_tokens_user    — supports "list my devices" / revoke-all-for-user lookups.
--   idx_api_tokens_expires — supports a future cleanup job purging long-expired rows.
--   idx_api_tokens_revoked — supports the same future cleanup job filtering already-revoked rows.
--
-- Existing conventions matched exactly (see any CREATE TABLE in the main schema dump):
--   ENGINE=InnoDB, CHARSET=utf8mb4, COLLATE=utf8mb4_unicode_ci, int(10) UNSIGNED ids,
--   CREATE TABLE (columns only) -> ALTER TABLE ADD PRIMARY KEY/keys -> ALTER TABLE MODIFY
--   AUTO_INCREMENT -> ALTER TABLE ADD CONSTRAINT (foreign keys), as a separate statement group
--   each, matching this project's existing phpMyAdmin-exported migration style.
--
-- Safe to re-run check: wrap in your own `SHOW TABLES LIKE 'api_tokens'` guard if your deploy
-- tooling doesn't already skip already-applied migrations; not added here to keep this file a
-- literal, reviewable diff against the existing dump's own style (none of the existing CREATE
-- TABLE statements in the dump use IF NOT EXISTS either).

CREATE TABLE `api_tokens` (
  `id` int(10) UNSIGNED NOT NULL,
  `user_id` int(10) UNSIGNED NOT NULL,
  `token_hash` char(64) NOT NULL,
  `device_name` varchar(150) DEFAULT NULL,
  `device_id` varchar(150) DEFAULT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `last_used_at` datetime DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `api_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_token_hash` (`token_hash`),
  ADD KEY `idx_api_tokens_user` (`user_id`),
  ADD KEY `idx_api_tokens_expires` (`expires_at`),
  ADD KEY `idx_api_tokens_revoked` (`revoked_at`);

ALTER TABLE `api_tokens`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;

ALTER TABLE `api_tokens`
  ADD CONSTRAINT `fk_api_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
