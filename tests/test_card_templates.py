"""Finite card templates: compatibility, seeds, safe-area, brand modes, ffmpeg."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import Image

from bumparr import config, db, render_cards
from bumparr.channel_profile import default_profile
from bumparr.creative import (
    TEMPLATES,
    TemplateError,
    assign_presentation,
    compatible_templates,
    default_template,
    merge_creative,
    resolve_creative,
    resolve_template,
    with_creative,
    with_presentation,
)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def _row(**kwargs):
    row = {
        "id": "card:psa:test",
        "type": "card",
        "kind": "psa",
        "source": "generated",
        "tags": "",
        "payload": {},
        "title": "A card",
        "duration": 4,
    }
    row.update(kwargs)
    return row


class TemplateCompatibility(unittest.TestCase):
    def test_finite_template_set(self):
        self.assertEqual(
            TEMPLATES,
            ("minimal_center", "minimal_corner", "image_caption",
             "information_board", "signal", "ident"))

    def test_kind_family_compatibility(self):
        self.assertEqual(compatible_templates("psa", "text"),
                         ("minimal_center", "minimal_corner", "image_caption"))
        self.assertEqual(compatible_templates("station_id", "ident"), ("ident",))
        self.assertEqual(compatible_templates("dead_air", "failure"), ("signal",))
        self.assertEqual(compatible_templates("technical_difficulties", "failure"),
                         ("signal",))
        self.assertEqual(compatible_templates("weather", "data"),
                         ("information_board",))
        self.assertEqual(compatible_templates("local_time", "data"),
                         ("information_board",))
        self.assertIn("information_board", compatible_templates("number", "data"))
        self.assertIn("minimal_center", compatible_templates("number", "data"))

    def test_profile_default_used_when_compatible(self):
        profile = default_profile()
        self.assertEqual(profile["presentation"]["default_template"], "minimal_center")
        self.assertEqual(default_template("psa", "text", profile), "minimal_center")
        self.assertEqual(default_template("weather", "data", profile),
                         "information_board")
        self.assertEqual(default_template("dead_air", "failure", profile), "signal")
        self.assertEqual(default_template("station_id", "ident", profile), "ident")

    def test_strict_creation_rejects_incompatible_explicit_template(self):
        with self.assertRaises(TemplateError):
            resolve_template("psa", "text", "signal", strict=True)
        with self.assertRaises(TemplateError):
            resolve_template("weather", "data", "minimal_corner", strict=True)
        self.assertEqual(
            resolve_template("psa", "text", "minimal_corner", strict=True),
            "minimal_corner")

    def test_runtime_falls_back_to_documented_default(self):
        self.assertEqual(resolve_template("psa", "text", "signal", strict=False),
                         "minimal_center")
        self.assertEqual(resolve_template("dead_air", "failure", "minimal_center"),
                         "signal")
        self.assertEqual(resolve_template("weather", "data", "image_caption"),
                         "information_board")
        self.assertEqual(resolve_template("station_id", "ident", "minimal_center"),
                         "ident")

    def test_resolve_creative_infers_compatible_default_without_persisting(self):
        psa = resolve_creative(_row())
        self.assertEqual(psa["template"], "minimal_center")
        ident = resolve_creative(_row(id="station_id:1", kind="station_id", type="video"))
        self.assertEqual(ident["template"], "ident")
        self.assertEqual(ident["brand_mode"], "none")
        fail = resolve_creative(_row(kind="dead_air"))
        self.assertEqual(fail["template"], "signal")


class DeterministicSeeds(unittest.TestCase):
    def test_seed_is_stable_id_hash_not_process_hash(self):
        a = resolve_creative(_row(id="card:psa:alpha"))
        b = resolve_creative(_row(id="card:psa:alpha"))
        c = resolve_creative(_row(id="card:psa:beta"))
        self.assertEqual(a["render_seed"], b["render_seed"])
        self.assertNotEqual(a["render_seed"], c["render_seed"])
        self.assertGreaterEqual(a["render_seed"], 0)
        self.assertNotEqual(a["render_seed"], hash("card:psa:alpha") & 0x7FFFFFFF)
        digest = hashlib.sha256(b"bumparr:render:card:psa:alpha").hexdigest()
        self.assertEqual(a["render_seed"], int(digest[:8], 16))

    def test_assign_presentation_is_deterministic(self):
        row = _row(id="card:psa:seeded")
        first = assign_presentation(row)
        second = assign_presentation(row)
        self.assertEqual(first, second)
        self.assertIn(first["template"], compatible_templates("psa", "text"))
        self.assertGreaterEqual(first["render_seed"], 0)
        self.assertIn(first["brand_mode"], ("reveal", "static", "none"))

    def test_with_presentation_persists_fields_on_new_items(self):
        payload = with_presentation({"lines": ["Hello."]}, _row(id="card:psa:new"))
        cr = payload["creative"]
        self.assertIn(cr["template"], compatible_templates("psa", "text"))
        self.assertGreaterEqual(cr["render_seed"], 0)
        self.assertIn(cr["brand_mode"], ("reveal", "static", "none"))
        self.assertEqual(payload["lines"], ["Hello."])

    def test_with_creative_still_omits_presentation_for_legacy_refresh(self):
        payload = with_creative({"lines": ["Hello."]}, _row(id="card:psa:old"))
        self.assertNotIn("template", payload["creative"])
        self.assertNotIn("render_seed", payload["creative"])
        self.assertNotIn("brand_mode", payload["creative"])


class PersistOnlyOnRender(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = config.DB_PATH
        self.assets = config.ASSET_ROOT
        config.DB_PATH = os.path.join(self.tmp.name, "t.db")
        config.ASSET_ROOT = Path(self.tmp.name) / "assets"
        config.ASSET_ROOT.mkdir()
        self.addCleanup(setattr, config, "DB_PATH", self.db_path)
        self.addCleanup(setattr, config, "ASSET_ROOT", self.assets)
        db.init_db()
        payload = {"lines": ["Legacy card.", "No presentation yet."]}
        with db.conn() as c:
            db.upsert_playable(c, {
                "id": "card:psa:legacy",
                "type": "card",
                "kind": "psa",
                "source": "seed",
                "uri": None,
                "duration": 4,
                "title": "Legacy card.",
                "payload": json.dumps(payload),
                "tags": "",
                "weight": 0.7,
            })
            c.commit()

    def _payload(self):
        with db.conn() as c:
            return json.loads(c.execute(
                "SELECT payload FROM playables WHERE id=?",
                ("card:psa:legacy",)).fetchone()["payload"])

    def test_inspection_and_selection_do_not_persist_seed(self):
        with db.conn() as c:
            row = dict(c.execute("SELECT * FROM playables").fetchone())
        before = self._payload()
        resolve_creative(row)
        from bumparr import selection
        selection.scored_candidates([row])
        self.assertEqual(self._payload(), before)
        self.assertNotIn("creative", before)

    def test_explicit_render_persists_seed_template_and_brand(self):
        with db.conn() as c:
            row = dict(c.execute("SELECT * FROM playables").fetchone())
        with mock.patch.object(render_cards, "_encode", return_value=None), \
                mock.patch.object(Image.Image, "save", lambda *a, **k: None):
            # render_one still needs a real dest file after encode
            def fake_encode(dest, *args, **kwargs):
                Path(dest).write_bytes(b"mp4")
            render_cards._encode = fake_encode
            status, rel = render_cards.render_one(
                row, None, None, "TV", force=True)
        self.assertEqual(status, "rendered")
        # render_one itself does not write the DB; render_all does.
        stamped = render_cards.stamp_presentation(row, rel)
        cr = stamped["creative"]
        self.assertIn(cr["template"], compatible_templates("psa", "text"))
        self.assertGreaterEqual(cr["render_seed"], 0)
        self.assertIn(cr["brand_mode"], ("reveal", "static", "none"))


class SafeAreaLayout(unittest.TestCase):
    def _boxes(self, kind, payload, title, template, brand_mode="reveal"):
        return render_cards.measure_layout(
            kind, payload, title, template=template, brand_mode=brand_mode,
            brand="TV")["boxes"]

    def _assert_safe(self, boxes):
        self.assertTrue(boxes)
        for box in boxes:
            self.assertGreaterEqual(box["x"], render_cards.SAFE_LEFT - 1, box)
            self.assertGreaterEqual(box["y"], render_cards.SAFE_TOP - 1, box)
            self.assertLessEqual(box["x"] + box["w"],
                                 render_cards.SAFE_RIGHT + 1, box)
            self.assertLessEqual(box["y"] + box["h"],
                                 render_cards.SAFE_BOTTOM + 1, box)

    def test_short_and_long_content_stay_in_safe_area(self):
        short = {"lines": ["Stay."]}
        long = {"lines": [
            "This is a considerably longer line that must wrap inside the frame "
            "without leaving the title-safe region of a 1920 by 1080 card.",
            "A second long line repeats the same constraint so wrapping is forced "
            "for both stacked blocks of ordinary prose.",
        ]}
        for template in ("minimal_center", "minimal_corner", "image_caption"):
            for payload in (short, long):
                with self.subTest(template=template, n=len(payload["lines"])):
                    boxes = self._boxes("psa", payload, payload["lines"][0], template)
                    self._assert_safe(boxes)

    def test_information_board_and_signal_safe_area(self):
        number = self._boxes(
            "number", {"number": "42", "meaning": "A small counting number"},
            "42", "information_board")
        self._assert_safe(number)
        signal = self._boxes(
            "technical_difficulties",
            {"text": "PLEASE STAND BY", "variant": "bars"},
            "PLEASE STAND BY", "signal", brand_mode="none")
        self._assert_safe(signal)

    def test_corner_is_not_centered(self):
        boxes = self._boxes("psa", {"lines": ["Stay."]}, "Stay.", "minimal_corner")
        cx = render_cards.W / 2
        self.assertTrue(
            all(box["x"] + box["w"] < cx - 80 or box["x"] > cx + 80 for box in boxes),
            boxes)

    def test_brand_modes_change_layers_not_files(self):
        payload = {"lines": ["A brand test."]}
        reveal = render_cards.measure_layout(
            "psa", payload, "A brand test.", template="minimal_center",
            brand_mode="reveal", brand="TV")
        static = render_cards.measure_layout(
            "psa", payload, "A brand test.", template="minimal_center",
            brand_mode="static", brand="TV")
        none = render_cards.measure_layout(
            "psa", payload, "A brand test.", template="minimal_center",
            brand_mode="none", brand="TV")
        self.assertTrue(any(b["layer"] == "brand" for b in reveal["boxes"]))
        self.assertGreater(reveal["brand_at"], 0)
        self.assertEqual(static["brand_at"], 0)
        self.assertTrue(any(b["layer"] == "brand" for b in static["boxes"]))
        self.assertFalse(any(b["layer"] == "brand" for b in none["boxes"]))
        self.assertGreater(none["brand_at"], none["duration"])


class FfmpegTemplateProbe(unittest.TestCase):
    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe not installed")
    def test_one_card_per_template_has_streams_and_duration(self):
        samples = [
            ("minimal_center", "psa", {"lines": ["Center card."]}),
            ("minimal_corner", "psa", {"lines": ["Corner card."]}),
            ("image_caption", "psa", {"lines": ["Caption card."]}),
            ("information_board", "number",
             {"number": "7", "meaning": "A small prime"}),
            ("signal", "technical_difficulties",
             {"text": "PLEASE STAND BY", "variant": "bars"}),
        ]
        original_root = config.ASSET_ROOT
        with tempfile.TemporaryDirectory() as tmp:
            config.ASSET_ROOT = Path(tmp)
            self.addCleanup(setattr, config, "ASSET_ROOT", original_root)
            for template, kind, payload in samples:
                with self.subTest(template=template):
                    row = {
                        "id": "card:%s:probe" % template,
                        "kind": kind,
                        "title": template,
                        "duration": 2.0,
                        "payload": json.dumps(merge_creative(payload, {
                            "template": template,
                            "render_seed": 1,
                            "brand_mode": "none" if template in ("signal", "ident")
                            else "static",
                        })),
                    }
                    status, rel = render_cards.render_one(
                        row, None, None, "TV", force=True)
                    self.assertEqual(status, "rendered")
                    dest = Path(config.ASSET_ROOT) / rel
                    self.assertTrue(dest.is_file())
                    probe = subprocess.run(
                        ["ffprobe", "-v", "error", "-show_entries",
                         "stream=codec_type,duration", "-of", "json", str(dest)],
                        capture_output=True, text=True, timeout=30)
                    self.assertEqual(probe.returncode, 0, probe.stderr)
                    info = json.loads(probe.stdout)
                    types = {s.get("codec_type") for s in info.get("streams", [])}
                    self.assertIn("video", types)
                    self.assertIn("audio", types)
                    durations = [float(s["duration"]) for s in info["streams"]
                                 if s.get("duration")]
                    self.assertTrue(durations)
                    self.assertGreater(max(durations), 1.5)
                    self.assertLess(max(durations), 3.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
