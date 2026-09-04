# Handoff prompt for the Craftnode bot/backend chat

Paste everything below the line into the bot/backend AI session. It is self-contained;
if that session can read this repo, point it at branch `arena/01a069ac-nappavt-growth-hub-good`
(PR #1) and especially `docs/BACKEND_STORAGE_SCHEMA.md`.

---

You are working on the existing NappaVT Growth Hub bot/backend (Python, hosted on Craftnode).

This is the SERVER-SIDE / BOT portion of a Google Drive clip-storage upgrade. The frontend
half is DONE and deployed in a separate repo. This prompt contains the VERIFIED frontend
contract — do not invent or rename schema fields. If you can read the frontend repo, verify
against PR #1 of Nappasapa/nappavt-growth-hub-good (branch arena/01a069ac-nappavt-growth-hub-good,
file docs/BACKEND_STORAGE_SCHEMA.md).

IMPORTANT
- Do NOT rebuild the bot from scratch. Do NOT rewrite unrelated systems.
- Do NOT change working Discord/Twitch/social functionality unless required.
- Do NOT push directly to main. Work in a feature branch (e.g. feature/google-drive-bot-storage)
  and open a Pull Request when finished. Do not merge it yourself.
- Before editing code, inspect the existing implementation and give me a written audit + plan.
- Preserve compatibility with existing Supabase-backed clips.
- Never commit secrets, OAuth refresh/access tokens, passwords, service-role keys, or client
  secrets to GitHub.

======================================================================
WHAT THE FRONTEND ALREADY DID (context — the bot does NOT replicate any of this)
======================================================================

1. Upload flow (browser only): owner clicks "Connect Google Drive" (Google Identity Services
   token client, scope https://www.googleapis.com/auth/drive.file, token lives in the browser
   only) → picks a file → validated (mp4/mov/webm/mkv) → resumable upload (8 MiB chunks)
   DIRECTLY from the browser into Drive folder "NappaVT Growth Hub Clips/<YYYY-MM>/" (folder
   auto-created once, PRIVATE, no link sharing) → only after Drive confirms completion does
   the dashboard create the queue record → the dashboard then verifies the Supabase
   dashboard_state write succeeded before reporting success.
   Consequence: a Drive file can transiently exist with NO queue record (upload succeeded,
   metadata save failed, user retried). The bot will never see those records — ignore them;
   cleanup is a manual Drive matter. Do not build anything that scans Drive for orphans.
2. Records: new records get storageProvider:'google_drive', driveFileId, driveFolderId,
   driveUploadedAt, videoName/videoSize/videoType, videoPath:'', source:'Upload'.
   Legacy records were not migrated and must not be.
3. Open: the dashboard checks Drive metadata (authenticated browser token) then opens
   https://drive.google.com/file/d/<driveFileId>/view under the OWNER's Google session.
   The bot has no role here and needs no Google access for it.
4. Delete: deleting a queue record in the dashboard explicitly TRASHES the Drive file after
   user confirmation (and offers "delete entry only" if the trash call fails). NOTHING
   auto-deletes — not on status change, not on reload, not by timer. videoDeleted /
   videoDeletedAt remain meaningful for legacy Supabase records only.
5. The dashboard merges ONLY these bot-owned fields back before saving
   (mergeBotQueueFields whitelist), plus bot status advances to "Posted":
     reminderSent, reminderSentAt, discordReminderMessageId, snoozedUntil,
     postedAt, videoDeleted, videoDeletedAt, videoPath
   Any NEW bot-side per-record field will be silently dropped by the frontend merge —
   coordinate across both repos before adding any.
6. The bot must NEVER: hold or request the browser's Drive token; construct Supabase signed
   URLs for Drive records; write videoPath on Drive records; auto-delete Drive files;
   migrate legacy clips; rename the camelCase fields; treat filename as the identifier
   (driveFileId is the only stable key; Drive allows duplicate filenames).

======================================================================
VERIFIED SHARED STORAGE SCHEMA (from the deployed frontend — authoritative)
======================================================================

Clip/post records live in the Supabase table `dashboard_state`: ONE JSON row per workspace
(columns: `user_id`, `state` (jsonb), `updated_at`). Queue records are `state.queue[]`.
There is NO separate clips table. The same JSON also holds: fields, routine, streams, clips,
twitchClips, twitchStatus, streamTrackingStatus, streamAudienceHistory, liveStreamSession,
streamLastReport, twitchHistoryStatus, socialConnections, socialVideos, socialSyncStatus, theme.

NEW Google Drive-backed queue record (camelCase — EXACTLY these names):

  storageProvider: "google_drive"      // exact value, never "GoogleDrive"/"gdrive"
  driveFileId:     "<drive file id>"   // stable identifier, always use this, never filename
  driveFolderId:   "<drive folder id>" // YYYY-MM folder inside "NappaVT Growth Hub Clips"
  driveUploadedAt: "<ISO timestamp>"
  videoName:       "PRAGMATA_clip_07.mp4"  // original file name (existing field, reused)
  videoSize:       259312844               // bytes (existing field, reused)
  videoType:       "video/mp4"             // mime type (existing field, reused)
  videoPath:       ""                      // ALWAYS empty for Drive records

