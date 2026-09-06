"""Truthful channel memory: history-backed cards and local operator messages."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import config, db, jobs, simulate
from bumparr.generators import channel_memory as mem

REPO = Path(__file__).resolve().parents[1]
SHIPPED = REPO / "bumparr" / "config_files" / "operator_messages.yaml"
FORBIDDEN = mem.FORBIDDEN_VIEWER

EMPTY_YAML = """\
version: 1
messages: []
"""

ENABLED_NOTE = """\
version: 1
messages:
  - id: example-note
    lines: ["A locally authored message."]
    enabled: true
    starts_at: null
    ends_at: null
    roles: [any]
"""


def _playable(ident, kind="trivia", title="Trivia card", enabled=1):
    return {
        "id": ident, "type": "card", "kind": kind, "source": "manual",
        "uri": None, "duration": 10.0, "title": title, "payload": "{}",
        "tags": "", "weight": 1.0, "enabled": enabled, "health": "ok",
    }


class MemoryHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.assets = self.root / "assets"
        self.assets.mkdir()
        self.messages = self.root / "messages.yaml"
        self.messages.write_text(EMPTY_YAML, encoding="utf-8")
        self._orig = (
            config.DB_PATH, config.ASSET_ROOT, config.OUTPUT_DIR,
            config.OPERATOR_MESSAGES, config.CHANNEL_MEMORY_KINDS,
            config.CHANNEL_MEMORY_REFRESH,
        )
        config.DB_PATH = str(self.root / "m.db")
        config.ASSET_ROOT = self.assets
        config.OUTPUT_DIR = self.assets / "bumpers"
        config.OUTPUT_DIR.mkdir()
        config.OPERATOR_MESSAGES = str(self.messages)
        config.CHANNEL_MEMORY_KINDS = (
            "channel_statistics,previously_on,viewer_achievement,operator_message"
        )
        config.CHANNEL_MEMORY_REFRESH = 3600
        mem.reset_runtime_state()
        db.init_db()
        self.addCleanup(self._restore)

    def _restore(self):
        (config.DB_PATH, config.ASSET_ROOT, config.OUTPUT_DIR,
         config.OPERATOR_MESSAGES, config.CHANNEL_MEMORY_KINDS,
         config.CHANNEL_MEMORY_REFRESH) = self._orig
        mem.reset_runtime_state()

    def _add_playable(self, ident, kind="trivia", title="Trivia card"):
        with db.conn() as c:
            db.upsert_playable(c, _playable(ident, kind, title))
            c.commit()

    def _add_history(self, playable_id, played_at, channel="station:live"):
        with db.conn() as c:
            c.execute(
                "INSERT INTO play_history(channel_id, playable_id, played_at) "
                "VALUES (?,?,?)",
                (channel, playable_id, float(played_at)))
            c.commit()

    def _rows(self, kind=None):
        sql = "SELECT * FROM playables WHERE source=?"
        args = [mem.PLAYABLE_SOURCE]
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        sql += " ORDER BY id"
        with db.conn() as c:
            return [dict(r) for r in c.execute(sql, args).fetchall()]

    def _payload(self, row):
        return json.loads(row["payload"])

    def _fingerprint(self):
        with db.conn() as c:
            playables = [tuple(r) for r in c.execute(
                "SELECT id, kind, enabled, payload, uri, play_count, last_played "
                "FROM playables ORDER BY id")]
            hist = [tuple(r) for r in c.execute(
                "SELECT channel_id, playable_id, played_at FROM play_history ORDER BY id")]
        return playables, hist


class PurePayloads(MemoryHarness):
    def test_empty_history_has_no_previously_on_or_achievements(self):
        stats = mem.statistics_payload([], 3, 1000.0)
        self.assertIn("not yet aired", stats["lines"][0].lower())
        self.assertEqual(stats["channel"], "station:live")
        self.assertEqual(stats["history_ids"], [])
        self.assertEqual(stats["window_start"], 0.0)
        self.assertEqual(stats["window_end"], 3600.0)
        self.assertEqual(stats["valid_until"], 3600.0)
        self.assertIsNone(mem.previously_on_payload([], 1000.0))
        self.assertEqual(mem.achievement_payloads(0, 1000.0), [])
        self.assertEqual(mem.achievement_payloads(24, 1000.0), [])

    def test_statistics_and_achievements_are_deterministic(self):
        rows = [
            {"id": 1, "playable_id": "t:1", "played_at": 10.0},
            {"id": 2, "playable_id": "t:2", "played_at": 20.0},
        ]
        a = mem.statistics_payload(rows, 4, 100.0, last_ident_at=10.0)
        b = mem.statistics_payload(rows, 4, 100.0, last_ident_at=10.0)
        self.assertEqual(a, b)
        self.assertEqual(mem.statistics_id("station:live"),
                         mem.statistics_id("station:live"))
        ach_a = mem.achievement_payloads(25, 100.0, history_ids=[1, 2],
                                         first_at=10.0, last_at=20.0)
        ach_b = mem.achievement_payloads(25, 100.0, history_ids=[1, 2],
                                         first_at=10.0, last_at=20.0)
        self.assertEqual(ach_a, ach_b)
        self.assertEqual(len(ach_a), 1)
        self.assertEqual(ach_a[0]["_id"], mem.achievement_id("station:live", "starts", 25))
        self.assertEqual(len(mem.achievement_payloads(100, 100.0)), 2)

    def test_previously_on_id_hashes_channel_and_ordered_history(self):
        joined = [
            {"id": 9, "played_at": 50.0, "title": "Weather", "kind": "weather"},
            {"id": 8, "played_at": 40.0, "title": "Trivia", "kind": "trivia"},
        ]
        a = mem.previously_on_payload(joined, 100.0)
        b = mem.previously_on_payload(joined, 100.0)
        self.assertEqual(a["_id"], b["_id"])
        self.assertEqual(a["lines"], b["lines"])
        other = mem.previously_on_payload(
            [{"id": 9, "played_at": 51.0, "title": "Weather", "kind": "weather"}],
            100.0)
        self.assertNotEqual(a["_id"], other["_id"])

    def test_non_viewer_wording(self):
        rows = [{"id": 1, "playable_id": "t:1", "played_at": 10.0}]
        payloads = [mem.statistics_payload(rows, 1, 100.0, last_ident_at=10.0)]
        payloads.append(mem.previously_on_payload(
            [{"id": 1, "played_at": 10.0, "title": "Trivia", "kind": "trivia"}],
            100.0))
        payloads.extend(mem.achievement_payloads(100, 100.0, history_ids=[1],
                                                 first_at=10.0, last_at=10.0))
        blob = " ".join(" ".join(p["lines"]) for p in payloads).lower()
        for phrase in FORBIDDEN:
            self.assertNotIn(phrase, blob)
        self.assertIn("this channel has aired", blob)
        self.assertNotIn("you watched", blob)

    def test_deleted_history_joins_are_skipped(self):
        joined = [
            {"id": 1, "played_at": 30.0, "title": None, "kind": None},
            {"id": 2, "played_at": 20.0, "title": "Still here", "kind": "psa"},
        ]
        payload = mem.previously_on_payload(joined, 100.0)
        self.assertEqual(payload["history_ids"], [2])
        self.assertTrue(any("Still here" in line for line in payload["lines"]))
        self.assertIsNone(mem.previously_on_payload(
            [{"id": 1, "played_at": 30.0, "title": None, "kind": None}], 100.0))


class RefreshBehavior(MemoryHarness):
    def test_empty_history_refresh(self):
        mem.refresh(now=1000.0, render=False)
        self.assertEqual(len(self._rows("previously_on")), 0)
        self.assertEqual(len(self._rows("viewer_achievement")), 0)
        stats = self._rows("channel_statistics")
        self.assertEqual(len(stats), 1)
        payload = self._payload(stats[0])
        self.assertIn("not yet aired", payload["lines"][0].lower())
        self.assertEqual(payload["channel"], "station:live")
        self.assertEqual(payload["valid_until"], 3600.0)
        notes = self._rows("operator_message")
        self.assertEqual(len(notes), 0)

    def test_standby_and_preview_channels_are_ignored(self):
        self._add_playable("t:1", "trivia", "Live trivia")
        self._add_history("t:1", 10.0, channel="station:standby")
        self._add_history("t:1", 11.0, channel="preview")
        mem.refresh(now=100.0, render=False)
        stats = self._payload(self._rows("channel_statistics")[0])
        self.assertIn("not yet aired", stats["lines"][0].lower())
        self.assertEqual(self._rows("previously_on"), [])

    def test_repeat_job_is_idempotent(self):
        self._add_playable("t:1", "trivia", "Trivia one")
        self._add_playable("t:sid", "station_id", "Ident")
        for i in range(25):
            self._add_history("t:1", 10.0 + i)
        self._add_history("t:sid", 40.0)
        mem.refresh(now=100.0, render=False)
        first = self._fingerprint()
        ids = [row["id"] for row in self._rows()]
        mem.refresh(now=100.0, render=False)
        self.assertEqual(self._fingerprint(), first)
        self.assertEqual([row["id"] for row in self._rows()], ids)

    def test_hourly_expiry_updates_window_and_clears_uri(self):
        self._add_playable("t:1", "trivia", "Trivia one")
        self._add_history("t:1", 10.0)
        mem.refresh(now=100.0, render=False)
        with db.conn() as c:
            c.execute("UPDATE playables SET uri=? WHERE kind=?",
                      ("cards/old.mp4", "channel_statistics"))
            c.commit()
        mem.refresh(now=4000.0, render=False)
        row = self._rows("channel_statistics")[0]
        payload = self._payload(row)
        self.assertEqual(payload["window_start"], 3600.0)
        self.assertEqual(payload["valid_until"], 7200.0)
        self.assertIsNone(row["uri"])

    def test_payload_update_preserves_unrelated_keys(self):
        self._add_playable("t:1", "trivia", "Trivia one")
        self._add_history("t:1", 10.0)
        mem.refresh(now=100.0, render=False)
        pid = self._rows("channel_statistics")[0]["id"]
        with db.conn() as c:
            payload = json.loads(c.execute(
                "SELECT payload FROM playables WHERE id=?", (pid,)).fetchone()[0])
            payload["music_credits"] = {"id": "keep-me"}
            payload["other"] = "kept"
            c.execute("UPDATE playables SET payload=? WHERE id=?",
                      (json.dumps(payload), pid))
            c.commit()
        mem.refresh(now=100.0, render=False)
        stored = self._payload(self._rows("channel_statistics")[0])
        self.assertEqual(stored["music_credits"], {"id": "keep-me"})
        self.assertEqual(stored["other"], "kept")
        self.assertIn("creative", stored)

    def test_deleted_join_does_not_crash_and_omits_missing_titles(self):
        self._add_playable("t:keep", "psa", "Keep me")
        self._add_history("t:gone", 50.0)
        self._add_history("t:keep", 40.0)
        mem.refresh(now=100.0, render=False)
        recap = self._rows("previously_on")
        self.assertEqual(len(recap), 1)
        lines = " ".join(self._payload(recap[0])["lines"])
        self.assertIn("Keep me", lines)
        self.assertNotIn("t:gone", lines)

    def test_achievements_use_stable_ids(self):
        self._add_playable("t:1", "trivia", "Trivia")
        for i in range(25):
            self._add_history("t:1", 10.0 + i)
        mem.refresh(now=100.0, render=False)
        first = [row["id"] for row in self._rows("viewer_achievement")]
        self.assertEqual(first, [mem.achievement_id("station:live", "starts", 25)])
        mem.refresh(now=200.0, render=False)
        self.assertEqual([row["id"] for row in self._rows("viewer_achievement")], first)

    def test_render_is_requested_outside_playback_after_change(self):
        self._add_playable("t:1", "trivia", "Trivia")
        self._add_history("t:1", 10.0)
        with mock.patch("bumparr.render_cards.render_all") as render:
            mem.refresh(now=100.0, render=True)
            render.assert_called()

    def test_disabling_every_memory_kind_parks_rows(self):
        self._add_playable("t:1", "trivia", "Trivia")
        for i in range(25):
            self._add_history("t:1", 10.0 + i)
        self.messages.write_text(ENABLED_NOTE, encoding="utf-8")
        mem.reset_runtime_state()
        mem.refresh(now=100.0, render=False)
        self.assertTrue(self._rows("channel_statistics"))
        self.assertTrue(self._rows("previously_on"))
        self.assertTrue(self._rows("viewer_achievement"))
        self.assertTrue(self._rows("operator_message"))
        config.CHANNEL_MEMORY_KINDS = ""
        mem.refresh(now=100.0, render=False)
        for kind in mem.ALL_KINDS:
            rows = self._rows(kind)
            self.assertTrue(rows, kind)
            self.assertTrue(all(row["enabled"] == 0 for row in rows), kind)
        config.CHANNEL_MEMORY_KINDS = "channel_statistics"
        mem.refresh(now=200.0, render=False)
        self.assertTrue(all(r["enabled"] == 1 for r in self._rows("channel_statistics")))
        self.assertTrue(all(r["enabled"] == 0 for r in self._rows("previously_on")))


class OperatorMessages(MemoryHarness):
    def test_shipped_example_is_disabled_and_valid(self):
        config.OPERATOR_MESSAGES = ""
        mem.reset_runtime_state()
        messages, status = mem.load_operator_messages(strict=True)
        self.assertEqual(status["source"], "shipped-default")
        self.assertTrue(status["valid"])
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["id"], "example-note")
        self.assertFalse(messages[0]["enabled"])
        self.assertFalse(mem.message_eligible(messages[0], time.time()))

    def test_config_owns_enable_and_parks_rather_than_deleting(self):
        self.messages.write_text(ENABLED_NOTE, encoding="utf-8")
        mem.reset_runtime_state()
        mem.refresh(now=100.0, render=False)
        rows = self._rows("operator_message")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["enabled"], 1)
        pid = rows[0]["id"]
        self.messages.write_text(EMPTY_YAML, encoding="utf-8")
        mem.reset_runtime_state()
        mem.refresh(now=200.0, render=False)
        parked = self._rows("operator_message")
        self.assertEqual(len(parked), 1)
        self.assertEqual(parked[0]["id"], pid)
        self.assertEqual(parked[0]["enabled"], 0)

    def test_missing_yaml_parks_expired_but_keeps_unexpired(self):
        yaml_text = """\
