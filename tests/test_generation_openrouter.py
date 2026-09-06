"""OpenRouter video adapter: discovery, distinct route, non-MiniMax fixture."""
import json
import time
import unittest
from unittest import mock

from bumparr import config
from bumparr.generation import models as gen_models
from bumparr.generation import service, worker
from bumparr.generation.providers.openrouter import OpenRouterAdapter
from tests.test_generation import GenerationHarness
from tests.test_generation_minimax import FakeTransport, _response, make_tiny_mp4
from pathlib import Path
from bumparr.generation import media as gen_media


OR_MANIFEST = """
models:
  - id: or-hailuo
    provider: openrouter
    model: minimax/hailuo-3
    output: video
    enabled: true
    allowed_modes: [text]
    default_duration: 8
    default_resolution: 2K
    default_aspect_ratio: "16:9"
  - id: or-veo
    provider: openrouter
    model: google/veo-3.1
    output: video
    enabled: true
    allowed_modes: [text]
    default_duration: 8
    default_resolution: 720p
    default_aspect_ratio: "16:9"
"""

DISCOVERY = {
    "data": [
        {
            "id": "minimax/hailuo-3",
            "canonical_slug": "minimax/hailuo-3",
            "supported_durations": list(range(5, 16)),
            "supported_resolutions": ["2K"],
            "supported_aspect_ratios": ["16:9"],
            "pricing_skus": {"per-video-second": "0.12"},
            "allowed_passthrough_parameters": ["output_config"],
        },
        {
            "id": "google/veo-3.1",
            "canonical_slug": "google/veo-3.1",
            "supported_durations": [4, 6, 8],
            "supported_resolutions": ["720p", "1080p"],
            "supported_aspect_ratios": ["16:9", "9:16"],
            "pricing_skus": {"per-video-second": "0.50"},
            "allowed_passthrough_parameters": ["output_config"],
        },
    ]
}


class OpenRouterTests(GenerationHarness):
    def setUp(self):
        super().setUp()
        self.manifest.write_text(OR_MANIFEST, encoding="utf-8")
        gen_models.reset_manifest_cache()
        config.MINIMAX_API_KEY = ""
        config.OPENROUTER_API_KEY = "or-TEST-SECRET-SENTINEL"
        cache = {
            "fetched_at": time.time(),
            "expires_at": time.time() + 3600,
            "models": DISCOVERY["data"],
        }
        (self.data / "generation-openrouter-discovery.json").write_text(
            json.dumps(cache), encoding="utf-8")

    def _adapter(self, script=None):
        transport = FakeTransport(script or [])
        adapter = OpenRouterAdapter(api_key="or-TEST-SECRET-SENTINEL", transport=transport)
        return adapter, transport

    def test_discovery_filters_manifest(self):
        adapter, _transport = self._adapter()
        hailuo = gen_models.intersect_capabilities(
            gen_models.current_manifest()[0][0], adapter.discovered_model("minimax/hailuo-3"))
        veo = gen_models.intersect_capabilities(
            gen_models.current_manifest()[0][1], adapter.discovered_model("google/veo-3.1"))
        self.assertIsNotNone(hailuo)
        self.assertIsNotNone(veo)
        self.assertEqual(hailuo["resolutions"], ["2K"])
        self.assertEqual(veo["resolutions"], ["720p", "1080p"])
        self.assertNotEqual(hailuo["durations"], veo["durations"])
        self.assertFalse(hailuo["zdr"])
        self.assertEqual(veo["routing"], "openrouter-unpinned")

    def test_stale_discovery_fails_closed(self):
        from bumparr.generation.providers.base import ProviderError
        adapter = OpenRouterAdapter(
            api_key="or-TEST-SECRET-SENTINEL",
            transport=FakeTransport([ProviderError("provider_unavailable", "down")]),
            discovery={"expires_at": 0, "models": []},
        )
        with self.assertRaises(ProviderError):
            adapter.discovery_snapshot(refresh=True)

    def test_unsupported_duration_rejected(self):
        adapter, _t = self._adapter()
        # 5 is hailuo min; veo does not support 5
        with self.assertRaises(service.GenerationError):
            service.preflight({
                "model": "or-veo", "prompt": "original foggy pier at dawn",
                "duration": 5, "resolution": "720p", "ratio": "16:9",
            })

    def test_does_not_send_zdr_or_pin_fields(self):
        adapter, transport = self._adapter([
            _response({"id": "job-1", "status": "pending"}, status=202),
        ])
        adapter.submit({
            "provider_model": "google/veo-3.1",
            "submitted_prompt": "original foggy pier",
            "duration": 8, "resolution": "720p",
        })
        create = [c for c in transport.calls if c["path"] == "/api/v1/videos"][0]
        body = create["json"]
        self.assertNotIn("zdr", body)
        self.assertNotIn("provider", body)
        self.assertEqual(body["model"], "google/veo-3.1")
        self.assertEqual(body["aspect_ratio"], "16:9")

    def test_reconstructed_content_path(self):
        adapter, transport = self._adapter([
            _response({"id": "job-9", "status": "completed", "usage": {"cost": 0.25}}),
        ])
        result = adapter.query("job-9")
        self.assertEqual(result["state"], "succeeded")
        self.assertTrue(result["download_url"].endswith("/api/v1/videos/job-9/content?index=0"))
        self.assertNotIn("unsigned", json.dumps(result))

    def test_expired_is_terminal_not_resubmit(self):
        adapter, _t = self._adapter([
            _response({"id": "job-e", "status": "expired"}),
        ])
        result = adapter.query("job-e")
        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error_code"], "provider_expired")

    def test_same_core_non_minimax_job(self):
        clip = Path(self.tmp.name) / "or.mp4"
        make_tiny_mp4(clip, audio=True, seconds=4)
        adapter, transport = self._adapter([
            _response({"id": "veo-job", "status": "pending"}, status=202),
            _response({"id": "veo-job", "status": "completed", "usage": {"cost": "1.00"}}),
            _response({"id": "veo-job", "status": "completed", "usage": {"cost": "1.00"}}),
        ])
        # Point worker adapters at this transport by patching get_adapter.
        def _get(name, **kwargs):
            self.assertEqual(name, "openrouter")
            return adapter
        job = service.enqueue({
            "model": "or-veo", "prompt": "original foggy pier at dawn",
            "duration": 4, "resolution": "720p", "ratio": "16:9",
        })
        with mock.patch("bumparr.generation.worker.get_adapter", _get), \
                mock.patch("bumparr.generation.service.get_adapter", _get), \
                mock.patch.object(gen_media, "download_untrusted", return_value=clip):
            claimed = service.claim_queued()
            worker.submit_claimed(claimed, transport=transport)
            worker.tick(transport=transport)
        done = service.get_job(job["id"])
        self.assertEqual(done["provider"], "openrouter")
        self.assertEqual(done["provider_model"], "google/veo-3.1")
        self.assertEqual(done["status"], "completed")
        self.assertFalse(done["zdr"])
        self.assertEqual(done["outputs"][0]["review_status"], "pending")

    def test_direct_minimax_is_not_rerouted(self):
        entries, _ = gen_models.current_manifest()
        self.assertTrue(all(e["provider"] == "openrouter" for e in entries))


if __name__ == "__main__":
    unittest.main(verbosity=2)
