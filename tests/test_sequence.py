"""Pure break composition and station adjacency (bumparr/sequence.py)."""
import ast
import math
import os
import random
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr import channel_profile
from bumparr.sequence import (
    RELAXATION_ORDER,
    Candidate,
    Composition,
    choose_next,
    compose_break,
)


def _creative(family="scenic", roles=None, energy="neutral", text_heavy=False,
              music_id=None, audio="unknown"):
    return {
        "family": family,
        "roles": list(roles if roles is not None else ["any", "inside"]),
        "energy": energy,
        "audio": audio,
        "text_heavy": text_heavy,
        "template": None,
        "render_seed": 0,
        "brand_mode": "reveal",
        "music_id": music_id,
    }


def _cand(ident, duration=10.0, score=1.0, **creative_kw):
    row = {"id": ident, "duration": duration, "kind": creative_kw.get("family", "scenic"),
           "type": "video", "weight": 1.0, "title": ident}
    return Candidate(row, score, _creative(**creative_kw))


def _profile(**seq):
    profile = channel_profile.default_profile()
    profile["sequence"].update(seq)
    return profile


def _compose(candidates, seconds=30.0, tolerance=1.5, max_items=8, placement="any",
             profile=None, recent=None, seed=1):
    return compose_break(
        candidates, seconds, tolerance, max_items, placement,
        profile or _profile(), recent or [], random.Random(seed))


def _ids(composition):
    return [c.row["id"] for c in composition.candidates]


class ModulePurity(unittest.TestCase):
    def test_no_db_file_time_or_global_rng_imports(self):
        source = Path(compose_break.__code__.co_filename).read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        forbidden = {"sqlite3", "pathlib", "time", "datetime", "os", "subprocess",
                     "httpx", "urllib", "requests"}
        self.assertFalse(imported & forbidden, imported & forbidden)

    def test_compose_does_not_call_wall_clock_or_global_rng(self):
        pool = [_cand("a", 10), _cand("b", 10, family="archive")]
        with mock.patch("time.time", side_effect=AssertionError("wall clock")):
            with mock.patch("random.random", side_effect=AssertionError("global rng")):
                with mock.patch("random.choice", side_effect=AssertionError("global rng")):
                    out = _compose(pool, seconds=20.0)
        self.assertEqual(len(out.candidates), 2)


class Determinism(unittest.TestCase):
    def test_same_seed_same_composition(self):
        pool = [_cand("a", 8, family="scenic"),
                _cand("b", 7, family="archive"),
                _cand("c", 5, family="data"),
                _cand("d", 10, family="window")]
        a = _compose(pool, seconds=20.0, seed=11)
        b = _compose(pool, seconds=20.0, seed=11)
        self.assertEqual(_ids(a), _ids(b))
        self.assertEqual(a.total, b.total)
        self.assertEqual(a.gap, b.gap)
        self.assertEqual(a.relaxed_rules, b.relaxed_rules)

    def test_choose_next_is_seedable(self):
        pool = [_cand("a", family="scenic"), _cand("b", family="archive")]
        first = choose_next(pool, _profile(), [], random.Random(3), mode="station")
        second = choose_next(pool, _profile(), [], random.Random(3), mode="station")
        self.assertEqual(first[0].row["id"], second[0].row["id"])
        self.assertEqual(first[1], second[1])


