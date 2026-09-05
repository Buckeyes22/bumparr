"""API contract checks for the bumper pool endpoints.

No httpx in the test env, so no FastAPI TestClient: endpoint-level checks run
the real view functions in a subprocess with DB_PATH/ASSET_ROOT pointed at a
temp dir (config paths bind at import time), while the pure helper and the
route-ordering invariant are asserted in-process.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bumparr.app as webapp
from bumparr.app import _m3u_attr, app

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_CHILD = r"""
import json, sys
from unittest import mock
from bumparr import db
from bumparr.app import fill, random_bumpers, delete_bumper, list_bumpers, status, get_bumper
from fastapi.responses import JSONResponse

db.init_db()
spec = json.loads(sys.argv[1])
with db.conn() as c:
    for row in spec.get("seed", []):
        db.upsert_playable(c, row)
        fields, vals = [], []
        for col in ("enabled", "health", "weight", "uri", "payload"):
            if col in row:
                fields.append("%s=?" % col)
                vals.append(row[col])
        if fields:
            vals.append(row["id"])
            c.execute("UPDATE playables SET %s WHERE id=?" % ", ".join(fields), vals)
    c.commit()
if spec.get("season") is not None:
    mock.patch("bumparr.seasons.factors_now", return_value=spec["season"]).start()
if spec.get("daypart") is not None:
    mock.patch("bumparr.dayparts.factors_now", return_value=spec["daypart"]).start()
action, kw = spec["action"], spec.get("kwargs", {})
if action == "fill":
    out = fill(None, **kw)
elif action == "random":
    out = random_bumpers(None, **kw)
elif action == "get":
    out = get_bumper(**kw)
elif action == "delete":
    out = delete_bumper(**kw)
    if isinstance(out, JSONResponse):
        out = {"__status__": out.status_code, "__body__": json.loads(out.body)}
elif action == "list":
    out = list_bumpers(None, **kw)
elif action == "status":
    out = status()
else:
    raise SystemExit("unknown action %r" % (action,))
if isinstance(out, JSONResponse):
    out = {"__status__": out.status_code, "__body__": json.loads(out.body)}
