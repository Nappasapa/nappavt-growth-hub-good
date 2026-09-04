"""
Tests for the YouTube OAuth reconnect fix.

Covers the EXACT reported scenario:
  stored access token: expired
  stored refresh token: invalid/revoked (refresh -> invalid_grant)
  user runs /youtube_connect
  EXPECTED: command does not fail; fresh Google authorization URL returned
  then /youtube_connect_finish with a valid new authorization result
  EXPECTED: new credentials saved, old refresh token replaced, CONNECTED,
            Data API + Analytics API validated.

Plus: normal automatic refresh still works, and background invalid_grant
still flips to REAUTH REQUIRED.

Run:  python3 -m unittest test_youtube_oauth_reconnect -v
      (from backend_reference/, or: python3 backend_reference/test_youtube_oauth_reconnect.py)
Stdlib only. No network. No google packages required (fakes injected).
"""

import logging
import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from youtube_oauth import (  # noqa: E402
    YOUTUBE_SCOPES,
    BeginResult,
    InMemoryCredsStore,
    InMemoryPendingStore,
    InMemoryStatusStore,
    ReauthRequired,
    YouTubeOAuthService,
    describe_credentials_for_log,
    is_invalid_grant_error,
)


# ---------------------------------------------------------------------------
# Fakes (stand-ins for google-auth / google-auth-oauthlib objects)
# ---------------------------------------------------------------------------

class FakeRefreshError(Exception):
    """Mimics google.auth.exceptions.RefreshError (class-name compatible)."""


# Rename so is_invalid_grant_error() sees a RefreshError-like name chain.
FakeRefreshError.__name__ = "RefreshError"


class FakeCredentials:
    def __init__(self, token="access-1", refresh_token="refresh-OLD-INVALID",
                 expired=True, valid=False, scopes=None):
        self.token = token
        self.refresh_token = refresh_token
        self.expired = expired
        self.valid = valid
        self.scopes = list(scopes or YOUTUBE_SCOPES)

    def to_json(self):  # pragma: no cover - only used by FileCredsStore
        import json
        return json.dumps({"token": self.token, "refresh_token": self.refresh_token})


def make_invalid_grant_error():
    # Mirrors the real failure payload from the bug report:
    # Google token refresh failed (400):
    # {"error": "invalid_grant", "error_description": "Token has been expired or revoked."}
    err = FakeRefreshError(
        '("invalid_grant: Token has been expired or revoked.", '
        '\'{"error": "invalid_grant", "error_description": '
        '"Token has been expired or revoked."}\')'
    )
    err.details = '{"error": "invalid_grant", "error_description": "Token has been expired or revoked."}'
    return err


class FakeFlow:
    """Mimics google_auth_oauthlib.flow.Flow for begin/finish."""

    instances = []

    def __init__(self, state=None, exchange=None):
        self.state = state or "STATE-123"
        self._exchange = exchange  # callable(authorization_response) -> FakeCredentials
        self.credentials = None
        FakeFlow.instances.append(self)

    def authorization_url(self, access_type=None, prompt=None, include_granted_scopes=None):
        assert access_type == "offline", "must request offline access (refresh token)"
        assert prompt == "consent", "must force consent so a NEW refresh_token is issued"
        url = (
            "https://accounts.google.com/o/oauth2/auth"
            "?client_id=TEST&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback"
            "&scope=" + "%20".join(s.split("/")[-1] for s in YOUTUBE_SCOPES)
            + f"&state={self.state}"
        )
        return url, self.state

    def fetch_token(self, authorization_response=None, code=None):
        if self._exchange is None:
            raise AssertionError("no exchange handler configured for this test flow")
        self.credentials = self._exchange(authorization_response or code)


def make_service(creds=None, refresh=None, exchange=None,
                 validate_data=None, validate_analytics=None):
    """Build a YouTubeOAuthService with injected fakes."""
    creds_store = InMemoryCredsStore(initial=creds)
    pending_store = InMemoryPendingStore()
    status_store = InMemoryStatusStore()
    flows = {}

    def create_flow(state=None):
        flow = FakeFlow(state=state or "STATE-FRESH-1", exchange=exchange)
        flows[state or "NEW"] = flow
        return flow

    service = YouTubeOAuthService(
        creds_store=creds_store,
        pending_store=pending_store,
        status_store=status_store,
        refresh_credentials=refresh or (lambda c: (_ for _ in ()).throw(AssertionError("unexpected refresh"))),
        create_flow=create_flow,
        validate_data_api=validate_data or (lambda c: {"channelTitle": "NappaVT", "videos": 42}),
        validate_analytics_api=validate_analytics or (lambda c: None),
        logger=logging.getLogger("test-youtube-oauth"),
    )
    return service, creds_store, pending_store, status_store, flows


