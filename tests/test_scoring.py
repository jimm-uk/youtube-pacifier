import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "fetch"))
import scoring  # noqa: E402
import youtube  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class NameMatching(unittest.TestCase):
    def test_exact_ignores_case_and_spacing(self):
        self.assertTrue(scoring.name_matches("Sam Rivera", "sam  rivera"))
        self.assertFalse(scoring.name_matches("Sam Rivera", "Sam Riveras"))

    def test_truncated_name_matches_by_prefix(self):
        self.assertTrue(scoring.name_matches("Alex Morgan Ta…", "Alex Morgan Taylor"))
        self.assertTrue(scoring.name_matches("Robin Talks M...", "Robin Talks Maths"))
        self.assertFalse(scoring.name_matches("Alex Morgan Ta…", "Alex Morgan"))

    def test_curly_apostrophe(self):
        self.assertTrue(scoring.name_matches("Kim's Economics", "Kim’s Economics"))

    def test_one_big_namesake_is_accepted(self):
        results = [
            {"channel_id": "A", "title": "Jordan Lee", "subscribers": 601_000},
            {"channel_id": "B", "title": "Jordan Lee", "subscribers": 822},
            {"channel_id": "C", "title": "JORDAN LEE FINANCE", "subscribers": 50_000},
        ]
        best, matches = scoring.pick_channel("Jordan Lee", results, 10_000)
        self.assertEqual(best["channel_id"], "A")
        self.assertEqual(len(matches), 2)

    def test_two_big_namesakes_are_dropped(self):
        results = [
            {"channel_id": "A", "title": "Sam Smith", "subscribers": 900_000},
            {"channel_id": "B", "title": "Sam Smith", "subscribers": 40_000},
        ]
        self.assertIsNone(scoring.pick_channel("Sam Smith", results, 10_000)[0])

    def test_no_match_is_dropped(self):
        self.assertIsNone(scoring.pick_channel("Nobody", [], 10_000)[0])


class Clickbait(unittest.TestCase):
    CALM = [
        "How to Invest at Every Salary",
        "Lead Architect Reveals His Rules for Coding Agents",
        "The Band - Full Performance (Live in Studio)",
        "GPT-5 vs Claude on the ARC benchmark",
        "The UK pension triple lock, explained",
        "Running LLMs locally on an M4 Mac",
    ]
    BAIT = [
        "You WON'T BELIEVE What Happened!!!",
        "This Changes EVERYTHING 🤯🔥",
        "I Got DESTROYED by AI?!",
        "SHOCKING truth they don't want you to know...",
    ]

    def test_calm_titles_score_low(self):
        for t in self.CALM:
            self.assertLess(scoring.clickbait_score(t), 1.0, t)

    def test_bait_titles_score_high(self):
        for t in self.BAIT:
            self.assertGreaterEqual(scoring.clickbait_score(t), 2.0, t)

    def test_acronyms_are_not_shouting(self):
        self.assertEqual(scoring.clickbait_score("NVIDIA GPU and CPU prices in the UK"), 0)


class FeedSelection(unittest.TestCase):
    def entries(self):
        # 6 from A (newest), then 3 from B, then 3 from C
        out = []
        for i in range(6):
            out.append({"id": f"a{i}", "channel_id": "A", "published": f"2026-10-15T1{9 - i}:00:00+00:00"})
        for i in range(3):
            out.append({"id": f"b{i}", "channel_id": "B", "published": f"2026-10-14T1{9 - i}:00:00+00:00"})
            out.append({"id": f"c{i}", "channel_id": "C", "published": f"2026-10-13T1{9 - i}:00:00+00:00"})
        return out

    def test_cap_per_creator(self):
        got = scoring.select_feed(self.entries(), 9, 3, lambda e: True)
        self.assertEqual([e["id"] for e in got],
                         ["a0", "a1", "a2", "b0", "b1", "b2", "c0", "c1", "c2"])

    def test_size_limit_and_newest_first(self):
        got = scoring.select_feed(self.entries(), 4, 3, lambda e: True)
        self.assertEqual([e["id"] for e in got], ["a0", "a1", "a2", "b0"])

    def test_ineligible_skipped_without_using_cap(self):
        got = scoring.select_feed(self.entries(), 3, 3, lambda e: e["id"] != "a1")
        self.assertEqual([e["id"] for e in got], ["a0", "a2", "a3"])

    def test_eligibility_checked_lazily(self):
        seen = []
        scoring.select_feed(self.entries(), 2, 3, lambda e: seen.append(e["id"]) or True)
        self.assertEqual(seen, ["a0", "a1"])


