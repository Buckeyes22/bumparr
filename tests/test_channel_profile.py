"""Channel profile loader: missing/valid/invalid, caps, strict vs runtime."""
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import channel_profile, config

REPO = Path(__file__).resolve().parents[1]
SHIPPED = REPO / "bumparr" / "config_files" / "channel_profile.yaml"

VALID = """\
version: 1

voice:
  persona: "Concise, dry, observant, and lightly strange."
  favored_subjects: []
  boundaries:
    allow_direct_address: true
    allow_profanity: false
    allow_politics: false
    allow_bleak_humor: false
  avoid_phrases: []
  avoid_topics: []

mix:
  break: {text: 1.0, scenic: 1.0, archive: 1.0, data: 1.0,
          window: 0.8, ident: 0.8, failure: 0.2, authored: 1.0}
  station: {text: 1.0, scenic: 1.0, archive: 1.0, data: 1.0,
            window: 1.0, ident: 0.7, failure: 0.3, authored: 1.0}

sequence:
  max_text_run: 2
  avoid_same_family: true
  prefer_exit_ident: true
  avoid_same_music: true
  avoid_large_energy_jump: true

presentation:
  default_template: minimal_center
  default_brand_mode: reveal

audio:
  allowed: [native, music, designed, silence, unknown]
  target_lufs: -16.0
  true_peak_db: -1.5
  fallback: silence
"""


def _write(tmp, text, name="profile.yaml"):
    path = Path(tmp) / name
    path.write_text(text, encoding="utf-8")
    return path