class QuietLogging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logging.disable(logging.CRITICAL)

    @classmethod
    def tearDownClass(cls):
        logging.disable(logging.NOTSET)


# ---------------------------------------------------------------------------
# The exact reported scenario
# ---------------------------------------------------------------------------

class TestExactReportedScenario(QuietLogging):
    def test_begin_survives_revoked_refresh_token_and_returns_fresh_url(self):
        """Stored access expired + refresh revoked -> /youtube_connect still works."""
        old = FakeCredentials(token="access-EXPIRED", refresh_token="refresh-OLD-INVALID",
                              expired=True, valid=False)

        def refresh_dead(creds):
            raise make_invalid_grant_error()

        service, creds_store, pending_store, status_store, _ = make_service(
            creds=old, refresh=refresh_dead)

        # This is the call that USED to raise RefreshError and abort.
        result = service.begin_connect(user_id="owner")

        self.assertIsInstance(result, BeginResult)
        self.assertTrue(result.ok)
        self.assertTrue(result.auth_url.startswith("https://accounts.google.com/"),
                        f"expected fresh Google auth URL, got: {result.auth_url!r}")
        self.assertIn("state=", result.auth_url)
        self.assertTrue(result.reauth_required)
        self.assertEqual(result.previous_status, "reauth_required")
        # Status store flipped to REAUTH REQUIRED…
        self.assertFalse(status_store.record.get("connected"))
        self.assertTrue(status_store.record.get("needsReauth"))
        # …but old credentials were NOT deleted before fresh auth succeeded.
        self.assertIs(creds_store.load(), old)
        self.assertEqual(creds_store.load().refresh_token, "refresh-OLD-INVALID")
        # Pending OAuth state persisted for finish step.
        pending = pending_store.load("owner")
        self.assertIsNotNone(pending)
        self.assertTrue(pending.get("state"))

    def test_finish_replaces_old_token_and_marks_connected(self):
        """Full reconnect: begin (dead grant) -> finish (valid new auth) -> CONNECTED."""
        old = FakeCredentials(token="access-EXPIRED", refresh_token="refresh-OLD-INVALID",
                              expired=True, valid=False)
        fresh = FakeCredentials(token="access-FRESH", refresh_token="refresh-NEW-VALID",
                                expired=False, valid=True)
        data_calls, analytics_calls = [], []

        def refresh_dead(creds):
            raise make_invalid_grant_error()

        def exchange_ok(authorization_response):
            self.assertTrue(authorization_response)
            self.assertNotIn("refresh-OLD-INVALID", authorization_response)
            return fresh

        service, creds_store, pending_store, status_store, _ = make_service(
            creds=old,
            refresh=refresh_dead,
            exchange=exchange_ok,
            validate_data=lambda c: (data_calls.append(c), {"channelTitle": "NappaVT", "videos": 42})[1],
            validate_analytics=lambda c: analytics_calls.append(c),
        )

        begin = service.begin_connect(user_id="owner")
        self.assertTrue(begin.ok)
        # Simulate the user approving in Google and pasting the redirect URL.
        redirect_url = ("http://127.0.0.1:53682/callback?state="
                        + pending_store.load("owner")["state"] + "&code=NEW-AUTH-CODE&scope=youtube")
        finish = service.finish_connect(redirect_url, user_id="owner")

        self.assertTrue(finish.ok, finish.message)
        self.assertEqual(creds_store.load(), fresh)
        self.assertEqual(creds_store.load().refresh_token, "refresh-NEW-VALID")
        # Both APIs validated with the FRESH credentials.
        self.assertEqual(data_calls, [fresh])
        self.assertEqual(analytics_calls, [fresh])
        # Status is CONNECTED with channel info.
        self.assertTrue(status_store.record.get("connected"))
        self.assertFalse(status_store.record.get("needsReauth"))
        self.assertEqual(status_store.record.get("channelTitle"), "NappaVT")
        self.assertEqual(status_store.record.get("videos"), 42)
        # Pending state cleaned up.
        self.assertIsNone(pending_store.load("owner"))
        # Background calls now work with the fresh token (no refresh needed).
        self.assertIs(service.get_valid_credentials(), fresh)


# ---------------------------------------------------------------------------
# Begin-connect edge cases
# ---------------------------------------------------------------------------