version: 1
messages:
  - id: keep-note
    lines: ["Still good."]
    enabled: true
    starts_at: null
    ends_at: null
    roles: [any]
  - id: dated-note
    lines: ["This window closed."]
    enabled: true
    starts_at: "2020-01-01T00:00:00Z"
    ends_at: "2020-01-02T00:00:00Z"
    roles: [any]
"""
        self.messages.write_text(yaml_text, encoding="utf-8")
        mem.reset_runtime_state()
        mem.refresh(now=1_577_880_000.0, render=False)  # 2020-01-01 12:00 UTC
        by_id = {row["id"]: row for row in self._rows("operator_message")}
        self.assertEqual(len(by_id), 2)
        keep_id = mem.operator_message_id("keep-note")
        dated_id = mem.operator_message_id("dated-note")
        self.assertEqual(by_id[keep_id]["enabled"], 1)
        self.assertEqual(by_id[dated_id]["enabled"], 1)
        self.messages.unlink()
        mem.reset_runtime_state()
        mem.refresh(now=1_577_966_400.0, render=False)  # 2020-01-02 12:00 UTC
        after = {row["id"]: row for row in self._rows("operator_message")}
        self.assertEqual(after[keep_id]["enabled"], 1)
        self.assertEqual(after[dated_id]["enabled"], 0)

    def test_expiry_parks_the_row(self):
        yaml_text = """\
