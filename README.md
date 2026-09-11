# NappaVT Growth Hub

A single-page content-planning and analytics dashboard for the NappaVT channel —
Twitch clips, posting queue, stream reports, social analytics and advisor feedback.

Architecture: static `index.html` front-end served by a small **Node.js
backend** (`server/`) which also provides the same-origin `/api/*`, with
**MariaDB** as the primary database. No framework, no Supabase, no
Cloudflare-specific database products — portable to any VPS / Docker host /
Pterodactyl-compatible panel.

> History: migrated off Supabase (Auth/Postgres/Storage/Realtime) in September
> 2026 because the old polling patterns exhausted Supabase egress. An interim
> Cloudflare (Pages Functions + D1/R2) backend on this branch was superseded by
> this portable backend. See `docs/CLOUDFLARE_MIGRATION.md` (historical) —
> the current definitive ops doc is **`docs/MARIADB_BACKEND.md`**.

```
Browser  ── same-origin ──▶  Node backend  ──▶  MariaDB
                                 │
                                 ├── local-disk clip store (STORAGE_DIR)
                                 └── /api/bot/*  ◀── Nappa Bot (Craftnode)
```

## Repo map

| Path | What it is |
|---|---|
| `index.html` | The whole front-end (no build step) |
| `server/` | Node.js backend: config, MariaDB pool+schema, session auth, routes, storage, scheduler |
| `server/migrations/` | Versioned SQL migrations (`npm run migrate`) |
| `scripts/` | Data-migration + verification + smoke (`export:supabase`, `import:mariadb`, `migrate:clips`, `verify`, `smoke`) |
| `.test/` | Node test suite (jsdom DOM tests + server unit/integration suites) |
| `Dockerfile`, `docker-compose.yml` | all-in-one container + MariaDB sidecar |
| `docs/` | Contracts & runbooks (`MARIADB_BACKEND`, `BOT_HANDOFF_PROMPT`, `BACKEND_STORAGE_SCHEMA`, historical) |

## Commands

```bash
npm install
cp .env.example .env          # fill secrets; never commit .env
npm run migrate               # create schema (idempotent)
npm run dev                   # backend+dashboard on :8788
npm test                      # unit + DOM suite (integration skips without TEST_DB_DSN)
npm run smoke                 # black-box E2E against the running server
npm run user:create / user:password / user:list / db:check
```

Full setup, production, Docker, Pterodactyl, backup/restore and rollback
instructions: **`docs/MARIADB_BACKEND.md`**.

## Migrating real data from Supabase

```bash
export SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…     # shell only
npm run export:supabase       # → migration-data/export.json (gitignored)
npm run import:mariadb        # users/states/invites/members/notes, owner inferred
GROWTH_HUB_API_BASE=http://localhost:8788 BOT_SYNC_TOKEN=… node scripts/migrate-clips.mjs --apply
npm run verify                # 11-check comparison vs Supabase; fails loudly
```
