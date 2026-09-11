# NappaVT Growth Hub

A single-page content-planning and analytics dashboard for the NappaVT channel —
Twitch clips, posting queue, stream reports, social analytics and advisor feedback.

Stack: static `index.html` front-end + **Cloudflare Pages Functions** API (`functions/`),
**D1** database, private **R2** bucket for legacy clips, and **Cloudflare Access** for
identity. No build step, no framework.

> Migrated off Supabase (Auth/Postgres/Storage/Realtime) in September 2026 because
> the old polling patterns exhausted Supabase egress. See
> [`docs/CLOUDFLARE_MIGRATION.md`](docs/CLOUDFLARE_MIGRATION.md) for the full
> setup / deploy / migration / rollback runbook.

## Repo map

| Path | What it is |
|---|---|
| `index.html` | The whole front-end (no build step) |
| `functions/` | Pages Functions: `/api/*` backend (state, access, invites, notes, clips, bot channel) |
| `migrations/` | D1 SQL migrations (`wrangler d1 migrations apply`) |
| `scripts/` | Data-migration + verification + dev smoke scripts (`export-supabase`, `import-d1`, `migrate-clips`, `verify-migration`, `mock-supabase`, `dev-smoke`) |
| `.test/` | Node test suite (jsdom DOM tests + pure logic tests) |
| `docs/` | Contracts and runbooks (bot handoff, storage schema, Cloudflare migration) |
| `wrangler.toml` | Pages project config: D1 binding `DB`, R2 binding `CLIPS` |

## Commands

```bash
npm install
npm run dev              # local Pages dev server (:8788) with local D1/R2
npm run smoke            # end-to-end API smoke against the dev server
npm test                 # full test suite
npm run migrate:local    # apply D1 schema locally
npm run migrate:remote   # apply D1 schema to production
```

See `docs/CLOUDFLARE_MIGRATION.md` §4 for the data-migration runbook
(export → import → clips → verify) and §7 for local development setup
(`.dev.vars` with `DEV_BYPASS_EMAIL` + `BOT_SYNC_TOKEN`, never committed).

## Deploy

Push to `main` → `.github/workflows/main.yml` applies D1 migrations and deploys
`dist/` (static assets + `functions/`) to Cloudflare Pages via wrangler-action.
GitHub secrets: `CLOUDFLARE_API_TOKEN` (Pages + D1 edit), `CLOUDFLARE_ACCOUNT_ID`.
Pages project secrets: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `BOT_SYNC_TOKEN`
(± `OWNER_EMAIL`). Never set `DEV_BYPASS_EMAIL` outside local dev.
