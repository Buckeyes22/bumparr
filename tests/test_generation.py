"""Generation core: config, schema, budgets, review, bypasses, redaction."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from bumparr import config, db, seed
from bumparr.generation import models as gen_models
from bumparr.generation import service
from bumparr.generation.providers.base import redact


MANIFEST = """
models:
  - id: h3-direct
    provider: minimax
    model: MiniMax-H3
    output: video
    enabled: true
    allowed_modes: [text]
    default_duration: 8
    default_resolution: 768P
    default_aspect_ratio: "16:9"
    cost_ceiling:
      unit: video_second
      max_usd_per_unit: "0.10"
"""


class GenerationHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.assets = root / "assets"
        self.data = root / "data"
        self.assets.mkdir()
        self.data.mkdir()
        (self.assets / "generated").mkdir()
        (self.assets / "bumpers").mkdir()
        self.manifest = root / "models.yaml"
        self.manifest.write_text(MANIFEST, encoding="utf-8")
        self._orig = {}
        for name, value in {
            "DB_PATH": str(root / "t.db"),
            "ASSET_ROOT": self.assets,
            "OUTPUT_DIR": self.assets / "bumpers",
            "DATA_DIR": self.data,
            "GENERATION_ENABLED": "1",
            "GENERATION_MODELS": str(self.manifest),
            "GENERATION_DEFAULT_MODEL": "h3-direct",
            "MINIMAX_API_KEY": "sk-TEST-SECRET-SENTINEL",
            "OPENROUTER_API_KEY": "",
            "GENERATION_STAGING_DIR": "",
            "GENERATION_OUTPUT_DIR": "",
            "GENERATION_DAILY_JOBS": "10",
            "GENERATION_DAILY_VIDEO_SECONDS": "60",
            "GENERATION_DAILY_USD": "5.00",
            "GENERATION_MAX_ACTIVE": "1",
        }.items():
            self._orig[name] = getattr(config, name)
            setattr(config, name, value)
        self.addCleanup(self._restore)
        gen_models.reset_manifest_cache()
        db.init_db()

    def _restore(self):
        for name, value in self._orig.items():
            setattr(config, name, value)
        gen_models.reset_manifest_cache()

    def _request(self, **overrides):
        body = {
            "model": "h3-direct",
            "output": "video",
            "mode": "text",
            "prompt": "An original bumper of a lighthouse in fog",
            "duration": 8,
            "resolution": "768P",
            "ratio": "16:9",
        }
        body.update(overrides)
        return body


class ConfigAndManifest(GenerationHarness):
    def test_off_unless_exact_one(self):
        config.GENERATION_ENABLED = "true"
        self.assertFalse(gen_models.runtime_settings()["enabled"])
        config.GENERATION_ENABLED = "1"
        self.assertTrue(gen_models.runtime_settings()["enabled"])

    def test_empty_shipped_manifest_is_valid(self):
        config.GENERATION_MODELS = ""
        gen_models.reset_manifest_cache()
        entries, status = gen_models.load_manifest(strict=True)
        self.assertEqual(entries, [])
        self.assertTrue(status["valid"])

    def test_invalid_manifest_enables_nothing(self):
        bad = Path(self.tmp.name) / "bad.yaml"
        bad.write_text("models:\n  - id: x\n", encoding="utf-8")
        config.GENERATION_MODELS = str(bad)
        entries, status = gen_models.load_manifest(strict=False)
        self.assertEqual(entries, [])
        self.assertFalse(status["valid"])

    def test_fallback_must_not_be_h3_max(self):
        snapshot = gen_models.intersect_capabilities({
            "id": "max", "provider": "minimax", "model": "MiniMax-H3-Max",
            "output": "video", "enabled": True, "allowed_modes": ("text",),
            "default_duration": 8, "default_resolution": "768P",
            "default_aspect_ratio": "16:9", "cost_unit": "video_second",
            "max_usd_per_unit": "0.1",
        })
        self.assertIsNone(snapshot)

    def test_key_redaction(self):
        text = redact("Authorization: Bearer sk-TEST-SECRET-SENTINEL exploded",
                      extra=["sk-TEST-SECRET-SENTINEL"])
        self.assertNotIn("sk-TEST-SECRET-SENTINEL", text)


class SchemaAndState(GenerationHarness):
    def test_tables_exist(self):
        with db.conn() as c:
            jobs = c.execute("SELECT name FROM sqlite_master WHERE name='generation_jobs'").fetchone()
            outs = c.execute("SELECT name FROM sqlite_master WHERE name='generation_outputs'").fetchone()
        self.assertIsNotNone(jobs)
        self.assertIsNotNone(outs)

    def test_disabled_rejects_create(self):
        config.GENERATION_ENABLED = "0"
        with self.assertRaises(service.GenerationError) as ctx:
            service.enqueue(self._request())
        self.assertEqual(ctx.exception.code, "disabled")

    def test_missing_key_rejects_create(self):
        config.MINIMAX_API_KEY = ""
        with self.assertRaises(service.GenerationError) as ctx:
            service.enqueue(self._request())
        self.assertEqual(ctx.exception.code, "missing_key")

    def test_preflight_does_not_insert(self):
        out = service.preflight(self._request())
        self.assertIn("lighthouse", out["submitted_prompt"])
        self.assertTrue(out["paid_api"])
        with db.conn() as c:
            n = c.execute("SELECT COUNT(*) FROM generation_jobs").fetchone()[0]
        self.assertEqual(n, 0)

    def test_enqueue_reserves_budget(self):
        job = service.enqueue(self._request())
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["reserved"]["jobs"], 1)
        self.assertEqual(job["reserved"]["video_seconds"], 8)
        self.assertGreater(job["reserved"]["microusd"], 0)
        usage = service.budget_usage(job["budget_day"])
        self.assertEqual(usage["jobs"], 1)

    def test_cancel_queued_releases_reservation(self):
        job = service.enqueue(self._request())
        service.cancel_job(job["id"])
        again = service.get_job(job["id"])
        self.assertEqual(again["status"], "cancelled")
        self.assertEqual(again["reserved"]["jobs"], 0)
        usage = service.budget_usage(again["budget_day"])
        self.assertEqual(usage["jobs"], 0)

    def test_daily_job_cap(self):
        config.GENERATION_DAILY_JOBS = "1"
        service.enqueue(self._request())
        with self.assertRaises(service.GenerationError) as ctx:
            service.enqueue(self._request())
        self.assertEqual(ctx.exception.code, "budget_exhausted")

    def test_usd_cap_uses_integers(self):
        config.GENERATION_DAILY_USD = "0.50"
        service.enqueue(self._request(duration=4))
        with self.assertRaises(service.GenerationError) as ctx:
            service.enqueue(self._request(duration=15))
        self.assertEqual(ctx.exception.code, "budget_exhausted")

    def test_unknown_field_rejected(self):
        with self.assertRaises(service.GenerationError):
            service.preflight(self._request(weight=9))

    def test_adult_swim_brief_rejected(self):
        with self.assertRaises(service.GenerationError) as ctx:
            service.preflight(self._request(prompt="in the style of Adult Swim"))
        self.assertEqual(ctx.exception.code, "invalid_request")

    def test_claim_is_compare_and_set(self):
        job = service.enqueue(self._request())
        first = service.claim_queued()
        second = service.claim_queued()
        self.assertEqual(first["id"], job["id"])
        self.assertIsNone(second)

    def test_stale_submitting_becomes_unknown(self):
        job = service.enqueue(self._request())
        service.claim_queued()
        recovered = service.recover_stale(stale_after=-1)
        self.assertIn(job["id"], recovered)
        self.assertEqual(service.get_job(job["id"])["status"], "submission_unknown")

    def test_reconcile_not_accepted_releases(self):
        job = service.enqueue(self._request())
        service.claim_queued()
        service.recover_stale(stale_after=-1)
        service.reconcile(job["id"], {"not_accepted": True})
        row = service.get_job(job["id"])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "confirmed_not_submitted")
        self.assertEqual(row["reserved"]["jobs"], 0)

    def test_midnight_rebook_or_fail(self):
        job = service.enqueue(self._request())
        with db.conn() as c:
            c.execute("UPDATE generation_jobs SET budget_day='1999-01-01' WHERE id=?", (job["id"],))
        config.GENERATION_DAILY_JOBS = "10"
        with db.conn() as c:
            service.rebook_midnight(c)
        self.assertEqual(service.get_job(job["id"])["budget_day"], service.utc_day())

    def test_enqueue_after_midnight_does_not_stack_daily_caps(self):
        """A leftover yesterday reservation is rebooked before today's enqueue."""
        config.GENERATION_DAILY_JOBS = "1"
        first = service.enqueue(self._request())
        with db.conn() as c:
            c.execute("UPDATE generation_jobs SET budget_day='1999-01-01' WHERE id=?",
                      (first["id"],))
        with self.assertRaises(service.GenerationError) as ctx:
            service.enqueue(self._request())
        self.assertEqual(ctx.exception.code, "budget_exhausted")
        held = service.get_job(first["id"])
        self.assertEqual(held["status"], "queued")
        # Enqueue and midnight rebooking now share one atomic transaction; a
        # refused enqueue rolls both back. The worker still rebooks before claim.
        service.claim_queued()
        held = service.get_job(held["id"])
        self.assertEqual(held["budget_day"], service.utc_day())
        self.assertEqual(service.budget_usage(service.utc_day())["jobs"], 1)
        with db.conn() as c:
            n = c.execute("SELECT COUNT(*) FROM generation_jobs WHERE status IN ('queued', 'submitting')").fetchone()[0]
        self.assertEqual(n, 1)

    def test_rebook_runs_when_concurrency_is_full(self):
        config.GENERATION_MAX_ACTIVE = "1"
        active = service.enqueue(self._request())
        claimed = service.claim_queued()
        self.assertEqual(claimed["id"], active["id"])
        queued = service.enqueue(self._request())
        with db.conn() as c:
            c.execute("UPDATE generation_jobs SET budget_day='1999-01-01' WHERE id=?",
                      (queued["id"],))
        self.assertIsNone(service.claim_queued())
        self.assertEqual(service.get_job(queued["id"])["budget_day"], service.utc_day())