All pre-existing fields (id, title, postTitle, caption, tags, status, platforms, platform,
note, reminderMinutes, reminderSent, reminderSentAt, discordReminderMessageId, snoozedUntil,
postedAt, source, twitchClipId, twitchUrl, twitchThumbnailUrl, twitchGame, twitchClipTitle,
twitchVodTitle, twitchVodUrl, twitchDuration, twitchCreatedAt, packagingMode, keepVideo,
videoDeleted, videoDeletedAt, createdAt) remain intact and unchanged.

LEGACY Supabase records (unchanged, do not migrate):
  storageProvider: absent or ""  → treat as Supabase
  videoPath: "<user_id>/<epoch>_<rand>_<sanitized>.<ext>"   // Supabase Storage bucket "clips"
  videoName / videoSize / videoType as before.

Provider detection (authoritative — mirror this exactly):

  def get_clip_storage_provider(clip: dict) -> str:
      """'google_drive' or 'supabase'. Absent provider == legacy Supabase."""
      if not isinstance(clip, dict):
          return "supabase"
      provider = (clip.get("storageProvider") or "").strip().lower()
      if provider == "google_drive":
          return "google_drive"
      if not provider and clip.get("driveFileId"):
          return "google_drive"   # defensive: provider missing but Drive id present
      return "supabase"

Any code that builds a Supabase signed URL, downloads from Storage, or deletes a Storage
object MUST call this check first.

WRITE RULES (critical):
- Bot writes must be READ-MODIFY-WRITE of the whole `state` JSON with all unknown fields
  preserved. Never rewrite records from a fixed schema — that strips driveFileId etc. and
  orphans the Drive file.
- `videoPath` is bot-writable for legacy Supabase cleanup ONLY. For Drive records it must
  stay "" — never write a Supabase path into a Drive record.
- Drive clips are NEVER auto-deleted by the bot. Drive records have videoPath "" so any
  existing Supabase auto-cleanup is already a natural no-op for them — keep it that way.
  If bot-side Drive deletion is ever added, it must be an explicit, logged, user-intended
  action and must TRASH (PATCH trashed:true), never purge.

Environment facts you can rely on:
- Supabase Storage bucket: "clips". Legacy path format above.
- New Drive uploads land in folder "NappaVT Growth Hub Clips/<YYYY-MM>/", created PRIVATE,
  scope https://www.googleapis.com/auth/drive.file, owned by the owner's Google account that
  authorized the DASHBOARD (browser token — the bot has none of this).
- Duplicate filenames are allowed by Drive; driveFileId is the only stable key.
- Credential-free viewer URL for display purposes:
  https://drive.google.com/file/d/<driveFileId>/view (opens only for Google accounts with
  access, i.e. the owner).

======================================================================
CRITICAL DESIGN DECISION — OPTION A vs B
======================================================================

OPTION A — METADATA ONLY (STRONGLY PREFERRED, and what the dashboard assumes):
The bot reads state.queue[] for titles/captions/statuses/reminder timing and sends Discord
DMs/links. Zero Google credentials on Craftnode. Drive clips work purely through metadata.

OPTION B — real Drive byte access. ONLY if the existing bot genuinely downloads video bytes
today. Audit first and report which functions need it BEFORE implementing any Google OAuth:
- [ ] Any Discord command that attaches/uploads the stored clip FILE to Discord?
- [ ] Any Supabase Storage .download() or signed-URL GET of clip bytes (processing, re-upload)?
- [ ] Any ffmpeg/thumbnail/duration/analysis consuming clip bytes?
- [ ] Any automated TikTok/YouTube/Instagram posting that pulls the file from Supabase?
If ALL no → Option A. If ANY yes → only those functions get provider-aware file resolution,
via server-side OAuth authorization-code flow with offline access, scope drive.file ONLY
(do not widen without stopping and explaining), env vars GOOGLE_DRIVE_CLIENT_ID /
GOOGLE_DRIVE_CLIENT_SECRET, refresh token in a PRIVATE gitignored runtime file consistent
with the project's existing private OAuth-state file pattern, automatic token refresh, and
streamed/chunked downloads to sanitized temp files (never whole-file in RAM, cleaned after
use, safe on 401/403/404/429/5xx). Do NOT add Google OAuth "just in case".
Do NOT use the browser's temporary Drive token server-side.

======================================================================
FIRST TASK: FULL BOT AUDIT BEFORE CODING
======================================================================
Inspect the backend and report:
1. Every function that reads/writes Growth Hub clip records (state.queue[]).
2. Every function assuming videoPath is always a Supabase path / constructing signed URLs
   without a provider check.
