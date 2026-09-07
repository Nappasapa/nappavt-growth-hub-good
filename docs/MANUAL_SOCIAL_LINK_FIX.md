# Manual social-link fix — pasted video links must actually get tracked (especially YouTube)

**Date:** 2026-09-07
**Branch:** `arena/01a07c06-nappavt-growth-hub-good`
**Frontend repo:** `Nappasapa/nappavt-growth-hub-good` (this repo — static dashboard)
**Backend repo:** Craftnode Python Discord bot (owns the social-analytics stats worker — **not in this repo**)

Reported symptom: *"manually linking a video to track the stats is not working,
especially for YouTube links"* — the owner pastes the link (a normal
`youtube.com/watch?v=…`), clicks save, and **stats never appear**. The
performance card stays on "Not matched yet." with no error and no feedback.

This document is the authoritative fix specification + handoff for both sides.
The dashboard half is implemented and deployed in this repo; the bot half is a
portable reference in `backend_reference/social_link.py` with tests in
`backend_reference/test_social_link.py` (19 stdlib tests, all passing).

---

## 1. TL;DR

- **Where the manual link lives:** queue record → `manualSocialLinks[platform]`
  (e.g. `manualSocialLinks.youtube`). The frontend writes it, then sets the
  top-level flag `socialRefreshRequested = true`. The bot's stats worker
  notices that flag, resolves stats for the linked video and writes them back
  into `socialAnalytics[platform]` (bot-owned key, merged by the dashboard).
- **Frontend root causes (fixed in this PR):**
  1. The link was stored **verbatim** — whatever the user pasted (`youtu.be/…`,
     `/shorts/…`, `/embed/…`, `/live/…`, music/mobile hosts, share-sheet
     `?si`/`&list`/`&t` params) — with **no validation, no canonicalization,
     no feedback**. Any mismatch between the pasted shape and what the bot's
     URL parser accepts meant a silent "stats never appear" state.
  2. Clearing the field stored `""` instead of removing the link, so a
     "cleared" post could still look linked to a worker.
  3. The dashboard never told the user whether the link was accepted, what URL
     is being tracked, or that stats are still pending — so failures were
     invisible.
- **Backend root causes (bot repo — hand off `backend_reference/social_link.py`):**
  - The worker must treat every manual link as a hard job, not a soft hint:
    resolve the URL → fetch stats → write `socialAnalytics[platform]` with
    `matchedBy: "manual"`. If it only auto-matches by scanning recent channel
    uploads and never reads `manualSocialLinks`, manually linked posts never
    get stats — exactly the reported symptom.
  - The worker must parse **all** YouTube URL shapes, not only
    `watch?v=…`. Links stored before this fix are still raw pastes.
  - Fetch failures must surface truthfully (`socialSyncStatus.error`) instead
    of silently leaving the card on "Not matched yet." — and must never be
    faked with zeroed stats.

---

## 2. What the dashboard now does (this repo, `index.html`)

All new code is in the "MANUAL SOCIAL LINK FIX" block (pure helpers, locked in
by `.test/social-link.test.js`, 72 assertions) plus wiring in
`promptSocialLink()`, `confirmSocialSuggestion()`, `renderQueue()` and
`renderContentPerformance()`:

1. **Canonicalizes before saving.** Every YouTube paste form becomes
   `https://www.youtube.com/watch?v=<videoId>`:
   `youtube.com/watch?v=…` (with `&list`/`&t`/`?si`/`&feature`), `youtu.be/…`,
   `/shorts/<id>`, `/embed/<id>`, `/live/<id>`, `/v/<id>`, `music.youtube.com`,
   `m.youtube.com`, `youtube-nocookie.com`, `<>`-wrapped pastes and plain
   11-character video IDs. TikTok (`/@user/video/<id>`, `vm.tiktok.com/…`) and
   Instagram (`/reel/<code>`, `/p/<code>`, `/reels/<code>`) are validated and
   stripped of tracking params. Foreign hosts (`notyoutube.com`, etc.) are
   rejected — a `?v=` on another site can never be accepted.
2. **Validates the paste with a clear message.** Junk input shows an error
   toast listing the accepted forms and changes nothing.
3. **Blank truly unlinks.** Clearing the field deletes
   `manualSocialLinks[platform]` (and the whole object when empty) and the new
   `manualLinkRequestedAt[platform]` timestamp.
4. **Honest link state in the UI.** Queue cards and the Content Performance
   panels show "Manual link saved · waiting for Nappa Bot stats" (with the
   stored URL linked) until `socialAnalytics` arrives, then switch to the
   automatic analytics block. Buttons change to "Change YouTube link" once a
   link exists.
5. **Every save requests a refresh** (`socialRefreshRequested = true`) and
   tells the user "…will fetch its stats on the next refresh".
6. Confirming a bot **suggestion** now routes through the same canonical store
   and also notifies the user.