class Suggestion(unittest.TestCase):
    CFG = {"min_recent_uploads": 3, "max_uploads_per_week": 7, "max_clickbait": 1.0,
           "cooldown_days": 30, "blocked_creators": ["Bad Channel"], "blocked_keywords": ["crypto"]}
    NOW = datetime(2026, 10, 16, tzinfo=timezone.utc)

    def feed(self, titles, every_days=7):
        return [{"title": t, "published": (self.NOW - timedelta(days=every_days * i)).isoformat()}
                for i, t in enumerate(titles)]

    def test_steady_calm_channel_passes(self):
        f = self.feed(["Rust ownership explained", "Writing a parser in Rust", "Rust async in depth",
                       "Benchmarking Rust and Go"])
        score, detail = scoring.assess_candidate(f, self.NOW, self.CFG, ["rust", "parser"])
        self.assertIsNotNone(score)
        self.assertEqual(detail["cadence"], "about weekly")

    def test_clickbait_channel_rejected(self):
        f = self.feed(["INSANE AI trick!!!", "You won't believe this 🤯", "SHOCKING results!!", "OMG"])
        self.assertIsNone(scoring.assess_candidate(f, self.NOW, self.CFG, [])[0])

    def test_firehose_channel_rejected(self):
        f = self.feed([f"Daily update {i}" for i in range(15)], every_days=0.5)
        self.assertIsNone(scoring.assess_candidate(f, self.NOW, self.CFG, [])[0])

    def test_dormant_channel_rejected(self):
        f = self.feed(["Old talk", "Older talk", "Oldest talk"], every_days=200)
        self.assertIsNone(scoring.assess_candidate(f, self.NOW, self.CFG, [])[0])

    def test_spin_off_channels(self):
        listed = ["Acme Tech", "Bright Science", "Two Minute Maths"]
        for t in ["Acme Clips", "AcmeClass", "Bright Science Podcast", "Some Show Highlights", "Other Clips"]:
            self.assertTrue(scoring.spin_off(t, listed), t)
        for t in ["Calm Woodwork", "The Prime Lens", "Maths Please Reviews"]:
            self.assertFalse(scoring.spin_off(t, listed), t)

    def test_blocked(self):
        self.assertTrue(scoring.blocked({"channel": "bad channel"}, self.CFG))
        self.assertTrue(scoring.blocked({"title": "My Crypto picks"}, self.CFG))
        self.assertFalse(scoring.blocked({"channel": "Good", "title": "Fine"}, self.CFG))

    def test_keywords_skip_stopwords(self):
        kws = scoring.keywords(["The best Rust parser", "A Rust parser in depth", "Rust and you"])
        self.assertEqual(kws[:2], ["rust", "parser"])


class Parsing(unittest.TestCase):
    def test_parse_count(self):
        self.assertEqual(youtube.parse_count("601k subscribers"), 601_000)
        self.assertEqual(youtube.parse_count("1.36M subscribers"), 1_360_000)
        self.assertEqual(youtube.parse_count("8.56 thousand subscribers"), 8_560)
        self.assertEqual(youtube.parse_count("228 subscribers"), 228)
        self.assertEqual(youtube.parse_count(""), 0)

    def test_parse_feed(self):
        items = youtube.parse_feed((FIXTURES / "feed.xml").read_text())
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["id"], "newer000001")  # sorted newest first
        self.assertEqual(items[0]["channel"], "Example Channel")
        self.assertEqual(items[1]["description"], "Second description")


if __name__ == "__main__":
    unittest.main()
