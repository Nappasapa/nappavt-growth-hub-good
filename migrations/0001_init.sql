-- NappaVT Growth Hub — Cloudflare D1 schema
-- Replaces the Supabase (Postgres) tables:
--   dashboard_state, growth_hub_invites, growth_hub_members, growth_hub_advisor_notes
-- D1 is SQLite: TEXT for ids/timestamps (ISO-8601), JSON stored as TEXT.
-- No enums, no triggers, no RLS — authorization is enforced by the Pages
-- Functions in /functions.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,             -- preserved Supabase auth user UUID when migrated
  email       TEXT UNIQUE COLLATE NOCASE,   -- NULL allowed: placeholder rows for migrated members whose Supabase auth email was unavailable; re-bound on their first login
  created_at  TEXT NOT NULL,                -- ISO-8601 UTC
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS hub_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- hub_meta rows used by the Functions:
--   key 'owner_user_id' → the workspace owner's users.id (seeded by migration,
--                       or claimed on first login when OWNER_EMAIL matches).

CREATE TABLE IF NOT EXISTS dashboard_state (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  state       TEXT NOT NULL,                -- JSON blob, same shape the dashboard already uses
  updated_at  TEXT NOT NULL,                -- ISO-8601 UTC, set server-side on every write
  state_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS growth_hub_invites (
  token              TEXT PRIMARY KEY,
  owner_user_id      TEXT NOT NULL REFERENCES users(id),
  email_hint         TEXT,
  expires_at         TEXT NOT NULL,         -- ISO-8601 UTC
  claimed_by_user_id TEXT,
  claimed_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_invites_owner ON growth_hub_invites (owner_user_id, expires_at);

CREATE TABLE IF NOT EXISTS growth_hub_members (
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  email         TEXT,                        -- convenience copy (advisor listing UI)
  role          TEXT NOT NULL DEFAULT 'advisor',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at    TEXT,
  PRIMARY KEY (owner_user_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON growth_hub_members (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS growth_hub_advisor_notes (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL REFERENCES users(id),
  author_user_id  TEXT NOT NULL,
  author_email    TEXT,
  target_type     TEXT NOT NULL DEFAULT 'general',
  target_ref      TEXT,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_owner_created ON growth_hub_advisor_notes (owner_user_id, created_at DESC);