version: 1
messages:
  - id: dated-note
    lines: ["This window closed."]
    enabled: true
    starts_at: "2020-01-01T00:00:00Z"
    ends_at: "2020-01-02T00:00:00Z"
    roles: [any]
"""
        self.messages.write_text(yaml_text, encoding="utf-8")
        mem.reset_runtime_state()
        mem.refresh(now=1_600_000_000.0, render=False)
        rows = self._rows("operator_message")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["enabled"], 0)

    def test_invalid_messages_are_rejected(self):
        cases = [
            {"id": "Bad ID", "lines": ["Hi."], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["any"]},
            {"id": "dup", "lines": ["Hi."], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["any"]},
            {"id": "empty", "lines": [], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["any"]},
            {"id": "four", "lines": ["a", "b", "c", "d"], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["any"]},
            {"id": "types", "lines": [1], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["any"]},
            {"id": "flag", "lines": ["Hi."], "enabled": "yes",
             "starts_at": None, "ends_at": None, "roles": ["any"]},
            {"id": "order", "lines": ["Hi."], "enabled": True,
             "starts_at": "2020-02-01T00:00:00Z",
             "ends_at": "2020-01-01T00:00:00Z", "roles": ["any"]},
            {"id": "when", "lines": ["Hi."], "enabled": True,
             "starts_at": "not-a-date", "ends_at": None, "roles": ["any"]},
            {"id": "role", "lines": ["Hi."], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["audience"]},
            {"id": "fetch", "lines": ["Hi."], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["any"],
             "url": "https://example.invalid/x"},
        ]
        seen = set()
        validate_message = mem.validate_message
        with self.assertRaises(mem.MemoryConfigError):
            validate_message(cases[0], seen)
        validate_message(
            {"id": "dup", "lines": ["Hi."], "enabled": True,
             "starts_at": None, "ends_at": None, "roles": ["any"]},
            seen)
        seen.add("dup")
        for raw in cases[1:]:
            with self.subTest(id=raw.get("id")):
                with self.assertRaises(mem.MemoryConfigError):
                    validate_message(raw, seen)

    def test_check_cli_accepts_shipped_and_rejects_invalid(self):
        env = dict(os.environ, PYTHONPATH=str(REPO) + os.pathsep + os.environ.get("PYTHONPATH", ""))
        ok = subprocess.run(
            [sys.executable, "-m", "bumparr.generators.channel_memory", "--check"],
            capture_output=True, text=True, env=env, cwd=str(REPO), timeout=30)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        bad = self.root / "bad.yaml"
        bad.write_text("version: 1\nmessages: [{id: nope}]\n", encoding="utf-8")
        env["OPERATOR_MESSAGES"] = str(bad)
        fail = subprocess.run(
            [sys.executable, "-m", "bumparr.generators.channel_memory", "--check"],
            capture_output=True, text=True, env=env, cwd=str(REPO), timeout=30)
        self.assertNotEqual(fail.returncode, 0)

    def test_status_never_includes_a_path(self):
        status = mem.memory_status()
        self.assertEqual(status["channel"], "station:live")
        self.assertNotIn("/", status["messages"]["source"])
        self.assertNotIn("\\", status["messages"]["source"])
        blob = json.dumps(status)
        self.assertNotIn(str(SHIPPED), blob)
        self.assertNotIn(str(self.messages), blob)


class Purity(MemoryHarness):
    def test_status_preview_and_simulation_do_not_write_memory_or_history(self):
        self._add_playable("t:1", "trivia", "Trivia")
        self._add_history("t:1", 10.0)
        before = self._fingerprint()
        from bumparr.app import status
        out = status()
        self.assertIn("memory", out)
        self.assertEqual(self._fingerprint(), before)
        with mock.patch("bumparr.station.playout.Channel.advance") as advance:
            simulate.run(simulate.snapshot_pool(), picks=8, seed=1, start=1000.0)
            advance.assert_not_called()
        self.assertEqual(self._fingerprint(), before)
        mem.refresh(now=100.0, render=False)
        after = self._fingerprint()
        self.assertNotEqual(after, before)
        status()
        simulate.run(simulate.snapshot_pool(), picks=8, seed=1, start=1000.0)
        self.assertEqual(self._fingerprint(), after)


class JobsLoop(MemoryHarness):
    def test_zero_disables_the_loop(self):
        config.CHANNEL_MEMORY_REFRESH = 0
        with mock.patch.object(jobs, "_refresh_channel_memory") as refresh:
            asyncio.run(jobs.channel_memory_loop())
            refresh.assert_not_called()

    def test_cancelled_error_is_reraised(self):
        with mock.patch.object(jobs, "_refresh_channel_memory",
                               side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(jobs._memory_once())

    def test_kind_failure_is_isolated(self):
        self._add_playable("t:1", "trivia", "Trivia")
        self._add_history("t:1", 10.0)
        with mock.patch.object(mem, "_refresh_statistics",
                               side_effect=RuntimeError("boom")):
            results = mem.refresh(now=100.0, render=False)
        self.assertEqual(results["channel_statistics"], "error")
        self.assertTrue(self._rows("previously_on"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
