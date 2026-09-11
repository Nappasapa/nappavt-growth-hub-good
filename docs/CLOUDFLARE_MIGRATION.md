# Cloudflare migration master doc — Supabase → Pages Functions + D1 + R2 + Access

The Growth Hub no longer talks to Supabase. The browser app calls a same-origin
`/api/*` backend implemented as **Cloudflare Pages Functions**; state lives in **D1**,
legacy clip files in **R2**, and identity is enforced by **Cloudflare Access**
(Zero Trust) instead of Supabase Auth. This doc is the runbook for setup, deploy,
data migration, verification, and rollback.

Cutover order (do not deviate): **audit → build CF infra → schema → migrate data →
validate → functions → auth → storage → sync → test → deploy → verify → only then
decommission Supabase.**

---

## 1. Architecture after migration

```
Browser (index.html, unchanged UI)
   │  same-origin fetch /api/*            (Cloudflare Access gates identity)
   ▼
Cloudflare Pages ── functions/api/*  (Pages Functions, this repo: functions/)
        ├── D1  `nappavt-growth-hub`        (binding DB)  — all structured data
        └── R2  `nappavt-growth-hub-clips`  (binding CLIPS) — legacy videoPath files only

Nappa Bot (Craftnode) → /api/bot/* with shared-secret token (BOT_SYNC_TOKEN)
Google Drive uploads remain browser-direct (unchanged), metadata only in D1.
```

What went away and why: the browser used to pull/write the full dashboard state
blob through Supabase PostgREST every 12 seconds (plus focus/visibility/online
triggers), full JSON each time, and generated fresh signed URLs for clip
operations — that is what burned Supabase egress. The replacement design fixes
this at the source:

| Old pattern (posupabase) | Replacement |
|---|---|
| Full-blob GET every 12 s | `GET /api/state/revision` (one timestamp row) every 12 s; blob fetched only when the timestamp changed |
| Full GET on tab focus/visible/online | Same revision check first |
| Bot polls whole blob | `GET /api/bot/state/revision` + `GET /api/bot/state?since=<ts>` short-circuits to `{unchanged:true}` |
| Client-side createSignedUrl (600 s) on every interaction | `GET /api/clips/<key>` streams from R2 with auth; zero egress fees; browser HTTP cache (`private, max-age=300`) |
| Nonce-column churn updates | No nonce column — revision is derived from `updated_at`/`MAX(created_at)` |

No Cron trigger is used: nothing in the app needs scheduled server work
(reminders live in the bot; sync is event/client driven).

## 2. Cloudflare resources to create (manual dashboard steps)

One-time setup, all in the Cloudflare dashboard unless noted.

1. **Pages project** `nappavt-growth-hub` — already exists and serving the static
   site; after this migration it serves `functions/` too (build command: none;
   the CI workflow assembles `dist/` including functions).
2. **D1 database**
   - `npx wrangler d1 create nappavt-growth-hub`
   - Note its `database_id` into `wrangler.toml` (already set there) — under
     `[[d1_databases]]` with `binding = "DB"`.
   - Apply schema: `npm run migrate:remote` (runs `wrangler d1 migrations apply … --remote`,
     migrations in `migrations/`).
3. **R2 bucket** (private — never public access, no custom domain, no public dev URL)
   - `npx wrangler r2 bucket create nappavt-growth-hub-clips`
   - Bound as `[[r2_buckets]] binding = "CLIPS"` in `wrangler.toml`.
4. **Pages project bindings** (Settings → Functions on the Pages project) —
   must match `wrangler.toml` exactly:
   - D1 binding: name `DB` → database `nappavt-growth-hub`
   - R2 binding: name `CLIPS` → bucket `nappavt-growth-hub-clips`
   - Compatibility date/flags: `nodejs_compat`? **Not needed** — functions use Web
     standard APIs only.
5. **Cloudflare Access (Zero Trust)** — protects both viewer and API identity:
   - Create a **self-hosted application** for `nappavt-growth-hub.pages.dev` (and its
     custom domain if any) covering the *whole* path, `/` and `/api/*` alike.
   - Policy: email allowlist with the owner email and each advisor email.
   - Note the **team domain** (e.g. `yourteam.cloudflareaccess.com`) and the
     application's **AUD tag** (Access → app → Overview).
