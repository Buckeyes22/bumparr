"""Operator-owned voice: prompt construction and pre-insert checks.

No model is called. Prompt tests inspect the string `build_prompt` returns.
Pre-insert checks are deterministic given voice + batch + existing texts.
"""
import os
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import contextmanager
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr.card_validation import (
    card_body_text,
    normalize_card_text,
    opening_phrase,
    pre_insert_check,
    validate_card,
)
from bumparr.channel_profile import default_profile
from bumparr.generators import cards

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

VOICE = {
    "persona": "Concise, dry, observant, and lightly strange.",
    "favored_subjects": ["sleep", "weather"],
    "boundaries": {
        "allow_direct_address": True,
        "allow_profanity": False,
        "allow_politics": False,
        "allow_bleak_humor": False,
    },
    "avoid_phrases": ["stay tuned", "calm"],
    "avoid_topics": ["elections"],
}


def _check(kind, obj, *, voice=None, batch_texts=None, batch_openings=None,
           existing_texts=None):
    return pre_insert_check(
        kind, obj,
        voice=voice if voice is not None else VOICE,
        batch_texts=batch_texts if batch_texts is not None else set(),
        batch_openings=batch_openings if batch_openings is not None else set(),
        existing_texts=existing_texts if existing_texts is not None else set(),
    )


class PromptConstruction(unittest.TestCase):
    def test_prompt_is_schema_plus_voice_plus_count(self):
        prompt = cards.build_prompt("psa", 7, VOICE)
        self.assertIn("7", prompt)
        self.assertIn("JSON array", prompt)
        self.assertIn('"lines"', prompt)
        self.assertIn(VOICE["persona"], prompt)
        self.assertIn("sleep", prompt)
        self.assertIn("weather", prompt)
        self.assertIn("stay tuned", prompt)
        self.assertIn("elections", prompt)
        self.assertIn("direct address", prompt.lower())
        self.assertRegex(prompt.lower(), r"not use profanity|no profanity")
        self.assertRegex(prompt.lower(), r"not use political|no political")

    def test_every_model_kind_has_a_schema_and_count(self):
        for kind in ("psa", "corrections", "achievements", "coming_up", "tiny_games"):
            prompt = cards.build_prompt(kind, 4, VOICE)
            self.assertIn("4", prompt)
            self.assertIn("JSON", prompt)
            self.assertIn(VOICE["persona"], prompt)

    def test_prompt_describes_traits_and_never_requests_imitation(self):
        for kind in cards.PROMPTS:
            prompt = cards.build_prompt(kind, 3, VOICE).lower()
            self.assertNotIn("adult swim", prompt)
            self.assertNotIn("adultswim", prompt)
            self.assertNotIn("in the style of", prompt)
            self.assertNotRegex(prompt, r"imitate (adult swim|a named creator|the network)")
            self.assertNotRegex(prompt, r"\bwilliamsburg\b")
            self.assertNotRegex(prompt, r"\btim and eric\b")

    def test_generate_sends_build_prompt_to_the_model(self):
        captured = {}

        def fake_model(prompt, **kwargs):
            captured["prompt"] = prompt
            return "[]"

        with mock.patch.object(cards, "_call_model", side_effect=fake_model), \
                tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(cards.config, "DB_PATH", os.path.join(tmp, "t.db")):
            from bumparr import db
            db.init_db()
            added, rejected = cards.generate("psa", 5)
        self.assertEqual((added, rejected), (0, 0))
        self.assertEqual(captured["prompt"], cards.build_prompt("psa", 5))

    def test_call_model_stays_provider_agnostic(self):
        self.assertIn("OpenAI-compatible", cards._call_model.__doc__)
        self.assertNotIn("voice", cards._call_model.__code__.co_varnames)


