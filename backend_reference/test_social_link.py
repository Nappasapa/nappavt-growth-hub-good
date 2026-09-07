"""
Tests for the manual social-link fix reference (backend_reference/social_link.py).

Locks in the SAME URL semantics as the dashboard canonicalizers in index.html
(".test/social-link.test.js", 70 assertions) so the two layers agree on one
URL shape per platform, plus the queue-record contract helpers:

  - youtube_video_id() / canonical_social_link(): every real-world YouTube
    paste form resolves to https://www.youtube.com/watch?v=<id>; foreign
    hosts and junk are rejected (notyoutube.com must NOT pass).
  - TikTok / Instagram canonicalization (vm.tiktok.com, /video/, /reel/…).
  - manual_link_jobs() only reports links that still need a stats refresh.
  - upsert_manual_analytics() writes ONLY the bot-owned socialAnalytics key
    and stamps matchedBy:'manual' + the canonical url.
  - mark_refresh_error() surfaces truthful fetch failures.

Run:  python3 -m unittest backend_reference.test_social_link -v
      (from the repo root), or from backend_reference/:
      python3 -m unittest test_social_link -v
Stdlib only. No network. No third-party imports.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from social_link import (  # noqa: E402
    ManualLinkError,
    canonical_instagram_url,
    canonical_social_link,
    canonical_tiktok_url,
    canonical_youtube_url,
    get_manual_social_link,
    manual_link_jobs,
    manual_link_needs_refresh,
    mark_refresh_error,
    upsert_manual_analytics,
    youtube_video_id,
)

CANON = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
VIDEO_ID = "dQw4w9WgXcQ"

ACCEPTED_YOUTUBE = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL9tY0BWXOZFuFEGuDA2emcrUe3cJgxwCj&index=2",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=2m30s",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=AbCdefGhiJk",
    "https://youtu.be/dQw4w9WgXcQ?t=42",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
    "https://www.youtube.com/v/dQw4w9WgXcQ",
    "https://youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "<https://www.youtube.com/watch?v=dQw4w9WgXcQ>",
    VIDEO_ID,
]

REJECTED_YOUTUBE = [
    "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=tooshort",
    "https://youtu.be/tooShort",
    "https://www.youtube.com/feed/subscriptions",
    "this is definitely not a youtube url",
    "https://www.youtube.com/watch?v=1234567890123",
]


class YoutubeCanonicalTests(unittest.TestCase):
    def test_youtube_video_id(self):
        self.assertEqual(youtube_video_id("https://youtu.be/dQw4w9WgXcQ"), VIDEO_ID)

    def test_all_real_world_forms_canonicalize(self):
        for form in ACCEPTED_YOUTUBE:
            with self.subTest(form=form):
                self.assertEqual(canonical_youtube_url(form), CANON, form)

    def test_foreign_hosts_and_junk_rejected(self):
        for form in REJECTED_YOUTUBE:
            with self.subTest(form=form):
                self.assertIsNone(canonical_youtube_url(form), form)
                self.assertIsNone(youtube_video_id(form), form)

    def test_notyoutube_com_never_passes(self):
        # Host-boundary regression: "...youtube.com" inside a longer label.
        for host in ("notyoutube.com", "youtube.com.evil.example", "myyoutu.be"):
            url = "https://{}/watch?v={}".format(host, VIDEO_ID)
            with self.subTest(host=host):
                self.assertIsNone(canonical_youtube_url(url), url)

    def test_blank_is_blank(self):
        self.assertIsNone(canonical_youtube_url("   "))

    def test_canonical_social_link_youtube_error_message(self):
        with self.assertRaises(ManualLinkError) as ctx:
            canonical_social_link("youtube", "garbage")
        self.assertIn("watch?v=", str(ctx.exception))


class TiktokInstagramTests(unittest.TestCase):
    def test_tiktok_video_canonicalizes(self):
        self.assertEqual(
            canonical_tiktok_url(
                "https://www.tiktok.com/@nappavt/video/7123456789012345678?is_from_webapp=1"
            ),
            "https://www.tiktok.com/@nappavt/video/7123456789012345678",
        )

    def test_tiktok_short_share_link_canonicalizes(self):
        self.assertEqual(
            canonical_tiktok_url("https://vm.tiktok.com/ZMabcDeFg/"),
            "https://vm.tiktok.com/ZMabcDeFg/",
        )

    def test_tiktok_userless_video_path_canonicalizes(self):
        self.assertEqual(
            canonical_tiktok_url("https://www.tiktok.com/video/7123456789012345678"),
            "https://www.tiktok.com/video/7123456789012345678",
        )

    def test_tiktok_rejects_photos_and_foreign_links(self):
        for bad in (
            "https://www.tiktok.com/@nappavt/photo/7123456789012345678",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ManualLinkError):
                    canonical_tiktok_url(bad)

    def test_instagram_reel_and_post_canonicalize(self):
        self.assertEqual(
            canonical_instagram_url("https://www.instagram.com/reel/CxAbCdEfGhI/?igsh=abc"),
            "https://www.instagram.com/reel/CxAbCdEfGhI",
        )
        self.assertEqual(
            canonical_instagram_url("https://www.instagram.com/p/CxAbCdEfGhI/"),
            "https://www.instagram.com/p/CxAbCdEfGhI",
        )
        self.assertEqual(
            canonical_instagram_url("https://instagram.com/reels/CxAbCdEfGhI"),
            "https://www.instagram.com/reel/CxAbCdEfGhI",
        )

    def test_instagram_rejects_stories_and_foreign_links(self):
        for bad in (
            "https://www.instagram.com/stories/nappavt/1234567890123456789/",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.instagram.com/reels/audio/912345678",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ManualLinkError):
                    canonical_instagram_url(bad)


class QueueContractTests(unittest.TestCase):
    def test_manual_link_jobs_reports_only_outstanding_links(self):
        record = {
            "id": 1,
            "status": "Posted",
            "manualSocialLinks": {"youtube": "https://youtu.be/dQw4w9WgXcQ"},
        }
        jobs = manual_link_jobs([record])
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["queue_id"], "1")
        self.assertEqual(jobs[0]["platform"], "youtube")
        self.assertEqual(jobs[0]["url"], CANON)  # resolved before hand-off

    def test_no_job_when_stats_already_written_for_same_url(self):
        record = {
            "id": 1,
            "manualSocialLinks": {"youtube": CANON},
            "socialAnalytics": {
                "youtube": {"views": 10, "url": CANON, "matchedBy": "manual"}
            },
        }
        self.assertFalse(manual_link_needs_refresh(record, "youtube"))
        self.assertEqual(manual_link_jobs([record]), [])

    def test_job_reappears_when_link_changes(self):
        record = {
            "id": 1,
            "manualSocialLinks": {"youtube": CANON + "2"},
            "socialAnalytics": {
                "youtube": {"views": 10, "url": CANON, "matchedBy": "manual"}
            },
        }
        self.assertTrue(manual_link_needs_refresh(record, "youtube"))

    def test_automatic_record_for_another_video_still_needs_manual_link(self):
        record = {
            "id": 1,
            "manualSocialLinks": {"youtube": CANON},
            "socialAnalytics": {
                "youtube": {"views": 10, "url": "https://www.youtube.com/watch?v=otherID11111", "matchedBy": "automatic"}
            },
        }
        self.assertTrue(manual_link_needs_refresh(record, "youtube"))

    def test_upsert_writes_only_bot_owned_social_analytics(self):
        record = {
            "id": 1,
            "manualSocialLinks": {"youtube": "https://youtu.be/dQw4w9WgXcQ"},
            "manualLinkRequestedAt": {"youtube": "2026-09-07T00:00:00Z"},
            "title": "keep me",
        }
        before = dict(record)
        upsert_manual_analytics(
            record,
            "youtube",
            {"views": 11, "likes": 2, "comments": 0, "shares": 1, "title": "t"},
        )
        self.assertIn("youtube", record["socialAnalytics"])
        entry = record["socialAnalytics"]["youtube"]
        self.assertEqual(entry["matchedBy"], "manual")
        self.assertEqual(entry["matchConfidence"], 1)
        self.assertEqual(entry["url"], CANON)
        # Owner-owned fields are untouched.
        self.assertEqual(record["manualSocialLinks"], before["manualSocialLinks"])
        self.assertEqual(record["manualLinkRequestedAt"], before["manualLinkRequestedAt"])
        self.assertEqual(record["title"], "keep me")
        # Nothing but the whitelisted key was added to the record.
        self.assertEqual(sorted(record.keys()), sorted(["id", "manualSocialLinks", "manualLinkRequestedAt", "title", "socialAnalytics"]))

    def test_get_manual_social_link(self):
        record = {"manualSocialLinks": {"youtube": "  https://youtu.be/x  "}}
        self.assertEqual(get_manual_social_link(record, "youtube"), "https://youtu.be/x")
        self.assertEqual(get_manual_social_link(record, "tiktok"), "")
        self.assertEqual(get_manual_social_link({}, "youtube"), "")

    def test_mark_refresh_error_is_truthful_and_preserves_state(self):
        state = {"socialSyncStatus": {"lastSyncAt": "2026-09-07T00:00:00Z"}}
        mark_refresh_error(state, "YouTube could not find that video (404).")
        self.assertEqual(state["socialSyncStatus"]["error"], "YouTube could not find that video (404).")
        self.assertIn("lastSyncAt", state["socialSyncStatus"])  # preserved


if __name__ == "__main__":
    unittest.main(verbosity=2)
