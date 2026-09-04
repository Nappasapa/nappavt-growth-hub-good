"""
NappaVT Growth Hub — YouTube OAuth reconnect reference implementation.

TARGET: Craftnode Python Discord bot (NOT this frontend repo).
This file is a drop-in reference for the backend repo that owns:
  /youtube_connect
  /youtube_connect_finish
  background YouTube Data API + YouTube Analytics calls

BUG BEING FIXED
---------------
BUGGY /youtube_connect pattern (do NOT do this):

    creds = load_youtube_credentials()
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())   # <-- raises RefreshError invalid_grant
                                   #     when the Google account was
                                   #     disabled/restored or the grant
                                   #     was revoked, and the command
                                   #     aborts BEFORE generating a fresh
                                   #     authorization URL.
    flow = Flow.from_client_config(...)
    auth_url, state = flow.authorization_url(...)
    return auth_url

Result: the user can never get past /youtube_connect, so they can never
reach /youtube_connect_finish. The old (dead) refresh token blocks fresh
OAuth. Exactly the reported failure:

    Google token refresh failed (400):
    {"error": "invalid_grant", "error_description": "Token has been expired or revoked."}

FIXED BEHAVIOR (implemented below)
----------------------------------
/youtube_connect:
  1. Inspect existing credentials (best effort, never fatal).
  2. If valid -> note "already connected" but STILL return a fresh auth URL
     (explicit reconnect must always be possible).
  3. If expired + refresh works -> refresh opportunistically, save, but STILL
     return a fresh auth URL (so the command is idempotent).
  4. If refresh fails with invalid_grant / revoked / expired refresh token ->
     mark REAUTH REQUIRED internally, DO NOT ABORT, continue to fresh OAuth.
  5. Always generate a FRESH authorization URL (offline access + consent so a
     NEW refresh_token is issued) and persist pending OAuth state.
  6. Never delete the old stored credentials until fresh auth succeeds
     (finish step replaces them).

/youtube_connect_finish:
  1. Load pending OAuth state, exchange the NEW authorization result.
  2. Save the newly issued credentials (this replaces the old invalid
     refresh token) only after the exchange succeeds.
  3. Validate YouTube Data API access.
  4. Validate YouTube Analytics API access.
  5. Mark CONNECTED.

Background API usage (unchanged normal refresh):
  - valid token -> use it
  - expired access + valid refresh -> refresh automatically + save
  - invalid refresh (invalid_grant) -> mark REAUTH REQUIRED + raise
    ReauthRequired (caller surfaces "run /youtube_connect")

SECURITY
--------
- Never log access tokens, refresh tokens, client secrets, auth codes.
- Use describe_credentials_for_log() for diagnostics (booleans only).
- Log auth-URL generation WITHOUT logging the full URL + state verbatim
  at INFO level; the URL itself is returned to the requesting user only
  (ephemeral Discord reply).

SCOPE SPLIT (do not regress)
----------------------------
YouTube OAuth uses ONLY:
  https://www.googleapis.com/auth/youtube.readonly
  https://www.googleapis.com/auth/yt-analytics.readonly
NEVER add https://www.googleapis.com/auth/drive.file to this flow.
Google rejects combined Drive+YouTube authorization with 400 invalid_request.
Drive clip uploads use a separate browser GIS token (see frontend index.html).

USAGE
-----
Option A — use the service class directly (recommended for new code):

    from youtube_oauth import YouTubeOAuthService, FileCredsStore, ...

    service = create_production_service()
    result = service.begin_connect(user_id="owner")
    # send result.auth_url to the user (ephemeral)

Option B — adapt the two core functions into your existing handlers:
copy the try/except structure from YouTubeOAuthService.begin_connect /
finish_connect into your current /youtube_connect handlers. The critical
change is: wrap the opportunistic creds.refresh() in try/except
RefreshError + is_invalid_grant_error() and CONTINUE to fresh OAuth
instead of returning the refresh failure.

Tests: backend_reference/test_youtube_oauth_reconnect.py (stdlib unittest,
no network, no google packages required — fakes are injected).
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

YOUTUBE_SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]

YOUTUBE_STATUS_CONNECTED = "connected"
YOUTUBE_STATUS_REAUTH_REQUIRED = "reauth_required"
YOUTUBE_STATUS_NOT_CONNECTED = "not_connected"

DEFAULT_REDIRECT_URI = "http://127.0.0.1:53682/callback"

# Substrings that (case-insensitive) indicate a permanently dead grant.
# Kept in sync with the frontend youtubeConnectionState() regex in index.html.
_INVALID_GRANT_MARKERS = (
    "invalid_grant",
    "invalid grant",
    "token has been expired or revoked",
    "token has been expired",
    "token has been revoked",
    "expired or revoked",
    "revoked",
)


class ReauthRequired(Exception):
    """Raised by background helpers when the stored grant is permanently dead.

    Discord handlers should catch this and tell the user to run
    /youtube_connect -> /youtube_connect_finish. It must NEVER be raised
    out of begin_connect() — that function must always return a fresh URL.
    """


# ---------------------------------------------------------------------------
# Safe diagnostics (never log secrets)
# ---------------------------------------------------------------------------

def _safe_text(value: Any, limit: int = 300) -> str:
    try:
        text = str(value)
    except Exception:
        return "<unprintable>"
    if len(text) > limit:
        text = text[:limit] + "…"
    return text


def describe_credentials_for_log(creds: Any) -> Dict[str, Any]:
    """Booleans-only credential summary for logs. Never includes token values."""
    if creds is None:
        return {"present": False}
    try:
        return {
            "present": True,
            "has_refresh_token": bool(getattr(creds, "refresh_token", None)),
            "expired": bool(getattr(creds, "expired", None)),
            "valid": bool(getattr(creds, "valid", None)),
            "scopes": list(getattr(creds, "scopes", []) or []),
            "type": type(creds).__name__,
        }
    except Exception as exc:  # pragma: no cover - defensive
        return {"present": True, "describe_error": _safe_text(exc, 120)}


def is_invalid_grant_error(exc: BaseException) -> bool:
    """True when `exc` represents a dead/revoked Google grant.

    Handles:
      - google.auth.exceptions.RefreshError (checked by class name so this
        module imports cleanly without google-auth installed)
      - raw token-endpoint payloads: {"error": "invalid_grant", ...}
      - wrapped messages containing invalid_grant / expired / revoked
    """
    if exc is None:
        return False
    # Class-name check avoids a hard google-auth dependency at import time.
    cls_names = {c.__name__ for c in type(exc).__mro__}
    text_parts = [_safe_text(exc)]
    # google RefreshError often carries .args + .details; include them.
    details = getattr(exc, "details", None)
    if details is not None:
        text_parts.append(_safe_text(details))
    args = getattr(exc, "args", ())
    for arg in args if isinstance(args, tuple) else ():
        text_parts.append(_safe_text(arg))
    blob = " | ".join(text_parts).lower()
    if "invalid_grant" in blob or "invalid grant" in blob:
        return True
    if "refresherror" in {n.lower() for n in cls_names}:
        # A RefreshError that mentions expiry/revocation is a dead grant.
        # (Other RefreshErrors — e.g. transient network — return False so
        # callers can distinguish, but begin_connect still continues to
        # fresh OAuth for ANY refresh failure.)
        return any(m in blob for m in _INVALID_GRANT_MARKERS) or (
            "expired" in blob or "revoked" in blob
        )
    return any(m in blob for m in _INVALID_GRANT_MARKERS)


def is_retryable_refresh_error(exc: BaseException) -> bool:
    """Best-effort: True for transient refresh failures (network/5xx/429)."""
    blob = _safe_text(exc).lower()
    return any(
        marker in blob
        for marker in (
            "timeout",
            "timed out",
            "temporary",
            "temporarily",
            "try again",
            "500",
            "502",
            "503",
            "504",
            "429",
            "rate",
            "network",
            "connection",
            "unavailable",
        )
    )


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class BeginResult:
    """Outcome of /youtube_connect. `ok` is ALWAYS True — even when the old
    grant is dead — because a fresh authorization URL is always produced."""

    ok: bool = True
    auth_url: str = ""
    previous_status: str = YOUTUBE_STATUS_NOT_CONNECTED
    already_connected: bool = False
    reauth_required: bool = False
    message: str = ""


@dataclass(frozen=True)
class FinishResult:
    ok: bool
    message: str
    channel_title: str = ""
    videos: int = 0
    error: str = ""


# ---------------------------------------------------------------------------
# Storage interfaces (duck-typed; file implementations below)
# ---------------------------------------------------------------------------

class CredsStore:
    """Persisted YouTube OAuth credentials (refresh token lives here)."""

    def load(self) -> Optional[Any]:
        raise NotImplementedError

    def save(self, creds: Any) -> None:
        raise NotImplementedError


class PendingStateStore:
    """Pending OAuth flow state between begin_connect and finish_connect."""

    def save(self, user_id: str, payload: Dict[str, Any]) -> None:
        raise NotImplementedError

    def load(self, user_id: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def clear(self, user_id: str) -> None:
        raise NotImplementedError


class StatusStore:
    """Connection status surfaced to the dashboard (socialConnections.youtube)."""

    def mark_reauth(self, reason: str) -> None:
        raise NotImplementedError

    def mark_connected(self, info: Dict[str, Any]) -> None:
        raise NotImplementedError

    def mark_error(self, error: str) -> None:
        raise NotImplementedError


class InMemoryCredsStore(CredsStore):
    def __init__(self, initial: Optional[Any] = None):
        self._creds = initial

    def load(self) -> Optional[Any]:
        return self._creds

    def save(self, creds: Any) -> None:
        self._creds = creds


class InMemoryPendingStore(PendingStateStore):
    def __init__(self):
        self._data: Dict[str, Dict[str, Any]] = {}

    def save(self, user_id: str, payload: Dict[str, Any]) -> None:
        self._data[str(user_id)] = dict(payload)

    def load(self, user_id: str) -> Optional[Dict[str, Any]]:
        payload = self._data.get(str(user_id))
        return dict(payload) if payload is not None else None

    def clear(self, user_id: str) -> None:
        self._data.pop(str(user_id), None)


class InMemoryStatusStore(StatusStore):
    """Test double mirroring the dashboard `socialConnections.youtube` shape."""

    def __init__(self):
        self.record: Dict[str, Any] = {}

    def mark_reauth(self, reason: str) -> None:
        self.record = {
            "connected": False,
            "configured": True,
            "needsReauth": True,
            "error": reason,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    def mark_connected(self, info: Dict[str, Any]) -> None:
        self.record = {
            "connected": True,
            "configured": True,
            "needsReauth": False,
            "error": "",
            "channelTitle": info.get("channelTitle", ""),
            "videos": int(info.get("videos", 0) or 0),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    def mark_error(self, error: str) -> None:
        self.record = {
            "connected": False,
            "configured": True,
            "needsReauth": False,
            "error": error,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }


class FileCredsStore(CredsStore):
    """Private runtime file (gitignored). Never commit this file.

    Stores google.oauth2.credentials.Credentials via its to_json()/from
    from_authorized_user_info() round-trip. Import of google-auth is lazy
    so unit tests run without the dependency installed.
    """

    def __init__(self, path: str):
        self.path = path

    def load(self) -> Optional[Any]:
        if not os.path.exists(self.path):
            return None
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                info = json.load(fh)
        except (OSError, ValueError):
            return None
        try:
            from google.oauth2.credentials import Credentials  # type: ignore

            return Credentials.from_authorized_user_info(info, scopes=YOUTUBE_SCOPES)
        except Exception:
            return None

    def save(self, creds: Any) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(creds.to_json())
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)


class FilePendingStore(PendingStateStore):
    """Private runtime JSON file holding pending OAuth state per user."""

    def __init__(self, path: str):
        self.path = path

    def _read_all(self) -> Dict[str, Any]:
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_all(self, data: Dict[str, Any]) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    def save(self, user_id: str, payload: Dict[str, Any]) -> None:
        data = self._read_all()
        data[str(user_id)] = dict(payload)
        self._write_all(data)

    def load(self, user_id: str) -> Optional[Dict[str, Any]]:
        payload = self._read_all().get(str(user_id))
        return dict(payload) if isinstance(payload, dict) else None

    def clear(self, user_id: str) -> None:
        data = self._read_all()
        if str(user_id) in data:
            del data[str(user_id)]
            self._write_all(data)


# ---------------------------------------------------------------------------
# Production helpers (lazy google imports)
# ---------------------------------------------------------------------------

def get_client_config_from_env() -> Dict[str, Any]:
    """Build the google Flow client_config from Craftnode env vars."""
    client_id = os.environ.get("YOUTUBE_CLIENT_ID", "").strip()
    client_secret = os.environ.get("YOUTUBE_CLIENT_SECRET", "").strip()
    redirect_uri = os.environ.get("YOUTUBE_REDIRECT_URI", DEFAULT_REDIRECT_URI).strip()
    if not client_id or not client_secret:
        raise RuntimeError(
            "YouTube OAuth is not configured: set YOUTUBE_CLIENT_ID and "
            "YOUTUBE_CLIENT_SECRET on Craftnode."
        )
    return {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [redirect_uri],
        },
        "redirect_uri": redirect_uri,
    }


def default_refresh_credentials(creds: Any) -> None:
    """Production refresh: creds.refresh(Request()). Raises RefreshError."""
    from google.auth.transport.requests import Request  # type: ignore

    creds.refresh(Request())


def default_create_flow(state: Optional[str] = None) -> Any:
    """Production Flow factory. Never mixes Drive scope into YouTube OAuth."""
    from google_auth_oauthlib.flow import Flow  # type: ignore

    config = get_client_config_from_env()
    return Flow.from_client_config(
        {"web": config["web"]},
        scopes=YOUTUBE_SCOPES,
        state=state,
        redirect_uri=config["redirect_uri"],
    )


def default_generate_auth_url(flow: Any) -> Tuple[str, str]:
    """Return (auth_url, state). offline+consent => fresh refresh_token."""
    auth_url, state = flow.authorization_url(
        access_type="offline",
        prompt="consent",
        include_granted_scopes="false",
    )
    return auth_url, state


def default_validate_youtube_data_api(creds: Any) -> Dict[str, Any]:
    """Lightweight YouTube Data API v3 check: channels.list(mine=True)."""
    from googleapiclient.discovery import build  # type: ignore

    service = build("youtube", "v3", credentials=creds, cache_discovery=False)
    response = (
        service.channels().list(part="snippet,statistics", mine=True).execute()
    )
    items = response.get("items", []) if isinstance(response, dict) else []
    channel_title = ""
    videos = 0
    if items:
        snippet = items[0].get("snippet", {}) or {}
        stats = items[0].get("statistics", {}) or {}
        channel_title = str(snippet.get("title", "") or "")
        try:
            videos = int(stats.get("videoCount", 0) or 0)
        except (TypeError, ValueError):
            videos = 0
    return {"channelTitle": channel_title, "videos": videos}


def default_validate_youtube_analytics_api(creds: Any) -> None:
    """Lightweight YouTube Analytics API check (read-only, cheap query)."""
    from googleapiclient.discovery import build  # type: ignore

    service = build("youtubeAnalytics", "v2", credentials=creds, cache_discovery=False)
    # Minimal query: channel reports for the last 7 days. Any successful
    # response (even zero rows) proves Analytics access.
    import datetime as _dt

    end = _dt.date.today()
    start = end - _dt.timedelta(days=7)
    service.reports().query(
        ids="channel==MINE",
        startDate=start.isoformat(),
        endDate=end.isoformat(),
        metrics="views",
    ).execute()


# ---------------------------------------------------------------------------
# Core service — the actual fix lives here
# ---------------------------------------------------------------------------

@dataclass
class YouTubeOAuthService:
    """Framework-agnostic YouTube OAuth core.

    Discord handlers should be thin wrappers around begin_connect() /
    finish_connect() / get_valid_credentials(). Inject fakes in tests.
    """

    creds_store: CredsStore
    pending_store: PendingStateStore
    status_store: StatusStore
    refresh_credentials: Callable[[Any], None] = default_refresh_credentials
    create_flow: Callable[[Optional[str]], Any] = default_create_flow
    generate_auth_url: Callable[[Any], Tuple[str, str]] = default_generate_auth_url
    validate_data_api: Callable[[Any], Dict[str, Any]] = default_validate_youtube_data_api
    validate_analytics_api: Callable[[Any], None] = default_validate_youtube_analytics_api
    logger: logging.Logger = field(default_factory=lambda: logging.getLogger("youtube_oauth"))

    # -- /youtube_connect -------------------------------------------------
    def begin_connect(self, user_id: str = "owner") -> BeginResult:
        """Start (or restart) a FRESH YouTube OAuth flow.

        NEVER raises for invalid_grant / revoked / expired refresh tokens.
        ALWAYS returns a fresh authorization URL.
        """
        log = self.logger
        previous_status = YOUTUBE_STATUS_NOT_CONNECTED
        already_connected = False
        reauth_required = False

        # 1-2. Best-effort inspection of existing credentials. Every failure
        # mode below FALLS THROUGH to fresh OAuth — nothing here may abort.
        try:
            creds = self.creds_store.load()
        except Exception as exc:  # storage failure must not block reconnect
            log.warning("youtube begin: credential load failed (%s); continuing to fresh OAuth",
                        _safe_text(exc, 150))
            creds = None

        if creds is not None:
            log.info("youtube begin: inspecting stored credentials: %s",
                     describe_credentials_for_log(creds))
            try:
                valid = bool(getattr(creds, "valid", False))
                expired = bool(getattr(creds, "expired", False))
                has_refresh = bool(getattr(creds, "refresh_token", None))
            except Exception:
                valid, expired, has_refresh = False, False, False

            if valid and not expired:
                previous_status = YOUTUBE_STATUS_CONNECTED
                already_connected = True
            elif expired and has_refresh:
                # 3-5. Opportunistic refresh. Success => note it; ANY
                # failure => mark REAUTH REQUIRED and CONTINUE to fresh OAuth.
                try:
                    self.refresh_credentials(creds)
                except Exception as exc:
                    reauth_required = is_invalid_grant_error(exc)
                    reason = (
                        "YouTube authorization expired (invalid_grant: stored "
                        "refresh token was revoked or expired). Reconnect required."
                        if reauth_required
                        else f"YouTube token refresh failed ({_safe_text(exc, 150)}). "
                             "Reconnect required."
                    )
                    log.warning("youtube begin: opportunistic refresh failed "
                                "(invalid_grant=%s); continuing to fresh OAuth",
                                reauth_required)
                    try:
                        self.status_store.mark_reauth(reason)
                    except Exception as store_exc:
                        log.warning("youtube begin: mark_reauth failed: %s",
                                    _safe_text(store_exc, 150))
                    previous_status = YOUTUBE_STATUS_REAUTH_REQUIRED
                    reauth_required = True
                else:
                    try:
                        self.creds_store.save(creds)
                    except Exception as exc:
                        log.warning("youtube begin: could not persist refreshed token: %s",
                                    _safe_text(exc, 150))
                    previous_status = YOUTUBE_STATUS_CONNECTED
                    already_connected = True
                    log.info("youtube begin: opportunistic refresh succeeded")
            elif expired and not has_refresh:
                previous_status = YOUTUBE_STATUS_REAUTH_REQUIRED
                reauth_required = True
                try:
                    self.status_store.mark_reauth(
                        "YouTube authorization expired (no refresh token stored). "
                        "Reconnect required."
                    )
                except Exception:
                    pass
            else:
                # Unusable credential object (missing fields, wrong type…).
                previous_status = YOUTUBE_STATUS_REAUTH_REQUIRED
                reauth_required = True
        else:
            log.info("youtube begin: no stored credentials; starting fresh OAuth")

        # IMPORTANT: old credentials are deliberately LEFT IN PLACE here.
        # They are replaced only after fresh authorization succeeds in
        # finish_connect(). A dead stored token must never block this step.

        # 6-8. ALWAYS generate a completely fresh authorization URL.
        try:
            flow = self.create_flow(None)
            auth_url, state = self.generate_auth_url(flow)
        except RuntimeError:
            raise  # missing YOUTUBE_CLIENT_ID/SECRET is a real config error
        except Exception as exc:
            log.error("youtube begin: could not generate authorization URL: %s",
                      _safe_text(exc, 200))
            raise RuntimeError(
                "Could not start YouTube authorization "
                f"({_safe_text(exc, 150)}). Check YOUTUBE_CLIENT_ID / "
                "YOUTUBE_CLIENT_SECRET and the redirect URI."
            ) from exc

        try:
            self.pending_store.save(str(user_id), {"state": state})
        except Exception as exc:
            log.warning("youtube begin: could not persist pending OAuth state: %s",
                        _safe_text(exc, 150))
            # Continue anyway: the URL is still usable if the bot keeps the
            # state in memory; finish_connect will report clearly if missing.

        log.info("youtube begin: generated fresh authorization URL "
                 "(previous_status=%s reauth_required=%s)",
                 previous_status, reauth_required)
        if already_connected:
            message = (
                "YouTube already looks connected, but here is a fresh "
                "authorization link anyway (use it to reconnect / switch "
                "accounts). After approving in Google, run /youtube_connect_finish."
            )
        elif reauth_required:
            message = (
                "Stored YouTube authorization is expired or revoked (REAUTH "
                "REQUIRED). Use this fresh Google authorization link, then run "
                "/youtube_connect_finish."
            )
        else:
            message = (
                "Use this Google authorization link to connect YouTube "
                "(read-only + analytics), then run /youtube_connect_finish."
            )
        return BeginResult(
            ok=True,
            auth_url=auth_url,
            previous_status=previous_status,
            already_connected=already_connected,
            reauth_required=reauth_required,
            message=message,
        )

    # -- /youtube_connect_finish ------------------------------------------
    def finish_connect(
        self,
        authorization_response: str,
        user_id: str = "owner",
    ) -> FinishResult:
        """Exchange the NEW authorization result and store fresh credentials.

        The old refresh token is replaced ONLY after the exchange succeeds.
        """
        log = self.logger
        if not authorization_response or not str(authorization_response).strip():
            return FinishResult(
                ok=False,
                message="No authorization result was provided.",
                error="missing authorization response",
            )

        pending = None
        try:
            pending = self.pending_store.load(str(user_id))
        except Exception as exc:
            log.warning("youtube finish: pending-state load failed: %s",
                        _safe_text(exc, 150))
        state = (pending or {}).get("state") if isinstance(pending, dict) else None
        if not state:
            return FinishResult(
                ok=False,
                message="No pending YouTube authorization was found. Run "
                        "/youtube_connect first and approve the fresh link.",
                error="missing pending OAuth state",
            )

        # 1. Exchange the NEW authorization result.
        try:
            flow = self.create_flow(state)
            # google-auth-oauthlib accepts the full redirect URL…
            try:
                flow.fetch_token(authorization_response=str(authorization_response).strip())
            except TypeError:
                # …older/alternate signatures accept code= instead.
                flow.fetch_token(code=str(authorization_response).strip())
            new_creds = flow.credentials
        except Exception as exc:
            # Exchange failed => old stored credentials are LEFT UNTOUCHED.
            log.warning("youtube finish: token exchange failed: %s", _safe_text(exc, 200))
            try:
                self.status_store.mark_reauth(
                    f"YouTube authorization exchange failed ({_safe_text(exc, 150)}). "
                    "Run /youtube_connect for a fresh link."
                )
            except Exception:
                pass
            return FinishResult(
                ok=False,
                message="Google authorization exchange failed. Run /youtube_connect "
                        "for a fresh link and try /youtube_connect_finish again.",
                error=_safe_text(exc, 200),
            )

        # 2. Replace the old invalid refresh token with the fresh credentials.
        try:
            self.creds_store.save(new_creds)
        except Exception as exc:
            log.error("youtube finish: could not persist fresh credentials: %s",
                      _safe_text(exc, 200))
            return FinishResult(
                ok=False,
                message="Google approved access but the bot could not save the new "
                        "credentials. Check bot storage/permissions and retry.",
                error=_safe_text(exc, 200),
            )

        # Pending state has served its purpose; best-effort cleanup.
        try:
            self.pending_store.clear(str(user_id))
        except Exception:
            pass

        # 3-4. Validate both APIs with the FRESH credentials.
        channel_title = ""
        videos = 0
        try:
            info = self.validate_data_api(new_creds) or {}
            channel_title = str(info.get("channelTitle", "") or "")
            videos = int(info.get("videos", 0) or 0)
        except Exception as exc:
            log.warning("youtube finish: Data API validation failed: %s",
                        _safe_text(exc, 200))
            try:
                self.status_store.mark_error(
                    f"YouTube connected but Data API check failed ({_safe_text(exc, 150)}). "
                    "Enable YouTube Data API v3 for the Craftnode OAuth client."
                )
            except Exception:
                pass
            return FinishResult(
                ok=False,
                message="Google authorization saved, but the YouTube Data API check "
                        "failed. Enable YouTube Data API v3, then run /youtube_connect "
                        "again.",
                error=_safe_text(exc, 200),
            )
        try:
            self.validate_analytics_api(new_creds)
        except Exception as exc:
            log.warning("youtube finish: Analytics API validation failed: %s",
                        _safe_text(exc, 200))
            try:
                self.status_store.mark_error(
                    f"YouTube connected but Analytics API check failed ({_safe_text(exc, 150)}). "
                    "Enable YouTube Analytics API for the Craftnode OAuth client."
                )
            except Exception:
                pass
            return FinishResult(
                ok=False,
                message="Google authorization saved, but the YouTube Analytics API "
                        "check failed. Enable YouTube Analytics API, then run "
                        "/youtube_connect again.",
                error=_safe_text(exc, 200),
            )

        # 5. Mark CONNECTED.
        try:
            self.status_store.mark_connected(
                {"channelTitle": channel_title, "videos": videos}
            )
        except Exception as exc:
            log.warning("youtube finish: mark_connected failed: %s", _safe_text(exc, 150))
        log.info("youtube finish: CONNECTED (channel=%s videos=%s)",
                 _safe_text(channel_title, 80), videos)
        return FinishResult(
            ok=True,
            message=f"YouTube connected ✓ ({channel_title or 'channel'} · "
                    f"{videos} uploads). Analytics will sync in the background.",
            channel_title=channel_title,
            videos=videos,
        )

    # -- background API usage ----------------------------------------------
    def get_valid_credentials(self) -> Any:
        """Return usable credentials for background YouTube calls.

        - valid token -> returned as-is
        - expired access + working refresh -> refreshed, saved, returned
        - dead refresh (invalid_grant) -> REAUTH REQUIRED + ReauthRequired
        """
        log = self.logger
        creds = self.creds_store.load()
        if creds is None:
            raise ReauthRequired("YouTube is not connected. Run /youtube_connect.")
        if bool(getattr(creds, "valid", False)) and not bool(getattr(creds, "expired", False)):
            return creds
        if bool(getattr(creds, "expired", False)) and bool(getattr(creds, "refresh_token", None)):
            try:
                self.refresh_credentials(creds)
            except Exception as exc:
                if is_invalid_grant_error(exc):
                    reason = ("YouTube authorization expired (invalid_grant). "
                              "Run /youtube_connect → /youtube_connect_finish.")
                    try:
                        self.status_store.mark_reauth(reason)
                    except Exception:
                        pass
                    log.warning("youtube background: refresh token dead (invalid_grant); "
                                "marked REAUTH REQUIRED")
                    raise ReauthRequired(reason) from exc
                if is_retryable_refresh_error(exc):
                    log.warning("youtube background: transient refresh failure: %s",
                                _safe_text(exc, 150))
                    raise
                # Unknown refresh failure: surface it, but ALSO flag reauth so
                # the dashboard stops showing a stale CONNECTED badge.
                try:
                    self.status_store.mark_reauth(
                        f"YouTube token refresh failed ({_safe_text(exc, 150)}). "
                        "Run /youtube_connect → /youtube_connect_finish."
                    )
                except Exception:
                    pass
                raise ReauthRequired(
                    f"YouTube token refresh failed ({_safe_text(exc, 150)}). "
                    "Run /youtube_connect → /youtube_connect_finish."
                ) from exc
            try:
                self.creds_store.save(creds)
            except Exception as exc:
                log.warning("youtube background: refreshed but save failed: %s",
                            _safe_text(exc, 150))
            return creds
        # No refresh path available.
        reason = "YouTube authorization is missing or expired. Run /youtube_connect."
        try:
            self.status_store.mark_reauth(reason)
        except Exception:
            pass
        raise ReauthRequired(reason)


# ---------------------------------------------------------------------------
# Production wiring helpers
# ---------------------------------------------------------------------------

def default_creds_path() -> str:
    base = os.environ.get("YOUTUBE_TOKEN_PATH", "").strip()
    if base:
        return base
    # Private runtime location next to the bot (must be gitignored).
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, ".runtime", "youtube_token.json")


def default_pending_path() -> str:
    base = os.environ.get("YOUTUBE_PENDING_PATH", "").strip()
    if base:
        return base
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, ".runtime", "youtube_pending.json")


def create_production_service(
    status_store: StatusStore,
    creds_path: Optional[str] = None,
    pending_path: Optional[str] = None,
    logger: Optional[logging.Logger] = None,
) -> YouTubeOAuthService:
    """Build a production YouTubeOAuthService with file-backed storage.

    `status_store` must update dashboard_state.state.socialConnections.youtube
    (see docs/YOUTUBE_OAUTH_RECONNECT_FIX.md for the Supabase snippet).
    """
    return YouTubeOAuthService(
        creds_store=FileCredsStore(creds_path or default_creds_path()),
        pending_store=FilePendingStore(pending_path or default_pending_path()),
        status_store=status_store,
        logger=logger or logging.getLogger("youtube_oauth"),
    )


# ---------------------------------------------------------------------------
# Example Discord handlers (adapt to your bot's framework)
# ---------------------------------------------------------------------------
#
# The handlers below are intentionally written against a minimal
# `interaction` duck-type (defer/followup) so they work with discord.py
# (app_commands), py-cord, or nextcord with small renames. Copy the
# try/except SHAPE into your existing commands — especially the fact that
# /youtube_connect has NO bare creds.refresh() outside try/except.
#
# ---- discord.py sketch -----------------------------------------------
# import discord
# from discord import app_commands
#
# youtube_service = create_production_service(SupabaseYouTubeStatusStore(...))
#
# @bot.tree.command(name="youtube_connect", description="Connect YouTube analytics (read-only)")
# @app_commands.checks.has_permissions(administrator=True)  # or your owner check
# async def youtube_connect(interaction: discord.Interaction):
#     await interaction.response.defer(ephemeral=True)
#     try:
#         result = youtube_service.begin_connect(user_id=str(interaction.user.id))
#     except RuntimeError as exc:  # missing client id/secret, URL build failure
#         await interaction.followup.send(f"❌ {exc}", ephemeral=True)
#         return
#     # NOTE: no RefreshError can escape begin_connect() — invalid_grant is
#     # handled internally and ALWAYS yields a fresh URL.
#     await interaction.followup.send(
#         f"{result.message}\n\n🔗 {result.auth_url}\n\n"
#         "After approving in Google, run /youtube_connect_finish.",
#         ephemeral=True,
#     )
#
# @bot.tree.command(name="youtube_connect_finish", description="Finish YouTube connection after Google approval")
# async def youtube_connect_finish(interaction: discord.Interaction, redirect_url: str):
#     await interaction.response.defer(ephemeral=True)
#     result = youtube_service.finish_connect(redirect_url.strip(), user_id=str(interaction.user.id))
#     await interaction.followup.send(
#         ("✅ " if result.ok else "❌ ") + result.message, ephemeral=True
#     )
# ---------------------------------------------------------------------------
