"""Objective release gates and deterministic review artifacts."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import config, creative, db, review, simulate

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "tests" / "fixtures" / "alignment_playables.json"
CHECKLIST = REPO / "docs" / "RELEASE_REVIEW.md"


def _load(pool="capable"):
    doc = simulate.load_alignment_fixture(FIXTURE)
    meta = simulate.fixture_meta(doc)
    return doc, meta, simulate.fixture_rows(doc, pool)


def _ids(items):
    return [item.get("id") for item in items]


class AlignmentFixture(unittest.TestCase):
    def test_fixture_has_capable_and_constrained_with_fixed_clock(self):
        doc, meta, capable = _load("capable")
        constrained = simulate.fixture_rows(doc, "constrained")
        self.assertEqual(meta["seed"], 7)
        self.assertEqual(meta["start"], 1_700_000_000.0)
        self.assertEqual(meta["timezone"], "UTC")
        self.assertEqual(meta["tolerance"], 1.5)
        self.assertEqual(meta["station_seconds"], 600)
        self.assertEqual(meta["break_seconds"], [15, 30, 60, 90])
        self.assertGreaterEqual(len(capable), 16)
        self.assertGreaterEqual(len(constrained), 6)
        self.assertTrue(meta["gates"]["score"])
        self.assertIn("fx:gated-weight", meta["gates"]["score"])
        self.assertIn("fx:gated-christmas", meta["gates"]["score"])
        self.assertIn("fx:standby-only", meta["gates"]["standby_only"])


class ObjectiveReleaseGates(unittest.TestCase):
    """CI covers only objective contracts. Shares stay diagnostic."""

    def setUp(self):
        self.doc, self.meta, self.rows = _load("capable")
        self.seed = self.meta["seed"]
        self.start = self.meta["start"]
        self.tz_name = self.meta["timezone"]
        self.tz = simulate.load_tz(self.tz_name)
        self.gated = set(self.meta["gates"]["score"])
        self.standby = set(self.meta["gates"]["standby_only"])

    def test_deterministic_json(self):
        a = simulate.run(self.rows, picks=80, seed=self.seed, start=self.start,
                         tz=self.tz, tz_name=self.tz_name)
        b = simulate.run(self.rows, picks=80, seed=self.seed, start=self.start,
                         tz=self.tz, tz_name=self.tz_name)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))
        review_a = review.build_review(
            self.rows, seed=self.seed, start=self.start, pool="capable",
            fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
        review_b = review.build_review(
            self.rows, seed=self.seed, start=self.start, pool="capable",
            fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
        self.assertEqual(json.dumps(review_a, sort_keys=True),
                         json.dumps(review_b, sort_keys=True))

    def test_no_gated_or_hard_role_selection(self):
        built = review.build_review(
            self.rows, seed=self.seed, start=self.start, pool="capable",
            fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
        station_ids = set(_ids(built["station"]["items"]))
        self.assertTrue(station_ids)
        self.assertFalse(station_ids & self.gated)
        self.assertEqual(built["mix"]["gated_selections"], 0)
        for seconds in simulate.STANDARD_BREAKS:
            pack = built["breaks"][str(seconds)]
            pack_ids = set(_ids(pack["items"]))
            self.assertFalse(pack_ids & self.gated, pack_ids)
            self.assertFalse(pack_ids & self.standby, pack_ids)
            self.assertEqual(pack["gated_selections"], 0)
            self.assertEqual(pack["role_violations"], 0)
            for item in pack["items"]:
                self.assertTrue(
                    creative.role_compatible(item["creative"], pack["placement"],
                                             mode="break"),
                    item["id"])

    def test_satisfiable_run_limits_on_capable_pool(self):
        built = review.build_review(
            self.rows, seed=self.seed, start=self.start, pool="capable",
            fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
        mix = built["mix"]
        self.assertLessEqual(mix["max_text_run"], mix["text_run_limit"])
        self.assertEqual(mix["text_runs"], 0)
        self.assertGreaterEqual(built["station"]["total"], 600)

    def test_valid_media_metadata(self):
        built = review.build_review(
            self.rows, seed=self.seed, start=self.start, pool="capable",
            fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
        self.assertEqual(built["mix"]["invalid_media_metadata"], 0)
        items = list(built["station"]["items"])
        for pack in built["breaks"].values():
            items.extend(pack["items"])
        self.assertTrue(items)
        for item in items:
            row = {"id": item["id"], "type": item["type"], "kind": item["kind"],
                   "uri": item["uri"], "duration": item["duration"]}
            self.assertEqual(simulate.media_metadata_errors(row, item["creative"]), [])

    def test_standard_break_duration_tolerance(self):
        built = review.build_review(
            self.rows, seed=self.seed, start=self.start, pool="capable",
            fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
        self.assertEqual(built["meta"]["tolerance"], 1.5)
        for seconds in ("15", "30", "60", "90"):
            pack = built["breaks"][seconds]
            self.assertEqual(pack["tolerance"], 1.5)
            self.assertTrue(pack["exact"], pack)
            self.assertLessEqual(pack["abs_error"], 1.5)
            error = built["mix"]["break_duration_error"]["seconds"][seconds]
            self.assertTrue(error["within_tolerance"], error)

    def test_no_subjective_similarity_score(self):
        built = review.build_review(
            self.rows, seed=self.seed, start=self.start, pool="capable",
            fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
        blob = json.dumps(built)
        self.assertNotIn("adult swim", blob.lower())
        keys = []

        def walk(obj):
            if isinstance(obj, dict):
                for key, value in obj.items():
                    keys.append(str(key))
                    walk(value)
            elif isinstance(obj, list):
                for value in obj:
                    walk(value)

        walk(built)
        self.assertTrue(all("similar" not in key.lower() for key in keys), keys)


class ConstrainedFixture(unittest.TestCase):
    def setUp(self):
        self.doc, self.meta, self.rows = _load("constrained")

    def test_gates_still_hold_and_diagnostics_are_honest(self):
        built = review.build_review(
            self.rows, seed=self.meta["seed"], start=self.meta["start"],
            pool="constrained", fixture=str(FIXTURE),
            tz=simulate.load_tz(self.meta["timezone"]),
            tz_name=self.meta["timezone"])
        gated = set(self.meta["gates"]["score"])
        station_ids = set(_ids(built["station"]["items"]))
        self.assertFalse(station_ids & gated)
        self.assertEqual(built["mix"]["gated_selections"], 0)
        pack15 = built["breaks"]["15"]
        self.assertFalse(pack15["exact"])
        self.assertGreater(pack15["abs_error"], 1.5)
        self.assertFalse(set(_ids(pack15["items"])) & gated)
        self.assertFalse(set(_ids(pack15["items"])) & set(self.meta["gates"]["standby_only"]))
        provenance = built["mix"]["provenance"]
        self.assertGreater(provenance["missing"] + provenance["stale"], 0)
        # Distribution metrics are present and diagnostic, not gated.
        for key in ("family_shares", "template_shares", "brand_mode_shares",
                    "energy_shares", "family_repeats", "template_repeats"):
            self.assertIn(key, built["mix"])


class ReviewArtifacts(unittest.TestCase):
    def setUp(self):
        _doc, self.meta, self.rows = _load("capable")
        self.tz = simulate.load_tz(self.meta["timezone"])
        self.tz_name = self.meta["timezone"]

    def test_artifacts_reproduce_and_reuse_media_uris(self):
        built = review.build_review(
            self.rows, seed=self.meta["seed"], start=self.meta["start"],
            pool="capable", fixture=str(FIXTURE), commit="test",
            tz=simulate.load_tz(self.meta["timezone"]),
            tz_name=self.meta["timezone"])
        uris = {row["uri"] for row in self.rows}
        with tempfile.TemporaryDirectory(prefix="bumparr-review-") as tmp:
            review.write_artifacts(built, tmp)
            root = Path(tmp)
            names = {path.name for path in root.iterdir()}
            self.assertEqual(names, {
                "station.m3u", "break-15.m3u", "break-30.m3u",
                "break-60.m3u", "break-90.m3u", "review.json", "review.md",
            })
            self.assertFalse(list(root.glob("*.mp4")))
            station = (root / "station.m3u").read_text(encoding="utf-8")
            self.assertTrue(station.startswith("#EXTM3U\n"))
            self.assertIn("#EXT-X-Bumparr-Plan-Only:1", station)
            self.assertIn("#EXTINF:", station)
            media_lines = [line for line in station.splitlines()
                           if line and not line.startswith("#")]
            self.assertEqual(media_lines, [])
            self.assertTrue(any("# bumparr-plan:" in line for line in station.splitlines()))
            del uris
            sidecar = json.loads((root / "review.json").read_text(encoding="utf-8"))
            self.assertEqual(sidecar, built)
            markdown = (root / "review.md").read_text(encoding="utf-8")
            self.assertIn("docs/RELEASE_REVIEW.md", markdown)
            self.assertIn("credits", markdown.lower())
            self.assertIn("gap", markdown.lower())
            self.assertIn("relax", markdown.lower())
            self.assertIn("no Adult Swim similarity", markdown)
            credits_hit = any("music_credits" in item
                              for item in sidecar["station"]["items"])
            self.assertTrue(credits_hit)
            self.assertIn("commit", sidecar["meta"])

    def test_does_not_write_db_or_call_station_advance(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        originals = config.DB_PATH, config.ASSET_ROOT, config.OUTPUT_DIR
        config.DB_PATH = str(Path(tmp.name) / "s.db")
        config.ASSET_ROOT = Path(tmp.name) / "assets"
        config.OUTPUT_DIR = config.ASSET_ROOT / "bumpers"
        config.ASSET_ROOT.mkdir()
        config.OUTPUT_DIR.mkdir()
        for attr, value in zip(("DB_PATH", "ASSET_ROOT", "OUTPUT_DIR"), originals):
            self.addCleanup(setattr, config, attr, value)
        db.init_db()
        with db.conn() as c:
            before_hist = c.execute("SELECT COUNT(*) FROM play_history").fetchone()[0]
            before_play = [tuple(r) for r in c.execute(
                "SELECT id, last_played, play_count FROM playables ORDER BY id")]
        with mock.patch("bumparr.station.playout.Channel.advance") as advance:
            with mock.patch("subprocess.run") as run:
                review.build_review(
                    self.rows, seed=self.meta["seed"],
                    start=self.meta["start"], pool="capable",
                    fixture=str(FIXTURE), tz=self.tz, tz_name=self.tz_name)
                advance.assert_not_called()
                run.assert_not_called()
        with db.conn() as c:
            after_hist = c.execute("SELECT COUNT(*) FROM play_history").fetchone()[0]
            after_play = [tuple(r) for r in c.execute(
                "SELECT id, last_played, play_count FROM playables ORDER BY id")]
        self.assertEqual(before_hist, after_hist)
        self.assertEqual(before_play, after_play)


class ReviewCli(unittest.TestCase):
    def test_fixture_cli_is_seedable_and_writes_out(self):
        env = dict(os.environ, PYTHONPATH=str(REPO) + os.pathsep + os.environ.get("PYTHONPATH", ""))
        with tempfile.TemporaryDirectory(prefix="bumparr-review-cli-") as tmp:
            out = Path(tmp) / "art"
            first = subprocess.run(
                [sys.executable, "-m", "bumparr.review",
                 "--fixture", str(FIXTURE), "--pool", "capable",
                 "--json", "--out", str(out)],
                capture_output=True, text=True, env=env, cwd=str(REPO), timeout=60)
            second = subprocess.run(
                [sys.executable, "-m", "bumparr.review",
                 "--fixture", str(FIXTURE), "--pool", "capable", "--json"],
                capture_output=True, text=True, env=env, cwd=str(REPO), timeout=60)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(first.stdout), json.loads(second.stdout))
            self.assertTrue((out / "station.m3u").is_file())
            self.assertTrue((out / "review.json").is_file())
            self.assertTrue((out / "break-90.m3u").is_file())
            m3u = (out / "station.m3u").read_text(encoding="utf-8")
            self.assertIn("#EXT-X-Bumparr-Plan-Only:1", m3u)
            self.assertFalse([line for line in m3u.splitlines()
                              if line and not line.startswith("#")])

    def test_live_cli_requires_start_before_creating_db(self):
        with tempfile.TemporaryDirectory(prefix="bumparr-review-missing-") as tmp:
            db_path = Path(tmp) / "new.db"
            env = dict(os.environ, DB_PATH=str(db_path),
                       ASSET_ROOT=str(Path(tmp) / "assets"),
                       DATA_DIR=str(Path(tmp) / "data"),
                       PYTHONPATH=str(REPO) + os.pathsep + os.environ.get("PYTHONPATH", ""))
            Path(env["ASSET_ROOT"]).mkdir()
            run = subprocess.run(
                [sys.executable, "-m", "bumparr.review", "--json"],
                capture_output=True, text=True, env=env, cwd=str(REPO), timeout=60)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("--start", (run.stderr or run.stdout).lower())
            self.assertFalse(db_path.exists())

    def test_live_m3u_emits_absolute_local_paths(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        originals = config.DB_PATH, config.ASSET_ROOT, config.OUTPUT_DIR
        config.DB_PATH = str(Path(tmp.name) / "s.db")
        config.ASSET_ROOT = Path(tmp.name) / "assets"
        config.OUTPUT_DIR = config.ASSET_ROOT / "bumpers"
        config.ASSET_ROOT.mkdir()
        config.OUTPUT_DIR.mkdir()
        for attr, value in zip(("DB_PATH", "ASSET_ROOT", "OUTPUT_DIR"), originals):
            self.addCleanup(setattr, config, attr, value)
        clip = config.ASSET_ROOT / "clip.mp4"
        clip.write_bytes(b"fake-mp4")
        db.init_db()
        with db.conn() as c:
            db.upsert_playable(c, {
                "id": "vid:clip", "type": "video", "kind": "ambient",
                "source": "manual", "uri": "clip.mp4", "duration": 10.0,
                "title": "Clip", "payload": "{}", "tags": "", "weight": 1.0,
            })
            c.commit()
        rows = simulate.snapshot_pool()
        built = review.build_review(rows, seed=1, start=1000.0, pool="live")
        self.assertFalse(built["meta"]["plan_only"])
        m3u = review.render_m3u(built["station"]["items"], "live")
        self.assertNotIn("Plan-Only", m3u)
        self.assertIn(str(clip.resolve()), m3u)

    def test_live_m3u_omits_missing_traversal_empty_and_bad_schemes(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        originals = config.DB_PATH, config.ASSET_ROOT, config.OUTPUT_DIR
        config.DB_PATH = str(Path(tmp.name) / "s.db")
        config.ASSET_ROOT = Path(tmp.name) / "assets"
        config.OUTPUT_DIR = config.ASSET_ROOT / "bumpers"
        config.ASSET_ROOT.mkdir()
        config.OUTPUT_DIR.mkdir()
        for attr, value in zip(("DB_PATH", "ASSET_ROOT", "OUTPUT_DIR"), originals):
            self.addCleanup(setattr, config, attr, value)
        good = config.ASSET_ROOT / "good.mp4"
        good.write_bytes(b"fake-mp4")
        db.init_db()
        with db.conn() as c:
            db.upsert_playable(c, {
                "id": "vid:good", "type": "video", "kind": "ambient",
                "source": "manual", "uri": "good.mp4", "duration": 10.0,
                "title": "Good", "payload": "{}", "tags": "", "weight": 1.0,
            })
            db.upsert_playable(c, {
                "id": "vid:missing", "type": "video", "kind": "ambient",
                "source": "manual", "uri": "missing.mp4", "duration": 10.0,
                "title": "Missing", "payload": "{}", "tags": "", "weight": 1.0,
            })
            db.upsert_playable(c, {
                "id": "vid:traverse", "type": "video", "kind": "ambient",
                "source": "manual", "uri": "../outside.mp4", "duration": 10.0,
                "title": "Traverse", "payload": "{}", "tags": "", "weight": 1.0,
            })
            db.upsert_playable(c, {
                "id": "card:empty", "type": "card", "kind": "psa",
                "source": "generated", "uri": None, "duration": 4.0,
                "title": "Empty", "payload": "{}", "tags": "", "weight": 1.0,
            })
            db.upsert_playable(c, {
                "id": "vid:js", "type": "video", "kind": "ambient",
                "source": "manual", "uri": "javascript:alert(1)", "duration": 10.0,
                "title": "JS", "payload": "{}", "tags": "", "weight": 1.0,
            })
            db.upsert_playable(c, {
                "id": "vid:file", "type": "video", "kind": "ambient",
                "source": "manual", "uri": "file:///etc/passwd", "duration": 10.0,
                "title": "File", "payload": "{}", "tags": "", "weight": 1.0,
            })
            c.commit()
        self.assertEqual(review.playable_media_uri({"uri": "missing.mp4"}), "")
        self.assertEqual(review.playable_media_uri({"uri": "../outside.mp4"}), "")
        self.assertEqual(review.playable_media_uri({"uri": ""}), "")
        self.assertEqual(review.playable_media_uri({"uri": None}), "")
        self.assertEqual(review.playable_media_uri({"uri": "javascript:alert(1)"}), "")
        self.assertEqual(review.playable_media_uri({"uri": "file:///etc/passwd"}), "")
        self.assertEqual(
            review.playable_media_uri({"uri": "good.mp4"}), str(good.resolve()))
        self.assertTrue(
            review.playable_media_uri({"uri": "https://example.invalid/live.m3u8"})
            .startswith("https://"))
        rows = simulate.snapshot_pool()
        built = review.build_review(rows, seed=1, start=1000.0, pool="live")
        ids = {item["id"] for item in built["station"]["items"]}
        self.assertIn("vid:good", ids)
        self.assertNotIn("vid:missing", ids)
        self.assertNotIn("vid:traverse", ids)
        self.assertNotIn("card:empty", ids)
        self.assertNotIn("vid:js", ids)
        self.assertNotIn("vid:file", ids)
        m3u = review.render_m3u(built["station"]["items"], "live")
        self.assertIn(str(good.resolve()), m3u)
        self.assertNotIn("missing.mp4", m3u)
        self.assertNotIn("../outside.mp4", m3u)
        self.assertNotIn("javascript:", m3u)
        self.assertNotIn("file://", m3u)
        extinf = [line for line in m3u.splitlines() if line.startswith("#EXTINF:")]
        media = [line for line in m3u.splitlines()
                 if line and not line.startswith("#")]
        self.assertEqual(len(extinf), len(media))
        self.assertTrue(media)
        self.assertTrue(all(line == str(good.resolve()) for line in media))
        unsafe = review.render_m3u(
            [{"id": "x", "title": "X", "duration": 1, "uri": "../outside.mp4"}],
            "unsafe")
        self.assertNotIn("../outside.mp4", unsafe)
        self.assertFalse([line for line in unsafe.splitlines()
                          if line and not line.startswith("#")])


class ReleaseReviewDoc(unittest.TestCase):
    def test_checklist_asks_experience_questions_and_has_blank_record(self):
        text = CHECKLIST.read_text(encoding="utf-8")
        self.assertIn("feels authored", text.lower())
        self.assertIn("quiet", text.lower())
        self.assertIn("repeat", text.lower())
        self.assertIn("role", text.lower())
        self.assertIn("brand", text.lower())
        self.assertIn("music", text.lower())
        self.assertIn("credit", text.lower())
        self.assertIn("truth", text.lower())
        for field in ("date", "commit", "profile", "fixture", "reviewer", "notes"):
            self.assertIn(field, text.lower())
        self.assertIn("Adult Swim similarity", text)
        self.assertIn("never", text.lower())
        self.assertNotRegex(text, r"(?i)reviewed by:.+\S")
        self.assertIn("operator", text.lower())


if __name__ == "__main__":
    unittest.main()
