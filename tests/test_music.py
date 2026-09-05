"""Music manifest, credits, loudness, compatibility, and silence fallback."""
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import config, creative, music, produce, render_cards, sequence, simulate

REPO = Path(__file__).resolve().parents[1]
SHIPPED = REPO / "bumparr" / "config_files" / "music_beds.yaml"
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))

BED_TEMPLATE = """\
version: 1
beds:
  - id: {ident}
    path: {path}
    title: {title}
    creator: {creator}
    source_page: {source_page}
    license: {license}
    license_url: {license_url}
    attribution: "{attribution}"
    energy: {energy}
    families: {families}
    enabled: {enabled}
    operator_owned: {operator_owned}
"""


def _bed_yaml(**kwargs):
    families = kwargs.get("families", ["text", "scenic", "data"])
    if isinstance(families, (list, tuple)):
        families = "[" + ", ".join(families) + "]"
    values = {
        "ident": "night-room-01",
        "path": "night-room-01.flac",
        "title": "Night Room",
        "creator": "Example Artist",
        "source_page": "https://example.invalid/night-room",
        "license": "CC0-1.0",
        "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "attribution": "",
        "energy": "quiet",
        "families": families,
        "enabled": "true",
        "operator_owned": "false",
    }
    values.update(kwargs)
    if isinstance(values.get("enabled"), bool):
        values["enabled"] = "true" if values["enabled"] else "false"
    if isinstance(values.get("operator_owned"), bool):
        values["operator_owned"] = "true" if values["operator_owned"] else "false"
    return BED_TEMPLATE.format(**values)


class MusicHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sound = Path(self.tmp.name) / "sounds"
        self.sound.mkdir()
        self.assets = Path(self.tmp.name) / "assets"
        self.assets.mkdir()
        self._orig = (
            config.SOUND_DIR, config.ASSET_ROOT, config.MUSIC_MANIFEST,
            config.ALLOW_UNMANIFESTED_MUSIC,
        )
        config.SOUND_DIR = self.sound
        config.ASSET_ROOT = self.assets
        config.MUSIC_MANIFEST = ""
        config.ALLOW_UNMANIFESTED_MUSIC = ""
        music.reset_runtime_state()
        self.addCleanup(self._restore)

    def _restore(self):
        (config.SOUND_DIR, config.ASSET_ROOT, config.MUSIC_MANIFEST,
         config.ALLOW_UNMANIFESTED_MUSIC) = self._orig
        music.reset_runtime_state()

    def _write_file(self, rel="night-room-01.flac", data=b"audio"):
        path = self.sound / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def _write_manifest(self, text, name="music_beds.yaml"):
        path = Path(self.tmp.name) / name
        path.write_text(text, encoding="utf-8")
        config.MUSIC_MANIFEST = str(path)
        music.reset_runtime_state()
        return path