class ReviewAndBypass(GenerationHarness):
    def _candidate(self):
        clip = self.assets / "generated" / "clip.mp4"
        clip.write_bytes(b"not-really-video-but-a-regular-file-xxxx")
        job = service.enqueue(self._request())
        output_id = service.new_output_id()
        playable = service.build_playable({
            "id": job["id"], "provider": "minimax", "model_alias": "h3-direct",
            "provider_model": "MiniMax-H3", "mode": "text",
            "operator_brief": "brief", "submitted_prompt": "brief 16:9",
            "title": "Lighthouse", "kind": "generated_short",
            "request_json": json.dumps({"duration": 8, "resolution": "768P"}),
            "creative_json": json.dumps({"roles": ["inside"], "energy": "quiet"}),
            "capability_json": "{}", "usage_json": "{}",
            "provider_job_id": "t1", "reserved_cost_microusd": 800000,
            "actual_cost_microusd": None,
        }, {
            "output_id": output_id,
            "uri": "generated/clip.mp4",
            "sha256": service._sha256_file(clip),
            "duration": 8.0,
            "audio": "silence",
            "actual": {"duration": 8.0, "width": 1920, "height": 1080, "fps": 30},
        })
        with db.conn() as c:
            db.insert_generated_playable(c, playable)
            c.execute(
                """INSERT INTO generation_outputs (
                     id, job_id, ordinal, modality, processing_status, review_status,
                     playable_id, output_sha256, media_path, metadata_json, created_at, updated_at
                   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (output_id, job["id"], 0, "video", "ready", "pending",
                 playable["id"], playable and json.loads(playable["payload"])["generation"]["sha256"],
                 "generated/clip.mp4", "{}", 1, 1),
            )
            c.execute("UPDATE generation_jobs SET status='completed' WHERE id=?", (job["id"],))
        return output_id, playable["id"], clip

    def test_insert_is_disabled_zero_weight(self):
        _output_id, playable_id, _clip = self._candidate()
        with db.conn() as c:
            row = dict(c.execute("SELECT enabled, weight, source FROM playables WHERE id=?",
                                 (playable_id,)).fetchone())
        self.assertEqual(row["enabled"], 0)
        self.assertEqual(row["weight"], 0)
        self.assertTrue(row["source"].startswith("generated:"))

    def test_approve_restores_weight(self):
        output_id, playable_id, _clip = self._candidate()
        service.approve_output(output_id)
        with db.conn() as c:
            row = dict(c.execute("SELECT enabled, weight FROM playables WHERE id=?",
                                 (playable_id,)).fetchone())
        self.assertEqual(row["enabled"], 1)
        self.assertEqual(row["weight"], 1.0)

    def test_reject_stays_disabled(self):
        output_id, playable_id, _clip = self._candidate()
        service.reject_output(output_id, "no")
        with db.conn() as c:
            row = dict(c.execute("SELECT enabled, weight FROM playables WHERE id=?",
                                 (playable_id,)).fetchone())
        self.assertEqual(row["enabled"], 0)
        self.assertEqual(row["weight"], 0)

    def test_checksum_mismatch_blocks_approval(self):
        output_id, _playable_id, clip = self._candidate()
        clip.write_bytes(b"changed-bytes-after-registration")
        with self.assertRaises(service.GenerationError) as ctx:
            service.approve_output(output_id)
        self.assertIn("checksum", ctx.exception.message)

    def test_generic_enable_is_409(self):
        _output_id, playable_id, _clip = self._candidate()
        from bumparr.app import enable_playable
        out = enable_playable(playable_id)
        self.assertEqual(out.status_code, 409)

    def test_revive_skips_pending_generated(self):
        from bumparr.app import revive
        _output_id, playable_id, _clip = self._candidate()
        with db.conn() as c:
            c.execute("UPDATE playables SET health='dead' WHERE id=?", (playable_id,))
        probe = mock.Mock(return_value=mock.Mock(returncode=0, stdout="h264\n", stderr=""))
        with mock.patch("bumparr.app.subprocess.run", probe):
            out = revive()
        with db.conn() as c:
            row = dict(c.execute(
                "SELECT enabled, health FROM playables WHERE id=?", (playable_id,)).fetchone())
        self.assertEqual(row["enabled"], 0)
        self.assertEqual(row["health"], "dead")
        self.assertEqual(out["restored"], 0)

    def test_repeated_approve_is_409(self):
        output_id, _playable_id, _clip = self._candidate()
        service.approve_output(output_id)
        with self.assertRaises(service.GenerationError) as ctx:
            service.approve_output(output_id)
        self.assertEqual(ctx.exception.http, 409)

    def test_seed_skips_generation_output_not_sibling(self):
        nested = self.assets / "ambient"
        nested.mkdir()
        (nested / "keep.mp4").write_bytes(b"keep")
        (self.assets / "generated" / "secret.mp4").write_bytes(b"secret")
        with mock.patch.object(seed, "_probe_duration", return_value=4):
            added = seed.seed_from_assets()
        with db.conn() as c:
            ids = [r[0] for r in c.execute("SELECT id FROM playables").fetchall()]
        self.assertTrue(any("keep.mp4" in i for i in ids))
        self.assertFalse(any("generated" in i for i in ids))
        self.assertGreaterEqual(added, 1)

    def test_produce_skips_generation_output_tree(self):
        from bumparr import produce
        nested = self.assets / "ambient"
        nested.mkdir()
        source = nested / "film.mp4"
        source.write_bytes(b"film")
        generated = self.assets / "generated" / "secret.mp4"
        generated.write_bytes(b"secret")
        original_video = config.VIDEO_DIR
        config.VIDEO_DIR = self.assets
        self.addCleanup(setattr, config, "VIDEO_DIR", original_video)
        seen = []

        def fake_cut(src, *args, **kwargs):
            seen.append(Path(src).resolve())
            return [], "skipped"

        with mock.patch.object(produce, "produce_from_source", fake_cut), \
                mock.patch.object(produce, "duration_of", return_value=8.0), \
                mock.patch.object(produce, "sound_pool", return_value=[]), \
                mock.patch.object(produce, "weight_index", return_value=({}, {})):
            produce.run()
        self.assertTrue(any(path.name == "film.mp4" for path in seen))
        self.assertFalse(any("generated" in path.parts for path in seen))
        with db.conn() as c:
            enabled = [r[0] for r in c.execute(
                "SELECT id FROM playables WHERE enabled=1 AND source LIKE 'generated:%'")]
        self.assertEqual(enabled, [])


class DownloadSafety(unittest.TestCase):
    def test_rejects_private_hosts(self):
        from bumparr.generation.media import _reject_private_peer, _require_https
        from bumparr.generation.providers.base import ProviderError
        with self.assertRaises(ProviderError):
            _require_https("http://example.com/x")
        with self.assertRaises(ProviderError):
            _reject_private_peer("127.0.0.1", 443)
        with self.assertRaises(ProviderError):
            _reject_private_peer("10.0.0.1", 443)


class HttpSurface(GenerationHarness):
    def setUp(self):
        super().setUp()
        from fastapi.testclient import TestClient
        from bumparr.app import app
        # Do not enter the context manager: that would start lifespan loops.
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def _preflight_once(self, transport):
        from bumparr.generation.providers import get_adapter as real_get
        from bumparr.generation.providers.base import ProviderError

        def boom(*_a, **_k):
            raise ProviderError("provider_unavailable", "preflight must not call a provider")

        def wrapped(name, **kwargs):
            kwargs = dict(kwargs)
            kwargs["transport"] = transport
            return real_get(name, **kwargs)

        with mock.patch("bumparr.generation.providers.base.StdlibTransport.request", boom), \
                mock.patch("bumparr.generation.service.get_adapter", wrapped):
            return self.client.post("/api/generation/preflight", json=self._request())

    def test_status_when_disabled(self):
        config.GENERATION_ENABLED = "0"
        r = self.client.get("/api/generation")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["enabled"])
        self.assertNotIn("sk-TEST-SECRET-SENTINEL", r.text)
        create = self.client.post("/api/generation/jobs", json=self._request())
        self.assertEqual(create.status_code, 503)

    def test_preflight_zero_provider_calls(self):
        from tests.test_generation_minimax import FakeTransport
        transport = FakeTransport([])
        for _ in range(2):
            r = self._preflight_once(transport)
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertIn("lighthouse", body["submitted_prompt"])
            self.assertIn("estimate", body)
            self.assertGreater(body["estimate"]["microusd"], 0)
            self.assertEqual(body["estimate"]["usd"], "0.800000")
            self.assertEqual(transport.calls, [])

    def test_unknown_field_422(self):
        body = self._request()
        body["surprise"] = True
        r = self.client.post("/api/generation/preflight", json=body)
        self.assertEqual(r.status_code, 422)

    def test_create_202(self):
        body = self._request()
        preview = self.client.post("/api/generation/preflight", json=body).json()
        r = self.client.post("/api/generation/jobs", json={**body, "preflight_token": preview["preflight_token"]})
        self.assertEqual(r.status_code, 202)
        self.assertEqual(r.json()["status"], "queued")
        self.assertNotIn("sk-TEST-SECRET-SENTINEL", r.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