No schema migration is needed. The only new queue-record field is the
frontend-owned `manualLinkRequestedAt` object (platform → ISO timestamp).

---

## 3. Frontend ↔ bot contract (authoritative)

```
queue_record = {
  ...,
  "manualSocialLinks": { "youtube": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
  "manualLinkRequestedAt": { "youtube": "2026-09-07T12:00:00.000Z" },
  ...,
  "socialAnalytics": { "youtube": { views, likes, comments, shares, title,
      url, publishedAt, averageViewPercentage, subscribersGained,
      matchedBy: "manual", matchConfidence: 1, matchEvidence: {} } }
}
```

- **Canonical YouTube URL (frontend writes, bot should assume):**
  `https://www.youtube.com/watch?v=<11-char video id>` — nothing else, no
  query params.
- **Owner-owned keys the bot must NEVER write:** `manualSocialLinks`,
  `manualLinkRequestedAt`. Leave them byte-for-byte alone.
- **Bot-owned keys (dashboard merge whitelist):** `socialAnalytics`,
  `socialMatch`, `socialMatchSuggestions`, `rejectedSocialIds`. Stats go into
  `socialAnalytics[platform]` only.
- **Trigger:** the bot may batch-refresh social analytics whenever
  `state.socialRefreshRequested === true` (also used by the automatic matcher)
  or on its normal social-refresh schedule. Outstanding jobs = records where
  `manual_link_needs_refresh(record, platform)` is true (see reference).
- **Failure contract:** video 404 / not owned / API error → write a truthful
  message to `state.socialSyncStatus.error`, leave `socialAnalytics[platform]`
  unset, never fabricate zeros.
- **YouTube note:** the YouTube Analytics API only reports on videos owned by
  the authorized channel. A pasted link to someone else's video will 403/empty
  — report that honestly; it is not a silent "not linked".

The exact numbers the dashboard renders per platform (keep numeric):

| platform | fields rendered from `socialAnalytics[platform]` |
|---|---|
| youtube | `views`, `likes`, `comments`, `shares`, `averageViewPercentage`, `subscribersGained` |
| tiktok | `views`, `likes`, `comments`, `shares` |
| instagram | `views`, `likes`, `comments`, `shares`, `reach`, `saved` |

---

## 4. Bot handoff — what to apply in the Craftnode repo

Copy `backend_reference/social_link.py` into the bot repo (it is stdlib-only,
no network, no new dependencies) and use it in the stats worker:

1. `canonical_social_link(platform, raw)` — canonicalize any legacy raw paste
   before resolving; replace any hand-rolled YouTube URL parser with
   `youtube_video_id()` / `canonical_youtube_url()`.
2. `manual_link_jobs(state["queue"])` — enumerate outstanding manual-link
   jobs; do NOT skip records just because a different auto-match exists.
3. Resolve stats per job with the bot's existing per-platform fetcher
   (YouTube Data API + Analytics, TikTok, Instagram).
4. `upsert_manual_analytics(record, platform, stats)` — write the result with
   `matchedBy: "manual"`, `matchConfidence: 1` and the canonical `url`.
5. On failure: `mark_refresh_error(state, "…")`; do not zero the stats.
6. Preserve unknown JSON fields on every read-modify-write (existing rule).
7. After processing a refresh cycle, set `state.socialRefreshRequested = false`
   in the same read-modify-write so the worker does not re-run forever.

Run the reference tests before merging:
`python3 -m unittest backend_reference.test_social_link -v`
(from the repo root; the same file also runs from `backend_reference/`).

---

## 5. Verification checklist

Frontend (this repo — done):
- `npm --prefix .test test` — 8 suites incl. the new `.test/social-link.test.js` pass.
- `python3 -m unittest backend_reference.test_social_link -v` — 19 pass.
- Manual: paste each of `watch?v=…&list=…&t=…`, `youtu.be/…?si=…`, `/shorts/…`,
  `/embed/…`, `/live/…`, `music.youtube.com/watch?v=…` → all store the same
  canonical `https://www.youtube.com/watch?v=<id>`; junk is rejected with a
  message; blank unlinks; card shows "waiting for Nappa Bot stats".

Bot (Craftnode — after handoff):
- Link a posted queue item with a YouTube URL in each shape → stats appear in
  `socialAnalytics.youtube` with `matchedBy:"manual"` within one refresh cycle.
- Link a non-existent / foreign-channel video → `socialSyncStatus.error`
  shows a truthful message, card keeps the manual-link waiting state, no zeros.
- Unlink (blank) → no job is produced; previously written analytics for that
  platform stay or are replaced per `manual_link_needs_refresh()` semantics.
- Confirm a bot suggestion → same canonical write path.

## 6. Rollback

Frontend: revert the "MANUAL SOCIAL LINK FIX" helpers + `promptSocialLink`
wiring. Old raw links remain valid input for the bot reference parser, so a
mixed deploy window is safe (dashboard canonicalizes going forward; the bot
canonicalizes anything it receives).