class HardGates(unittest.TestCase):
    def test_non_positive_and_non_finite_scores_are_excluded(self):
        pool = [_cand("zero", score=0.0), _cand("neg", score=-1.0),
                _cand("nan", score=float("nan")), _cand("inf", score=float("inf")),
                _cand("ok", 10.0, score=1.2)]
        out = _compose(pool, seconds=10.0)
        self.assertEqual(_ids(out), ["ok"])

    def test_role_incompatible_items_are_excluded(self):
        standby = _cand("sb", 10, family="failure", roles=["standby"])
        inside = _cand("in", 10, family="scenic", roles=["inside"])
        out = _compose([standby, inside], seconds=10.0, placement="any")
        self.assertEqual(_ids(out), ["in"])
        closed = _compose([inside, _cand("op", 10, family="ident",
                                         roles=["open", "close", "return", "ident"])],
                          seconds=10.0, placement="close")
        self.assertEqual(_ids(closed), ["op"])

    def test_zero_family_preference_is_a_hard_gate(self):
        profile = _profile()
        profile["mix"]["break"]["failure"] = 0.0
        pool = [_cand("fail", 10, family="failure"), _cand("ok", 10, family="scenic")]
        out = _compose(pool, seconds=10.0, profile=profile)
        self.assertEqual(_ids(out), ["ok"])

    def test_malformed_durations_are_excluded(self):
        bad = []
        for ident, duration in (("none", None), ("str", "nope"), ("nan", float("nan")),
                                ("inf", float("inf")), ("zero", 0), ("neg", -4)):
            row = {"id": ident, "duration": duration}
            bad.append(Candidate(row, 1.0, _creative()))
        bad.append(_cand("ok", 8.0))
        out = _compose(bad, seconds=8.0)
        self.assertEqual(_ids(out), ["ok"])

    def test_unique_ids_in_a_break(self):
        clones = [_cand("same", 5.0), _cand("same", 5.0), _cand("other", 5.0)]
        out = _compose(clones, seconds=20.0, max_items=8)
        self.assertEqual(len(_ids(out)), len(set(_ids(out))))
        self.assertLessEqual(len(out.candidates), 2)

    def test_max_items_is_honored(self):
        pool = [_cand("i%d" % i, 5.0, family="scenic" if i % 2 else "archive")
                for i in range(6)]
        out = _compose(pool, seconds=100.0, max_items=2)
        self.assertEqual(len(out.candidates), 2)


class FitAndEmpty(unittest.TestCase):
    def test_exact_fit(self):
        pool = [_cand("a", 22.0, family="scenic"),
                _cand("b", 18.0, family="archive"),
                _cand("c", 7.0, family="data")]
        out = _compose(pool, seconds=47.0, tolerance=1.5)
        self.assertTrue(out.exact)
        self.assertAlmostEqual(out.total, 47.0)
        self.assertAlmostEqual(out.gap, 0.0)
        self.assertEqual(set(_ids(out)), {"a", "b", "c"})

    def test_near_fit_returns_best_effort_gap(self):
        pool = [_cand("a", 10.0), _cand("b", 10.0, family="archive")]
        out = _compose(pool, seconds=25.0, tolerance=1.5, max_items=2)
        self.assertFalse(out.exact)
        self.assertAlmostEqual(out.total, 20.0)
        self.assertAlmostEqual(out.gap, 5.0)
        self.assertEqual(len(out.candidates), 2)

    def test_empty_pool(self):
        out = _compose([], seconds=12.0, tolerance=1.5)
        self.assertEqual(out.candidates, [])
        self.assertEqual(out.total, 0.0)
        self.assertEqual(out.gap, 12.0)
        self.assertFalse(out.exact)
        self.assertEqual(out.relaxed_rules, [])

    def test_one_item_pool(self):
        out = _compose([_cand("only", 9.0)], seconds=10.0, tolerance=1.5)
        self.assertEqual(_ids(out), ["only"])
        self.assertTrue(out.exact)
        self.assertAlmostEqual(out.gap, 1.0)

    def test_invalid_seconds_returns_empty(self):
        pool = [_cand("a", 10.0)]
        for seconds in (0, -5, float("nan"), float("inf")):
            out = _compose(pool, seconds=seconds)
            self.assertEqual(out.candidates, [])