class TestBeginConnectEdges(QuietLogging):
    def test_begin_with_no_stored_token(self):
        service, _, pending_store, _, _ = make_service(creds=None)
        result = service.begin_connect(user_id="owner")
        self.assertTrue(result.ok)
        self.assertIn("accounts.google.com", result.auth_url)
        self.assertEqual(result.previous_status, "not_connected")
        self.assertIsNotNone(pending_store.load("owner"))

    def test_begin_with_valid_token_still_returns_fresh_url(self):
        creds = FakeCredentials(token="access-GOOD", refresh_token="refresh-GOOD",
                                expired=False, valid=True)
        service, _, _, _, _ = make_service(creds=creds)
        result = service.begin_connect(user_id="owner")
        self.assertTrue(result.ok)
        self.assertTrue(result.already_connected)
        self.assertIn("accounts.google.com", result.auth_url,
                      "explicit reconnect must always yield a fresh URL")

    def test_begin_with_expired_but_refreshable_token(self):
        creds = FakeCredentials(token="access-OLD", refresh_token="refresh-GOOD",
                                expired=True, valid=False)

        def refresh_ok(c):
            c.token = "access-REFRESHED"
            c.expired = False
            c.valid = True

        service, creds_store, _, _, _ = make_service(creds=creds, refresh=refresh_ok)
        result = service.begin_connect(user_id="owner")
        self.assertTrue(result.ok)
        self.assertTrue(result.already_connected)
        self.assertIn("accounts.google.com", result.auth_url)
        self.assertEqual(creds_store.load().token, "access-REFRESHED")

    def test_begin_with_transient_refresh_failure_still_returns_fresh_url(self):
        """Even non-invalid_grant refresh failures must not abort reconnect."""
        creds = FakeCredentials(expired=True, valid=False)

        def refresh_flaky(c):
            raise TimeoutError("connection timed out talking to oauth2.googleapis.com")

        service, _, _, status_store, _ = make_service(creds=creds, refresh=refresh_flaky)
        result = service.begin_connect(user_id="owner")
        self.assertTrue(result.ok)
        self.assertIn("accounts.google.com", result.auth_url)
        self.assertTrue(result.reauth_required)
        self.assertTrue(status_store.record.get("needsReauth"))

    def test_begin_with_unusable_credential_object(self):
        service, _, _, _, _ = make_service(creds=object())  # no .valid/.expired
        result = service.begin_connect(user_id="owner")
        self.assertTrue(result.ok)
        self.assertIn("accounts.google.com", result.auth_url)

    def test_begin_does_not_require_old_token_for_pending_state(self):
        """Pending state from a previous aborted attempt is overwritten cleanly."""
        service, _, pending_store, _, _ = make_service(creds=None)
        pending_store.save("owner", {"state": "STALE"})
        result = service.begin_connect(user_id="owner")
        self.assertTrue(result.ok)
        self.assertNotEqual(pending_store.load("owner")["state"], "STALE")


# ---------------------------------------------------------------------------
# Finish-connect edge cases
# ---------------------------------------------------------------------------

class TestFinishConnectEdges(QuietLogging):
    def test_finish_without_begin_fails_clearly_and_keeps_old_token(self):
        old = FakeCredentials(expired=True, valid=False)
        service, creds_store, _, _, _ = make_service(creds=old)
        result = service.finish_connect("http://127.0.0.1:53682/callback?code=X", user_id="owner")
        self.assertFalse(result.ok)
        self.assertIn("/youtube_connect", result.message)
        self.assertIs(creds_store.load(), old)

    def test_finish_exchange_failure_keeps_old_token(self):
        old = FakeCredentials(expired=True, valid=False)

        def exchange_bad(authorization_response):
            raise FakeRefreshError("invalid_grant: bad auth code")

        service, creds_store, pending_store, status_store, _ = make_service(
            creds=old, refresh=lambda c: (_ for _ in ()).throw(make_invalid_grant_error()),
            exchange=exchange_bad)
        service.begin_connect(user_id="owner")
        result = service.finish_connect("http://127.0.0.1:53682/callback?code=BAD", user_id="owner")
        self.assertFalse(result.ok)
        self.assertIs(creds_store.load(), old, "old token must survive a failed exchange")
        self.assertTrue(status_store.record.get("needsReauth"))

    def test_finish_data_api_failure_reports_clearly(self):
        old = FakeCredentials(expired=True, valid=False)
        fresh = FakeCredentials(token="new", refresh_token="new-r", expired=False, valid=True)
        service, creds_store, pending_store, status_store, _ = make_service(
            creds=old,
            refresh=lambda c: (_ for _ in ()).throw(make_invalid_grant_error()),
            exchange=lambda resp: fresh,
            validate_data=lambda c: (_ for _ in ()).throw(Exception("youtube.googleapis.com: API not enabled")),
        )
        service.begin_connect(user_id="owner")
        result = service.finish_connect("http://127.0.0.1:53682/callback?code=OK", user_id="owner")
        self.assertFalse(result.ok)
        self.assertIn("Data API", result.message)
        # Fresh creds were saved (exchange succeeded) even though validation failed.
        self.assertIs(creds_store.load(), fresh)

    def test_finish_analytics_failure_reports_clearly(self):
        old = FakeCredentials(expired=True, valid=False)
        fresh = FakeCredentials(token="new", refresh_token="new-r", expired=False, valid=True)
        service, _, pending_store, _, _ = make_service(
            creds=old,
            refresh=lambda c: (_ for _ in ()).throw(make_invalid_grant_error()),
            exchange=lambda resp: fresh,
            validate_analytics=lambda c: (_ for _ in ()).throw(Exception("analytics API disabled")),
        )
        service.begin_connect(user_id="owner")
        result = service.finish_connect("http://127.0.0.1:53682/callback?code=OK", user_id="owner")
        self.assertFalse(result.ok)
        self.assertIn("Analytics", result.message)


