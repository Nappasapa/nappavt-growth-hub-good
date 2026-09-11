# Handoff prompt — Craftnode bot/backend: Supabase → Cloudflare Growth Hub API

Paste everything below the line into the bot/backend AI session. It is self-contained;
see also `docs/BACKEND_STORAGE_SCHEMA.md` (queue field contract — still authoritative)
and `docs/CLOUDFLARE_MIGRATION.md` (infra runbook) in this repo.

---

You are working on the existing NappaVT Growth Hub bot/backend (Python, hosted on Craftnode).

The Growth Hub dashboard has been **migrated off Supabase onto Cloudflare**
(Pages + Pages Functions + D1 + R2 + Cloudflare Access). Your job: repoint the bot
from its direct Supabase data channel to the new **same-origin HTTP API** so Twitch
clip imports, stream analytics, social analytics, reminders and Discord flows keep
working unchanged. Do NOT rebuild the bot; do NOT rewrite unrelated systems; do NOT
change working Discord/Twitch/social functionality; work in a feature branch and open
a PR; never commit secrets; audit first, then implement.

IMPORTANT RULES THAT DID NOT CHANGE
- Do not push directly to main; open a PR and do not merge it yourself.
- The dashboard state remains ONE JSON document per workspace with the queue at
  `state.queue[]` and the camelCase field names in docs/BACKEND_STORAGE_SCHEMA.md.
  Your writes MUST remain full read-modify-write of that document with unknown
  fields preserved (the frontend still merges only its bot-owned whitelist).
- `storageProvider: "google_drive"` semantics are unchanged: Drive bytes never pass
  through the bot or the dashboard backend; the bot only needs metadata for those.
- Never store or log tokens; report configuration by status (set/unset) only.

======================================================================
WHAT CHANGED FOR YOU (Supabase → Cloudflare Growth Hub API)
======================================================================

1. STOP calling Supabase entirely for Growth Hub data:
   - PostgREST `GET/PATCH {SUPABASE_URL}/rest/v1/dashboard_state?...`
   - Supabase Storage signed URLs / .download() / .remove() on bucket "clips"
   - GoTrue/admin user lookups to resolve the owner id
   All of it. The anon key you had will be revoked after cutover.

2. NEW data channel — plain HTTPS JSON on the dashboard origin:
   Base URL: the Pages site (e.g. `https://nappavt-growth-hub.pages.dev` — take it
   from env `GROWTH_HUB_API_BASE`, no trailing slash).

   AUTH (every request): header
     `Authorization: Bearer <BOT_SYNC_TOKEN>`   (or `X-Nappa-Bot-Key: <BOT_SYNC_TOKEN>`)
   `BOT_SYNC_TOKEN` is a shared secret stored on Craftnode env AND as an encrypted
   secret on the Cloudflare Pages project. It is NOT a user token and never enters
   a browser. Responses: 401 wrong/missing token · 403 forbidden · 503 if the
   server secret is not configured.

   ENDPOINTS (all JSON unless noted):
   - `GET /api/bot/state/revision?user_id=<owner_id>`
       → `{"user_id":…, "state_updated_at":"<ISO-8601 Z>"}` — cheap change marker
       (empty string when the workspace has no state yet).
   - `GET /api/bot/state?user_id=<owner_id>[&since=<updated_at>]`
       → `{"state":{…}, "updated_at":"…"}` or, when nothing changed,
         `{"unchanged":true, "updated_at":"…"}`. `state` may be `null` (never saved).
   - `PUT /api/bot/state`  body `{"user_id":"<owner_id>", "state":{…}}`
       → `{"ok":true, "updated_at":"<server timestamp>"}`. Full-blob replace with
       server-side `updated_at = now()`. Max body 10 MB (413 above). Unknown
       `user_id` → 400 `unknown_user`.
   - `GET /api/bot/clips` → `{"count":N, "bytes":B, "truncated":false, "keys":[…]}`
       listing of legacy clip objects (prefix `<owner_id>/`, fraction key).
   - `GET /api/bot/clips/<key>` → the file bytes (supports HTTP Range;
       206 partial). Content-Type preserved from upload.
   - `DELETE /api/bot/clips/<key>` → `{"ok":true}` (idempotent; 400 on malformed key,
       403 outside the owner prefix).
   Errors are JSON: `{"error":"<code>", "detail":"…"}`.

3. `user_id` — the workspace owner's id. Get it once: the owner copies
   `GROWTH_HUB_USER_ID` from the dashboard Settings page
   ("Social analytics connections → Growth Hub connection"). Store it in env.

