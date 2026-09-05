"""Creative resolver: inference mappings, precedence, merge, roles."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bumparr.creative import (
    FAMILIES,
    PERSIST_FIELDS,
    merge_creative,
    resolve_creative,
    role_compatible,
    with_creative,
)


def _row(**kwargs):
    row = {
        "id": "t:item",
        "type": "video",
        "kind": "ambient",
        "source": "produced",
        "tags": "",
        "payload": {},
    }
    row.update(kwargs)
    return row


class FamilyInference(unittest.TestCase):
    def test_kind_mapping_table(self):
        cases = [
            ("station_id", "video", "generated", "", "ident"),
            ("technical_difficulties", "card", "render", "", "failure"),
            ("dead_air", "card", "render", "", "failure"),
            ("testpattern", "video", "archive", "", "failure"),
            ("weather", "card", "grounded", "", "data"),
            ("local_time", "card", "generated", "", "data"),
            ("on_this_day", "card", "generated", "", "data"),
            ("number", "card", "grounded", "", "data"),
            ("trivia", "card", "grounded", "", "data"),
            ("fun_facts", "card", "grounded", "", "data"),
            ("psa", "card", "generated", "", "text"),
            ("corrections", "card", "generated", "", "text"),
            ("achievements", "card", "generated", "", "text"),
            ("coming_up", "card", "generated", "", "text"),
            ("tiny_games", "card", "generated", "", "text"),
            ("channel_statistics", "card", "channel-memory", "", "data"),
            ("previously_on", "card", "channel-memory", "", "data"),
            ("viewer_achievement", "card", "channel-memory", "", "data"),
            ("operator_message", "card", "channel-memory", "", "authored"),
            ("webcam", "stream", "live-cam", "live,window", "window"),
            ("window", "video", "youtube-live", "", "window"),
        ]
        for kind, typ, source, tags, family in cases:
            with self.subTest(kind=kind):
                got = resolve_creative(_row(kind=kind, type=typ, source=source, tags=tags))
                self.assertEqual(got["family"], family)

    def test_stream_type_is_window(self):
        self.assertEqual(
            resolve_creative(_row(type="stream", kind="traffic", source="live-cam",
                                  tags="live"))["family"],
            "window")

    def test_window_webcam_tags_are_window(self):
        self.assertEqual(
            resolve_creative(_row(type="video", kind="ambient", tags="window"))["family"],
            "window")
        self.assertEqual(
            resolve_creative(_row(type="video", kind="ambient", tags="live,webcam"))["family"],
            "window")

    def test_archive_and_government_provenance(self):
        self.assertEqual(
            resolve_creative(_row(kind="gm_film", source="archive"))["family"], "archive")
        self.assertEqual(
            resolve_creative(_row(type="image", kind="poster", source="loc",
                                  tags="image,pd,gov,loc"))["family"],
            "archive")
        self.assertEqual(
            resolve_creative(_row(kind="ambient", source="nasa"))["family"], "archive")

    def test_user_manual_source_is_authored(self):
        self.assertEqual(
            resolve_creative(_row(kind="unsorted", source="user-added"))["family"],
            "authored")
        self.assertEqual(
            resolve_creative(_row(kind="clip", source="manual"))["family"], "authored")

    def test_remaining_image_video_card_fallbacks(self):
        self.assertEqual(
            resolve_creative(_row(type="video", kind="ambient", source="produced"))["family"],
            "scenic")
        self.assertEqual(
            resolve_creative(_row(type="image", kind="still", source="produced"))["family"],
            "scenic")
        self.assertEqual(
            resolve_creative(_row(type="card", kind="oddity", source="generated"))["family"],
            "text")

    def test_kind_mapping_beats_archive_source(self):
        self.assertEqual(
            resolve_creative(_row(kind="station_id", source="archive"))["family"],
            "ident")


class RoleEnergyAudio(unittest.TestCase):
    def test_role_defaults(self):
        ident = resolve_creative(_row(kind="station_id"))
        self.assertEqual(ident["roles"], ["open", "close", "return", "ident"])
        td = resolve_creative(_row(kind="technical_difficulties", type="card"))
        self.assertEqual(td["roles"], ["inside", "standby"])
        dead = resolve_creative(_row(kind="dead_air", type="card"))
        self.assertEqual(dead["roles"], ["any", "inside", "standby"])
        window = resolve_creative(_row(type="stream", kind="webcam", tags="live,window"))
        self.assertEqual(window["roles"], ["any", "inside", "standby"])
        ordinary = resolve_creative(_row(kind="trivia", type="card", source="grounded"))
        self.assertEqual(ordinary["roles"], ["any", "inside"])
        unknown = resolve_creative({"type": "mystery"})
        self.assertEqual(unknown["roles"], ["any"])

    def test_energy_and_text_heavy(self):
        quiet_kinds = [
            _row(kind="trivia", type="card", source="grounded"),
            _row(kind="psa", type="card"),
            _row(kind="dead_air", type="card"),
            _row(type="stream", kind="webcam"),
            _row(type="video", kind="ambient", source="produced"),
        ]
        for row in quiet_kinds:
            with self.subTest(kind=row.get("kind")):
                self.assertEqual(resolve_creative(row)["energy"], "quiet")
        ident = resolve_creative(_row(kind="station_id"))
        self.assertEqual(ident["energy"], "neutral")
        archive = resolve_creative(_row(kind="gm_film", source="archive"))
        self.assertEqual(archive["energy"], "neutral")
        trivia = resolve_creative(_row(kind="trivia", type="card", source="grounded"))
        self.assertTrue(trivia["text_heavy"])
        psa = resolve_creative(_row(kind="psa", type="card"))
        self.assertTrue(psa["text_heavy"])
        scenic = resolve_creative(_row(type="video", kind="ambient", source="produced"))
        self.assertFalse(scenic["text_heavy"])

    def test_audio_from_legacy_payload_and_type(self):
        self.assertEqual(
            resolve_creative(_row(payload={"audio": "native"}))["audio"], "native")
        self.assertEqual(
            resolve_creative(_row(payload={"audio": "bed:dusk"}))["audio"], "music")
        self.assertEqual(
            resolve_creative(_row(payload={"audio": "silent"}))["audio"], "silence")
        self.assertEqual(
            resolve_creative(_row(payload={"music": "bed.wav"}))["audio"], "music")
        self.assertEqual(
            resolve_creative(_row(type="card", kind="psa"))["audio"], "silence")
        self.assertEqual(
            resolve_creative(_row(type="image", kind="poster"))["audio"], "silence")
        self.assertEqual(
            resolve_creative(_row(type="stream", kind="webcam"))["audio"], "native")
        self.assertEqual(
            resolve_creative(_row(type="video", kind="ambient", source="produced"))["audio"],
            "unknown")

    def test_complete_normalized_keys(self):
        got = resolve_creative(_row())
        self.assertEqual(
            set(got),
            {"family", "roles", "energy", "audio", "text_heavy",
             "template", "render_seed", "brand_mode", "music_id"})
        self.assertIn(got["family"], FAMILIES)
        self.assertEqual(got["template"], "image_caption")
        self.assertIsNone(got["music_id"])
        self.assertIsInstance(got["render_seed"], int)
        self.assertGreaterEqual(got["render_seed"], 0)
        self.assertEqual(got["brand_mode"], "reveal")
        ident = resolve_creative(_row(kind="station_id"))
        self.assertEqual(ident["brand_mode"], "none")


class ExplicitPrecedence(unittest.TestCase):
    def test_valid_explicit_wins_per_field(self):
        row = _row(
            kind="trivia",
            type="card",
            source="grounded",
            payload={"lines": ["Q"], "creative": {
                "family": "authored",
                "roles": ["open"],
                "energy": "loud",
                "audio": "designed",
                "text_heavy": False,
                "template": "minimal_center",
                "render_seed": 12,
                "brand_mode": "static",
                "music_id": "bed-a",
            }},
        )
        got = resolve_creative(row)
        self.assertEqual(got["family"], "authored")
        self.assertEqual(got["roles"], ["open"])
        self.assertEqual(got["energy"], "loud")
        self.assertEqual(got["audio"], "designed")
        self.assertFalse(got["text_heavy"])
        self.assertEqual(got["template"], "minimal_center")
        self.assertEqual(got["render_seed"], 12)
        self.assertEqual(got["brand_mode"], "static")
        self.assertEqual(got["music_id"], "bed-a")

    def test_invalid_explicit_fields_fall_through(self):
        row = _row(
            kind="psa",
            type="card",
            payload={"creative": {
                "family": "jingle",
                "roles": ["nope", "inside"],
                "energy": "blaring",
                "audio": "tape",
                "text_heavy": "yes",
                "render_seed": -3,
                "brand_mode": "neon",
            }},
        )
        got = resolve_creative(row)
        self.assertEqual(got["family"], "text")
        self.assertEqual(got["roles"], ["inside"])
        self.assertEqual(got["energy"], "quiet")
        self.assertEqual(got["audio"], "silence")
        self.assertTrue(got["text_heavy"])
        self.assertGreaterEqual(got["render_seed"], 0)
        self.assertEqual(got["brand_mode"], "reveal")

    def test_partial_creative_keeps_valid_and_infers_rest(self):
        row = _row(kind="station_id", payload={"creative": {"energy": "loud"}})
        got = resolve_creative(row)
        self.assertEqual(got["family"], "ident")
        self.assertEqual(got["roles"], ["open", "close", "return", "ident"])
        self.assertEqual(got["energy"], "loud")

    def test_malformed_payload_and_creative_degrade(self):
        self.assertEqual(resolve_creative(_row(payload="not-json"))["family"], "scenic")
        self.assertEqual(resolve_creative(_row(payload=["x"]))["family"], "scenic")
        self.assertEqual(
            resolve_creative(_row(kind="trivia", type="card",
                                  payload={"creative": "nope"}))["family"],
            "data")
        self.assertEqual(
            resolve_creative(_row(kind="trivia", type="card",
                                  payload={"creative": None}))["family"],
            "data")
        as_json = _row(payload='{"lines":["Q"],"creative":{"family":"text"}}')
        as_json["type"] = "card"
        as_json["kind"] = "trivia"
        self.assertEqual(resolve_creative(as_json)["family"], "text")
        self.assertTrue(resolve_creative(as_json)["text_heavy"])

    def test_legacy_tags_before_kind_when_kind_is_generic(self):
        got = resolve_creative(_row(kind="ambient", tags="archive,pd"))
        self.assertEqual(got["family"], "archive")

    def test_render_seed_is_stable_and_not_process_hash(self):
        a = resolve_creative(_row(id="clip:one"))
        b = resolve_creative(_row(id="clip:one"))
        c = resolve_creative(_row(id="clip:two"))
        self.assertEqual(a["render_seed"], b["render_seed"])
        self.assertNotEqual(a["render_seed"], c["render_seed"])
        self.assertNotEqual(a["render_seed"], hash("clip:one") & 0x7FFFFFFF)


class RoleCompatibility(unittest.TestCase):
    def test_break_open_inside_close(self):
        any_role = {"roles": ["any", "inside"]}
        close_only = {"roles": ["close"]}
        ident = {"roles": ["open", "close", "return", "ident"]}
        inside = {"roles": ["inside"]}
        self.assertTrue(role_compatible(any_role, "open"))
        self.assertTrue(role_compatible(any_role, "inside"))
        self.assertTrue(role_compatible(any_role, "close"))
        self.assertFalse(role_compatible(close_only, "open"))
        self.assertTrue(role_compatible(close_only, "close"))
        self.assertTrue(role_compatible(ident, "close"))
        self.assertTrue(role_compatible({"roles": ["return"]}, "close"))
        self.assertTrue(role_compatible({"roles": ["ident"]}, "close"))
        self.assertFalse(role_compatible(inside, "close"))

    def test_placement_any_rejects_standby_only(self):
        self.assertTrue(role_compatible({"roles": ["any", "inside"]}, "any"))
        self.assertTrue(role_compatible({"roles": ["open"]}, "any"))
        self.assertTrue(role_compatible({"roles": ["inside", "standby"]}, "any"))
        self.assertFalse(role_compatible({"roles": ["standby"]}, "any"))

    def test_station_mode_is_not_narrowed_by_specialized_roles(self):
        ident = {"roles": ["open", "close", "return", "ident"]}
        self.assertTrue(role_compatible(ident, "any", mode="station"))
        self.assertTrue(role_compatible(ident, "inside", mode="station"))
        self.assertTrue(role_compatible({"roles": ["standby"]}, "any", mode="station"))


class MergeCreative(unittest.TestCase):
    def test_preserves_unrelated_keys_and_existing_creative(self):
        payload = {"lines": ["Hello"], "source": "Open Trivia DB",
                   "creative": {"family": "data", "extra": "keep"}}
        out = merge_creative(payload, {"energy": "quiet", "family": "data"})
        self.assertEqual(out["lines"], ["Hello"])
        self.assertEqual(out["source"], "Open Trivia DB")
        self.assertEqual(out["creative"]["family"], "data")
        self.assertEqual(out["creative"]["energy"], "quiet")
        self.assertEqual(out["creative"]["extra"], "keep")
        self.assertIsNot(out, payload)
        self.assertEqual(payload["creative"], {"family": "data", "extra": "keep"})

    def test_malformed_payload_degrades_to_object(self):
        self.assertEqual(merge_creative("nope", {"family": "text"})["creative"]["family"],
                         "text")
        self.assertEqual(merge_creative(["x"], {"family": "text"})["creative"]["family"],
                         "text")
        from_json = merge_creative('{"lines":["Q"]}', {"family": "data"})
        self.assertEqual(from_json["lines"], ["Q"])
        self.assertEqual(from_json["creative"]["family"], "data")

    def test_invalid_explicit_values_do_not_clobber(self):
        payload = {"creative": {"family": "ident"}}
        out = merge_creative(payload, {"family": "jingle", "energy": "loud"})
        self.assertEqual(out["creative"]["family"], "ident")
        self.assertEqual(out["creative"]["energy"], "loud")

    def test_with_creative_persists_inference_without_render_fields(self):
        payload = {"lines": ["ON THIS DAY"]}
        out = with_creative(payload, _row(id="card:on_this_day:abc", type="card",
                                          kind="on_this_day", source="generated"))
        self.assertEqual(out["lines"], ["ON THIS DAY"])
        self.assertEqual(out["creative"]["family"], "data")
        self.assertEqual(out["creative"]["roles"], ["any", "inside"])
        self.assertTrue(out["creative"]["text_heavy"])
        for key in PERSIST_FIELDS:
            self.assertIn(key, out["creative"])
        self.assertNotIn("render_seed", out["creative"])
        self.assertNotIn("template", out["creative"])
        self.assertNotIn("brand_mode", out["creative"])

    def test_content_hash_identity_ignores_creative(self):
        payload = {"lines": ["A fact."], "source": "Wikipedia: X"}
        identity = json.dumps(payload, sort_keys=True)
        merged = with_creative(payload, _row(type="card", kind="fun_facts",
                                             source="grounded", tags="grounded"))
        self.assertNotEqual(json.dumps(merged, sort_keys=True), identity)
        self.assertEqual(json.dumps(payload, sort_keys=True), identity)


if __name__ == "__main__":
    unittest.main(verbosity=2)
