# NappaVT Growth Hub — Bug Report & Security Audit

Prepared alongside **feature: Google Drive large-clip storage** (PR #1).
Every issue found during the audits is listed here. "Fixed in this PR" = YES
only when the fix landed on this PR branch.

---

## Bugs

### BUG-001
**Severity:** HIGH
**Area:** Twitch clips / title packaging
**File/function:** `mergeBotTwitchFields()` (main script, before-write merge)
**How to reproduce:**
1. Owner signs in, opens Twitch Clips, picks a Nappa-packaged title variant for a clip (choice saved on the next debounced cloud save).
2. Before the debounced save fires, the bot (or another device) changes anything under `state.twitchClips`.
3. The pending save runs `writeCloudStateNow()` → `mergeBotTwitchFields()` compares `JSON.stringify(remote.twitchClips) !== JSON.stringify(local)` and **replaces the local array wholesale** — the just-made `packageSelectedIndex / packageRejectedTitles / packageVariant` selection is discarded, then persisted.
**Expected:** locally selected title variants survive a bot/remote metadata update.
**Actual:** title selection reverts to the bot/remote packaging ("title selection reverting to the wrong title").
**Likely cause:** `twitchClips` is merged as one opaque JSON blob instead of per-clip field merging (unlike `mergeBotQueueFields`, which whitelists bot-owned fields).
**Recommended fix:** merge per-clip: keep local `package*` fields for clips that exist locally with a newer `packageLastUsedAt`; only take bot-owned import metadata from remote.
**Fixed in this PR?** NO (unrelated system; report only)

### BUG-002
**Severity:** HIGH
**Area:** Content queue / Advisor role
**File/function:** `addQueue` click handler + `save()` + `refreshFullCloudState()`
**How to reproduce:** sign in as an Advisor → Content queue → fill title/platforms → "Upload & add to queue" (without a video) → post appears → within ~12 s a poll/refresh replaces state from cloud.
**Expected:** post is rejected with a clear message, or saved.
**Actual:** post silently disappears (advisors are read-only: `save()` skips persistence for non-owners, but the add handler never checks).
**Likely cause:** missing role guard in the add-queue path.
**Recommended fix:** disable/hide the add-queue action for advisors, or show "Advisors are read-only" on submit.
**Fixed in this PR?** PARTIAL — file uploads are now blocked for advisors with a clear message (required so a 500 MB upload is never silently lost). The no-video path still behaves as before (out of scope; flagged here).

### BUG-003
**Severity:** MEDIUM
**Area:** Advisor access
**File/function:** `createAdvisorInvite()`
**How to reproduce:** double-click "Create invite" quickly → two invite rows are inserted.
**Expected:** one invite (button disabled while inserting).
**Actual:** duplicate invites; unused tokens stay valid for 7 days.
**Likely cause:** no busy/disabled guard around the async insert.
**Recommended fix:** disable the button until the insert resolves (same pattern used by the login form).
**Fixed in this PR?** NO (unrelated)

### BUG-004
**Severity:** MEDIUM
**Area:** Clip log
**File/function:** `renderClips()` (`data-del-clip` handler)
**How to reproduce:** Clips page → click the red `×` on a clip row.
**Expected:** confirmation, consistent with queue/stream deletion.
**Actual:** immediate, unrecoverable deletion with no confirm.
**Likely cause:** missing `confirm()`.
**Recommended fix:** add `confirm('Delete this clip log entry?')`.
**Fixed in this PR?** NO (unrelated)

### BUG-005
**Severity:** LOW
**Area:** Cloud save integrity
**File/function:** `writeCloudStateNow()`
**How to reproduce:** hard to hit; build payload → during the awaited `upsert()`, mutate `state` from another handler.
**Expected:** the snapshot that was validated is what persists.
**Actual:** `state:state` is a live reference; supabase-js serializes at await time, so a concurrent mutation can be captured mid-save.
**Likely cause:** payload built from a mutable reference instead of a snapshot.
**Recommended fix:** `state: JSON.parse(JSON.stringify(state))` (or `structuredClone`) when building the payload.
**Fixed in this PR?** NO (pre-existing, affects all saves equally; not required for Drive safety)

### BUG-006
**Severity:** LOW
**Area:** Cloud save race
**File/function:** `refreshFullCloudState()` / 12 s poll
**How to reproduce:** theoretical — a poll fetch that starts before a local save and resolves after it can transiently render older state.
**Expected/Actual:** mostly self-protects via the `updated_at` comparison and `localDirty` guards; self-heals on the next poll.
**Recommended fix:** none needed now; keep in mind when touching sync.
**Fixed in this PR?** NO (pre-existing, no user-visible reproduction found)

### BUG-007
**Severity:** LOW
**Area:** Drive clips / external bot cleanup
**File/function:** external Nappa Bot (Craftnode) + `mergeBotQueueFields()`
**How to reproduce:** let the auto-cleanup bot process a Drive-backed queue record.
**Expected:** Drive videos are only removed explicitly (per requirement).
**Actual/by design:** the bot has no Drive knowledge; for Drive records `videoPath` is empty so it cannot delete the file — it may still set `videoDeleted=true` metadata, which only changes the UI label.
**Recommended fix:** none required; document that Drive clips are never auto-deleted.
**Fixed in this PR?** YES (by design — Drive delete is explicit-only; UI copy updated in the "Clip storage" card)

### BUG-008
**Severity:** HIGH (data safety)
**Area:** Settings / backups
**File/function:** `#importBackup` change handler
**How to reproduce:** Settings → "Import backup" → pick any JSON file (wrong file, old backup, or a random `.json`) → the entire dashboard state is replaced and immediately pushed to the cloud. No confirmation, no validation.
**Expected:** a deliberate, reversible action.
**Actual:** silent wholesale replace + cloud overwrite; unrecoverable except from an external backup.
**Likely cause:** handler imported whatever parsed as JSON with no guard.
**Recommended fix:** validate the JSON shape, show a summary confirm dialog, and auto-download a safety backup of the current data first.
**Fixed in this PR?** YES — import now requires Growth-Hub-shaped JSON, shows a backup-vs-current summary confirm, and downloads `NappaVT_GrowthHub_PRE_IMPORT_SAFETY_<date>.json` before replacing anything.

### BUG-009
**Severity:** MEDIUM (data safety)
**Area:** Settings / reset
**File/function:** `#resetAll` click handler → `resetCloudAndLocal()`
**How to reproduce:** Settings → "Delete all data" → single confirm click deletes all local AND cloud data.
**Expected:** destructive global reset should require deliberate confirmation.
**Actual:** one misclick away from total deletion.
**Likely cause:** single generic `confirm()`.
**Recommended fix:** typed confirmation.
**Fixed in this PR?** YES — reset now additionally requires typing `DELETE`.

### BUG-010
**Severity:** LOW
**Area:** Multiple buttons
**File/function:** `createAdvisorInvite()`, `submitAdvisorNote()`, `addStream` handler
**How to reproduce:** double-click any of these buttons quickly.
**Expected:** one invite / one note / one stream entry.
**Actual:** duplicates (no busy guard on the async inserts or the add handler).
**Likely cause:** no disabled-while-processing guard.
**Recommended fix:** same pattern as the login form (`disabled` until the async op resolves).
**Fixed in this PR?** NO (unrelated)

### BUG-011
**Severity:** LOW
**Area:** Settings exports
**File/function:** `csvDownload()`
**How to reproduce:** put `=HYPERLINK("http://evil","x")` into a stream note → export CSV → open in Excel.
**Expected:** the text is inert data.
**Actual:** Excel/Sheets interprets the cell as a formula.
**Likely cause:** cells not neutralized for leading `= + - @`.
**Recommended fix:** prefix a `'` before such cells (standard mitigation).
**Fixed in this PR?** YES — `csvDownload` now neutralizes formula-leading cells.

---

## Follow-up improvements shipped in this PR (quick-wins pack)

- **Cancel upload** button during Drive uploads (aborts cleanly, keeps the resumable session so retry continues from the last confirmed byte; no queue record is created).
- **Local video preview** of the selected file before uploading (object URL, revoked on change/reset).
- **Clip-name autofill** from the chosen filename (never overwrites an existing title).
- **Storage stats line** in the "Clip storage" card (Drive clips/size vs Supabase clips/size + cleanup setting).
- **Backup import safety** (BUG-008 fix) and **typed Reset confirmation** (BUG-009 fix).
- **Global `unhandledrejection` handler** → sync pill shows "Background error · will retry" instead of silent console-only failures.
- **`beforeunload` warning** for unsaved (still-syncing) edits, in addition to the upload warning.
- **A11y/meta polish:** `aria-label`s on icon-only delete buttons, `aria-live` on upload/storage status, favicon, meta description, preconnect hints to Supabase/Google endpoints.
- **CSV formula-injection guard** (BUG-011 fix).

---

## Security audit

Scope: full repository (`index.html`, `privacy/`, `terms/`, TikTok verification file, GitHub Actions workflow).

| Location | Type | Status | Action required |
|---|---|---|---|
| `index.html` — `SUPABASE_ANON_KEY` (`sb_publishable_…`) | Supabase publishable/anon key | Browser-safe by design (RLS enforced server-side) | None |
| `index.html` — `GDRIVE_CLIENT_ID` | Google OAuth Client ID | Public identifier, designed to be embedded | None |
| `.github/workflows/main.yml` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GITHUB_TOKEN` | Referenced via `${{ secrets.* }}` — values not in repo | None |
| `index.html` — YouTube/TikTok credential mentions | Documentation text only (env var *names* on Craftnode) | No secret values present | None |
| `tiktokbSoGYzHe5aeNCnsrhIKFW8BguLbCIJxy.txt` | TikTok site-verification token | Public by design | None |

Scanned for: Google client secrets (`GOCSPX-…`), OAuth access/refresh tokens, Supabase service-role keys, AWS/R2 keys, Twitch/Instagram/TikTok/YouTube client secrets, private keys, passwords, `.env` content, JWT-shaped strings (`eyJ…`).
**Result: no secrets leaked. No new secrets introduced by this feature.**

Additional Drive-specific guarantees implemented in this PR:
- Google access token is held **in memory only** — never logged, never written to Supabase, localStorage, sessionStorage, or GitHub.
- No Google Client Secret exists anywhere in the repo or the browser flow (GIS token client only).
- Drive files are created **private**; no `permissions.create` / link-sharing calls exist in the code.
- Only the narrow `https://www.googleapis.com/auth/drive.file` scope is requested.