class ShippedManifest(MusicHarness):
    def test_empty_shipped_yaml_is_valid(self):
        loaded = music.load_manifest(SHIPPED, strict=True)
        self.assertEqual(loaded, [])
        self.assertTrue(SHIPPED.is_file())
        text = SHIPPED.read_text(encoding="utf-8")
        self.assertIn("version: 1", text)
        self.assertIn("beds: []", text)
        self.assertNotIn("id:", text.split("beds: []", 1)[1] if "beds: []" in text else text)

    def test_check_cli_accepts_shipped_empty_manifest(self):
        env = dict(os.environ, PYTHONPATH=str(REPO))
        env.pop("MUSIC_MANIFEST", None)
        env.pop("ALLOW_UNMANIFESTED_MUSIC", None)
        ok = subprocess.run(
            [sys.executable, "-m", "bumparr.music", "--check"],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("ok", ok.stdout.lower())


class ManifestValidation(MusicHarness):
    def test_valid_entry_loads_with_credits(self):
        self._write_file()
        self._write_manifest(_bed_yaml())
        beds = music.load_manifest(strict=True)
        self.assertEqual(len(beds), 1)
        bed = beds[0]
        self.assertEqual(bed.id, "night-room-01")
        self.assertEqual(bed.title, "Night Room")
        self.assertEqual(bed.creator, "Example Artist")
        self.assertEqual(bed.license, "CC0-1.0")
        self.assertEqual(bed.energy, "quiet")
        self.assertIn("scenic", bed.families)
        self.assertTrue(bed.enabled)
        self.assertFalse(bed.operator_owned)
        snap = music.snapshot_credits(bed)
        self.assertEqual(
            set(snap),
            {"id", "title", "creator", "source_page", "license", "license_url",
             "attribution"})
        self.assertEqual(snap["id"], "night-room-01")
        self.assertEqual(snap["title"], "Night Room")

    def test_duplicate_ids_fail_strict_and_are_skipped_at_runtime(self):
        self._write_file("a.flac")
        self._write_file("b.flac")
        text = _bed_yaml(ident="dup-id", path="a.flac") + """\
  - id: dup-id
    path: b.flac
    title: Other
    creator: Other
    source_page: ""
    license: CC0-1.0
    license_url: ""
    attribution: ""
    energy: quiet
    families: [scenic]
    enabled: true
    operator_owned: false
"""
        self._write_manifest(text)
        with self.assertRaises(music.MusicError) as ctx:
            music.load_manifest(strict=True)
        self.assertIn("dup", str(ctx.exception).lower())
        runtime = music.load_manifest(strict=False)
        ids = [bed.id for bed in runtime]
        self.assertEqual(ids.count("dup-id"), 1)

    def test_required_fields_and_id_pattern(self):
        self._write_file()
        for kwargs in (
                {"ident": "Bad ID"},
                {"ident": ""},
                {"ident": "-leading"},
                {"ident": "x" * 81},
                {"path": ""},
                {"title": "x" * 501},
                {"energy": "blaring"},
                {"families": "[jingle]"},
                {"enabled": "maybe"},
        ):
            self._write_manifest(_bed_yaml(**kwargs), name="bad.yaml")
            with self.subTest(kwargs):
                with self.assertRaises(music.MusicError):
                    music.load_manifest(strict=True)

    def test_path_longer_than_500_is_rejected(self):
        rel = "a" * 501 + ".flac"
        self._write_manifest(_bed_yaml(path=rel))
        with self.assertRaises(music.MusicError):
            music.load_manifest(strict=True)

    def test_unknown_family_is_rejected(self):
        self._write_file()
        self._write_manifest(_bed_yaml(families="[text, jingle]"))
        with self.assertRaises(music.MusicError) as ctx:
            music.load_manifest(strict=True)
        self.assertIn("family", str(ctx.exception).lower())

    def test_unreadable_path_fails_strict_and_is_skipped_runtime(self):
        self._write_manifest(_bed_yaml(path="missing.flac"))
        with self.assertRaises(music.MusicError):
            music.load_manifest(strict=True)
        runtime = music.load_manifest(strict=False)
        self.assertEqual(runtime, [])

    def test_disabled_bed_is_valid_but_not_selectable(self):
        self._write_file()
        self._write_manifest(_bed_yaml(enabled=False))
        beds = music.load_manifest(strict=True)
        self.assertEqual(len(beds), 1)
        self.assertFalse(beds[0].enabled)
        self.assertEqual(music.selectable_beds(), [])
        self.assertIsNone(music.pick_bed("scenic", "quiet", random.Random(1)))


class Traversal(MusicHarness):
    def test_absolute_and_parent_escape_are_rejected(self):
        outside = Path(self.tmp.name) / "outside.flac"
        outside.write_bytes(b"secret")
        for rel in (str(outside), "../outside.flac"):
            self._write_manifest(_bed_yaml(path=rel), name="esc.yaml")
            with self.assertRaises(music.MusicError):
                music.load_manifest(strict=True)
            self.assertEqual(music.load_manifest(strict=False), [])

    def test_escaping_symlink_is_never_followed(self):
        outside = Path(self.tmp.name) / "secret.flac"
        outside.write_bytes(b"secret")
        link = self.sound / "escape.flac"
        os.symlink(outside, link)
        self._write_manifest(_bed_yaml(path="escape.flac"))
        with self.assertRaises(music.MusicError):
            music.load_manifest(strict=True)
        self.assertEqual(music.load_manifest(strict=False), [])
        self.assertIsNone(music.resolve_playable(
            {"creative": {"music_id": "night-room-01"}}))

    def test_contained_regular_file_resolves(self):
        path = self._write_file()
        self._write_manifest(_bed_yaml())
        bed = music.resolve_playable({"creative": {"music_id": "night-room-01"}})
        self.assertIsNotNone(bed)
        self.assertEqual(Path(bed.resolved_path), path)


class CompatibilityMode(MusicHarness):
    def test_flag_defaults_off_and_requires_exact_one(self):
        self.assertFalse(music.allow_unmanifested())
        config.ALLOW_UNMANIFESTED_MUSIC = "true"
        self.assertFalse(music.allow_unmanifested())
        config.ALLOW_UNMANIFESTED_MUSIC = "1"
        self.assertTrue(music.allow_unmanifested())

    def test_legacy_payload_music_ignored_without_flag(self):
        audio = self.assets / "music" / "good.mp3"
        audio.parent.mkdir()
        audio.write_bytes(b"audio")
        payload = {"music": "music/good.mp3"}
        self.assertIsNone(music.resolve_playable(payload))
        self.assertIsNone(render_cards._music_bed(payload))

    def test_legacy_payload_music_works_only_in_compatibility_mode(self):
        audio = self.assets / "music" / "good.mp3"
        audio.parent.mkdir()
        audio.write_bytes(b"audio")
        outside = Path(self.tmp.name) / "outside.mp3"
        outside.write_bytes(b"secret")
        os.symlink(outside, self.assets / "escape.mp3")
        config.ALLOW_UNMANIFESTED_MUSIC = "1"
        payload = {"music": "music/good.mp3"}
        bed = music.resolve_playable(payload)
        self.assertIsNotNone(bed)
        self.assertTrue(bed.operator_owned)
        snap = music.snapshot_credits(bed)
        self.assertEqual(snap["title"], "")
        self.assertEqual(snap["creator"], "")
        self.assertEqual(snap["license"], "")
        self.assertEqual(snap["attribution"], "")
        self.assertNotIn("unknown artist", json.dumps(snap).lower())
        self.assertEqual(render_cards._music_bed(payload), str(audio.resolve()))
        for value in (str(outside), "../outside.mp3", "escape.mp3"):
            self.assertIsNone(render_cards._music_bed({"music": value}))

    def test_unmanifested_sound_dir_files_are_operator_owned_uncredited(self):
        self._write_file("loose.wav")
        config.ALLOW_UNMANIFESTED_MUSIC = "1"
        self._write_manifest("version: 1\nbeds: []\n")
        beds = music.selectable_beds()
        self.assertEqual(len(beds), 1)
        self.assertTrue(beds[0].operator_owned)
        snap = music.snapshot_credits(beds[0])
        self.assertEqual(snap["title"], "")
        self.assertEqual(snap["creator"], "")
        self.assertEqual(snap["license"], "")
        self.assertNotRegex(json.dumps(snap).lower(), r"unknown|example artist|anonymous")

    def test_unmanifested_scan_skips_escaping_symlink(self):
        outside = Path(self.tmp.name) / "secret.wav"
        outside.write_bytes(b"secret")
        os.symlink(outside, self.sound / "escape.wav")
        config.ALLOW_UNMANIFESTED_MUSIC = "1"
        self._write_manifest("version: 1\nbeds: []\n")
        self.assertEqual(music.selectable_beds(), [])


class PairingAndSilence(MusicHarness):
    def test_pairs_enabled_family_energy_and_avoids_recent(self):
        self._write_file("quiet-text.flac")
        self._write_file("loud-scenic.flac")
        text = _bed_yaml(ident="quiet-text", path="quiet-text.flac",
                         energy="quiet", families="[text]")
        text += _bed_yaml(ident="loud-scenic", path="loud-scenic.flac",
                          energy="loud", families="[scenic]").split("beds:\n", 1)[1]
        self._write_manifest(text)
        rng = random.Random(0)
        self.assertEqual(music.pick_bed("text", "quiet", rng).id, "quiet-text")
        self.assertIsNone(music.pick_bed("text", "loud", rng))
        self.assertIsNone(music.pick_bed("scenic", "quiet", rng))
        self.assertEqual(music.pick_bed("scenic", "loud", rng).id, "loud-scenic")
        other = self._write_file("quiet-text-2.flac")
        del other
        extra = _bed_yaml(ident="quiet-text-2", path="quiet-text-2.flac",
                          energy="quiet", families="[text]")
        self._write_manifest(text + extra.split("beds:\n", 1)[1])
        music.reset_runtime_state()
        picked = music.pick_bed("text", "quiet", random.Random(0),
                                recent_ids=["quiet-text"])
        self.assertEqual(picked.id, "quiet-text-2")
        # With no alternative, unavoidable reuse is allowed.
        self.assertEqual(
            music.pick_bed("scenic", "loud", rng, recent_ids=["loud-scenic"]).id,
            "loud-scenic")

    def test_missing_disabled_unreadable_become_silence(self):
        self._write_file("ok.flac")
        text = _bed_yaml(ident="ok-bed", path="ok.flac")
        text += _bed_yaml(ident="off-bed", path="ok.flac", enabled=False).split(
            "beds:\n", 1)[1]
        self._write_manifest(text)
        self.assertIsNotNone(music.resolve_playable({"creative": {"music_id": "ok-bed"}}))
        self.assertIsNone(music.resolve_playable({"creative": {"music_id": "off-bed"}}))
        self.assertIsNone(music.resolve_playable({"creative": {"music_id": "missing"}}))
        self.assertIsNone(music.resolve_playable({}))
        payload = {"lines": ["Stay."], "creative": {"audio": "native"}}
        self.assertIsNone(music.resolve_playable(payload))
        silent = music.apply_playable_audio({"keep": 1, "creative": {"audio": "music"}}, None)
        self.assertEqual(silent["keep"], 1)
        self.assertEqual(silent["creative"]["audio"], "silence")
        self.assertIsNone(silent["creative"].get("music_id"))
        self.assertNotIn("music_credits", silent)

    def test_native_designed_and_silence_stay_distinct(self):
        native = music.apply_playable_audio(
            {"creative": {"audio": "native"}}, None, preserve_non_music=True)
        designed = music.apply_playable_audio(
            {"creative": {"audio": "designed"}}, None, preserve_non_music=True)
        self.assertEqual(native["creative"]["audio"], "native")
        self.assertEqual(designed["creative"]["audio"], "designed")
        self.assertNotEqual(native["creative"]["audio"], "silence")
        self.assertNotEqual(designed["creative"]["audio"], "music")


class CreditsAndAttribution(MusicHarness):
    def test_cc0_does_not_require_onscreen_attribution(self):
        self._write_file()
        self._write_manifest(_bed_yaml())
        bed = music.load_manifest(strict=True)[0]
        self.assertFalse(music.attribution_required(bed.license))
        self.assertEqual(music.onscreen_attribution(music.snapshot_credits(bed)), "")

    def test_cc_by_uses_truthful_attribution_only(self):
        credits = {
            "id": "by-1", "title": "Night Room", "creator": "Example Artist",
            "source_page": "https://example.invalid/night-room",
            "license": "CC-BY-4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "attribution": "",
        }
        self.assertTrue(music.attribution_required(credits["license"]))
        self.assertIn("Night Room", music.onscreen_attribution(credits))
        self.assertIn("Example Artist", music.onscreen_attribution(credits))
        empty = dict(credits, title="", creator="", attribution="")
        self.assertEqual(music.onscreen_attribution(empty), "")

    def test_apply_credits_preserves_unrelated_payload_keys(self):
        self._write_file()
        self._write_manifest(_bed_yaml())
        bed = music.load_manifest(strict=True)[0]
        out = music.apply_playable_audio(
            {"lines": ["Stay."], "keep": True, "creative": {"template": "minimal_center"}},
            bed)
        self.assertEqual(out["lines"], ["Stay."])
        self.assertTrue(out["keep"])
        self.assertEqual(out["creative"]["template"], "minimal_center")
        self.assertEqual(out["creative"]["music_id"], "night-room-01")
        self.assertEqual(out["creative"]["audio"], "music")
        self.assertEqual(out["music_credits"]["creator"], "Example Artist")


class LoudnessPolicy(MusicHarness):
    def test_documented_targets_and_aac_filter(self):
        self.assertEqual(music.TARGET_LUFS, -16.0)
        self.assertEqual(music.TRUE_PEAK_DB, -1.5)
        filt = music.audio_filter(8.0, offset=1.25)
        self.assertIn("loudnorm", filt)
        self.assertIn("I=-16", filt)
        self.assertIn("TP=-1.5", filt)
        self.assertIn("afade", filt)
        self.assertIn("48000", filt)
        self.assertIn("stereo", filt)

    def test_normalize_failure_unlinks_partial(self):
        dest = Path(self.tmp.name) / "partial.m4a"
        dest.write_bytes(b"partial")
        with mock.patch.object(music.subprocess, "run",
                               side_effect=RuntimeError("ffmpeg failed")):
            with self.assertRaises(Exception):
                music.normalize_excerpt(self._write_file(), dest, duration=2.0)
        self.assertFalse(dest.exists())

    @unittest.skipUnless(HAS_FFMPEG, "ffmpeg/ffprobe not installed")
    def test_normalized_excerpt_meets_lufs_tolerance(self):
        src = Path(self.tmp.name) / "sine.wav"
        made = subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=3",
             "-ar", "44100", "-ac", "1", str(src)],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(made.returncode, 0, made.stderr)
        dest = Path(self.tmp.name) / "out.m4a"
        music.normalize_excerpt(src, dest, duration=2.0, offset=0.2)
        self.assertTrue(dest.is_file())
        self.assertGreater(dest.stat().st_size, 0)
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_name,sample_rate,channels", "-of", "json", str(dest)],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(probe.returncode, 0, probe.stderr)
        info = json.loads(probe.stdout)
        stream = info["streams"][0]
        self.assertEqual(stream["codec_name"], "aac")
        self.assertEqual(int(stream["sample_rate"]), 48000)
        self.assertEqual(int(stream["channels"]), 2)
        measured = music.measure_loudness(dest)
        self.assertIsNotNone(measured)
        self.assertAlmostEqual(float(measured["input_i"]), music.TARGET_LUFS,
                               delta=music.LUFS_TOLERANCE)
        self.assertLessEqual(float(measured["input_tp"]), music.TRUE_PEAK_DB + 0.5)


