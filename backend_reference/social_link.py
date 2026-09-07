"""
NappaVT Growth Hub — manual social-link fix (canonical URLs + refresh contract).

TARGET: Craftnode Python Discord bot (NOT this frontend repo).
This file is the portable reference half of the "manually linking a video to
track the stats isn't working, especially for YouTube links" fix. It mirrors,
character for character in behaviour, the canonicalization helpers that now
ship in the dashboard (`index.html`, "MANUAL SOCIAL LINK FIX" block) so both
layers agree on exactly one URL shape per platform.

BUG BEING FIXED (summary)
-------------------------
The dashboard used to store a manual link VERBATIM (whatever the user pasted:
youtu.be/..., /shorts/..., /embed/..., music/mobile links, share-sheet
?si/&list/&t params) and gave zero feedback. Depending on how the bot parsed
URLs, most real-world YouTube pastes ended in a silent "stats never appear"
state. The dashboard now canonicalizes and validates before saving, shows
"waiting for Nappa Bot stats" until analytics arrive, and unlinks on blank.

WHAT THE BOT MUST DO AFTER DEPLOYING THIS REFERENCE
---------------------------------------------------
1. When the workspace state has socialRefreshRequested == true (the dashboard
   sets it when the owner links/unlinks a video), walk state["queue"].
2. For each queue record with a stored manual link
   (record["manualSocialLinks"][platform]) use manual_link_needs_refresh() to
   decide whether stats are still owed. If yes, resolve stats for the
   canonical URL (Data API/Analytics for YouTube; the existing per-platform
   stats fetcher for TikTok/Instagram) and store them with
   upsert_manual_analytics(). If the video cannot be found / is not owned /
   the API refuses, do NOT write fake zeros: surface a truthful error in
   state["socialSyncStatus"]["error"] and leave socialAnalytics unset so the
   dashboard keeps showing "waiting for Nappa Bot stats".
3. Preserve unknown JSON fields on every write (read-modify-write of the whole
   state JSON). manualSocialLinks and manualLinkRequestedAt are OWNER-owned:
   the bot must never write, move, or clear them.

DO NOT WRITE from the bot into queue records: manualSocialLinks,
manualLinkRequestedAt. Only these bot-owned keys are merged back by the
dashboard mergeBotSocialFields() whitelist:
    socialAnalytics, socialMatch, socialMatchSuggestions, rejectedSocialIds
Write-back shape for one manually linked post (camelCase, same values the
automatic matcher already produces, plus matchedBy/url overrides):

    queue_record["socialAnalytics"]["youtube"] = {
        "views": 1234, "likes": 56, "comments": 4, "shares": 1,
        "title": "video title", "url": "<canonical url>",
        "publishedAt": "2026-09-01T00:00:00Z",
        # youtube only:
        "averageViewPercentage": 62.5, "subscribersGained": 3,
        # instagram only:
        "reach": 8000, "saved": 40,
        "matchedBy": "manual",          # exactly this value
        "matchConfidence": 1,           # a confirmed manual link is 100%
        "matchEvidence": {}
    }

The dashboard renders metricNumber() of views/likes/comments/shares,
averageViewPercentage + subscribersGained for youtube, reach + saved for
instagram. Numbers must be numbers (not strings).

Stdlib only. No network. No third-party imports (the bot supplies its own
HTTP/API layer and calls the pure functions here).
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional

# ---------------------------------------------------------------------------
# Canonical URL semantics — MUST stay in lockstep with index.html
# ---------------------------------------------------------------------------

YOUTUBE_CANONICAL_TEMPLATE = "https://www.youtube.com/watch?v={video_id}"
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

# /shorts/ /embed/ /live/ /v/ /e/ /watch/<id> path forms (11-char ids).
_YOUTUBE_PATH_ID_RE = re.compile(
    r"/(?:shorts|embed|live|v|e|watch)/([A-Za-z0-9_-]{11})(?:[/?#]|$)", re.I
)
_YOUTUBE_BE_RE = re.compile(r"\byoutu\.be/([A-Za-z0-9_-]{11})(?:[/?#]|$)", re.I)
_YOUTUBE_VPARAM_RE = re.compile(r"(?:^|[?&#])v=([A-Za-z0-9_-]{11})(?:$|[&#])", re.I)
_YOUTUBE_HOST_SUFFIX_RE = re.compile(r"(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com)$")


class ManualLinkError(ValueError):
    """Raised when a pasted link cannot be canonicalized for a platform.

    A ManualLinkError with an empty message means "blank input" — callers
    treat it as "remove the link" (the dashboard never stores blanks)."""


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _strip_markdown_wrappers(value: str) -> str:
    value = value.strip()
    if value.startswith("<") and value.endswith(">"):
        value = value[1:-1].strip()
    return value


def _youtube_host_hint(value: str) -> bool:
    """Domain-boundary host check (www/m/music/mobile subdomains OK; a host
    like 'notyoutube.com' must NEVER pass)."""
    match = re.match(r"^[a-z][a-z0-9+.\-]*://([^/?#]+)", value, re.I)
    host = match.group(1).lower() if match else re.sub(r"^([^/?#:]+).*$", r"\1", value).lower()
    return bool(_YOUTUBE_HOST_SUFFIX_RE.search(host))


def youtube_video_id(raw: Any) -> Optional[str]:
    """Return the 11-character video id for any real-world YouTube URL, or
    None when the input is not a YouTube link."""
    value = _strip_markdown_wrappers(_text(raw))
    if not value:
        return None
    if YOUTUBE_ID_RE.match(value):
        return value  # bare video id
    if not _youtube_host_hint(value):
        return None  # never trust a foreign host with a ?v= lookalike
    match = _YOUTUBE_BE_RE.search(value)
    if match:
        return match.group(1)
    match = _YOUTUBE_VPARAM_RE.search(value)
    if match:
        return match.group(1)
    match = _YOUTUBE_PATH_ID_RE.search(value)
    if match:
        return match.group(1)
    return None


def canonical_youtube_url(raw: Any) -> Optional[str]:
    value = _text(raw).strip()
    if not value:
        return None
    video_id = youtube_video_id(value)
    if not video_id:
        return None
    return YOUTUBE_CANONICAL_TEMPLATE.format(video_id=video_id)


def _media_host(raw: Any) -> str:
    match = re.match(r"^[a-z][a-z0-9+.\-]*://([^/?#]+)", _text(raw), re.I)
    if not match:
        return ""
    host = match.group(1).lower()
    # Anchored, like the JS mediaHost() helper: "www."/"m." subdomain prefixes
    # only. An unanchored replace would eat the "m." inside instagram.com or
    # vm.tiktok.com.
    host = re.sub(r"^www\.", "", host, count=1)
    host = re.sub(r"^m\.", "", host, count=1)
    return host


def _strip_query_fragment(raw: Any) -> str:
    return _text(raw).split("?", 1)[0].split("#", 1)[0].rstrip("/")


def canonical_tiktok_url(raw: Any) -> str:
    """Canonical TikTok URL or raise ManualLinkError."""
    value = _text(raw).strip()
    if not value:
        raise ManualLinkError("")
    host = _media_host(value)
    if not host:
        raise ManualLinkError(
            "Paste the full TikTok link (https://www.tiktok.com/@user/video/… "
            "or a https://vm.tiktok.com/… share link)."
        )
    if host in ("vm.tiktok.com", "vt.tiktok.com"):
        match = re.search(r"/([A-Za-z0-9]+)/?$", value.split("?", 1)[0].split("#", 1)[0])
        if not match:
            raise ManualLinkError("That vm.tiktok.com share link does not contain a video code.")
        return "https://vm.tiktok.com/{}/".format(match.group(1))
    if host != "tiktok.com":
        raise ManualLinkError("That link is not a TikTok link.")
    path = re.sub(r"^https?://(?:www\.)?tiktok\.com", "", _strip_query_fragment(value), flags=re.I)
    if not re.search(r"/video/", path, re.I):
        raise ManualLinkError(
            "That TikTok link does not point at a video page (expected /@user/video/<id>)."
        )
    return _strip_query_fragment(value)


def canonical_instagram_url(raw: Any) -> str:
    """Canonical Instagram Reel/post URL or raise ManualLinkError."""
    value = _text(raw).strip()
    if not value:
        raise ManualLinkError("")
    host = _media_host(value)
    if host != "instagram.com":
        raise ManualLinkError("That link is not an Instagram link (expected instagram.com/reel/…).")
    path = re.sub(
        r"^https?://(?:www\.)?instagram\.com", "", _strip_query_fragment(value), flags=re.I
    )
    # Real shortcodes are ~11 base64url chars; {8,} keeps words such as
    # "reels/audio/…" from being misread as a post shortcode.
    match = re.search(r"/(?:reel|reels|p)/([A-Za-z0-9_-]{8,})(?:[/?#]|$)", path)
    if not match:
        raise ManualLinkError(
            "That Instagram link does not contain a Reel/post shortcode "
            "(expected instagram.com/reel/<code>)."
        )
    kind = "p" if re.search(r"/p/", path) else "reel"
    return "https://www.instagram.com/{}/{}".format(kind, match.group(1))


def canonical_social_link(platform: str, raw: Any) -> str:
    """Canonical URL for a manual link, or raise ManualLinkError.

    Blank input raises ManualLinkError("") so callers can treat it as
    "remove the link"."""
    platform = str(platform or "").strip().lower()
    value = _text(raw).strip()
    if not value:
        raise ManualLinkError("")
    if platform == "youtube":
        canonical = canonical_youtube_url(value)
        if not canonical:
            raise ManualLinkError(
                "That does not look like a YouTube video link. Accepted: "
                "youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…, "
                "or a plain 11-character video ID."
            )
        return canonical
    if platform == "tiktok":
        return canonical_tiktok_url(value)
    if platform == "instagram":
        return canonical_instagram_url(value)
    return value  # unknown platform: leave untouched for the caller to judge


# ---------------------------------------------------------------------------
# Queue-record helpers — the bot-facing contract
# ---------------------------------------------------------------------------

BOT_OWNED_QUEUE_KEYS = ("socialAnalytics", "socialMatch", "socialMatchSuggestions", "rejectedSocialIds")
PLATFORMS = ("youtube", "tiktok", "instagram")
PLATFORM_NAMES = {"youtube": "YouTube", "tiktok": "TikTok", "instagram": "Instagram"}


def get_manual_social_link(record: Dict[str, Any], platform: str) -> str:
    links = record.get("manualSocialLinks") if isinstance(record, dict) else None
    if not isinstance(links, dict):
        return ""
    value = links.get(platform)
    return "" if value is None else str(value).strip()


def manual_link_needs_refresh(record: Dict[str, Any], platform: str) -> bool:
    """True when the dashboard is still owed analytics for a stored link.

    Mirrors the frontend manualSocialLinkState(): a stored link with no
    socialAnalytics[platform] is waiting; if a manual record exists but its
    url differs from the stored link, the owner changed the link and the old
    numbers must be replaced."""
    url = get_manual_social_link(record, platform)
    if not url:
        return False
    root = record.get("socialAnalytics")
    existing = root.get(platform) if isinstance(root, dict) else None
    if not isinstance(existing, dict):
        return True
    if str(existing.get("matchedBy") or "") == "manual":
        return str(existing.get("url") or "").strip() != url
    # A same-platform record from automatic matching exists; honour the
    # explicit manual link only when it points at a different video.
    existing_url = str(existing.get("url") or "").strip()
    return bool(existing_url) and existing_url != url


def manual_link_jobs(queue: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every stored manual link that still needs a stats refresh, as jobs.

    Each job: {queue_id, platform, name, url}. queue_id is the record id
    stringified for lookup. URLs created after the frontend fix are already
    canonical; legacy raw links are best-effort resolved through
    canonical_social_link() first and kept raw when unresolvable so the fetch
    layer can still report a truthful error."""
    jobs: List[Dict[str, Any]] = []
    for record in queue or []:
        if not isinstance(record, dict):
            continue
        for platform in PLATFORMS:
            url = get_manual_social_link(record, platform)
            if not url or not manual_link_needs_refresh(record, platform):
                continue
            try:
                url = canonical_social_link(platform, url) or url
            except ManualLinkError:
                pass  # keep the raw legacy URL; fetch layer reports truthfully
            jobs.append(
                {
                    "queue_id": str(record.get("id", "")),
                    "platform": platform,
                    "name": PLATFORM_NAMES.get(platform, platform),
                    "url": url,
                }
            )
    return jobs


