"""Regression evidence for all seventeen generation review findings. No paid calls."""
import copy
import io
import ipaddress
import json
import os
import socket
import threading
import time
import urllib.error
import yaml
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock
from urllib.parse import urlparse

from bumparr import config, db
from bumparr.generation import media, models, service, worker
from bumparr.generation.providers import base
from bumparr.generation.providers.openrouter import OpenRouterAdapter
from tests.test_generation import GenerationHarness
from tests.test_generation_minimax import FakeTransport, _response


class GenerationRemediation(GenerationHarness):
    def setUp(self):
        super().setUp()
        guard = mock.patch.object(base.StdlibTransport, "request",
                                  side_effect=AssertionError("unexpected external provider call"))
        guard.start()
        self.addCleanup(guard.stop)

    def client(self):
        from fastapi.testclient import TestClient
        from bumparr.app import app
        client = TestClient(app)  # No lifespan/background processes.
        self.addCleanup(client.close)
        return client

    def accepted(self, duration=4):
        job = service.enqueue(self._request(duration=duration))
        claimed = service.claim_queued()
        worker.submit_claimed(claimed, transport=FakeTransport([_response({"task_id": "accepted"})]))
        return service.load_job(job["id"])

    def succeeded(self):
        return _response({"task": {"id": "accepted", "status": "succeeded", "duration": 4,
                                   "content": {"url": "https://cdn.example/video.mp4"}}})

    def fake_media(self):
        raw = self.data / "test-raw.bin"
        raw.write_bytes(b"source" * 100)

        def encode(src, dest, **kwargs):
            Path(dest).write_bytes(b"encoded" * 100)
            return dest

        patches = [mock.patch.object(media, "download_untrusted", return_value=raw),
                   mock.patch.object(media, "probe_video", return_value={
                       "duration": 4, "width": 1920, "height": 1080, "has_audio": False}),
                   mock.patch.object(media, "normalize", side_effect=encode)]
        handles = [p.start() for p in patches]
        for p in patches:
            self.addCleanup(p.stop)
        return handles

    def test_immediate_transaction_is_active_before_select(self):
        with db.conn(immediate=True) as c:
            self.assertTrue(c.in_transaction)

    def test_concurrent_enqueues_cannot_exceed_daily_cap(self):
        config.GENERATION_DAILY_JOBS = "1"
        barrier = threading.Barrier(6)

        def enqueue():
            barrier.wait(timeout=5)
            try:
                return service.enqueue(self._request())["status"]
            except service.GenerationError as exc:
                return exc.code

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: enqueue(), range(6)))
        self.assertEqual(results.count("queued"), 1)
        self.assertEqual(results.count("budget_exhausted"), 5)
        self.assertEqual(service.budget_usage(service.utc_day())["jobs"], 1)

    def test_removed_alias_blocks_paid_submission(self):
        service.enqueue(self._request())
        job = service.claim_queued()
        self.manifest.write_text("models: []\n")
        models.reset_manifest_cache()
        transport = FakeTransport([])
        self.assertEqual(worker.submit_claimed(job, transport=transport), "blocked")
        self.assertEqual(transport.calls, [])

    def test_changed_alias_contract_blocks_submission(self):
        service.enqueue(self._request())
        job = service.claim_queued()
        self.manifest.write_text(self.manifest.read_text().replace('"0.10"', '"0.20"'))
        models.reset_manifest_cache()
        self.assertFalse(service.pre_submit_gate(job))
        self.assertEqual(service.get_job(job["id"])["error_code"], "preflight_changed")

    def test_actual_overrun_blocks_further_claims_even_after_failure(self):
        job = self.accepted()
        queued = service.enqueue(self._request(duration=4))
        service.apply_query(job, {"state": "failed", "usage": {"cost_microusd": 6000000}})
        self.assertEqual(service.budget_usage(service.utc_day())["microusd"], 6400000)
        self.assertIsNone(service.claim_queued())
        self.assertEqual(service.get_job(queued["id"])["status"], "queued")

    def test_budget_reduction_after_claim_prevents_create(self):
        service.enqueue(self._request())
        job = service.claim_queued()
        config.GENERATION_DAILY_USD = "0.10"
        transport = FakeTransport([])
        self.assertEqual(worker.submit_claimed(job, transport=transport), "blocked")
        self.assertEqual(transport.calls, [])

    def test_redaction_includes_live_credentials_urls_and_exception_strings(self):
        secret = config.MINIMAX_API_KEY
        error = base.ProviderError("provider_unavailable", secret + " https://cdn.example/signed/path?arbitrary=SECRET")
        self.assertNotIn(secret, str(error))
        job = service.enqueue(self._request())
        worker.submit_claimed(service.claim_queued(), transport=FakeTransport([error]))
        public = json.dumps(service.get_job(job["id"]))
        with db.conn(readonly=True) as c:
            persisted = c.execute("SELECT error_message FROM generation_jobs WHERE id=?", (job["id"],)).fetchone()[0]
        for text in (public, persisted):
            self.assertNotIn(secret, text)
            self.assertNotIn("arbitrary=SECRET", text)
            self.assertNotIn("signed/path", text)

    def test_deletion_db_failure_restores_file(self):
        from tests.test_generation import ReviewAndBypass
        oid, pid, clip = ReviewAndBypass._candidate(self)
        with db.conn() as c:
            c.execute("CREATE TRIGGER audit_failure BEFORE DELETE ON playables BEGIN SELECT RAISE(ABORT, 'test failure'); END")
        with self.assertRaises(Exception):
            service.delete_output(oid)
        self.assertTrue(clip.is_file())
        self.assertEqual(list(clip.parent.glob(".bumparr-delete-*")), [])
        with db.conn(readonly=True) as c:
            self.assertIsNotNone(c.execute("SELECT id FROM playables WHERE id=?", (pid,)).fetchone())

    def test_failed_processing_retries_staged_bytes_without_key_or_provider(self):
        job = self.accepted()
        download, probe, encode = self.fake_media()
        encode.side_effect = base.ProviderError("normalize_failed", "injected")
        worker.tick(transport=FakeTransport([self.succeeded(), self.succeeded()]))
        failed = service.get_job(job["id"])
        out = failed["outputs"][0]
        self.assertEqual((failed["status"], out["processing_status"]), ("completed", "failed"))
        raw = models.staging_dir() / (out["id"].replace(":", "-") + ".bin")
        self.assertTrue(raw.is_file())
        self.assertNotIn(str(raw), json.dumps(failed))
        config.MINIMAX_API_KEY = ""
        config.GENERATION_ENABLED = "0"
        service.retry_processing(out["id"])
        encode.side_effect = lambda src, dest, **kw: Path(dest).write_bytes(b"normalized")
        transport = FakeTransport([])
        worker.tick(transport=transport)
        done = service.get_job(job["id"])
        self.assertEqual(done["outputs"][0]["id"], out["id"])
        self.assertEqual(done["outputs"][0]["processing_status"], "ready")
        self.assertFalse(raw.exists())
        self.assertEqual(download.call_count, 1)
        self.assertEqual(transport.calls, [])
        self.assertIsNotNone(done["outputs"][0]["playable_id"])

    def test_landed_file_recovers_after_db_failure_without_reencode(self):
        job = self.accepted()
        download, probe, encode = self.fake_media()
        with mock.patch.object(db, "insert_generated_playable", side_effect=RuntimeError("injected DB failure")):
            worker.tick(transport=FakeTransport([self.succeeded(), self.succeeded()]))
        interrupted = service.load_job(job["id"])
        self.assertEqual(interrupted["status"], "processing")
        with db.conn(readonly=True) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM playables WHERE source LIKE 'generated:%'").fetchone()[0], 0)
        worker.tick(transport=FakeTransport([]), now=interrupted["next_attempt_at"] + 1)
        out = service.get_job(job["id"])["outputs"][0]
        self.assertEqual(out["processing_status"], "ready")
        self.assertEqual(encode.call_count, 1)
        self.assertEqual(download.call_count, 1)
        self.assertEqual(len(list(models.output_dir().glob("*.mp4"))), 1)

    def test_crash_after_encode_before_descriptor_commit_reuses_output_identity(self):
        job = self.accepted()
        self.fake_media()
        with mock.patch.object(service, "record_landed", side_effect=RuntimeError("crash")):
            worker.tick(transport=FakeTransport([self.succeeded(), self.succeeded()]))
        first = service.get_job(job["id"])["outputs"][0]["id"]
        worker.tick(transport=FakeTransport([]), now=time.time() + 100)
        self.assertEqual(service.get_job(job["id"])["outputs"][0]["id"], first)
        self.assertEqual(len(list(models.output_dir().glob("*.mp4"))), 1)

    def test_missing_key_pauses_then_resumes_same_paid_job(self):
        job = self.accepted()
        config.MINIMAX_API_KEY = ""
        worker.tick(transport=FakeTransport([]))
        paused = service.load_job(job["id"])
        self.assertEqual(paused["status"], "submitted")
        self.assertEqual(paused["error_code"], "missing_key")
        config.MINIMAX_API_KEY = "fake-restored-key"
        config.GENERATION_ENABLED = "0"
        self.manifest.write_text("models: []\n")
        models.reset_manifest_cache()
        transport = FakeTransport([_response({"task": {"status": "running"}})])
        worker.tick(transport=transport, now=paused["next_attempt_at"] + 1)
        resumed = service.load_job(job["id"])
        self.assertEqual(resumed["status"], "running")
        self.assertIsNone(resumed["next_attempt_at"])
        self.assertEqual([c["method"] for c in transport.calls], ["GET"])

    def test_query_backoff_is_durable_and_cleared_on_same_state_success(self):
        job = self.accepted()
        worker.tick(transport=FakeTransport([base.ProviderError("provider_unavailable", "temporary")]))
        paused = service.load_job(job["id"])
        self.assertGreater(paused["attempt_count"], 0)
        worker.tick(transport=FakeTransport([]))
        worker.tick(transport=FakeTransport([_response({"task": {"status": "queued"}})]),
                    now=paused["next_attempt_at"] + 1)
        resumed = service.load_job(job["id"])
        self.assertEqual(resumed["status"], "submitted")
        self.assertEqual(resumed["attempt_count"], 0)
        self.assertIsNone(resumed["next_attempt_at"])

    def test_staging_cleanup_preserves_failed_and_active_bytes(self):
        root = models.staging_dir()
        root.mkdir()
        keep = root / "keep.bin"
        orphan = root / "orphan.bin"
        partial = root / "old.part"
        recent = root / "recent.part"
        for p in (keep, orphan, partial, recent):
            p.write_bytes(b"x")
        for p in (keep, orphan, partial):
            os.utime(p, (1, 1))
        media.cleanup_staging(root, keep=[keep])
        self.assertTrue(keep.exists())
        self.assertTrue(recent.exists())
        self.assertFalse(orphan.exists())
        self.assertFalse(partial.exists())

    def test_regenerate_and_cancel_return_committed_state(self):
        job = service.enqueue(self._request())
        clone = service.regenerate(job["id"])
        self.assertNotEqual(clone["id"], job["id"])
        self.assertEqual(clone["parent_job_id"], job["id"])
        self.assertEqual(service.cancel_job(clone["id"])["status"], "cancelled")
        claimed = service.claim_queued()
        service.mark_submission_unknown(claimed, "test")
        result = service.reconcile(job["id"], {"not_accepted": True})
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reserved"]["jobs"], 0)

    def test_create_requires_matching_preflight_and_replay_is_rejected(self):
        client = self.client()
        body = self._request()
        self.assertEqual(client.post("/api/generation/jobs", json=body).status_code, 409)
        token = client.post("/api/generation/preflight", json=body).json()["preflight_token"]
        changed = {**body, "prompt": "A different original landscape", "preflight_token": token}
        self.assertEqual(client.post("/api/generation/jobs", json=changed).status_code, 409)
        body["preflight_token"] = token
        self.assertEqual(client.post("/api/generation/jobs", json=body).status_code, 202)
        self.assertEqual(client.post("/api/generation/jobs", json=body).status_code, 409)

    def test_preflight_rejects_changed_capability_and_budget(self):
        client = self.client()
        body = self._request()
        token = service.preflight(body)["preflight_token"]
        self.manifest.write_text(self.manifest.read_text().replace('"0.10"', '"0.11"'))
        models.reset_manifest_cache()
        self.assertEqual(client.post("/api/generation/jobs", json={**body, "preflight_token": token}).status_code, 409)
        token = service.preflight(body)["preflight_token"]
        config.GENERATION_DAILY_JOBS = "9"
        self.assertEqual(client.post("/api/generation/jobs", json={**body, "preflight_token": token}).status_code, 409)

    def test_all_write_endpoints_enforce_actual_byte_limit_without_length(self):
        client = self.client()
        paths = ["preflight", "jobs", "jobs/x/regenerate", "jobs/x/reconcile", "jobs/x/cancel",
                 "outputs/x/approve", "outputs/x/reject", "outputs/x/retry-processing", "outputs/x"]
        for path in paths:
            method = "DELETE" if path == "outputs/x" else "POST"
            response = client.request(method, "/api/generation/" + path,
                                      content=iter([b" " * 140000, b"{}"]),
                                      headers={"Content-Type": "application/json"})
            self.assertIsNone(response.request.headers.get("Content-Length"))
            self.assertEqual(response.status_code, 413, path)

    def test_manifest_rejects_truthy_false_and_invalid_price(self):
        original = self.manifest.read_text()
        for text in (original.replace("enabled: true", 'enabled: "false"'),
                     original.replace('"0.10"', '"nonsense"')):
            self.manifest.write_text(text)
            with self.assertRaises(models.ManifestError):
                models.load_manifest(strict=True)

    def test_compose_forwards_all_generation_settings_with_safe_defaults(self):
        compose = yaml.safe_load((Path(__file__).resolve().parents[1] / "docker-compose.yml").read_text())
        environment = dict(item.split("=", 1) for item in compose["services"]["bumparr"]["environment"])
        names = [name for name in vars(config) if name.startswith("GENERATION_")]
        names += ["MINIMAX_API_KEY", "OPENROUTER_API_KEY"]
        for name in names:
            self.assertTrue(environment[name].startswith("${" + name + ":-"), name)
        self.assertEqual(environment["GENERATION_ENABLED"], "${GENERATION_ENABLED:-0}")

    def test_http_regeneration_preflights_original_options_and_links_parent(self):
        original = self._request(title="Original title", duration=4)
        job = service.enqueue(original)
        token = service.preflight(original)["preflight_token"]
        client = self.client()
        response = client.post("/api/generation/jobs/" + job["id"] + "/regenerate",
                               json={"preflight_token": token})
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["parent_job_id"], job["id"])

    def test_download_recovery_pauses_for_missing_key_instead_of_abandoning_job(self):
        job = self.accepted()
        service.apply_query(job, {"state": "succeeded"})
        config.MINIMAX_API_KEY = ""
        worker.tick(transport=FakeTransport([]))
        stored = service.load_job(job["id"])
        self.assertEqual(stored["status"], "processing")
        self.assertEqual(stored["provider_job_id"], "accepted")
        self.assertEqual(stored["error_code"], "missing_key")

    def test_delete_failed_output_removes_private_bytes_and_cannot_retry(self):
        job = self.accepted()
        download, probe, encode = self.fake_media()
        encode.side_effect = base.ProviderError("normalize_failed", "injected")
        worker.tick(transport=FakeTransport([self.succeeded(), self.succeeded()]))
        output = service.get_job(job["id"])["outputs"][0]
        raw = models.staging_dir() / (output["id"].replace(":", "-") + ".bin")
        self.assertTrue(raw.exists())
        service.delete_output(output["id"])
        self.assertFalse(raw.exists())
        with self.assertRaises(service.GenerationError):
            service.retry_processing(output["id"])

    def test_delete_active_output_is_rejected(self):
        job = self.accepted()
        output = service.ensure_pending_output(job)
        with self.assertRaises(service.GenerationError) as ctx:
            service.delete_output(output["id"])
        self.assertEqual(ctx.exception.http, 409)


