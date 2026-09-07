# Backend reference — portable fixes for the Craftnode bot

This directory holds the **portable fix payloads** for the Craftnode Python
Discord bot (which owns `/youtube_connect` / `/youtube_connect_finish` and the
social-analytics stats worker). This frontend repo contains no bot code, so
each fix ships here as a tested reference the backend session copies over.

- `youtube_oauth.py` — YouTube OAuth reconnect fix: `YouTubeOAuthService.begin_connect()` always
  returns a fresh authorization URL even when the old refresh token is dead
  (`invalid_grant`), `finish_connect()` replaces the token only after fresh
  auth succeeds, `get_valid_credentials()` preserves normal auto-refresh.
- `test_youtube_oauth_reconnect.py` — 20 stdlib tests (no network, no google
  packages). Run: `python3 -m unittest backend_reference.test_youtube_oauth_reconnect -v`
- Full spec + patch instructions: `docs/YOUTUBE_OAUTH_RECONNECT_FIX.md`
- `social_link.py` — manual social-link fix: canonical URL parsing (all
  real-world YouTube/TikTok/Instagram paste shapes → one predictable URL),
  plus the queue-record contract helpers (`manual_link_jobs`,
  `manual_link_needs_refresh`, `upsert_manual_analytics`,
  `mark_refresh_error`) so manually linked videos actually get stats.
- `test_social_link.py` — 19 stdlib tests (no network, no third-party
  imports), in lockstep with the dashboard canonicalizers tested by
  `.test/social-link.test.js`. Run:
  `python3 -m unittest backend_reference.test_social_link -v`
- Full spec + bot handoff: `docs/MANUAL_SOCIAL_LINK_FIX.md`

Never commit `backend_reference/.runtime/` (token + pending-state files).