class FamilyTextExitPolicy(unittest.TestCase):
    def test_capable_pool_avoids_same_family_adjacency(self):
        pool = [_cand("s1", 10, family="scenic"),
                _cand("s2", 10, family="scenic"),
                _cand("a1", 10, family="archive")]
        out = _compose(pool, seconds=20.0, max_items=2)
        self.assertTrue(out.exact)
        families = [c.creative["family"] for c in out.candidates]
        self.assertNotEqual(families[0], families[1])
        self.assertNotIn("same_family", out.relaxed_rules)

    def test_capable_pool_honors_max_text_run(self):
        pool = [_cand("t1", 10, family="text", text_heavy=True, energy="quiet"),
                _cand("t2", 10, family="text", text_heavy=True, energy="quiet"),
                _cand("t3", 10, family="text", text_heavy=True, energy="quiet"),
                _cand("s1", 10, family="scenic", text_heavy=False)]
        out = _compose(pool, seconds=30.0, max_items=3, profile=_profile(max_text_run=2))
        self.assertTrue(out.exact)
        run = 0
        for item in out.candidates:
            run = run + 1 if item.creative["text_heavy"] else 0
            self.assertLessEqual(run, 2)
        self.assertNotIn("text_run", out.relaxed_rules)

    def test_close_break_ends_with_exit_ident(self):
        pool = [_cand("a", 22, family="scenic"),
                _cand("b", 18, family="archive"),
                _cand("id", 7, family="ident",
                      roles=["open", "close", "return", "ident"])]
        out = _compose(pool, seconds=47.0, placement="close")
        self.assertTrue(out.exact)
        self.assertEqual(out.candidates[-1].row["id"], "id")
        self.assertNotIn("exit_ident", out.relaxed_rules)

    def test_capable_pool_avoids_quiet_loud_jump(self):
        pool = [_cand("q", 10, family="text", energy="quiet", text_heavy=True),
                _cand("l", 10, family="authored", energy="loud"),
                _cand("n", 10, family="scenic", energy="neutral")]
        out = _compose(pool, seconds=20.0, max_items=2)
        energies = [c.creative["energy"] for c in out.candidates]
        pair = set(energies)
        self.assertFalse(pair == {"quiet", "loud"})
        self.assertNotIn("energy_jump", out.relaxed_rules)


class RelaxationAndConstrainedPools(unittest.TestCase):
    def test_one_family_pool_relaxes_same_family_instead_of_returning_nothing(self):
        pool = [_cand("a", 10, family="scenic"),
                _cand("b", 10, family="scenic"),
                _cand("c", 10, family="scenic")]
        out = _compose(pool, seconds=30.0, max_items=3)
        self.assertEqual(len(out.candidates), 3)
        self.assertTrue(out.exact)
        self.assertIn("same_family", out.relaxed_rules)
        self.assertEqual(out.relaxed_rules, [r for r in RELAXATION_ORDER
                                             if r in out.relaxed_rules])

    def test_close_without_ident_reports_exit_ident(self):
        pool = [_cand("a", 10, family="scenic"),
                _cand("b", 10, family="archive")]
        out = _compose(pool, seconds=20.0, placement="close")
        self.assertEqual(len(out.candidates), 2)
        self.assertIn("exit_ident", out.relaxed_rules)
        self.assertEqual(out.relaxed_rules[0], "exit_ident")

    def test_relaxation_names_are_the_allowed_set_in_order(self):
        self.assertEqual(list(RELAXATION_ORDER),
                         ["exit_ident", "energy_jump", "same_family",
                          "text_run", "same_music"])
        pool = [_cand("a", 10, family="text", text_heavy=True, energy="quiet",
                      music_id="bed-1"),
                _cand("b", 10, family="text", text_heavy=True, energy="loud",
                      music_id="bed-1"),
                _cand("c", 10, family="text", text_heavy=True, energy="quiet",
                      music_id="bed-1")]
        out = _compose(pool, seconds=30.0, max_items=3, placement="close",
                       profile=_profile(max_text_run=2))
        self.assertTrue(out.candidates)
        allowed = set(RELAXATION_ORDER)
        self.assertTrue(set(out.relaxed_rules) <= allowed)
        ranks = [RELAXATION_ORDER.index(name) for name in out.relaxed_rules]
        self.assertEqual(ranks, sorted(ranks))

    def test_same_music_is_relaxed_when_unavoidable(self):
        pool = [_cand("a", 10, family="scenic", music_id="x"),
                _cand("b", 10, family="archive", music_id="x")]
        out = _compose(pool, seconds=20.0, max_items=2)
        self.assertEqual(len(out.candidates), 2)
        self.assertIn("same_music", out.relaxed_rules)