class ProduceAndRenderConsumers(MusicHarness):
    def test_sound_pool_uses_manifest_not_directory_scan(self):
        self._write_file("loose.wav")
        self._write_manifest("version: 1\nbeds: []\n")
        self.assertEqual(produce.sound_pool(), [])
        config.ALLOW_UNMANIFESTED_MUSIC = "1"
        music.reset_runtime_state()
        self.assertEqual(len(produce.sound_pool()), 1)

    def test_produce_silence_fallback_leaves_no_partial(self):
        originals = (config.DB_PATH, config.VIDEO_DIR, config.OUTPUT_DIR)
        config.DB_PATH = str(Path(self.tmp.name) / "p.db")
        config.VIDEO_DIR = Path(self.tmp.name) / "src"
        config.OUTPUT_DIR = Path(self.tmp.name) / "out"
        config.VIDEO_DIR.mkdir()
        config.OUTPUT_DIR.mkdir()
        self.addCleanup(setattr, config, "DB_PATH", originals[0])
        self.addCleanup(setattr, config, "VIDEO_DIR", originals[1])
        self.addCleanup(setattr, config, "OUTPUT_DIR", originals[2])
        source = config.VIDEO_DIR / "clip.mp4"
        source.write_bytes(b"source")
        self._write_file()
        self._write_manifest(_bed_yaml())
        from bumparr import db
        db.init_db()
        produce.ADD_SOUND_MIN = produce.ADD_SOUND_MAX = 1.0
        self.addCleanup(setattr, produce, "ADD_SOUND_MIN", 0.40)
        self.addCleanup(setattr, produce, "ADD_SOUND_MAX", 0.75)

        def cut(_src, dest, *args, **kwargs):
            dest.parent.mkdir(parents=True, exist_ok=True)
            if kwargs.get("bed"):
                dest.write_bytes(b"partial")
                raise RuntimeError("bed encode failed")
            dest.write_bytes(b"silent-ok")

        with mock.patch.object(produce, "duration_of",
                               side_effect=lambda p: 100 if Path(p) == source else 8), \
                mock.patch.object(produce, "scene_cuts", return_value=[]), \
                mock.patch.object(produce, "plan_windows", return_value=[(1.0, 5.0)]), \
                mock.patch.object(produce, "mean_volume", return_value=-80), \
                mock.patch.object(produce, "cut_clip", side_effect=cut), \
                mock.patch.object(produce.brandslam, "roll", return_value=None), \
                mock.patch.object(produce.brandslam, "static_face", return_value=None), \
                mock.patch.object(music, "normalize_excerpt",
                                  lambda *a, **k: Path(a[1]).write_bytes(b"aac")):
            made, err = produce.produce_from_source(
                source, "ambient", random.Random(1), [], produce.sound_pool(), ({}, {}))
        self.assertIsNone(err)
        self.assertEqual(len(made), 1)
        self.assertEqual(made[0][2], "silent")
        dest = config.OUTPUT_DIR / made[0][0]
        self.assertEqual(dest.read_bytes(), b"silent-ok")
        with db.conn() as c:
            row = dict(c.execute("SELECT payload FROM playables").fetchone())
        payload = json.loads(row["payload"])
        self.assertEqual(payload["creative"]["audio"], "silence")
        self.assertIsNone(payload["creative"].get("music_id"))
        self.assertNotIn("music_credits", payload)

    def test_status_source_is_never_a_path(self):
        status = music.manifest_status()
        self.assertEqual(set(status), {"version", "valid", "source", "enabled_beds",
                                       "compatibility"})
        self.assertNotIn("/", status["source"])
        self.assertNotIn("\\", status["source"])
        self.assertIn(status["source"],
                      ("shipped-default", "custom", "fallback-after-error"))
        self._write_file()
        path = self._write_manifest(_bed_yaml())
        status = music.manifest_status()
        self.assertEqual(status["source"], "custom")
        self.assertNotIn(str(path), status["source"])
        self.assertTrue(status["valid"])
        self.assertEqual(status["enabled_beds"], 1)