# ---------------------------------------------------------------------------
# Normal background refresh (must NOT break)
# ---------------------------------------------------------------------------

class TestBackgroundRefresh(QuietLogging):
    def test_valid_token_used_as_is_without_refresh(self):
        creds = FakeCredentials(token="good", refresh_token="r", expired=False, valid=True)
        calls = []
        service, _, _, _, _ = make_service(creds=creds, refresh=lambda c: calls.append(c))
        self.assertIs(service.get_valid_credentials(), creds)
        self.assertEqual(calls, [])

    def test_expired_access_plus_valid_refresh_auto_refreshes(self):
        creds = FakeCredentials(token="old", refresh_token="r-good", expired=True, valid=False)

        def refresh_ok(c):
            c.token = "rotated"
            c.expired = False
            c.valid = True

        service, creds_store, _, status_store, _ = make_service(creds=creds, refresh=refresh_ok)
        out = service.get_valid_credentials()
        self.assertEqual(out.token, "rotated")
        self.assertEqual(creds_store.load().token, "rotated")
        self.assertNotEqual(status_store.record.get("needsReauth"), True)

    def test_dead_refresh_marks_reauth_and_raises(self):
        creds = FakeCredentials(expired=True, valid=False)
        service, _, _, status_store, _ = make_service(
            creds=creds, refresh=lambda c: (_ for _ in ()).throw(make_invalid_grant_error()))
        with self.assertRaises(ReauthRequired):
            service.get_valid_credentials()
        self.assertTrue(status_store.record.get("needsReauth"))
        self.assertFalse(status_store.record.get("connected"))

    def test_no_token_raises_reauth(self):
        service, _, _, _, _ = make_service(creds=None)
        with self.assertRaises(ReauthRequired):
            service.get_valid_credentials()


# ---------------------------------------------------------------------------
# Helpers / safety
# ---------------------------------------------------------------------------

class TestHelpers(QuietLogging):
    def test_invalid_grant_detection(self):
        self.assertTrue(is_invalid_grant_error(make_invalid_grant_error()))
        self.assertTrue(is_invalid_grant_error(FakeRefreshError("invalid_grant: nope")))
        self.assertTrue(is_invalid_grant_error(Exception('{"error": "invalid_grant"}')))
        self.assertTrue(is_invalid_grant_error(Exception("Token has been expired or revoked.")))
        self.assertTrue(is_invalid_grant_error(Exception("refresh token revoked")))
        self.assertFalse(is_invalid_grant_error(Exception("connection timed out")))
        self.assertFalse(is_invalid_grant_error(Exception("")))
        self.assertFalse(is_invalid_grant_error(None))

    def test_diagnostics_never_contain_token_values(self):
        creds = FakeCredentials(token="SECRET-ACCESS-123", refresh_token="SECRET-REFRESH-456")
        described = describe_credentials_for_log(creds)
        blob = str(described)
        self.assertNotIn("SECRET-ACCESS-123", blob)
        self.assertNotIn("SECRET-REFRESH-456", blob)
        self.assertTrue(described["has_refresh_token"])

    def test_youtube_scopes_are_youtube_only(self):
        self.assertEqual(len(YOUTUBE_SCOPES), 2)
        self.assertIn("https://www.googleapis.com/auth/youtube.readonly", YOUTUBE_SCOPES)
        self.assertIn("https://www.googleapis.com/auth/yt-analytics.readonly", YOUTUBE_SCOPES)
        for scope in YOUTUBE_SCOPES:
            self.assertNotIn("drive", scope, "Drive scope must never enter the YouTube flow")

    def test_fresh_flow_requests_offline_consent(self):
        """The generated URL must be capable of minting a NEW refresh token."""
        service, _, _, _, flows = make_service(creds=None)
        result = service.begin_connect(user_id="owner")
        self.assertIn("accounts.google.com", result.auth_url)
        # FakeFlow asserts offline+consent internally; reaching here means OK.
        self.assertTrue(flows)


if __name__ == "__main__":
    unittest.main(verbosity=2)
