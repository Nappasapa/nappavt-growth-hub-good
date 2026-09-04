# YouTube OAuth reconnect fix — `/youtube_connect` must survive `invalid_grant`

**Date:** 2026-09-04
**Branch:** `arena/01a06e06-nappavt-growth-hub-good`
**Frontend repo:** `Nappasapa/nappavt-growth-hub-good` (this repo — static dashboard only)
**Backend repo:** Craftnode Python Discord bot (owns `/youtube_connect` — **not in this repo**)

This document is the authoritative fix specification + handoff for the Craftnode
backend session. The portable reference implementation lives in
`backend_reference/youtube_oauth.py` with tests in
`backend_reference/test_youtube_oauth_reconnect.py` (20 tests, all passing).

---

## 1. TL;DR

- **Symptom:** `/youtube_connect` dies with `invalid_grant: Token has been expired
  or revoked` after the Google account was disabled and restored. The user can
  never reach `/youtube_connect_finish`.
- **Root cause (backend):** the `/youtube_connect` handler refreshes the OLD stored
  credentials as a prerequisite and returns the refresh failure as the final
  user-facing result, instead of treating it as "REAUTH REQUIRED, continue to
  fresh OAuth".
- **Fix:** `/youtube_connect` must wrap the opportunistic `creds.refresh()` in
  `try/except RefreshError`, mark REAUTH REQUIRED on `invalid_grant`, and
  **always** continue to generate a FRESH authorization URL
  (`access_type='offline'`, `prompt='consent'`). Old credentials are replaced
  only after `/youtube_connect_finish` successfully exchanges the NEW grant.
- **This frontend repo needed no code change** — it already renders
  CONNECTED / REAUTH REQUIRED / NOT CONNECTED correctly for `invalid_grant`
  (verified by `.test/oauth-split.test.js`, 53 passing). The fix belongs in the
  backend repo; this repo carries the spec + reference code + tests so the
  backend session can apply it verbatim.

---

## 2. Audit — what was inspected and where the bug lives

Searched this entire repo for:

```
youtube_connect  youtube_connect_finish  credentials.refresh  RefreshError
invalid_grant  refresh_token  google.oauth2  Flow.from_client_config
authorization_url  generate_auth_url  token.json
youtube.readonly  yt-analytics.readonly
```

**Result: this repo contains NO Discord bot code, NO Python, NO
`google.oauth2` / `Flow` / `credentials.refresh` implementation.**

| Location | What it contains | Verdict |
|---|---|---|
| `index.html` (lines ~4845, ~6613, ~8830) | Dashboard copy mentioning `/youtube_connect → /youtube_connect_finish`; `GOOGLE_YOUTUBE_SCOPES` as **reference-only** constants; `youtubeConnectionState()` badge helper; Drive GIS token client (drive.file only) | Correct. No refresh logic. Not the bug. |
| `.test/oauth-split.test.js` | Locks in the Drive/YouTube OAuth split + badge states | Passing (53/53). `invalid_grant` → `reauth` already covered. |
| `docs/BACKEND_STORAGE_SCHEMA.md`, `docs/BOT_HANDOFF_PROMPT.md` | Frontend↔bot contracts | Confirm YouTube OAuth is **Craftnode-backend-owned**. |
| Any `*.py`, `token.json`, `Flow`, `RefreshError` | **None exist in this repo** | Bug cannot be here. |

**Therefore:**

1. **Exact root cause (Q1):** the backend `/youtube_connect` handler treats the
   OLD refresh token as a prerequisite for starting a NEW authorization flow.
   When Google returns `400 invalid_grant` (expected after account
   disable/restore — Google revokes outstanding grants), the handler aborts and
   surfaces the raw refresh error to the user.
2. **Which function caused the failure (Q2):** the backend `/youtube_connect`
   command handler — specifically its eager `credentials.refresh(Request())`
   path (or equivalent `POST oauth2.googleapis.com/token` with the stored
   `refresh_token`) executed **before** `Flow.authorization_url()`.