def upsert_manual_analytics(record: Dict[str, Any], platform: str, stats: Dict[str, Any]) -> Dict[str, Any]:
    """Write a confirmed manual-link analytics record.

    Never touches manualSocialLinks / manualLinkRequestedAt (owner-owned).
    Only writes record["socialAnalytics"][platform] (bot-owned whitelist)."""
    stats = dict(stats or {})
    url = _text(stats.get("url") or get_manual_social_link(record, platform)).strip()
    if url:
        try:  # always persist the canonical shape when we can read one
            url = canonical_social_link(platform, url) or url
        except ManualLinkError:
            pass  # legacy/unresolvable: keep the raw URL so nothing is lost
        stats["url"] = url
    stats.setdefault("matchedBy", "manual")
    stats.setdefault("matchConfidence", 1)
    stats.setdefault("matchEvidence", {})
    root = record.get("socialAnalytics")
    if not isinstance(root, dict):
        root = {}
    root[platform] = stats
    record["socialAnalytics"] = root
    return root[platform]


def mark_refresh_error(state: Dict[str, Any], message: str) -> None:
    """Truthful, non-fatal error for the dashboard's social sync status.

    The dashboard shows state.socialSyncStatus.error and keeps any manual
    links marked "waiting", so a failed fetch is visible instead of silent."""
    sync = state.get("socialSyncStatus")
    if not isinstance(sync, dict):
        sync = {}
    sync["error"] = str(message)
    state["socialSyncStatus"] = sync