class SequenceDiagnostics(unittest.TestCase):
    def test_repeated_beds_treatments_and_energy_jumps(self):
        views = [
            {"id": "a", "family": "scenic", "energy": "quiet", "audio": "music",
             "music_id": "bed-1", "text_heavy": False, "roles": []},
            {"id": "b", "family": "archive", "energy": "loud", "audio": "music",
             "music_id": "bed-1", "text_heavy": False, "roles": []},
            {"id": "c", "family": "text", "energy": "quiet", "audio": "silence",
             "music_id": None, "text_heavy": True, "roles": []},
        ]
        diag = sequence.sequence_diagnostics(views)
        self.assertEqual(diag["music_repeats"], 1)
        self.assertEqual(diag["energy_jumps"], 2)
        self.assertEqual(diag["treatment_shares"]["music"]["count"], 2)
        self.assertEqual(diag["treatment_shares"]["silence"]["count"], 1)
        self.assertIn("share", diag["treatment_shares"]["music"])

    def test_simulate_report_includes_new_diagnostics(self):
        rows = [
            {"id": "t:1", "type": "video", "kind": "ambient", "source": "manual",
             "uri": "a.mp4", "duration": 10.0, "title": "A", "weight": 1.0,
             "payload": json.dumps({"creative": {
                 "family": "scenic", "roles": ["any"], "energy": "quiet",
                 "audio": "music", "music_id": "bed-1", "text_heavy": False}}),
             "enabled": 1, "health": "ok", "play_count": 0, "last_played": None},
            {"id": "t:2", "type": "video", "kind": "archive", "source": "manual",
             "uri": "b.mp4", "duration": 10.0, "title": "B", "weight": 1.0,
             "payload": json.dumps({"creative": {
                 "family": "archive", "roles": ["any"], "energy": "loud",
                 "audio": "native", "music_id": None, "text_heavy": False}}),
             "enabled": 1, "health": "ok", "play_count": 0, "last_played": None},
        ]
        report = simulate.run(rows, picks=12, seed=3, start=1_700_000_000.0)
        for key in ("music_repeats", "energy_jumps", "treatment_shares"):
            self.assertIn(key, report)
        self.assertIsInstance(report["music_repeats"], int)
        self.assertIsInstance(report["energy_jumps"], int)
        self.assertTrue(report["treatment_shares"])
        self.assertGreaterEqual(report["music_repeats"], 0)
        self.assertGreaterEqual(report["energy_jumps"], 0)


class CreativeMusicIdUnchanged(unittest.TestCase):
    def test_music_id_field_is_not_redefined(self):
        got = creative.resolve_creative({
            "id": "x", "type": "card", "kind": "psa",
            "payload": json.dumps({"creative": {"music_id": "bed-a"}}),
        })
        self.assertEqual(got["music_id"], "bed-a")
        self.assertIn("music_id", creative.PERSIST_FIELDS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