3. **Why old credentials were refreshed during reconnect (Q3):** almost
   certainly a well-intentioned "reuse / opportunistic refresh" block at the top
   of the handler (e.g. "if we have creds, refresh and report already
   connected") with no `except RefreshError → continue to fresh OAuth` branch.
   After the disable/restore, that block throws on every invocation, so the
   `authorization_url()` line below it is unreachable.

If the backend session finds the handler does NOT call `refresh()` directly,
the same failure occurs when it calls any helper that does — e.g.
`get_youtube_service()` / `get_youtube_credentials()` / `ensure_valid_token()`
shared with background jobs. The fix is identical: reconnect must not route
through a fatal refresh path.

---

## 3. Expected behavior (contract)

### `/youtube_connect` — must ALWAYS return a fresh authorization URL

```
inspect stored creds (best effort, never fatal)
  ├─ valid ──────────────────────────────► note "already connected",
  │                                         STILL return fresh auth URL
  ├─ expired + refresh works ─────────────► refresh + save opportunistically,
  │                                         STILL return fresh auth URL
  ├─ refresh fails (invalid_grant etc.) ──► mark REAUTH REQUIRED,
  │                                         CONTINUE to fresh OAuth (do NOT abort)
  ├─ no token / unusable object ──────────► CONTINUE to fresh OAuth
  └─ storage read fails ──────────────────► CONTINUE to fresh OAuth

then ALWAYS:
  flow = Flow.from_client_config(client_config, scopes=YOUTUBE_SCOPES)
  auth_url, state = flow.authorization_url(access_type='offline', prompt='consent')
  persist pending state (per user)
  return auth_url (ephemeral Discord reply)
```

Rules:

- Do NOT delete old credentials at this step.
- Do NOT return raw `invalid_grant` to the user.
- `prompt='consent'` + `access_type='offline'` are REQUIRED so Google issues a
  NEW `refresh_token` (without them a re-auth may return no refresh token).
- Scopes MUST be exactly `youtube.readonly + yt-analytics.readonly` — never
  add `drive.file` (Google 400 `invalid_request`).

### `/youtube_connect_finish` — exchanges the NEW grant

```
load pending state (must exist; else tell user to run /youtube_connect)
exchange NEW authorization_response/code via Flow.fetch_token()
  └─ failure ──► keep OLD stored creds untouched, mark REAUTH, report clearly
save NEW credentials (this replaces the old invalid refresh token)
clear pending state
validate YouTube Data API (channels.list mine=True)
validate YouTube Analytics API (small channel report query)
mark CONNECTED (channelTitle, videos) → dashboard badge flips to CONNECTED
```

### Background API usage — normal refresh preserved

```
valid ─────────────────────────────► use as-is
expired + refresh works ───────────► refresh + save + use (no user action)
expired + invalid_grant ───────────► mark REAUTH REQUIRED + raise ReauthRequired
no token ──────────────────────────► raise ReauthRequired
```

---

## 4. What changed in THIS repo (Q4)

This repo is the frontend; the backend handler cannot be patched here. What was
added is the complete, tested fix payload for the backend session:

```
backend_reference/youtube_oauth.py               # fixed core (service class +
                                                 # file stores + production
                                                 # google wiring + Discord sketch)
backend_reference/test_youtube_oauth_reconnect.py # 20 stdlib tests, no network
docs/YOUTUBE_OAUTH_RECONNECT_FIX.md               # this file
```

No changes to `index.html` were needed (see §7). `.gitignore` was extended so
backend runtime token files can never be committed by accident.

**How `invalid_grant` is now handled (Q5):**

- New `is_invalid_grant_error(exc)` helper detects `RefreshError` /
  `{"error": "invalid_grant"}` / "expired or revoked" across google-auth
  versions without a hard import.
- `YouTubeOAuthService.begin_connect()` catches **any** exception from the
  opportunistic `refresh_credentials()` call, calls
  `status_store.mark_reauth(...)`, and continues to fresh `authorization_url()`.
- `get_valid_credentials()` (background path) still surfaces dead grants as
  `ReauthRequired` + REAUTH REQUIRED status — the dashboard badge and the
  Discord error message both point at `/youtube_connect`.
- Logs use `describe_credentials_for_log()` (booleans only). Tokens, secrets,
  and auth codes are never logged.

**Direct answers:**

- (Q6) Fresh OAuth without valid old credentials? **Yes** — `begin_connect()`
  returns a fresh URL for: no token, expired access, revoked refresh,
  `invalid_grant`, unusable objects, even storage failures. Covered by tests.
- (Q7) Does finish store a fresh refresh token? **Yes** — `finish_connect()`
  saves `flow.credentials` only after `fetch_token()` succeeds, replacing the
  old value; verified by test asserting `refresh-OLD-INVALID → refresh-NEW-VALID`.
- (Q8) Normal automatic refresh still works? **Yes** — `get_valid_credentials()`
  refreshes + saves when possible; only dead grants flip to REAUTH REQUIRED.
  Covered by background-refresh tests.

---

## 5. Backend patch instructions (for the Craftnode bot session)

### 5a. Fastest path — adopt the reference service

1. Copy `backend_reference/youtube_oauth.py` into the backend repo (e.g.
   `bot/youtube_oauth.py`).
2. Implement a `StatusStore` that writes
   `dashboard_state.state.socialConnections.youtube`:

```python
# Backend repo — Supabase status writer (adapt table/client names to yours).
class SupabaseYouTubeStatusStore(StatusStore):
    def __init__(self, supabase, user_id: str):
        self.supabase = supabase
        self.user_id = user_id

    def _patch(self, youtube_record: dict):
        row = self.supabase.table("dashboard_state").select("state") \
            .eq("user_id", self.user_id).maybe_single().execute().data
        state = (row or {}).get("state", {}) or {}
        conns = state.get("socialConnections", {}) or {}
        conns["youtube"] = youtube_record
        state["socialConnections"] = youtube_record and conns
        # READ-MODIFY-WRITE: preserve every other key (queue, streams, …).
        self.supabase.table("dashboard_state").upsert(
            {"user_id": self.user_id, "state": state}).execute()

    def mark_reauth(self, reason: str):
        self._patch({"connected": False, "configured": True,
                     "needsReauth": True, "error": reason})

    def mark_connected(self, info: dict):
        self._patch({"connected": True, "configured": True,
                     "needsReauth": False, "error": "",
                     "channelTitle": info.get("channelTitle", ""),
                     "videos": int(info.get("videos", 0) or 0)})

    def mark_error(self, error: str):
        self._patch({"connected": False, "configured": True,
                     "needsReauth": False, "error": error})
```

3. Wire the Discord commands (thin wrappers — see the sketch at the bottom of
   `youtube_oauth.py`). Key point: `/youtube_connect` calls
   `service.begin_connect()` and sends `result.auth_url`; it contains **no**
   direct `creds.refresh()` call.
4. Set Craftnode env (no code defaults for secrets):

```
YOUTUBE_CLIENT_ID=<oauth client id>
YOUTUBE_CLIENT_SECRET=<oauth client secret>   # never in git
YOUTUBE_REDIRECT_URI=http://127.0.0.1:53682/callback
YOUTUBE_TOKEN_PATH=/path/to/private/youtube_token.json        # optional override
YOUTUBE_PENDING_PATH=/path/to/private/youtube_pending.json    # optional override
```

5. Enable **YouTube Data API v3** + **YouTube Analytics API** for the OAuth
   client in Google Cloud Console.
6. Copy `backend_reference/test_youtube_oauth_reconnect.py` next to it and run
   `python3 -m unittest test_youtube_oauth_reconnect -v` in the backend repo.

### 5b. Minimal patch — if you keep your existing handler structure

Find your `/youtube_connect` handler and apply this shape (names will differ —
match by behavior):

```python
# BEFORE (buggy) — aborts on invalid_grant, never reaches authorization_url:
creds = load_youtube_credentials()
if creds and creds.expired and creds.refresh_token:
    creds.refresh(Request())  # 💥 RefreshError invalid_grant escapes here
flow = Flow.from_client_config(CLIENT_CONFIG, scopes=YOUTUBE_SCOPES, ...)
auth_url, state = flow.authorization_url(access_type="offline", prompt="consent")
...

# AFTER (fixed) — opportunistic refresh, always continue to fresh OAuth:
from google.auth.exceptions import RefreshError

creds = load_youtube_credentials()  # best effort; None is fine
if creds is not None and getattr(creds, "expired", False) \
        and getattr(creds, "refresh_token", None):
    try:
        creds.refresh(Request())
        save_youtube_credentials(creds)
    except RefreshError as exc:
        # Dead grant (e.g. account disabled/restored) must NOT abort reconnect.
        mark_youtube_reauth(
            "YouTube authorization expired (invalid_grant). Reconnect required.")
        # *** intentional fall-through to fresh authorization_url() below ***
    except Exception as exc:  # transient/network — same: do not abort reconnect
        mark_youtube_reauth(f"YouTube refresh failed ({exc}). Reconnect required.")
        # *** intentional fall-through ***

# ALWAYS reached, even when the old token is dead:
flow = Flow.from_client_config(CLIENT_CONFIG, scopes=YOUTUBE_SCOPES,
                               redirect_uri=REDIRECT_URI)
auth_url, state = flow.authorization_url(access_type="offline", prompt="consent")
save_pending_youtube_state(user_id, {"state": state})
return auth_url  # ephemeral reply + "then run /youtube_connect_finish"
```

And in `/youtube_connect_finish`, confirm the order is:

```
exchange NEW code/response -> save fresh creds -> validate Data API ->
validate Analytics API -> mark CONNECTED
```

with old creds left untouched if the exchange fails.

### 5c. Backend audit checklist (run before declaring done)

- [ ] `grep -rn "youtube_connect\|credentials.refresh\|RefreshError\|invalid_grant\|refresh_token\|Flow.from_client_config\|authorization_url" --include="*.py" .`
- [ ] No code path in `/youtube_connect` lets `RefreshError`/`invalid_grant` escape.
- [ ] Pending OAuth state is per-user and survives long enough for the user to
      approve in the browser (file or DB, NOT a local variable that dies on
      restart mid-flow — or document the restart limitation).
- [ ] `YOUTUBE_SCOPES` contains no `drive` scope.
- [ ] Token/pending files are gitignored with `0600` permissions.
- [ ] No `print`/`log` of tokens, secrets, or codes (search for `refresh_token`,
      `access_token`, `client_secret`, `authorization_response` in log lines).
- [ ] Dashboard `socialConnections.youtube` writer is read-modify-write
      (preserves `queue`, `streams`, etc.).

---

## 6. Tests (Q9/Q10)

### Actually tested (Q9)

**New backend reference tests** — `python3 -m unittest
backend_reference.test_youtube_oauth_reconnect -v` → **20 passed, 0 failed**:

- Exact reported scenario: expired access + revoked refresh →
  `begin_connect()` returns fresh `https://accounts.google.com/...` URL,
  marks REAUTH REQUIRED, keeps old token in place; `finish_connect()` with a
  valid new grant saves fresh creds (`refresh-OLD-INVALID →
  refresh-NEW-VALID`), validates Data + Analytics with the fresh creds, marks
  CONNECTED, clears pending state, and background calls then succeed.
- Begin edges: no token, valid token (still returns fresh URL for explicit
  reconnect), expired-but-refreshable, transient refresh failure, unusable
  credential object, stale pending state overwrite.
- Finish edges: missing pending state, exchange failure (old token preserved),
  Data API validation failure, Analytics validation failure.
- Background refresh preserved: valid passthrough, auto-refresh + save,
  dead-refresh → `ReauthRequired` + REAUTH REQUIRED, no-token → `ReauthRequired`.
- Safety: `invalid_grant` detection variants, diagnostics contain no token
  values, scopes are YouTube-only, flow requests `offline` + `consent`.

**Existing frontend tests** — `node .test/oauth-split.test.js` → **53 passed,
0 failed** (no regressions): badge split, `invalid_grant → reauth`, Drive/YouTube
isolation intact. (`drive.test.js` / `dom.test.js` / `large.test.js` untouched.)

### NOT tested (Q10)

- The real Craftnode backend handler (it is not in this repo) — the backend
  session must run the copied tests there AND do one live reconnect:
  `/youtube_connect` (expect fresh URL despite dead grant) →
  approve in Google → `/youtube_connect_finish <redirect-url>` (expect
  CONNECTED + dashboard badge flips from REAUTH REQUIRED to CONNECTED).
- Real Google token endpoint / API responses (tests use fakes by design).
- Google Cloud Console API enablement, OAuth consent-screen / redirect-URI
  configuration, and Supabase `dashboard_state` write permissions.
- Discord slash-command registration, permission checks, and ephemeral-reply UX.
- Concurrent `/youtube_connect` invocations racing on pending state (last-write
  wins; acceptable, but untested under load).
- Token-file migration from any legacy backend storage layout.

---

## 7. Why the frontend needed no change

`youtubeConnectionState()` in `index.html` already maps the backend's
`socialConnections.youtube` record to the three required states, and its regex
already matches the reported failure text:

```
"Google token refresh failed (400): {"error": "invalid_grant",
 "error_description": "Token has been expired or revoked."}"
 → contains invalid_grant / expir / revok / token / 400 → 'reauth'
 → badge: REAUTH REQUIRED + "Reconnect with /youtube_connect → …"
```

`renderContentPerformance()` reads ONLY `socialConnections.youtube`, so Drive
expiry can never demote YouTube (and vice versa) — verified by test.
Changing dashboard copy cannot fix a backend handler that aborts before
producing a URL, so no `index.html` edit was made. If the backend session wants
friendlier dashboard copy after the fix, it can set `error` to a short human
string (e.g. "YouTube authorization expired.") instead of the raw payload — the
frontend appends the reconnect hint automatically.

---

## 8. Security notes

- No secrets were added to this repo. `backend_reference/` contains only logic
  + tests; token/pending runtime paths default to a gitignored `.runtime/`
  directory with `0600` file permissions.
- Reference code never logs `token`, `refresh_token`, `client_secret`, or
  `authorization_response`/`code`. The Discord sketch sends the auth URL via
  **ephemeral** reply only.
- Backend session: verify with `git status` + `git diff --cached` that no
  `youtube_token.json` / `.env` / client-secret value is staged, and keep
  `YOUTUBE_CLIENT_SECRET` in Craftnode env only.

---

## 9. Rollback

- This change is additive (new `backend_reference/` + docs). Rollback = revert
  this branch; frontend behavior is unchanged.
- Backend rollout rollback = restore the previous bot handler; worst case the
  reconnect bug returns (no data loss — the fix never deletes stored tokens
  before fresh auth succeeds).

---

## 10. Report checklist (answers at a glance)

1. Root cause: backend `/youtube_connect` refreshes the OLD token as a
   prerequisite and aborts on `invalid_grant` before generating a fresh URL.
2. Failing function: backend `/youtube_connect` handler (eager
   `credentials.refresh()` / token-refresh helper before `authorization_url()`).
3. Why: opportunistic "refresh if expired" block with no
   `except RefreshError → continue to fresh OAuth` branch.
4. Changed: added `backend_reference/youtube_oauth.py` (fixed core),
   `backend_reference/test_youtube_oauth_reconnect.py` (20 tests), this doc;
   extended `.gitignore`; no `index.html` change needed.
5. `invalid_grant`: detected by `is_invalid_grant_error()`; in begin-connect it
   marks REAUTH REQUIRED and continues to fresh OAuth; in background it raises
   `ReauthRequired` with REAUTH REQUIRED status.
6. Fresh OAuth without valid old creds: yes (all dead-grant variants tested).
7. Finish stores fresh refresh token: yes, only after successful exchange.
8. Normal auto-refresh preserved: yes (tested).
9. Tested: 20 new backend tests + 53 existing frontend split tests, all green.
10. Not tested: live backend handler, real Google endpoints, Cloud Console /
    Supabase / Discord wiring (backend session must verify live).
