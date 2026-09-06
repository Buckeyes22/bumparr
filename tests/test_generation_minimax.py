"""MiniMax H3 adapter and worker against an injected fake transport."""
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from bumparr import db
from bumparr.generation import media as gen_media
from bumparr.generation import service, worker
from bumparr.generation.providers.base import ProviderError, TransportResponse
from bumparr.generation.providers.minimax import MiniMaxAdapter
from tests.test_generation import GenerationHarness


def _response(payload, status=200):
    return TransportResponse(status, {"Content-Type": "application/json"},
                             json.dumps(payload).encode("utf-8"))


class FakeTransport:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def request(self, method, path, *, headers=None, json_body=None, timeout=None):
        self.calls.append({"method": method, "path": path, "json": json_body,
                           "headers": dict(headers or {})})
        if not self.script:
            raise AssertionError("unexpected %s %s" % (method, path))
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def make_tiny_mp4(path, audio=False, seconds=1):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
           "-f", "lavfi", "-i", "color=c=black:s=160x120:d=%s:r=15" % seconds]
    if audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
            "-t", str(seconds), str(path)]
    subprocess.run(cmd, check=True, timeout=60)


class MiniMaxAdapterTests(GenerationHarness):
    def test_create_and_poll_sequence(self):
        transport = FakeTransport([
            _response({"task_id": "task-1"}),
            _response({"task": {"id": "task-1", "status": "queued"}}),
            _response({"task": {"id": "task-1", "status": "running"}}),
            _response({"task": {
                "id": "task-1", "status": "succeeded",
                "content": {"url": "https://cdn.example/out.mp4"},
                "duration": 8, "usage": {"output_seconds": 8},
            }}),
        ])
        adapter = MiniMaxAdapter(api_key="sk-TEST-SECRET-SENTINEL", transport=transport)
        sub = adapter.submit({"submitted_prompt": "fog lighthouse 16:9 composition, no letterboxing, no logos or legible on-screen text.",
                              "duration": 8, "resolution": "768P"})
        self.assertEqual(sub["provider_job_id"], "task-1")
        self.assertEqual(adapter.query("task-1")["state"], "submitted")
        self.assertEqual(adapter.query("task-1")["state"], "running")
        done = adapter.query("task-1")
        self.assertEqual(done["state"], "succeeded")
        self.assertTrue(done["download_url"].startswith("https://"))

    def test_maps_http_errors(self):
        for status, code in ((401, "auth_failed"), (402, "insufficient_balance"),
                             (422, "provider_moderation"), (429, "rate_limited")):
            transport = FakeTransport([
                ProviderError(code, "x", http=status) if False else
                TransportResponse(status, {}, b'{"error":{"message":"x"}}'),
            ])
            adapter = MiniMaxAdapter(api_key="k", transport=transport)
            # StdlibTransport maps HTTPError; FakeTransport returns the response.
            # Adapter treats status >= 400 via map_http_error.
            from bumparr.generation.providers.base import map_http_error
            err = map_http_error(status, "x")
            self.assertEqual(err.code, code)

    def test_unknown_status_is_not_success(self):
        transport = FakeTransport([
            _response({"task": {"id": "t", "status": "thinking"}}),
        ])
        adapter = MiniMaxAdapter(api_key="k", transport=transport)
        result = adapter.query("t")
        self.assertEqual(result["state"], "unknown_nonterminal")

    def test_worker_does_not_resubmit_unknown(self):
        job = service.enqueue(self._request())
        claimed = service.claim_queued()
        transport = FakeTransport([
            ProviderError("provider_unavailable", "connection reset"),
        ])
        worker.submit_claimed(claimed, transport=transport)
        self.assertEqual(service.get_job(job["id"])["status"], "submission_unknown")
        transport2 = FakeTransport([
            _response({"task_id": "should-not-happen"}),
        ])
        worker.tick(transport=transport2)
        self.assertEqual(len(transport2.calls), 0)
        self.assertEqual(service.get_job(job["id"])["status"], "submission_unknown")

    def test_worker_persists_provider_id(self):
        job = service.enqueue(self._request())
        claimed = service.claim_queued()
        transport = FakeTransport([_response({"task_id": "abc"})])
        worker.submit_claimed(claimed, transport=transport)
        stored = service.get_job(job["id"])
        self.assertEqual(stored["status"], "submitted")
        self.assertEqual(stored["provider_job_id"], "abc")
        self.assertNotIn("sk-TEST-SECRET-SENTINEL", json.dumps(stored))

    def test_full_fake_ingest_registers_disabled(self):
        clip = Path(self.tmp.name) / "src.mp4"
        make_tiny_mp4(clip, audio=False, seconds=4)
        job = service.enqueue(self._request(duration=4))
        claimed = service.claim_queued()
        transport = FakeTransport([
            _response({"task_id": "t9"}),
            _response({"task": {
                "id": "t9", "status": "succeeded",
                "content": {"url": "https://cdn.example/out.mp4"},
                "duration": 4, "usage": {"output_seconds": 4},
            }}),
            _response({"task": {
                "id": "t9", "status": "succeeded",
                "content": {"url": "https://cdn.example/out.mp4"},
                "duration": 4,
            }}),
        ])
        worker.submit_claimed(claimed, transport=transport)
        with mock.patch.object(gen_media, "download_untrusted", return_value=clip):
            worker.tick(transport=transport)
        row = service.get_job(job["id"])
        self.assertEqual(row["status"], "completed")
        self.assertEqual(len(row["outputs"]), 1)
        self.assertEqual(row["outputs"][0]["review_status"], "pending")
        playable_id = row["outputs"][0]["playable_id"]
        with db.conn() as c:
            p = dict(c.execute("SELECT enabled, weight FROM playables WHERE id=?",
                               (playable_id,)).fetchone())
        self.assertEqual(p["enabled"], 0)
        self.assertEqual(p["weight"], 0)

    def _created(self, transport):
        return [c for c in transport.calls
                if c["method"] == "POST" and c["path"] == "/v2/video_generation"]

    def _enabled_generated(self):
        with db.conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT id, enabled, weight FROM playables WHERE source LIKE 'generated:%'"
            ).fetchall()]

    def _succeeded_script(self):
        body = {"task": {
            "id": "t-fail", "status": "succeeded",
            "content": {"url": "https://cdn.example/out.mp4"},
            "duration": 4,
        }}
        return [
            _response({"task_id": "t-fail"}),
            _response(body),
            _response(body),
        ]

    def test_download_failure_does_not_resubmit_or_enable(self):
        transport = FakeTransport(self._succeeded_script())
        job = service.enqueue(self._request(duration=4))
        claimed = service.claim_queued()
        worker.submit_claimed(claimed, transport=transport)
        self.assertEqual(len(self._created(transport)), 1)

        def _get(name, **kwargs):
            return MiniMaxAdapter(api_key="sk-TEST-SECRET-SENTINEL", transport=transport)

        with mock.patch("bumparr.generation.worker.get_adapter", _get), \
                mock.patch.object(gen_media, "download_untrusted",
                                  side_effect=ProviderError("download_rejected", "peer rejected")):
            worker.tick(transport=transport)
        done = service.get_job(job["id"])
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["outputs"][0]["processing_status"], "failed")
        self.assertEqual(done["outputs"][0]["error_code"], "download_rejected")
        self.assertEqual(self._enabled_generated(), [])
        self.assertEqual(len(self._created(transport)), 1)
        idle = FakeTransport([])
        with mock.patch("bumparr.generation.worker.get_adapter",
                        lambda name, **kw: MiniMaxAdapter(api_key="k", transport=idle)):
            worker.tick(transport=idle)
        self.assertEqual(idle.calls, [])
        self.assertEqual(len(self._created(transport)), 1)

    def test_normalize_failure_does_not_resubmit_or_enable(self):
        clip = Path(self.tmp.name) / "raw.mp4"
        clip.write_bytes(b"raw-bytes")
        transport = FakeTransport(self._succeeded_script())
        job = service.enqueue(self._request(duration=4))
        claimed = service.claim_queued()
        worker.submit_claimed(claimed, transport=transport)

        def _get(name, **kwargs):
            return MiniMaxAdapter(api_key="sk-TEST-SECRET-SENTINEL", transport=transport)

        with mock.patch("bumparr.generation.worker.get_adapter", _get), \
                mock.patch.object(gen_media, "download_untrusted", return_value=clip), \
                mock.patch.object(gen_media, "probe_video",
                                  return_value={"duration": 4.0, "width": 160, "height": 120,
                                                "has_audio": False}), \
                mock.patch.object(gen_media, "normalize",
                                  side_effect=ProviderError("normalize_failed", "ffmpeg died")):
            worker.tick(transport=transport)
        done = service.get_job(job["id"])
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["outputs"][0]["processing_status"], "failed")
        self.assertEqual(done["outputs"][0]["error_code"], "normalize_failed")
        self.assertEqual(self._enabled_generated(), [])
        self.assertEqual(len(self._created(transport)), 1)
        idle = FakeTransport([])
        worker.tick(transport=idle)
        self.assertEqual(idle.calls, [])

    def test_register_failure_does_not_resubmit_or_enable(self):
        clip = Path(self.tmp.name) / "raw.mp4"
        clip.write_bytes(b"raw-bytes")
        transport = FakeTransport(self._succeeded_script())
        job = service.enqueue(self._request(duration=4))
        claimed = service.claim_queued()
        worker.submit_claimed(claimed, transport=transport)

        def _get(name, **kwargs):
            return MiniMaxAdapter(api_key="sk-TEST-SECRET-SENTINEL", transport=transport)

        def fake_norm(src, dest, *, has_audio, timeout=180):
            dest = Path(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"normalized")
            return dest

        with mock.patch("bumparr.generation.worker.get_adapter", _get), \
                mock.patch.object(gen_media, "download_untrusted", return_value=clip), \
                mock.patch.object(gen_media, "probe_video",
                                  return_value={"duration": 4.0, "width": 1920, "height": 1080,
                                                "has_audio": False}), \
                mock.patch.object(gen_media, "normalize", fake_norm), \
                mock.patch.object(db, "insert_generated_playable",
                                  side_effect=RuntimeError("db down")):
            worker.tick(transport=transport)
        self.assertEqual(service.get_job(job["id"])["status"], "processing")
        self.assertEqual(service.get_job(job["id"])["error_code"], "processing_interrupted")
        self.assertEqual(self._enabled_generated(), [])
        self.assertEqual(len(self._created(transport)), 1)
        idle = FakeTransport([])
        worker.tick(transport=idle)
        self.assertEqual(idle.calls, [])

    def test_key_never_in_error(self):
        transport = FakeTransport([
            ProviderError("auth_failed", "Authorization: Bearer sk-TEST-SECRET-SENTINEL"),
        ])
        adapter = MiniMaxAdapter(api_key="sk-TEST-SECRET-SENTINEL", transport=transport)
        with self.assertRaises(ProviderError) as ctx:
            adapter.submit({"submitted_prompt": "x", "duration": 8, "resolution": "768P"})
        self.assertNotIn("sk-TEST-SECRET-SENTINEL", ctx.exception.message)


if __name__ == "__main__":
    unittest.main(verbosity=2)