print(json.dumps(out, default=str))
"""


def _row(i, duration, type="video", kind="ambient"):
    """One enabled, healthy, file-backed pool row for the child to seed."""
    return {"id": "t:item-%d" % i, "type": type, "kind": kind,
            "source": "manual", "uri": "clip-%d.mp4" % i,
            "duration": duration, "title": "Clip %d" % i}


class AppApi(unittest.TestCase):
    """Endpoint-level contracts, each on an isolated temp database."""

    def _run_child(self, action, seed=(), season=None, daypart=None, **kwargs):
        """Run one view function in a subprocess on a temp DB; return its JSON."""
        with tempfile.TemporaryDirectory(prefix="bumparr-api-test-") as tmp:
            env = dict(os.environ)
            env["DB_PATH"] = os.path.join(tmp, "t.db")
            env["ASSET_ROOT"] = os.path.join(tmp, "assets")
            env["DATA_DIR"] = os.path.join(tmp, "data")
            spec = {"action": action, "seed": list(seed), "kwargs": kwargs}
            if season is not None:
                spec["season"] = season
            if daypart is not None:
                spec["daypart"] = daypart
            p = subprocess.run([sys.executable, "-c", _CHILD, json.dumps(spec)],
                               capture_output=True, text=True, timeout=180,
                               env=env, cwd=REPO_ROOT)
            self.assertEqual(p.returncode, 0,
                             "api child failed: %s%s" % (p.stdout, p.stderr))
            return json.loads(p.stdout.strip().splitlines()[-1])

    def test_fill_exactness(self):
        """A pool holding exactly 22+18+7 must fill a 47s gap exactly."""
        seed = [_row(1, 22.0), _row(2, 18.0), _row(3, 7.0)]
        out = self._run_child("fill", seed, seconds=47.0, tolerance=1.5,
                              max_items=8, types=None)
        self.assertTrue(out["exact"], out)
        self.assertAlmostEqual(out["total"], 47.0, places=2)
        self.assertAlmostEqual(out["gap"], 0.0, places=2)
        self.assertEqual(out["count"], 3)
        self.assertEqual(out["requested"], 47.0)
        self.assertEqual({b["id"] for b in out["bumpers"]},
                         {"t:item-1", "t:item-2", "t:item-3"})

    def test_fill_empty_pool_shape(self):
        out = self._run_child("fill", (), seconds=12.0, tolerance=1.5,
                              max_items=8, types=None)
        self.assertEqual(out["count"], 0)
        self.assertFalse(out["exact"])
        self.assertEqual(out["gap"], 12.0)

    def test_random_empty_pool_shape(self):
        """An empty pool returns the empty shape, not an error."""
        out = self._run_child("random", (), count=5, max_duration=None,
                                types=None)
        self.assertEqual(out, {"count": 0, "bumpers": []})

    def test_random_max_duration_applies_to_videos_too(self):
        seed = [_row(1, 10.0, type="video"),
                _row(2, 4.0, type="card")]
        out = self._run_child("random", seed, count=5, max_duration=5,
                              types=None)
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["bumpers"][0]["id"], "t:item-2")

    def test_random_excludes_unrendered_cards(self):
        row = _row(1, 4.0, type="card")
        row["uri"] = None
        out = self._run_child("random", [row], count=5, max_duration=None,
                              types=None)
        self.assertEqual(out, {"count": 0, "bumpers": []})

    def test_random_does_not_revive_season_gated_rows(self):
        """A season factor of 0 is a hard gate; no epsilon may put it back."""
        only_gated = [_row(1, 4.0, kind="christmas")]
        out = self._run_child("random", only_gated, count=5, max_duration=None,
                              types=None, season={"christmas": 0.0})
        self.assertEqual(out, {"count": 0, "bumpers": []})
        mixed = [_row(1, 4.0, kind="christmas"), _row(2, 4.0, kind="ambient")]
        out = self._run_child("random", mixed, count=10, max_duration=None,
                              types=None, season={"christmas": 0.0})
        self.assertEqual({b["id"] for b in out["bumpers"]}, {"t:item-2"})
        self.assertNotIn("selection", out["bumpers"][0])

    def test_random_explain_adds_factors_without_changing_default_shape(self):
        seed = [_row(1, 4.0), _row(2, 4.0)]
        plain = self._run_child("random", seed, count=2, max_duration=None,
                                types=None)
        self.assertTrue(all("selection" not in b for b in plain["bumpers"]))
        explained = self._run_child("random", seed, count=2, max_duration=None,
                                    types=None, explain=True)
        self.assertGreaterEqual(explained["count"], 1)
        for bumper in explained["bumpers"]:
            for key in ("id", "type", "kind", "title", "duration",
                        "media_url", "payload"):
                self.assertIn(key, bumper)
            self.assertEqual(set(bumper["selection"]), {"factors"})
            self.assertEqual(set(bumper["selection"]["factors"]),
                             {"base", "season", "daypart", "recency",
                              "affinity", "fatigue", "score"})
            self.assertGreater(bumper["selection"]["factors"]["score"], 0)

    def test_fill_excludes_season_and_daypart_gates(self):
        seed = [_row(1, 22.0, kind="christmas"),
                _row(2, 18.0, kind="ambient"),
                _row(3, 7.0, kind="ambient")]
        out = self._run_child("fill", seed, seconds=47.0, tolerance=1.5,
                              max_items=8, types=None,
                              season={"christmas": 0.0})
        ids = {b["id"] for b in out["bumpers"]}
        self.assertNotIn("t:item-1", ids)
        self.assertFalse(out["exact"])
        only_gated = [_row(1, 22.0, kind="christmas"),
                      _row(2, 40.0, kind="ambient")]
        gated = self._run_child("fill", only_gated, seconds=22.0, tolerance=0.05,
                                max_items=8, types=None,
                                season={"christmas": 0.0})
        self.assertEqual(gated["count"], 0)
        daypart_gated = self._run_child(
            "fill", only_gated, seconds=22.0, tolerance=0.05,
            max_items=8, types=None, daypart={"christmas": 0.0})
        self.assertEqual(daypart_gated["count"], 0)

    def test_get_explain_reports_disabled_unhealthy_and_missing_media(self):
        row = _row(1, 4.0, type="card")
        row["uri"] = None
        row["enabled"] = 0
        row["health"] = "dead"
        row["weight"] = 0.0
        out = self._run_child("get", [row], bumper_id="t:item-1", explain=True)
        sel = out["selection"]
        self.assertFalse(sel["eligible_now"])
        self.assertEqual(sel["reasons"],
                         ["disabled", "unhealthy", "missing_media", "base_weight"])
        self.assertEqual(sel["factors"]["score"], 0.0)
        self.assertEqual(sel["factors"]["base"], 0.0)

    def test_get_explain_uses_eligible_pool_for_affinity_context(self):
        seed = [_row(1, 4.0, kind="ambient"), _row(2, 4.0, kind="ambient")]
        seed[0]["enabled"] = 0
        out = self._run_child("get", seed, bumper_id="t:item-1", explain=True)
        self.assertEqual(out["selection"]["reasons"], ["disabled"])
        self.assertFalse(out["selection"]["eligible_now"])
        healthy = self._run_child("get", [_row(1, 4.0)], bumper_id="t:item-1",
                                  explain=True)
        self.assertEqual(healthy["selection"]["reasons"], ["eligible"])
        self.assertTrue(healthy["selection"]["eligible_now"])
        self.assertNotIn("selection", self._run_child(
            "get", [_row(1, 4.0)], bumper_id="t:item-1"))

    def test_delete_unknown_id_404(self):
        """Deleting a missing id is a 404 with a stable body."""
        out = self._run_child("delete", (), bumper_id="does-not-exist")
        self.assertEqual(out["__status__"], 404)
        self.assertEqual(out["__body__"], {"error": "not found"})

    def test_list_limit_bound(self):
        """The list limit caps returned rows; a large limit returns the pool."""
        seed = [_row(i, 10.0) for i in range(5)]
        out = self._run_child("list", seed, limit=2, offset=0)
        self.assertEqual(out["count"], 2)
        out = self._run_child("list", seed, limit=100, offset=0)
        self.assertEqual(out["count"], 5)

    def test_search_finds_match_beyond_first_page(self):
        seed = [_row(i, 10.0) for i in range(30)]
        seed[0]["title"] = "Needle at the old end"
        out = self._run_child("list", seed, q="needle", limit=24, offset=0)
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["bumpers"][0]["title"], "Needle at the old end")

    def test_status_accumulates_kind_across_types(self):
        seed = [_row(1, 10.0, type="video", kind="shared"),
                _row(2, 10.0, type="card", kind="shared")]
        out = self._run_child("status", seed)
        self.assertEqual(out["by_kind"]["shared"], 2)
        self.assertEqual(out["by_type"], {"card": 1, "video": 1})

    def test_m3u_attr_mapping(self):
        """Quotes and newlines are replaced; commas survive inside the quotes."""
        self.assertEqual(_m3u_attr('Say "hi", now\ntomorrow\rend'),
                         "Say 'hi', now tomorrow end")

    def test_full_playlist_keeps_commas_and_stays_one_line_per_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            originals = (webapp.config.DB_PATH, webapp.config.ASSET_ROOT,
                         webapp.config.OUTPUT_DIR, webapp.config.PUBLIC_BASE_URL)
            webapp.config.DB_PATH = str(Path(tmp) / "m3u.db")
            webapp.config.ASSET_ROOT = Path(tmp) / "assets"
            webapp.config.OUTPUT_DIR = webapp.config.ASSET_ROOT / "bumpers"
            webapp.config.PUBLIC_BASE_URL = "http://bumparr.test"
            self.addCleanup(setattr, webapp.config, "DB_PATH", originals[0])
            self.addCleanup(setattr, webapp.config, "ASSET_ROOT", originals[1])
            self.addCleanup(setattr, webapp.config, "OUTPUT_DIR", originals[2])
            self.addCleanup(setattr, webapp.config, "PUBLIC_BASE_URL", originals[3])
            webapp.db.init_db()
            with webapp.db.conn() as connection:
                connection.execute(
                    "INSERT INTO playables (id,type,kind,uri,duration,title) "
                    "VALUES (?,?,?,?,?,?)",
                    ("v", "video", "news", "news/a.mp4", 3,
                     'Say "hi", now\ntomorrow\rend'),
                )
            body = webapp.playlist_m3u(None).body.decode("utf-8")
        lines = body.splitlines()
        self.assertEqual(len(lines), 3)
        self.assertIn('tvg-name="Say \'hi\', now tomorrow end"', lines[1])
        self.assertTrue(lines[2].startswith("http://bumparr.test/media/"))

    def test_fill_route_declared_before_bumper_id(self):
        """The /fill route must precede /{bumper_id:path} or it is swallowed."""
        order = [(getattr(r, "path", None), getattr(r, "methods", None))
                 for r in app.routes]
        fill_i = next(i for i, (p, m) in enumerate(order)
                      if p == "/api/bumpers/fill" and m and "GET" in m)
        wild_i = next(i for i, (p, m) in enumerate(order)
                      if p == "/api/bumpers/{bumper_id:path}" and m and "GET" in m)
        self.assertLess(fill_i, wild_i,
                        "/api/bumpers/fill must be declared before "
                        "/api/bumpers/{bumper_id:path}")

    def test_dashboard_missing_or_undecodable_file_is_stable_500(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp)
            with mock.patch.object(webapp, "WEB_DIR", web):
                missing = webapp.dashboard()
                self.assertEqual(missing.status_code, 500)
                (web / "index.html").write_bytes(b"\xff\xfe")
                undecodable = webapp.dashboard()
                self.assertEqual(undecodable.status_code, 500)
            self.assertEqual(json.loads(missing.body),
                             {"error": "dashboard unavailable"})
            self.assertEqual(json.loads(undecodable.body),
                             {"error": "dashboard unavailable"})


class HttpValidation(unittest.TestCase):
    """Exercise FastAPI's Query validation through a real ASGI HTTP server."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="bumparr-http-test-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        env = dict(os.environ,
                   DB_PATH=os.path.join(cls.tmp.name, "http.db"),
                   ASSET_ROOT=os.path.join(cls.tmp.name, "assets"),
                   DATA_DIR=os.path.join(cls.tmp.name, "data"),
                   WINDOW_REFRESH="0",
                   PYTHONPATH=REPO_ROOT + os.pathsep + os.environ.get("PYTHONPATH", ""))
        cls.proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "bumparr.app:app", "--host",
             "127.0.0.1", "--port", str(cls.port), "--log-level", "error"],
            cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                out, err = cls.proc.communicate()
                raise AssertionError("uvicorn failed to start: %s%s" % (out, err))
            try:
                with urllib.request.urlopen(
                        "http://127.0.0.1:%d/healthz" % cls.port, timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, urllib.error.URLError):
                time.sleep(0.05)
        else:
            cls.proc.terminate()
            out, err = cls.proc.communicate(timeout=5)
            raise AssertionError("uvicorn did not become ready: %s%s" % (out, err))

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.communicate(timeout=5)
        cls.tmp.cleanup()

    def _status(self, path, method="GET"):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path), method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            try:
                return exc.code
            finally:
                exc.close()

    def _json(self, path):
        with urllib.request.urlopen(
                "http://127.0.0.1:%d%s" % (self.port, path), timeout=5) as response:
            return json.load(response)

    def test_numeric_query_bounds_are_enforced_by_fastapi(self):
        cases = [
            ("/api/bumpers?limit=0", "GET"),
            ("/api/bumpers?offset=-1", "GET"),
            ("/api/bumpers/random?count=0", "GET"),
            ("/api/bumpers/random?max_duration=0", "GET"),
            ("/api/bumpers/random?explain=maybe", "GET"),
            ("/api/bumpers/nope?explain=maybe", "GET"),
            ("/api/bumpers/fill?seconds=0", "GET"),
            ("/api/bumpers/fill?seconds=5&tolerance=3601", "GET"),
            ("/api/starter?limit=0", "POST"),
            ("/api/render/cards?limit=1001", "POST"),
            ("/api/generate/trivia?n=101", "POST"),
        ]
        for path, method in cases:
            with self.subTest(path=path):
                self.assertEqual(self._status(path, method), 422)

    def test_query_types_search_length_and_type_allowlist(self):
        self.assertEqual(self._status("/api/bumpers?limit=nope"), 422)
        self.assertEqual(self._status("/api/bumpers?q=" + "x" * 101), 422)
        self.assertEqual(self._status("/api/bumpers/random?types=video,evil"), 400)
        self.assertEqual(self._status("/api/bumpers/fill?seconds=5&types=evil"), 400)

    def test_random_default_count_contract_over_http(self):
        result = self._json("/api/bumpers/random")
        self.assertLessEqual(result["count"], 5)
        self.assertEqual(result["count"], len(result["bumpers"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
