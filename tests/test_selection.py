"""Shared computed-eligibility helper (bumparr/selection.py)."""
import datetime
import math
import os
import sys
import unittest
from unittest import mock
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import rotation, selection


def row(i="a", kind="ambient", weight=1.0, last_played=0, play_count=0, **extra):
    d = {"id": i, "kind": kind, "weight": weight,
         "last_played": last_played, "play_count": play_count}
    d.update(extra)
    return d


class ScoredCandidates(unittest.TestCase):
    def test_base_zero_is_excluded(self):
        rows = [row("off", weight=0.0), row("on", weight=1.0)]
        got, ctx = selection.scored_candidates(rows, now=1000.0)
        self.assertEqual([r["id"] for r, _ in got], ["on"])
        self.assertTrue(all(score > 0 for _, score in got))
        self.assertIn("median_plays", ctx)

    def test_base_negative_is_excluded(self):
        rows = [row("off", weight=-1.0), row("on", weight=1.0)]
        got, _ = selection.scored_candidates(rows, now=1000.0)
        self.assertEqual([r["id"] for r, _ in got], ["on"])

    def test_season_zero_is_excluded(self):
        rows = [row("xmas", kind="christmas"), row("plain", kind="ambient")]
        got, _ = selection.scored_candidates(
            rows, season_factors={"christmas": 0.0}, now=1000.0)
        self.assertEqual([r["id"] for r, _ in got], ["plain"])

    def test_daypart_zero_is_excluded(self):
        rows = [row("night", kind="window"), row("plain", kind="ambient")]
        got, _ = selection.scored_candidates(
            rows, daypart_factors={"window": 0.0}, now=1000.0)
        self.assertEqual([r["id"] for r, _ in got], ["plain"])

    def test_positive_score_is_kept(self):
        rows = [row("a", weight=1.2), row("b", weight=0.5)]
        got, _ = selection.scored_candidates(rows, now=1000.0)
        self.assertEqual([r["id"] for r, _ in got], ["a", "b"])
        self.assertTrue(all(math.isfinite(s) and s > 0 for _, s in got))

    def test_non_finite_score_is_excluded(self):
        rows = [row("nan", kind="broken"), row("ok", kind="ambient")]
        got, _ = selection.scored_candidates(
            rows, season_factors={"broken": float("nan")}, now=1000.0)
        self.assertEqual([r["id"] for r, _ in got], ["ok"])

    def test_infinite_score_is_excluded(self):
        rows = [row("inf", kind="broken"), row("ok", kind="ambient")]
        got, _ = selection.scored_candidates(
            rows, season_factors={"broken": float("inf")}, now=1000.0)
        self.assertEqual([r["id"] for r, _ in got], ["ok"])

    def test_does_not_floor_a_zero_score(self):
        rows = [row("off", weight=0.0)]
        got, _ = selection.scored_candidates(rows, now=1000.0)
        self.assertEqual(got, [])


class EligibilityReasons(unittest.TestCase):
    def test_reasons_follow_declared_order_and_eligible_is_exclusive(self):
        ctx = rotation.build_context([row("a")], now=1000.0)
        gated = row("a", weight=0.0, enabled=0, health="dead")
        reasons = selection.eligibility_reasons(
            gated, ctx, has_media=False, now=1000.0)
        self.assertEqual(reasons, ["disabled", "unhealthy", "missing_media",
                                   "base_weight"])
        ok = row("a", weight=1.0, enabled=1, health="ok")
        self.assertEqual(
            selection.eligibility_reasons(ok, ctx, has_media=True, now=1000.0),
            ["eligible"])

    def test_season_and_daypart_and_non_finite_reasons(self):
        item = row("a", kind="trivia", enabled=1, health="ok")
        ctx = rotation.build_context(
            [item], season_factors={"trivia": 0.0},
            daypart_factors={"trivia": 0.0}, now=1000.0)
        self.assertEqual(
            selection.eligibility_reasons(item, ctx, has_media=True, now=1000.0),
            ["season", "daypart"])
        nan_ctx = rotation.build_context(
            [item], season_factors={"trivia": float("nan")}, now=1000.0)
        self.assertEqual(
            selection.eligibility_reasons(item, nan_ctx, has_media=True, now=1000.0),
            ["non_finite_score"])


class LiveFactors(unittest.TestCase):
    def test_config_errors_degrade_to_empty_maps(self):
        with mock.patch("bumparr.seasons.factors_now", side_effect=RuntimeError("boom")), \
                mock.patch("bumparr.dayparts.factors_now", side_effect=RuntimeError("boom")):
            season, daypart = selection.live_factors()
        self.assertEqual(season, {})
        self.assertEqual(daypart, {})


class ExplainRow(unittest.TestCase):
    def test_explain_row_shape(self):
        item = row("a", weight=1.0, enabled=1, health="ok")
        ctx = rotation.build_context([item], now=1000.0)
        view = selection.explain_row(item, ctx, has_media=True, now=1000.0)
        self.assertEqual(view["eligible_now"], True)
        self.assertEqual(view["reasons"], ["eligible"])
        self.assertEqual(set(view["factors"]),
                         {"base", "season", "daypart", "recency",
                          "affinity", "fatigue", "score"})
        self.assertGreater(view["factors"]["score"], 0)


class TimezoneConversion(unittest.TestCase):
    def test_unix_timestamp_uses_named_zone_not_host_local(self):
        ts = 1_700_000_000.0  # 2023-11-14 22:13:20 UTC / 17:13 America/New_York
        utc = selection.instant(ts, datetime.timezone.utc)
        self.assertEqual(utc.hour, 22)
        ny = selection.instant(ts, ZoneInfo("America/New_York"))
        self.assertEqual(ny.hour, 17)

    def test_factors_at_pins_daypart_hour_to_named_zone(self):
        ts = 1_700_000_000.0
        utc_season, utc_day = selection.factors_at(ts, tz=datetime.timezone.utc)
        ny_season, ny_day = selection.factors_at(ts, tz=ZoneInfo("America/New_York"))
        # 22:13 UTC is evening; 17:13 Eastern is daytime. Trivia is boosted
        # only in the evening window of the shipped dayparts file.
        self.assertNotEqual(utc_day.get("trivia", 1.0), ny_day.get("trivia", 1.0))
        self.assertEqual(utc_season, ny_season)


if __name__ == "__main__":
    unittest.main()
