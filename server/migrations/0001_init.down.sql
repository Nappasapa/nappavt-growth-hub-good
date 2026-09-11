-- Rollback for 0001_init.sql (development convenience; production rollback =
-- restore from backup).

DROP TABLE IF EXISTS hub_meta;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS growth_hub_advisor_notes;
DROP TABLE IF EXISTS growth_hub_invites;
DROP TABLE IF EXISTS growth_hub_members;
DROP TABLE IF EXISTS dashboard_state;
DROP TABLE IF EXISTS users;