3. Every Supabase Storage call (upload/download/signed URL/remove/list) + hardcoded buckets.
4. Every function downloading a video locally; every feature needing ACTUAL BYTES vs metadata.
5. Twitch clip import handling; social-posting handling; clip analysis; background jobs.
6. Deletion logic and whether "remove record" vs "delete video" are distinguished.
7. Any code path that could overwrite records and erase Drive metadata (fixed-schema writes).
8. File-size assumptions/limits; whole-file-into-RAM reads; temp-file leaks; blocking I/O
   inside async Discord handlers; duplicate tasks/handlers; retry loops without limits.
Then give the concise audit report (what needs bytes / what needs metadata / which functions
must change / which stay untouched) and your Option A/B verdict BEFORE implementing.

======================================================================
THEN IMPLEMENT (provider-aware, minimal)
======================================================================
- Small service layer, e.g. get_clip_storage_provider(clip) + provider-specific resolution
  only where bytes are actually needed. No giant framework, no scattering Drive calls.
- Legacy Supabase behavior byte-for-byte identical: no migrations, no deletions, no path
  changes, Drive records never sent through Supabase Storage logic.
- Provider-aware logging like "[GrowthHub] Resolving clip storage provider: google_drive"
  and "[GrowthHub] Drive file missing for clip <id>". NEVER log tokens/secrets.
- If Option B: expose safe connection status (CONNECTED / REAUTH REQUIRED / NOT CONFIGURED)
  without exposing refresh/access tokens or client secret.

======================================================================
DO NOT BREAK
======================================================================
Discord commands, Twitch integration & clip importing, Supabase integration, stream
analytics, social analytics, TikTok/YouTube/Instagram integrations, existing OAuth
connections, owner/staff functionality, dashboard API compatibility, existing Supabase
clips. Do not change Twitch import storage behavior without first explaining advantages,
risks, and dependencies (default: leave Twitch imports exactly as they are).

======================================================================
TESTS (reason through; automate what the repo allows)
======================================================================
A/B Legacy + explicit "supabase" records behave exactly as today (signed URLs, cleanup).
C Drive record → NO Supabase Storage call attempted (videoPath is "").
D Metadata-only use works with zero Google credentials present.
B' (if Option B) Drive download via driveFileId, streamed/chunked; expired token auto-refresh;
   revoked access → clear REAUTH REQUIRED, no crash; missing Drive file → clean 404 handling.
I Duplicate filenames stay distinct (driveFileId keyed).
J Bot restart: no lost/corrupt state; (Option B: refresh token survives via private file).
K Record updates preserve storageProvider/driveFileId/driveFolderId/driveUploadedAt.
L Marking Posted does NOT delete/touch any file.
M–S Twitch clips, stream analytics, social analytics, Instagram, YouTube, TikTok, Discord
    commands all still work against a workspace containing BOTH legacy and Drive records.

======================================================================
BUG AUDIT + SECURITY AUDIT + DELIVERY
======================================================================
Produce a structured BUG REPORT (BUG ID / Severity / Area / File:function / Repro / Expected
/ Actual / Likely cause / Recommended fix / Fixed in this PR? YES-NO) covering storage-provider
assumptions, stale records, Drive-metadata erasure, wrong-file deletion, duplicates, races,
blocking I/O in async handlers, RAM-hoisting big files, unclosed sessions, temp leaks, token
expiry/refresh, swallowed errors, missing-key crashes, unbounded retries, env handling,
startup/dependency failures. Only auto-fix unrelated bugs if they block this feature or were
caused by this branch — otherwise report them.
Security-audit the bot repo for leaked secrets (service-role keys, client secrets, refresh/
access tokens, Discord bot token, R2/AWS keys, tracked credential JSON, .env content) and
report type/location/risk/action WITHOUT printing values. Ensure any new private OAuth/state
runtime files are gitignored.
Craftnode: list EXACT env/config to add (e.g. GOOGLE_DRIVE_CLIENT_ID=, GOOGLE_DRIVE_CLIENT_
SECRET= — no dummy values) and any requirements.txt additions (prefer official, small libs).
Commit in logical units (provider-aware handling / Drive service / legacy preservation /
error handling + tests). Then the FINAL REPORT: architecture; Option A/B verdict; features
needing bytes vs metadata; files changed; functions added/modified; final schema; legacy
compat; Drive behavior; OAuth architecture + refresh-token storage location; Craftnode
config; dependency changes; download/temp-file/delete/Twitch/social/analysis behavior;
tests performed vs not; bug report; security audit; limitations; rollback instructions.
Open the PR (title like "Add Google Drive clip support to Growth Hub bot") with architecture
summary, files changed, shared schema, whether offline OAuth was needed, Craftnode setup,
compatibility notes, manual test checklist, known risks, rollback. DO NOT merge.