class ChannelProfileLoader(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        channel_profile.reset_runtime_state()
        self.addCleanup(channel_profile.reset_runtime_state)

    def test_missing_file_returns_independent_default_copies(self):
        missing = Path(self.tmp.name) / "nope.yaml"
        a = channel_profile.load_profile(missing)
        b = channel_profile.load_profile(missing)
        expected = channel_profile.default_profile()
        self.assertEqual(a, expected)
        self.assertEqual(b, expected)
        a["voice"]["persona"] = "mutated"
        a["mix"]["break"]["text"] = 99
        self.assertEqual(b["voice"]["persona"], expected["voice"]["persona"])
        self.assertEqual(b["mix"]["break"]["text"], 1.0)
        defaults = channel_profile.default_profile()
        defaults["sequence"]["max_text_run"] = 9
        self.assertEqual(channel_profile.default_profile()["sequence"]["max_text_run"], 2)

    def test_shipped_yaml_matches_defaults(self):
        loaded = channel_profile.load_profile(SHIPPED, strict=True)
        self.assertEqual(loaded, channel_profile.default_profile())
        self.assertEqual(loaded["version"], 1)
        self.assertEqual(loaded["presentation"]["default_template"], "minimal_center")
        self.assertEqual(loaded["audio"]["target_lufs"], -16.0)

    def test_valid_custom_file_loads(self):
        text = VALID.replace('persona: "Concise, dry, observant, and lightly strange."',
                             'persona: "Custom voice."')
        path = _write(self.tmp.name, text)
        loaded = channel_profile.load_profile(path, strict=True)
        self.assertEqual(loaded["voice"]["persona"], "Custom voice.")
        self.assertEqual(loaded["mix"]["break"]["failure"], 0.2)

    def test_unknown_top_level_section_is_rejected(self):
        path = _write(self.tmp.name, VALID + "\nextra: {}\n")
        with self.assertRaises(channel_profile.ProfileError) as ctx:
            channel_profile.load_profile(path, strict=True)
        self.assertIn("unknown", str(ctx.exception).lower())

    def test_wrong_version_is_rejected(self):
        path = _write(self.tmp.name, VALID.replace("version: 1", "version: 2"))
        with self.assertRaises(channel_profile.ProfileError):
            channel_profile.load_profile(path, strict=True)

    def test_wrong_structural_types_are_rejected(self):
        cases = [
            VALID.replace("voice:", "voice: []\nnothing:"),
            VALID.replace("mix:", "mix: []\nnothing:"),
            VALID.replace("favored_subjects: []", "favored_subjects: no"),
            VALID.replace("allow_direct_address: true", "allow_direct_address: 1"),
            VALID.replace("allowed: [native, music, designed, silence, unknown]",
                          "allowed: native"),
        ]
        for i, text in enumerate(cases):
            path = _write(self.tmp.name, text, name="bad-%d.yaml" % i)
            with self.subTest(case=i):
                with self.assertRaises(channel_profile.ProfileError):
                    channel_profile.load_profile(path, strict=True)

    def test_unknown_family_and_treatment_are_rejected(self):
        family = VALID.replace("authored: 1.0}", "authored: 1.0, jingle: 2.0}")
        path = _write(self.tmp.name, family)
        with self.assertRaises(channel_profile.ProfileError) as ctx:
            channel_profile.load_profile(path, strict=True)
        self.assertIn("family", str(ctx.exception).lower())

        treatment = VALID.replace("fallback: silence", "fallback: bed")
        path = _write(self.tmp.name, treatment, name="treat.yaml")
        with self.assertRaises(channel_profile.ProfileError) as ctx:
            channel_profile.load_profile(path, strict=True)
        self.assertRegex(str(ctx.exception).lower(), r"treatment|audio|fallback")

        allowed = VALID.replace("unknown]", "unknown, tape]")
        path = _write(self.tmp.name, allowed, name="allowed.yaml")
        with self.assertRaises(channel_profile.ProfileError):
            channel_profile.load_profile(path, strict=True)

        brand = VALID.replace("default_brand_mode: reveal", "default_brand_mode: neon")
        path = _write(self.tmp.name, brand, name="brand.yaml")
        with self.assertRaises(channel_profile.ProfileError):
            channel_profile.load_profile(path, strict=True)

    def test_negative_and_nan_weights_are_rejected(self):
        neg = VALID.replace("failure: 0.2", "failure: -0.1")
        path = _write(self.tmp.name, neg)
        with self.assertRaises(channel_profile.ProfileError):
            channel_profile.load_profile(path, strict=True)

        nan = VALID.replace("failure: 0.2", "failure: .nan")
        path = _write(self.tmp.name, nan, name="nan.yaml")
        with self.assertRaises(channel_profile.ProfileError):
            channel_profile.load_profile(path, strict=True)

        inf = VALID.replace("ident: 0.8, failure", "ident: .inf, failure")
        path = _write(self.tmp.name, inf, name="inf.yaml")
        with self.assertRaises(channel_profile.ProfileError):
            channel_profile.load_profile(path, strict=True)

        over = VALID.replace("window: 0.8, ident: 0.8", "window: 100.1, ident: 0.8")
        path = _write(self.tmp.name, over, name="over.yaml")
        with self.assertRaises(channel_profile.ProfileError):
            channel_profile.load_profile(path, strict=True)

    def test_sequence_and_loudness_bounds(self):
        for src, dst in (
            ("max_text_run: 2", "max_text_run: 0"),
            ("max_text_run: 2", "max_text_run: 21"),
            ("target_lufs: -16.0", "target_lufs: -36.1"),
            ("target_lufs: -16.0", "target_lufs: -4.9"),
            ("true_peak_db: -1.5", "true_peak_db: -12.1"),
            ("true_peak_db: -1.5", "true_peak_db: 0.1"),
        ):
            path = _write(self.tmp.name, VALID.replace(src, dst),
                          name="bound-%s.yaml" % dst.replace(" ", "").replace(":", "-"))
            with self.subTest(dst=dst):
                with self.assertRaises(channel_profile.ProfileError):
                    channel_profile.load_profile(path, strict=True)

    def test_string_lists_trim_dedupe_and_cap(self):
        long_item = "x" * 250
        extra = ", ".join(["z%d" % i for i in range(120)])
        text = VALID.replace(
            "avoid_phrases: []",
            "avoid_phrases: ['  Hello  ', 'hello', '', '%s', %s]" % (long_item, extra),
        ).replace(
            "favored_subjects: []",
            "favored_subjects: [' Cats ', 'cats', 'Dogs']",
        )
        path = _write(self.tmp.name, text)
        loaded = channel_profile.load_profile(path, strict=True)
        self.assertEqual(loaded["voice"]["favored_subjects"], ["Cats", "Dogs"])
        phrases = loaded["voice"]["avoid_phrases"]
        self.assertEqual(phrases[0], "Hello")
        self.assertNotIn("", phrases)
        self.assertEqual(len(phrases[1]), 200)
        self.assertLessEqual(len(phrases), 100)
        self.assertEqual(len(set(p.casefold() for p in phrases)), len(phrases))

    def test_persona_is_capped(self):
        text = VALID.replace(
            'persona: "Concise, dry, observant, and lightly strange."',
            'persona: "%s"' % ("q" * 1200),
        )
        path = _write(self.tmp.name, text)
        loaded = channel_profile.load_profile(path, strict=True)
        self.assertEqual(len(loaded["voice"]["persona"]), 1000)

    def test_runtime_invalidity_warns_once_and_uses_full_default(self):
        bad = VALID.replace("failure: 0.2", "failure: -1")
        path = _write(self.tmp.name, bad)
        buf = io.StringIO()
        with mock.patch("sys.stdout", buf):
            first = channel_profile.load_profile(path, strict=False)
            second = channel_profile.load_profile(path, strict=False)
        self.assertEqual(first, channel_profile.default_profile())
        self.assertEqual(second, channel_profile.default_profile())
        logs = [line for line in buf.getvalue().splitlines()
                if line.startswith("[channel_profile]")]
        self.assertEqual(len(logs), 1)
        self.assertRegex(logs[0].lower(), r"invalid|default")
        self.assertNotIn("partial", logs[0].lower())

    def test_malformed_config_is_never_partially_applied(self):
        # Valid voice + sequence, invalid mix: runtime must not keep the custom voice.
        text = VALID.replace(
            'persona: "Concise, dry, observant, and lightly strange."',
            'persona: "Keep me if this were partial."',
        ).replace("failure: 0.2", "failure: -4")
        path = _write(self.tmp.name, text)
        loaded = channel_profile.load_profile(path, strict=False)
        self.assertEqual(loaded, channel_profile.default_profile())
        self.assertNotEqual(loaded["voice"]["persona"], "Keep me if this were partial.")

    def test_status_source_is_never_a_path(self):
        channel_profile.reset_runtime_state()
        with mock.patch.object(config, "CHANNEL_PROFILE", ""):
            status = channel_profile.profile_status()
        self.assertEqual(status["source"], "shipped-default")
        self.assertTrue(status["valid"])
        self.assertEqual(status["version"], 1)
        self.assertEqual(set(status), {"version", "valid", "source"})
        self.assertNotIn("/", status["source"])
        self.assertNotIn("\\", status["source"])

        custom = _write(self.tmp.name, VALID, name="custom.yaml")
        channel_profile.reset_runtime_state()
        with mock.patch.object(config, "CHANNEL_PROFILE", str(custom)):
            status = channel_profile.profile_status()
        self.assertEqual(status["source"], "custom")
        self.assertTrue(status["valid"])
        self.assertNotIn(str(custom), status["source"])

        bad = _write(self.tmp.name, VALID.replace("version: 1", "version: 9"),
                     name="bad.yaml")
        channel_profile.reset_runtime_state()
        with mock.patch.object(config, "CHANNEL_PROFILE", str(bad)):
            status = channel_profile.profile_status()
        self.assertEqual(status["source"], "fallback-after-error")
        self.assertFalse(status["valid"])
        self.assertNotIn(str(bad), status["source"])
        self.assertEqual(channel_profile.current(), channel_profile.default_profile())

    def test_check_cli_strict(self):
        good = _write(self.tmp.name, VALID, name="ok.yaml")
        env = dict(os.environ, CHANNEL_PROFILE=str(good), PYTHONPATH=str(REPO))
        ok = subprocess.run(
            [sys.executable, "-m", "bumparr.channel_profile", "--check"],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(ok.returncode, 0, ok.stderr)

        bad = _write(self.tmp.name, VALID.replace("version: 1", "version: 0"),
                     name="no.yaml")
        env["CHANNEL_PROFILE"] = str(bad)
        fail = subprocess.run(
            [sys.executable, "-m", "bumparr.channel_profile", "--check"],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(fail.returncode, 0)
        self.assertTrue(fail.stderr.strip() or fail.stdout.strip())

    def test_defaults_contain_no_deployment_secrets(self):
        blob = str(channel_profile.default_profile()).lower()
        for needle in ("127.0.0.1", "localhost", "http://", "password", "secret",
                       "api_key", "token"):
            self.assertNotIn(needle, blob)


class ShippedYamlContract(unittest.TestCase):
    def test_shipped_file_is_the_documented_shape(self):
        import yaml
        doc = yaml.safe_load(SHIPPED.read_text(encoding="utf-8"))
        self.assertEqual(doc["version"], 1)
        self.assertEqual(set(doc),
                         {"version", "voice", "mix", "sequence", "presentation", "audio"})
        self.assertEqual(set(doc["mix"]), {"break", "station"})
        self.assertEqual(set(doc["mix"]["break"]), set(channel_profile.FAMILIES))
        self.assertEqual(doc["audio"]["fallback"], "silence")
        self.assertEqual(doc["voice"]["persona"],
                         "Concise, dry, observant, and lightly strange.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
