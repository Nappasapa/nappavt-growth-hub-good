# Growth Hub Clip Storage — Frontend ↔ Backend (Nappa Bot) Contract

**Authoritative schema for the Google Drive clip-storage upgrade.**
The frontend (this repo, PR #1) and the Python bot/backend on Craftnode MUST agree on everything in
this document. If the bot was implemented against a different field naming (e.g. snake_case
`storage_provider` / `drive_file_id`), it WILL misclassify Drive clips as legacy Supabase and break.

---

## 1. Where clip records live (do not guess)

- There is **no clips table**. All Growth Hub data lives in **one JSON row** per workspace in the
  Supabase table **`dashboard_state`** (columns: `user_id`, `state`, `updated_at`).
- Queue/post records: **`state.queue[]`**.
- Other arrays in the same JSON that MUST be preserved on every bot write:
  `fields`, `routine`, `streams`, `clips`, `twitchClips`, `twitchStatus`, `streamTrackingStatus`,
  `streamAudienceHistory`, `liveStreamSession`, `streamLastReport`, `twitchHistoryStatus`,
  `socialConnections`, `socialVideos`, `socialSyncStatus`, `theme`.
- **Bot writes must be read-modify-write of the whole JSON with unknown fields preserved.**
  Rewriting records from a fixed schema strips Drive metadata (failure mode: "overwriting Drive
  metadata").

## 2. Storage-provider schema (camelCase — exactly as the frontend writes it)

Every queue record may contain these fields. **New Drive-backed records:**

```jsonc
{
  // …all existing fields (title, postTitle, caption, tags, status, platforms, reminderMinutes,
  // twitch*, keepVideo, videoDeleted, videoDeletedAt, createdAt, …) remain intact…
  "storageProvider": "google_drive",   // exactly this value; never "GoogleDrive"/"gdrive"
  "driveFileId":   "<google drive file id>",   // stable identifier — always use this, never filename
  "driveFolderId": "<google drive folder id>", // YYYY-MM folder inside "NappaVT Growth Hub Clips"
  "driveUploadedAt": "2026-09-04T00:00:00.000Z",
  "videoName": "PRAGMATA_clip_07.mp4",  // original file name
  "videoSize": 259312844,               // bytes
  "videoType": "video/mp4",             // mime type
  "videoPath": ""                       // ALWAYS empty for Drive records
}
```

**Legacy Supabase records** (do not touch, do not migrate):

```jsonc
{
  "storageProvider": "" or absent,      // absent == legacy Supabase
  "videoPath": "userId/1722500000_abc_name.mp4",  // Supabase Storage object path, bucket "clips"
  "videoName": "old.mp4", "videoSize": 52428800, "videoType": "video/mp4"
}
```

### Mapping from snake_case proposals → actual fields

| Generic prompt name | ACTUAL field in `dashboard_state` |
|---|---|
| `storage_provider` | **`storageProvider`** |
| `drive_file_id` | **`driveFileId`** |
| `drive_folder_id` | **`driveFolderId`** |
| `original_file_name` | **`videoName`** (existing field, reused) |
| `file_size` | **`videoSize`** (existing field, reused) |
| `mime_type` | **`videoType`** (existing field, reused) |
| `uploaded_at` | **`driveUploadedAt`** |

## 3. Provider detection (authoritative logic — mirror of the frontend)

```python
def get_clip_storage_provider(clip: dict) -> str:
    """'google_drive' or 'supabase'. Absent provider == legacy Supabase."""
    if not isinstance(clip, dict):
        return "supabase"
    provider = (clip.get("storageProvider") or "").strip().lower()
    if provider == "google_drive":
        return "google_drive"
    if not provider and clip.get("driveFileId"):
        return "google_drive"          # defensive: provider field missing but Drive id present
    return "supabase"                  # everything else — existing behavior, unchanged
```

Rules:
- `storageProvider == "google_drive"` → Drive handling.
- `storageProvider == "supabase"` (explicit) → Supabase handling.
- Field absent → **legacy Supabase** (never assume Drive).
- Any code that builds a Supabase signed URL / downloads from Storage **must call this first**.

## 4. Deletion semantics (already implemented in the frontend — do not duplicate)

- Deleting a queue record in the dashboard **trashes** the Drive file itself (reversible) and only
  after user confirmation. Legacy Supabase objects are removed from Storage as before.
- **No auto-deletion exists for Drive clips**: not on status change, not on reload, not by timer.
  The Nappa Bot auto-cleanup setting only ever applied to Supabase Storage objects via `videoPath`;
  Drive records keep `videoPath == ""`, so that cleanup is a **natural no-op** for them. Keep it that
  way unless the owner explicitly requests bot-side Drive deletion.
- If bot-side Drive deletion is ever added: use **trash** (`trashed: true`), never purge, and make it
  an explicit, logged action.

## 5. Frontend↔bot field-merge contract (two-sided!)

The frontend merges ONLY these bot-owned queue fields back before saving (whitelist in
`mergeBotQueueFields`), plus bot status advances to `Posted`:

```
reminderSent, reminderSentAt, discordReminderMessageId, snoozedUntil,
postedAt, videoDeleted, videoDeletedAt, videoPath
```

Consequences:
- If the bot adds NEW per-record fields (e.g. its own Drive status), they will be **dropped** by the
  frontend merge unless the whitelist is extended on the frontend too. Coordinate both sides.
- `videoPath` is bot-writable for Supabase cleanup. For Drive records it must stay `""` — never set a
  Supabase path there.
- `videoDeleted`/`videoDeletedAt` remain meaningful for legacy records only.

## 6. Option A vs Option B (does the bot need Drive bytes?)

**Option A — metadata only (preferred, and what the dashboard currently assumes).**
The bot reads `state.queue[]` for titles/captions/statuses/reminder timing and sends Discord DMs with
links. Nothing in the dashboard flow requires the bot to fetch Drive bytes. No Google OAuth on
Craftnode. The bot needs **zero Google credentials**, and Drive-backed clips work purely through
metadata. `driveFileId` is enough for the owner to open the file (the dashboard does this).

**Option B — required ONLY IF the bot today downloads actual video bytes for its own work.**
Audit checklist for the backend repo before choosing B:
- [ ] Does any Discord command attach/upload the stored clip file to Discord?
- [ ] Does the bot download Supabase clip bytes (`.storage.from('clips').download(...)` or signed-URL
      GET) for processing, re-upload, analysis, or social posting?
- [ ] Does any ffmpeg/thumbnail/duration step consume clip bytes?
- [ ] Does automated TikTok/YouTube/Instagram posting pull the file from Supabase?
If **all no** → Option A. If **any yes** → only those functions need a provider-aware
`download_clip(clip, destination)` with Drive support (offline OAuth, `drive.file` scope, streamed to
disk in chunks, temp files cleaned up). Do not add OAuth "just in case".

## 7. What breaks if the bot does NOT match this contract

| Bot behavior | Result |
|---|---|
| Detects provider via `storage_provider` (snake_case) | Every Drive clip misclassified as Supabase |
| Creates signed URL without provider check | Signed URL from empty `videoPath` → Supabase error |
| Rewrites records from a fixed schema | Strips `driveFileId` etc. → orphaned Drive files (dashboard loses the link) |
| Auto-deletes "video" for Drive records | Could delete Drive files the user wanted kept (contract violation) |
| Writes only queue array back | Drops bot-unrelated live updates from the dashboard (streams/social/etc.) |

## 8. Backend test matrix (mirror of the owner's checklist, with expected results)

- **A/B. Legacy + explicit Supabase records** → provider `supabase`; existing signed-URL/download
  behavior identical to today.
- **C. Drive record** → provider `google_drive`; NO Supabase Storage call is attempted
  (`videoPath == ""`).
- **D. Metadata-only use** → title/caption/status/platforms/twitch fields work with **zero** Google
  credentials present.
- **H. Drive file manually deleted** → irrelevant to Option A (no fetch); if Option B: clean 404
  handling, no crash.
- **J. Bot restart** → Option A keeps working trivially (no Google state to persist). Option B:
  refresh token must survive restart in a private runtime file (gitignored).
- **K. Supabase metadata update** → bot read-modify-write preserves `storageProvider`/`driveFileId`/
  `driveFolderId`/`driveUploadedAt` on every record.
- **L. Status update** → marking Posted must not touch any storage object for Drive records.
- **M–S. Twitch/streams/social/Discord** → untouched by this change; verify by running the existing
  flows against a workspace that contains BOTH legacy and Drive records.

## 9. Frontend behavior reference (what the bot can rely on)

- Buckets/values: Supabase Storage bucket is `"clips"`; legacy path format
  `<user_id>/<epoch>_<rand>_<sanitized-name>.<ext>`.
- New Drive uploads land in Drive folder `NappaVT Growth Hub Clips/<YYYY-MM>/`, created **private**,
  shared with nobody; `drive.file` scope; files owned by the owner's Google account that authorized
  the dashboard.
- Duplicate filenames are allowed by Drive; `driveFileId` is the only stable key.
- The dashboard itself opens Drive clips via `https://drive.google.com/file/d/<driveFileId>/view`
  after an authenticated metadata check — the bot may construct the same URL for display purposes
  WITHOUT any credentials (it only opens for Google accounts with access, i.e. the owner).