class ChooseNext(unittest.TestCase):
    def test_avoids_exact_repeat_when_another_positive_exists(self):
        pool = [_cand("a", family="scenic"), _cand("b", family="archive")]
        pick, rules = choose_next(pool, _profile(), [_cand("a")], random.Random(1),
                                  mode="station")
        self.assertEqual(pick.row["id"], "b")
        self.assertEqual(rules, [])

    def test_repeats_previous_when_it_is_the_only_positive(self):
        pool = [_cand("a", family="scenic"), _cand("b", family="archive", score=0.0)]
        pick, _rules = choose_next(pool, _profile(), [_cand("a")], random.Random(1),
                                   mode="station")
        self.assertEqual(pick.row["id"], "a")

    def test_empty_or_gated_pool_returns_none(self):
        pick, rules = choose_next([], _profile(), [], random.Random(1))
        self.assertIsNone(pick)
        self.assertEqual(rules, [])
        gated = [_cand("z", score=0.0)]
        pick, rules = choose_next(gated, _profile(), [], random.Random(1))
        self.assertIsNone(pick)
        self.assertEqual(rules, [])

    def test_one_family_pool_relaxes_same_family(self):
        pool = [_cand("a", family="scenic"), _cand("b", family="scenic")]
        pick, rules = choose_next(pool, _profile(), [_cand("prev", family="scenic")],
                                  random.Random(2), mode="station")
        self.assertIn(pick.row["id"], ("a", "b"))
        self.assertIn("same_family", rules)

    def test_text_run_uses_recent_context(self):
        recent = [_cand("p1", family="text", text_heavy=True),
                  _cand("p2", family="text", text_heavy=True)]
        pool = [_cand("t", family="text", text_heavy=True, energy="quiet"),
                _cand("s", family="scenic", text_heavy=False)]
        pick, rules = choose_next(pool, _profile(max_text_run=2), recent,
                                  random.Random(1), mode="station")
        self.assertEqual(pick.row["id"], "s")
        self.assertEqual(rules, [])

    def test_station_mode_does_not_drop_specialized_roles(self):
        ident = _cand("id", family="ident",
                      roles=["open", "close", "return", "ident"])
        pick, rules = choose_next([ident], _profile(), [], random.Random(1),
                                  mode="station")
        self.assertEqual(pick.row["id"], "id")
        self.assertEqual(rules, [])

    def test_zero_family_preference_gates_station_too(self):
        profile = _profile()
        profile["mix"]["station"]["failure"] = 0.0
        pool = [_cand("fail", family="failure"), _cand("ok", family="scenic")]
        pick, _rules = choose_next(pool, profile, [], random.Random(1),
                                   mode="station")
        self.assertEqual(pick.row["id"], "ok")

    def test_accepts_tuple_candidates(self):
        row = {"id": "t", "duration": 10.0, "kind": "ambient", "type": "video"}
        pick, _rules = choose_next([(row, 1.5, _creative())], _profile(), [],
                                   random.Random(1))
        self.assertEqual(pick.row["id"], "t")


class CompositionShape(unittest.TestCase):
    def test_gap_is_signed_requested_minus_total(self):
        out = _compose([_cand("a", 12.0)], seconds=10.0, tolerance=2.0)
        self.assertLess(out.gap, 0)
        self.assertAlmostEqual(out.gap, 10.0 - out.total)
        self.assertIsInstance(out, Composition)
        self.assertTrue(math.isfinite(out.total))


if __name__ == "__main__":
    unittest.main()
