-- Growth Hub schema — MariaDB (>= 10.6), utf8mb4 throughout.
-- Replaces the Supabase (Postgres) tables:
--   auth.users                  → users
--   dashboard_state             → dashboard_state (single JSON row per workspace)
--   growth_hub_invites          → growth_hub_invites
--   growth_hub_members          → growth_hub_members
--   growth_hub_advisor_notes    → growth_hub_advisor_notes
-- plus sessions (cookie auth), growthhub_migrations (runner bookkeeping)
-- and hub_meta (workspace singleton flags).
-- All timestamps are UTC DATETIME(3); the API layer converts to ISO-8601 Z.

CREATE TABLE IF NOT EXISTS users (
  id            CHAR(36)      NOT NULL,             -- uuid, preserved from Supabase export when migrated
  email         VARCHAR(191)  NULL,                 -- NULL allowed: placeholder rows for migrated members whose email was unavailable
  password_hash VARCHAR(255)  NULL,                 -- scrypt$N$r$p$salt$hash; NULL = user cannot log in until password set
  created_at    DATETIME(3)   NOT NULL,
  last_seen_at  DATETIME(3)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dashboard_state (
  user_id       CHAR(36)      NOT NULL,
  state         LONGTEXT      NOT NULL,
  state_bytes   INT UNSIGNED  NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)   NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT chk_state_is_json CHECK (JSON_VALID(state)),
  CONSTRAINT fk_dashboard_state_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS growth_hub_invites (
  token              CHAR(64)    NOT NULL,          -- 24 random bytes hex
  owner_user_id      CHAR(36)    NOT NULL,
  email_hint         VARCHAR(191) NULL,
  expires_at         DATETIME(3) NOT NULL,
  claimed_by_user_id CHAR(36)    NULL,
  claimed_at         DATETIME(3) NULL,
  created_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (token),
  KEY ix_invites_owner (owner_user_id),
  KEY ix_invites_claimed_by (claimed_by_user_id),
  CONSTRAINT fk_invites_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS growth_hub_members (
  owner_user_id CHAR(36)      NOT NULL,
  user_id       CHAR(36)      NOT NULL,
  email         VARCHAR(191)  NULL,                 -- denormalized copy; enables self-healing rebind after id changes
  role          VARCHAR(32)   NOT NULL DEFAULT 'advisor',
  created_at    DATETIME(3)   NOT NULL,
  revoked_at    DATETIME(3)   NULL,
  PRIMARY KEY (owner_user_id, user_id),
  KEY ix_members_user (user_id),
  KEY ix_members_email (email),
  CONSTRAINT fk_members_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS growth_hub_advisor_notes (
  id             CHAR(36)      NOT NULL,
  owner_user_id  CHAR(36)      NOT NULL,
  author_user_id CHAR(36)      NOT NULL,
  author_email   VARCHAR(191)  NULL,
  target_type    VARCHAR(32)   NOT NULL DEFAULT 'general',  -- general|stream|clip|analytics|idea
  target_ref     VARCHAR(200)  NULL,
  body           TEXT          NOT NULL,
  created_at     DATETIME(3)   NOT NULL,
  resolved_at    DATETIME(3)   NULL,
  PRIMARY KEY (id),
  KEY ix_notes_owner_created (owner_user_id, created_at),
  KEY ix_notes_author (author_user_id),
  CONSTRAINT fk_notes_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notes_author FOREIGN KEY (author_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id          CHAR(64)     NOT NULL,                -- sha256 hex of the bearer token (token itself never stored)
  user_id     CHAR(36)     NOT NULL,
  created_at  DATETIME(3)  NOT NULL,
  expires_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hub_meta (
  meta_key       VARCHAR(64) NOT NULL,
  meta_value     LONGTEXT    NULL,
  PRIMARY KEY (meta_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
