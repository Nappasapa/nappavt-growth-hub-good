# Backend reference — YouTube OAuth reconnect fix

This directory holds the **portable fix payload** for the Craftnode Python
Discord bot (which owns `/youtube_connect` / `/youtube_connect_finish`).
This frontend repo contains no bot code, so the fix ships here as a tested
reference the backend session copies over.

- `youtube_oauth.py` — fixed core: `YouTubeOAuthService.begin_connect()` always
  returns a fresh authorization URL even when the old refresh token is dead
  (`invalid_grant`), `finish_connect()` replaces the token only after fresh
  auth succeeds, `get_valid_credentials()` preserves normal auto-refresh.
- `test_youtube_oauth_reconnect.py` — 20 stdlib tests (no network, no google
  packages). Run: `python3 -m unittest test_youtube_oauth_reconnect -v`
- Full spec + patch instructions: `docs/YOUTUBE_OAUTH_RECONNECT_FIX.md`

Never commit `backend_reference/.runtime/` (token + pending-state files).