4. Legacy Supabase clips became R2 objects behind the API. **The string
   `"supabase"` in `storageProvider` still means "legacy cloud clip"** — keep the
   provider-detection function exactly as in BACKEND_STORAGE_SCHEMA.md; only the
   *fetch mechanism* changed:

   ```python
   def legacy_clip_url(owner_id: str, video_path: str) -> str:
       base = os.environ["GROWTH_HUB_API_BASE"].rstrip("/")
       return f"{base}/api/bot/clips/{quote(video_path, safe='')}"
   # download with the BOT_SYNC_TOKEN header; stream to a temp file as before
   ```

   For Drive records nothing changes: `videoPath == ""`, never request bytes.

5. EGRESS/PERFORMANCE DISCIPLINE — the Supabase egress quota was killed by
   always-on full-blob polling. The new API exists partly to stop that. Required:
   - Poll `GET /api/bot/state/revision` (single timestamp) on your timer.
   - Only when `state_updated_at` changes, `GET /api/bot/state` (or pass
     `since=<your last updated_at>` and accept `unchanged:true`).
   - Never re-download the full state when `unchanged` or when only your own
     write changed it (track the `updated_at` YOUR last PUT returned).
   - Do NOT backfill lists with full-body GETs; the revision check is the gate.

6. Timestamps: `updated_at` is an opaque ISO-8601 `Z` string assigned by the
   server (lexicographically comparable). Last-writer-wins: the dashboard and the
   bot both write the same blob, and the dashboard saves on human edits —
   you MUST base every PUT on the freshest GET (read → merge → write in one gulp,
   keep the window small). The dashboard mounts a 409-recovery loop if it loses a
   race; you get simpler semantics: your PUT always succeeds but can clobber — so
   minimize your in-memory state age and never rewrite from stale snapshots.

7. After cutover the bot will get `401` from Supabase (key revoked) — treat that
   as "you are still on the old code path", log once, and stop (no retry storm).

======================================================================
IMPLEMENTATION PLAN
======================================================================

1. AUDIT (report before coding): every place the bot reads/writes
   `dashboard_state`, every Supabase Storage call, how it discovers the owner id,
   its polling cadence, retry/backoff logic, and every env var it consumes.
2. Add a tiny `growth_hub_api.py` client (requests/httpx, timeouts ~10 s,
   retry with exponential backoff on 429/5xx, max 3 attempts):
   `get_revision(user_id)`, `get_state(user_id, since=None)`,
   `put_state(user_id, state)`, `list_clips()`, `download_clip(path, fileobj)`,
   `delete_clip(path)`. Centralize the auth header there — never inline tokens.
3. Replace the old Supabase client usage with that module — one code path,
   not scattered edits. Keep provider detection and queue merge logic as-is.
4. Polling loop: switch to revision-first as described in rule 5.
5. `finally`: remove the Supabase client dependency ONLY after the new path is
   verified live; keep the env var names clear.

======================================================================
CRAFTNODE CONFIG (exact env to add — real values, none dummy)
======================================================================
- `GROWTH_HUB_API_BASE=https://nappavt-growth-hub.pages.dev` (no trailing slash)
- `GROWTH_HUB_USER_ID=<owner id from dashboard Settings page>`
- `BOT_SYNC_TOKEN=<the shared secret generated for the Pages project secret>`
Remove after verification: `SUPABASE_URL`, `SUPABASE_ANON_KEY`/service keys.
No new pip dependencies required if the bot already has requests/httpx.

======================================================================
TESTS / ACCEPTANCE
======================================================================
A. Fresh boot: bot reads `state_updated_at` via revision endpoint only, then
   downloads the blob exactly once.
B. Steady state: N minutes of polling with zero changes → zero full-state GETs.
C. Twitch clip import / stream analytics write: state persists, `updated_at`
   advances (server timestamp), dashboard UI reflects it without manual refresh
   (its own revision poll picks it up).
D. Legacy clip cleanup: bot lists via `/api/bot/clips`, downloads via
   `/api/bot/clips/<key>`, deletes; Drive records untouched (videoPath "").
E. Wrong/missing token → 401 handled without crash or retry storm.
F. `unchanged:true` response treated as a no-op (no blob parse, no write).
G. Blob >10 MB write rejected → logged actionable error (this means the queue
   is pathological; surfaces a real problem instead of silently growing egress).
H. All existing features (Discord commands, Twitch import, social analytics,
   reminder DMs) verified unchanged end-to-end against the new backend.

======================================================================
DELIVERY
======================================================================
Feature branch → PR: summary of the audit, new client module, before/after
polling traffic estimate, env changes on Craftnode (names only), test evidence
(A–H), rollback note ("revert branch + restore old env → Supabase path returns
until the Supabase project is decommissioned"). DO NOT merge the PR yourself.
