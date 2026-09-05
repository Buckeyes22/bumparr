"""Read-only selection simulation (bumparr/simulate.py)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import config, db, simulate

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _row(i, kind="ambient", weight=1.0, duration=10.0, payload="{}"):
    return {"id": "t:%d" % i, "type": "video", "kind": kind, "source": "manual",
            "uri": "clip-%d.mp4" % i, "duration": duration, "title": "Clip %d" % i,
            "payload": payload, "weight": weight}


class SimulateReport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.originals = config.DB_PATH, config.ASSET_ROOT, config.OUTPUT_DIR
        config.DB_PATH = str(Path(self.tmp.name) / "s.db")
        config.ASSET_ROOT = Path(self.tmp.name) / "assets"
        config.OUTPUT_DIR = config.ASSET_ROOT / "bumpers"
        config.ASSET_ROOT.mkdir()
        config.OUTPUT_DIR.mkdir()
        for attr, value in zip(("DB_PATH", "ASSET_ROOT", "OUTPUT_DIR"), self.originals):
            self.addCleanup(setattr, config, attr, value)
        db.init_db()
        with db.conn() as c:
            for row in (_row(1, "ambient", payload='{"audio":"native"}'),
                        _row(2, "trivia", payload='{"audio":"silent"}'),
                        _row(3, "station_id", payload='{"music":"bed.wav"}')):
                db.upsert_playable(c, row)
                c.execute("UPDATE playables SET payload=?, weight=? WHERE id=?",
                          (row["payload"], row["weight"], row["id"]))
            c.commit()

    def _fingerprint(self):
        with db.conn() as c:
            rows = [tuple(r) for r in c.execute(
                "SELECT id, weight, last_played, play_count, enabled, health "
                "FROM playables ORDER BY id")]
            hist = [tuple(r) for r in c.execute(
                "SELECT channel_id, playable_id, played_at FROM play_history ORDER BY id")]
            cursor = [tuple(r) for r in c.execute(
                "SELECT channel_id, current_id, started_at FROM playout ORDER BY channel_id")]
        return rows, hist, cursor

    def test_seeded_json_is_identical_and_has_required_fields(self):
        rows = simulate.snapshot_pool()
        a = simulate.run(rows, picks=40, seed=7, start=1_700_000_000.0)
        b = simulate.run(rows, picks=40, seed=7, start=1_700_000_000.0)
        self.assertEqual(a, b)
        self.assertEqual(a["picks"], 40)
        self.assertEqual(a["seed"], 7)
        self.assertEqual(a["start"], 1_700_000_000.0)
        for key in ("item_shares", "kind_shares", "exact_repeats",
                    "same_kind_runs", "zero_score_picks", "seasonal",
                    "daypart", "audio"):
            self.assertIn(key, a)
        self.assertEqual(a["chosen"] + a["zero_score_picks"], 40)
        self.assertGreater(a["chosen"], 0)
        self.assertTrue(a["audio"])

    def test_does_not_write_db_or_call_station_advance(self):
        before = self._fingerprint()
        with mock.patch("bumparr.station.playout.Channel.advance") as advance:
            simulate.run(simulate.snapshot_pool(), picks=25, seed=1, start=1000.0)
            advance.assert_not_called()
        self.assertEqual(self._fingerprint(), before)

    def test_zero_score_pool_is_reported_not_revived(self):
        with db.conn() as c:
            c.execute("UPDATE playables SET weight=0")
            c.commit()
        report = simulate.run(simulate.snapshot_pool(), picks=8, seed=1, start=1000.0)
        self.assertEqual(report["chosen"], 0)
        self.assertEqual(report["zero_score_picks"], 8)
        self.assertEqual(report["item_shares"], {})


class SimulateCli(unittest.TestCase):
    def _run(self, *args, seed_rows=None):
        with tempfile.TemporaryDirectory(prefix="bumparr-sim-") as tmp:
            env = dict(os.environ, DB_PATH=os.path.join(tmp, "t.db"),
                       ASSET_ROOT=os.path.join(tmp, "assets"),
                       DATA_DIR=os.path.join(tmp, "data"),
                       PYTHONPATH=REPO + os.pathsep + os.environ.get("PYTHONPATH", ""))
            db_path = env["DB_PATH"]
            Path(env["ASSET_ROOT"]).mkdir()
            init = (
                "from bumparr import db\n"
                "db.init_db()\n"
            )
            if seed_rows:
                init += (
                    "with db.conn() as c:\n"
                    "    for row in %r:\n"
                    "        db.upsert_playable(c, row)\n"
                    "    c.commit()\n"
                    % seed_rows
                )
            probe = Path(tmp) / "seed.py"
            probe.write_text(init, encoding="utf-8")
            subprocess.run([sys.executable, str(probe)], check=True, env=env,
                           cwd=REPO, timeout=60)
            return subprocess.run(
                [sys.executable, "-m", "bumparr.simulate", *args],
                capture_output=True, text=True, env=env, cwd=REPO, timeout=60)

    def test_json_cli_is_seedable_and_rejects_bad_picks(self):
        rows = [_row(1), _row(2, kind="trivia")]
        first = self._run("--seed", "3", "--picks", "12", "--start", "1000",
                          "--json", seed_rows=rows)
        second = self._run("--seed", "3", "--picks", "12", "--start", "1000",
                           "--json", seed_rows=rows)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(json.loads(first.stdout), json.loads(second.stdout))
        bad = self._run("--picks", "0", seed_rows=rows)
        self.assertNotEqual(bad.returncode, 0)
        self.assertIn("positive", (bad.stderr or bad.stdout).lower())


if __name__ == "__main__":
    unittest.main()