class OpenRouterRemediation(GenerationHarness):
    def setUp(self):
        super().setUp()
        from tests.test_generation_openrouter import OR_MANIFEST, DISCOVERY
        self.manifest.write_text(OR_MANIFEST)
        models.reset_manifest_cache()
        config.OPENROUTER_API_KEY = "fake-openrouter-key"
        self.catalog = copy.deepcopy(DISCOVERY)
        self.catalog["data"][1]["pricing_skus"]["per-video-second-1080p"] = "0.75"
        self.cache = self.data / "generation-openrouter-discovery.json"
        self.cache.write_text(json.dumps({"fetched_at": time.time(), "expires_at": time.time() + 3600,
                                         "models": self.catalog["data"]}))

    def test_resolution_specific_pricing_and_budget(self):
        request = {"model": "or-veo", "prompt": "Original landscape", "duration": 8, "resolution": "1080p"}
        self.assertEqual(service.preflight(request)["estimate"]["microusd"], 6000000)
        with self.assertRaises(service.GenerationError):
            service.enqueue(request)

    def test_unknown_or_invalid_skus_fail_closed(self):
        for skus in ({"per-video-second": "0.50", "audio-surcharge": "0.25"},
                     {"per-video-second": "0.50", "per-video-second-1080p": "unknown"}):
            self.assertIsNone(models._openrouter_pricing({"pricing_skus": skus}))

    def test_status_models_preflight_never_discover_on_read(self):
        self.cache.unlink()
        with mock.patch.object(base.StdlibTransport, "request", side_effect=AssertionError("read performed network")):
            self.assertFalse(service.public_status()["models"])
            self.assertTrue(all(not entry["available"] for entry in service.list_models()))
            with self.assertRaises(service.GenerationError) as ctx:
                service.preflight({"model": "or-veo", "prompt": "Original landscape"})
            self.assertEqual(ctx.exception.code, "capabilities_stale")
        self.assertFalse(self.cache.exists())

    def test_background_discovery_reuses_cache_and_expiry_fails_closed(self):
        idle = FakeTransport([])
        worker.refresh_openrouter_discovery(transport=idle)
        self.assertEqual(idle.calls, [])
        self.cache.write_text(json.dumps({"expires_at": 0, "models": self.catalog["data"]}))
        adapter = OpenRouterAdapter(api_key="fake", transport=idle)
        self.assertIsNone(adapter.discovery_snapshot())
        transport = FakeTransport([_response(self.catalog)])
        worker.refresh_openrouter_discovery(transport=transport)
        self.assertEqual(len(transport.calls), 1)
        worker.refresh_openrouter_discovery(transport=transport)
        self.assertEqual(len(transport.calls), 1)