class DuplicateNormalization(unittest.TestCase):
    def test_case_space_punctuation_collapse_to_the_same_key(self):
        a = normalize_card_text("Hello, World!")
        b = normalize_card_text("hello world")
        c = normalize_card_text("HELLO   WORLD.")
        self.assertEqual(a, b)
        self.assertEqual(a, c)
        self.assertTrue(a)

    def test_duplicate_is_equality_not_substring(self):
        full = normalize_card_text("Please remain seated. Seated is mandatory.")
        other = normalize_card_text("Please remain seated.")
        self.assertNotEqual(full, other)
        existing = {full}
        self.assertIsNone(_check("psa", {"lines": ["Please remain seated."]},
                                 existing_texts=existing))
        self.assertIsNotNone(_check(
            "psa", {"lines": ["Please remain seated.", "Seated is mandatory."]},
            existing_texts=existing))

    def test_batch_and_existing_same_kind_duplicates_are_rejected(self):
        obj = {"lines": ["This is a test.", "It has always been a test."]}
        key = normalize_card_text(card_body_text("psa", obj))
        self.assertIsNotNone(_check("psa", obj, batch_texts={key}))
        self.assertIsNotNone(_check("psa", obj, existing_texts={key}))
        self.assertIsNone(_check("psa", obj))

    def test_repeated_batch_opening_phrases_are_rejected(self):
        first = {"lines": ["The signal is lost.", "Wait."]}
        second = {"lines": ["The signal is fine.", "Really."]}
        opening = opening_phrase(first)
        self.assertEqual(opening, opening_phrase(second))
        self.assertIsNone(_check("psa", first))
        self.assertIsNotNone(_check("psa", second, batch_openings={opening}))
        distinct = {"lines": ["Something else entirely.", "Wait."]}
        self.assertNotEqual(opening_phrase(distinct), opening)
        self.assertIsNone(_check("psa", distinct, batch_openings={opening}))

    def test_avoid_phrases_and_topics_use_word_boundaries(self):
        self.assertIsNotNone(_check("psa", {"lines": ["Please remain calm."]}))
        self.assertIsNone(_check("psa", {"lines": ["Calmly wait it out."]}))
        self.assertIsNotNone(_check("psa", {"lines": ["Stay tuned after this."]}))
        self.assertIsNone(_check("psa", {"lines": ["The catalog is closed."]}))
        self.assertIsNotNone(_check("psa", {"lines": ["Coverage of elections continues."]}))
        self.assertIsNone(_check("psa", {"lines": ["Selections were made."]}))

    def test_length_and_shape_rules_still_reject(self):
        long_line = "word " * 80
        self.assertIsNone(validate_card("psa", {"lines": [long_line]})[0])
        too_many = {"lines": ["one", "two", "three", "four"]}
        self.assertIsNone(validate_card("psa", too_many)[0])
        self.assertIsNone(validate_card("psa", {"lines": []})[0])

    def test_pre_insert_runs_after_structural_clean(self):
        # A well-formed card that trips an avoid phrase is still a rejection
        # reason from pre_insert_check, not validate_card.
        obj = {"lines": ["Please remain calm."]}
        clean, reason = validate_card("psa", obj)
        self.assertIsNotNone(clean, reason)
        self.assertIsNotNone(_check("psa", clean))