6. **Pages secrets** (Settings → Environment variables → Production, *encrypt*):
   | Name | Purpose |
   |---|---|
   | `ACCESS_TEAM_DOMAIN` | e.g. `yourteam.cloudflareaccess.com` |
   | `ACCESS_AUD` | Access application AUD tag |
   | `BOT_SYNC_TOKEN` | long random shared secret for the Nappa Bot (`openssl rand -hex 32`) |
   | `OWNER_EMAIL` | optional override for owner-claim (see §5) |
   - **Never** set `DEV_BYPASS_EMAIL` in production/preview — it exists only in
     `.dev.vars` (gitignored) and makes the app pretend to be a fixed test user.
7. **GitHub Actions secrets** (repo settings, already used by `main.yml`):
   `CLOUDFLARE_API_TOKEN` (needs **D1 edit** + **Pages edit** permissions now —
   add D1 to the existing token), `CLOUDFLARE_ACCOUNT_ID`. CI runs
   `wrangler d1 migrations apply … --remote` before deploying.

Do **not** store Service Tokens or `CF_Authorization` cookie values anywhere.
The bot does not pass through Access: it reaches `/api/bot/*` which is exempt from
the Access application — protect it by either (a) an Access **service token**
route, or (b) simplest: make the Access application path cover only non-`/api/bot`
paths. The bot authenticates with `BOT_SYNC_TOKEN` instead; see
`docs/BOT_HANDOFF_PROMPT.md`.

## 3. Schema (D1) — `migrations/0001_init.sql`

Exact PostgreSQL→SQLite mapping, not a blind conversion:

| Supabase (PG) | D1 (SQLite) | Notes |
|---|---|---|
| `auth.users` | `users(id TEXT PK, email TEXT UNIQUE NULL, created_at, last_seen_at)` | IDs preserved from Supabase export so foreign rows keep matching |
| `dashboard_state(user_id, state jsonb, updated_at)` | `dashboard_state(user_id PK, state TEXT, updated_at TEXT)` | JSON stored as TEXT; normalized ISO-8601 `Z` timestamps; `updated_at` doubles as the revision |
| `growth_hub_invites` | same columns, `expires_at`/`claimed_at` normalized | token stays the primary key |
| `growth_hub_members` | composite PK (owner_user_id, user_id) + `email` (for re-binding) + `revoked_at` | `email` enables self-healing if a migrated member's Supabase id can't be resolved |
| `growth_hub_advisor_notes` | same shape (`resolved_at NULL` = open) | |
| – | `hub_meta(key, value)` | singleton: `owner_user_id` |

RLS (Supabase) is replaced by application-level checks in `functions/_lib/*`:
owner-only writes on state, advisor read-only on state/notes, invite claiming,
membership revocation. See `functions/_lib/workspace.js`.

## 4. Data migration runbook

**No local tooling?** There is a `workflow_dispatch` GitHub Action
(`.github/workflows/migrate.yml`, "Data migration") that runs this entire
runbook from the GitHub website: Actions → Data migration → Run workflow with
mode `plan` first (writes nothing), then mode `apply`. It requires repo secrets
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (delete both after a green apply),
`CLOUDFLARE_API_TOKEN` (Pages + D1 + R2 edit) and `CLOUDFLARE_ACCOUNT_ID`.
The steps below are the same runbook for a local terminal.

Prereq env (terminal only — never committed):

```bash
export SUPABASE_URL="https://<project>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="…"   # service role, data-export only, never shipped anywhere
```

Run in order (everything is idempotent — safe to re-run after fixing errors):

```bash
# A. Export everything out of Supabase (tables + auth users + clip object list)
npm run export:supabase            # writes migration-data/export.json (gitignored)

# B. Turn the export into D1 SQL (users incl. placeholders, states, invites,
#    members, notes, owner inference into hub_meta)
npm run import:d1                  # writes migration-data/d1-import.sql

# C. Rehearse locally, then apply to production D1
npx wrangler d1 execute nappavt-growth-hub --local  --file=migration-data/d1-import.sql
npm run verify -- --local          # should print 'verify: N passed, 0 failed'
npx wrangler d1 execute nappavt-growth-hub --remote --file=migration-data/d1-import.sql

# D. Migrate legacy clips Supabase Storage → R2 (dry-run first, then --apply)
node scripts/migrate-clips.mjs               # prints the plan
node scripts/migrate-clips.mjs --apply       # copies via `wrangler r2 object put --remote`

# E. Verify production D1 matches Supabase exactly (counts + canonical blob hash
#    + updated_at preservation + clip manifest complete)
npm run verify                     # exits non-zero on any mismatch
```