class TransportRemediation(GenerationHarness):
    def test_json_redirects_are_not_followed_and_failures_are_safe(self):
        handler = base._NoRedirect()
        for code in (301, 302, 303, 307, 308):
            self.assertIsNone(handler.redirect_request(None, None, code, "", {}, "http://other.example"))
        error = urllib.error.HTTPError("https://api.minimax.io/task", 302, "redirect", {}, io.BytesIO(b""))
        with mock.patch.object(base._JSON_OPENER, "open", side_effect=error) as opened:
            with self.assertRaises(base.ProviderError):
                base.StdlibTransport("https://api.minimax.io").request("POST", "/task", headers={"Authorization": "Bearer fake"})
        self.assertEqual(opened.call_count, 1)

    def test_get_transport_errors_retry_but_create_is_ambiguous(self):
        for error in (urllib.error.URLError("temporary"), TimeoutError("read timed out")):
            for method, retryable in (("GET", True), ("POST", False)):
                with mock.patch.object(base._JSON_OPENER, "open", side_effect=error):
                    with self.assertRaises(base.ProviderError) as ctx:
                        base.StdlibTransport("https://api.minimax.io").request(method, "/task")
                self.assertEqual(ctx.exception.retryable, retryable)

    def test_pinned_socket_uses_validated_ip_and_original_tls_hostname(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ("8.8.8.8", 443)
        ctx = mock.Mock()
        conn = mock.Mock()
        conn.getresponse.return_value.status = 200
        with mock.patch.object(socket, "create_connection", return_value=sock) as connect, \
                mock.patch.object(media.ssl, "create_default_context", return_value=ctx), \
                mock.patch.object(media.http.client, "HTTPSConnection", return_value=conn):
            response = media._open_pinned(urlparse("https://cdn.example/video"), ipaddress.ip_address("8.8.8.8"), {})
            response.close()
        connect.assert_called_once_with(("8.8.8.8", 443), timeout=60)
        ctx.wrap_socket.assert_called_once_with(sock, server_hostname="cdn.example")
        conn.close.assert_called_once()

    def test_unvalidated_actual_peer_is_rejected_before_tls_or_request(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ("127.0.0.1", 443)
        with mock.patch.object(socket, "create_connection", return_value=sock), \
                mock.patch.object(media.ssl, "create_default_context") as tls:
            with self.assertRaises(base.ProviderError):
                media._open_pinned(urlparse("https://cdn.example/video"), ipaddress.ip_address("8.8.8.8"), {})
            tls.assert_not_called()
        sock.close.assert_called_once()

    def test_cross_origin_download_redirect_strips_auth(self):
        first = mock.Mock(status=302, headers={"Location": "https://cdn.example/video"})
        second = io.BytesIO(b"x" * 200)
        second.status = 200
        second.headers = {}
        opener = mock.Mock()
        opener.open.side_effect = [first, second]
        with mock.patch.object(media, "_public_peer_ip", return_value=ipaddress.ip_address("8.8.8.8")):
            media.download_untrusted("https://openrouter.ai/content", self.data, {"max_bytes": 1000},
                                     auth_origin="https://openrouter.ai", auth_header="Bearer fake", opener=opener)
        requests = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer fake")
        self.assertIsNone(requests[1].get_header("Authorization"))

    def test_redirect_to_private_address_is_rejected(self):
        first = mock.Mock(status=302, headers={"Location": "https://127.0.0.1/video"})
        opener = mock.Mock()
        opener.open.return_value = first
        with mock.patch.object(media, "_public_peer_ip", side_effect=[ipaddress.ip_address("8.8.8.8"),
                               base.ProviderError("download_rejected", "private")]):
            with self.assertRaises(base.ProviderError):
                media.download_untrusted("https://cdn.example/content", self.data, {}, opener=opener)
        self.assertEqual(opener.open.call_count, 1)