class GenerateAccounting(unittest.TestCase):
    def test_added_rejected_counts_survive_mixed_batch(self):
        profile = textwrap.dedent("""\
            version: 1
            voice:
              persona: "Concise, dry, observant, and lightly strange."
              favored_subjects: []
              boundaries:
                allow_direct_address: true
                allow_profanity: false
                allow_politics: false
                allow_bleak_humor: false
              avoid_phrases: ["calm"]
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
        """)
        code = textwrap.dedent("""
            import json
            from bumparr import db
            from bumparr.generators import cards
            db.init_db()
            cards._call_model = lambda prompt, **kw: json.dumps([
                {"lines": ["Alpha one.", "Keep walking."]},
                {"lines": ["Alpha one.", "Keep walking."]},
                {"lines": ["Please remain calm."]},
                {"lines": ["The signal is lost.", "Wait."]},
                {"lines": ["The signal is fine.", "Really."]},
                {"lines": ["A distinct later card.", "Still dry."]},
            ])
            added, rejected = cards.generate("psa", 6)
            assert added == 3, (added, rejected)
            assert rejected == 3, (added, rejected)
            with db.conn() as c:
                n = c.execute("SELECT COUNT(*) FROM playables WHERE kind='psa'").fetchone()[0]
            assert n == 3, n
            print("OK accounting")
        """)
        with tempfile.TemporaryDirectory() as tmp:
            profile_path = os.path.join(tmp, "profile.yaml")
            with open(profile_path, "w", encoding="utf-8") as fh:
                fh.write(profile)
            env = dict(os.environ, DB_PATH=os.path.join(tmp, "t.db"),
                       ASSET_ROOT=tmp, PYTHONPATH=REPO,
                       CHANNEL_PROFILE=profile_path)
            result = subprocess.run(
                [sys.executable, "-c", code], cwd=REPO, env=env,
                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])
        self.assertIn("OK accounting", result.stdout)

    def test_voice_change_does_not_rewrite_existing_cards(self):
        code = textwrap.dedent("""
            import json
            from bumparr import db
            from bumparr.generators import cards
            db.init_db()
            cards._call_model = lambda prompt, **kw: json.dumps([
                {"lines": ["Original voice card.", "Leave it."]},
            ])
            added, rejected = cards.generate("psa", 1)
            assert added == 1 and rejected == 0, (added, rejected)
            with db.conn() as c:
                row = c.execute("SELECT id, payload FROM playables").fetchone()
                original = row["payload"]
                pid = row["id"]
            cards._call_model = lambda prompt, **kw: json.dumps([
                {"lines": ["A later card after the persona changed."]},
            ])
            added, rejected = cards.generate("psa", 1)
            assert added == 1 and rejected == 0, (added, rejected)
            with db.conn() as c:
                kept = c.execute("SELECT payload FROM playables WHERE id=?", (pid,)).fetchone()[0]
                n = c.execute("SELECT COUNT(*) FROM playables").fetchone()[0]
            assert kept == original, (kept, original)
            assert n == 2, n
            print("OK no rewrite")
        """)
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, DB_PATH=os.path.join(tmp, "t.db"),
                       ASSET_ROOT=tmp, PYTHONPATH=REPO)
            env.pop("CHANNEL_PROFILE", None)
            result = subprocess.run(
                [sys.executable, "-c", code], cwd=REPO, env=env,
                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])
        self.assertIn("OK no rewrite", result.stdout)

    def test_database_error_is_not_a_model_rejection(self):
        good = '[{"lines":["Still Awake","You are still here."]}]'

        @contextmanager
        def broken_conn():
            class Broken:
                def execute(self, *args, **kwargs):
                    raise sqlite3.OperationalError("database unavailable")
            yield Broken()

        with mock.patch.object(cards, "_call_model", return_value=good), \
                mock.patch.object(cards.db, "conn", broken_conn):
            with self.assertRaises(sqlite3.OperationalError):
                cards.generate("achievements", 1)

    def test_new_cards_persist_presentation_fields(self):
        code = textwrap.dedent("""
            import json
            from bumparr import db
            from bumparr.creative import TEMPLATES
            from bumparr.generators import cards
            db.init_db()
            cards._call_model = lambda prompt, **kw: json.dumps([
                {"lines": ["A new card.", "With presentation."]},
            ])
            added, rejected = cards.generate("psa", 1)
            assert added == 1 and rejected == 0, (added, rejected)
            with db.conn() as c:
                payload = json.loads(c.execute("SELECT payload FROM playables").fetchone()[0])
            cr = payload["creative"]
            assert cr["template"] in TEMPLATES, cr
            assert isinstance(cr["render_seed"], int) and cr["render_seed"] >= 0, cr
            assert cr["brand_mode"] in ("reveal", "static", "none"), cr
            print("OK presentation")
        """)
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, DB_PATH=os.path.join(tmp, "t.db"),
                       ASSET_ROOT=tmp, PYTHONPATH=REPO)
            env.pop("CHANNEL_PROFILE", None)
            result = subprocess.run(
                [sys.executable, "-c", code], cwd=REPO, env=env,
                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])
        self.assertIn("OK presentation", result.stdout)

    def test_default_profile_voice_is_the_working_default(self):
        persona = default_profile()["voice"]["persona"].lower()
        self.assertIn("concise", persona)
        self.assertIn("dry", persona)
        self.assertIn("observant", persona)
        self.assertIn("strange", persona)


if __name__ == "__main__":
    unittest.main(verbosity=2)