Only after `verify` is green: deploy the site (push to `main` → CI) and point the
bot at the new API. Keep Supabase running (read-only) as rollback for two weeks.

A full offline rehearsal (no real Supabase) exists:
`node scripts/mock-supabase.mjs &` then run steps A–E with
`SUPABASE_URL=http://127.0.0.1:59876 SUPABASE_SERVICE_ROLE_KEY=rehearsal`
and `--local` flags — 11/11 verify checks and 2/2 clip copies should pass.

## 5. Auth (Access) behavior & owner claiming

- Every browser request arrives with a verified Access JWT; functions verify it
  again server-side (signature, exp, iss, aud) via the team `certs` endpoint.
- On first login the workspace has no owner: the app claims ownership for the
  first authenticated email **unless** `OWNER_EMAIL` is set, in which case only
  that email can own the workspace (use it as a safety pin during cutover for
  the migrated owner id; clear it afterwards or keep — it only constrains a
  bootstrap that no longer happens).
- Migrated `growth_hub_members` rows referencing an old Supabase id are
  re-bound transparently on the advisor's first Access login (email match).
- The frontend shows no password UI anymore: identity banner comes from
  `/api/me`. Prior Supabase accounts had email+password; those no longer exist
  here — Access *is* the login wall.

## 6. Deploy & rollback

**Deploy**: push to `main` → GitHub Action `main.yml`:
1. builds `dist/` (static assets + `functions/`),
2. applies D1 migrations (`migrations/`, recorded in `d1_migrations` bookkeeping table — additive only),
3. `wrangler pages deploy dist --project-name=nappavt-growth-hub`.

Preview deploys happen per-branch via `wrangler pages dev`/Pages Git integration;
production is `main` only.

**Rollback** (ordered, pick the earliest sufficient step):
1. *Bad site/backend release* → Cloudflare Pages dashboard → Deployments →
   roll back to the previous deployment (static + functions ship together — a
   rollback restores both).
2. *Bad data written post-cutover* → the Supabase project is untouched; if the
   incident predates writes, data is simply still **in** Supabase — redeploy the
   `360ae39`-era commit (last Supabase release) as a hotfix branch to restore
   the old app, then investigate.
3. *Migration step itself broken* → re-run the failing script (idempotent);
   D1 can be reset with
   `npx wrangler d1 execute nappavt-growth-hub --remote --command "DELETE FROM dashboard_state; DELETE FROM growth_hub_invites; DELETE FROM growth_hub_members; DELETE FROM growth_hub_advisor_notes; DELETE FROM users;"` then re-import.
4. **Never** delete the Supabase project automatically. Manual, user-approved
   step, weeks after cutover is verified.

## 7. Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # fill DEV_BYPASS_EMAIL + BOT_SYNC_TOKEN (local only)
npm run migrate:local              # local D1 schema
npm run dev                        # pages dev server on :8788
npm run smoke                      # curls the API end-to-end (owner/advisor/bot/clips)
npm test                           # .test/ suite (80 custom DOM asserts + all node tests)
```

`.dev.vars` is gitignored and never deployed; without
`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` set, local dev uses the bypass identity header
`X-Dev-Identity-Email` to impersonate users (that header is ignored and the code
path unreachable in any environment where Access secrets are configured).

---

### Verification summary of this migration (what was actually run)

- `npm run migrate:local` — schema applies cleanly, zero-error.
- Offline rehearsal (`scripts/mock-supabase.mjs`): export → import → local D1 →
  `verify --local` **11/11 passed** (row counts, row sets, canonical state-blob
  sha match, updated_at preserved, notes/ids, owner meta, clips manifest) —
  plus clip migration **2/2 copied** into local R2 and downloadable through
  `GET /api/clips/<key>` (byte-exact 200).
- Live API against migrated rehearsal data: owner `role=owner` sees full state
  incl. queue/streams; advisor `role=advisor` reads the same state; stranger
  `role=none` → `403` on state; `/api/clips` lists 2 objects.
- Bot channel: `state/revision` returns migrated `updated_at`; `?since=<future>`
  short-circuits `{unchanged:true}`; `PUT /api/bot/state` writes a full state
  blob with server timestamp; wrong token → `401`.
- Whole test suite green (`npm test`, TAP `# fail 0`, `dom.test.js` 80/80
  custom assertions) + `scripts/dev-smoke.mjs` green.
- CI: `.github/workflows/main.yml` now ships `functions/` and applies D1
  migrations on every deploy.
