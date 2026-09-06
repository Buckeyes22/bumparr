"""One bounded generation loop: recover, claim, submit, poll, ingest."""
import time
import shutil
import threading
from pathlib import Path

from bumparr.generation import media as gen_media
from bumparr.generation import models as gen_models
from bumparr.generation import service
from bumparr.generation.providers import get_adapter
from bumparr.generation.providers.base import ProviderError

POLL_STATES = ("submitted", "running")
_TICK_LOCK = threading.Lock()


def adapter_for(job, transport=None):
    settings = gen_models.runtime_settings()
    key = settings["minimax_key"] if job["provider"] == "minimax" else settings["openrouter_key"]
    if not key:
        raise ProviderError("missing_key", "credential missing for an accepted job")
    return get_adapter(job["provider"], api_key=key, transport=transport)


def submit_claimed(job, *, transport=None):
    if not service.pre_submit_gate(job):
        return "blocked"
    try:
        adapter = adapter_for(job, transport=transport)
        request = {
            "submitted_prompt": job["submitted_prompt"],
            "duration": _request_field(job, "duration"),
            "resolution": _request_field(job, "resolution"),
            "provider_model": job["provider_model"],
        }
        submission = adapter.submit(request)
    except ProviderError as exc:
        if exc.code in ("auth_failed", "insufficient_balance", "invalid_request",
                        "provider_moderation", "rate_limited", "missing_key"):
            service.fail_current(job, exc.code, exc.message, release=True)
            return "failed"
        service.mark_submission_unknown(job, exc.message)
        return "submission_unknown"
    except Exception as exc:
        service.mark_submission_unknown(job, str(exc))
        return "submission_unknown"
    if not service.record_submission(job, submission):
        service.mark_submission_unknown(job, "could not persist provider job id")
        return "submission_unknown"
    return "submitted"


def poll_job(job, *, transport=None):
    if not job.get("provider_job_id"):
        return
    try:
        adapter = adapter_for(job, transport=transport)
        result = adapter.query(job["provider_job_id"])
    except ProviderError as exc:
        if exc.code in ("missing_key", "auth_failed"):
            service.pause_recovery(job, exc.code, exc.message, delay=60)
            return
        if exc.code == "provider_expired":
            service.fail_current(job, exc.code, exc.message, release=False)
            return
        if exc.retryable or exc.code == "provider_unavailable":
            service.backoff_query(job)
            return
        service.fail_current(job, exc.code, exc.message, release=False)
        return
    result["provider_job_id"] = job["provider_job_id"]
    service.apply_query(job, result)
    return result


def ingest_job(job, *, transport=None):
    settings = gen_models.runtime_settings()
    staging = gen_models.staging_dir()
    dest_root = gen_models.output_dir()
    if staging is None or dest_root is None:
        service.pause_recovery(job, "disabled", "generation directories are invalid")
        return
    staging.mkdir(parents=True, exist_ok=True)
    dest_root.mkdir(parents=True, exist_ok=True)
    output = service.ensure_pending_output(job, 0)
    if output["processing_status"] == "ready" or output["review_status"] == "deleted":
        return
    meta = service._load_json(output.get("metadata_json"), {})
    service.mark_processing(job)
    # A stable output identity owns both files, including after process death.
    stem = output["id"].replace(":", "-")
    raw_path = staging / (stem + ".bin")
    filename = stem + ".mp4"
    dest = dest_root / filename
    if raw_path.is_symlink() or dest.is_symlink():
        raise ProviderError("invalid_media", "generation artifact must not be a symlink")
    service.record_staging_path(output["id"], raw_path)
    try:
        landed = meta.get("landed") or {}
        if not (dest.is_file() and landed.get("sha256") == gen_media.sha256_file(dest)):
            if not raw_path.is_file():
                adapter = adapter_for(job, transport=transport)
                query = adapter.query(job["provider_job_id"])
                if query.get("state") != "succeeded":
                    if query.get("state") in ("failed", "cancelled"):
                        raise ProviderError(query.get("error_code") or "provider_expired", "provider result is unavailable")
                    service.pause_recovery(job, "provider_unavailable", "waiting for provider result")
                    return
                query["provider_job_id"] = job["provider_job_id"]
                limits = {"max_bytes": settings["download_max_bytes"], "filename": stem}
                raws = adapter.fetch(query, staging, limits)
                if len(raws) != 1:
                    raise ProviderError("invalid_media", "expected one video output")
                downloaded = Path(raws[0]["path"])
                if downloaded != raw_path:
                    # Adapter results are trusted local paths, never persisted
                    # verbatim. Adopt into our stable private recovery path.
                    shutil.copyfile(downloaded, raw_path)
            info = gen_media.probe_video(raw_path)
            requested = _request_field(job, "duration") or info["duration"]
            if abs(info["duration"] - float(requested)) > max(2.0, 0.35 * float(requested)):
                raise ProviderError("invalid_media", "duration is not close to the request")
            gen_media.normalize(raw_path, dest, has_audio=info["has_audio"])
            actual = gen_media.probe_video(dest)
            landed = {"actual": actual, "audio": "designed" if info["has_audio"] else "silence",
                      "sha256": gen_media.sha256_file(dest)}
            service.record_landed(output["id"], landed)
        actual, audio, digest = landed["actual"], landed["audio"], landed["sha256"]
        uri = gen_media.output_uri_for(filename)
        playable = service.build_playable(job, {
            "output_id": output["id"],
            "uri": uri,
            "sha256": digest,
            "duration": actual["duration"],
            "audio": audio,
            "actual": {
                "duration": actual["duration"],
                "width": actual["width"],
                "height": actual["height"],
                "fps": 30,
            },
        })
        service.complete_with_outputs(job, [{
            "output_id": output["id"],
            "playable_id": playable["id"],
            "ordinal": 0,
            "sha256": digest,
            "media_path": uri,
            "duration": actual["duration"],
            "audio": audio,
            "metadata": {"duration": actual["duration"], "audio": audio, "sha256": digest},
            "playable": playable,
            "processing_status": "ready",
            "review_status": "pending",
        }])
        try:
            Path(raw_path).unlink()
        except OSError:
            pass
    except ProviderError as exc:
        if exc.code in ("missing_key", "auth_failed"):
            service.pause_recovery(job, exc.code, exc.message)
            return
        if exc.retryable or exc.code == "provider_unavailable":
            service.backoff_query(job)
            return
        service.mark_output_processing_failed(output["id"], exc.code, exc.message)
        service.complete_provider_job(job)


def _request_field(job, key):
    import json
    try:
        data = json.loads(job.get("request_json") or "{}")
    except (TypeError, ValueError):
        data = {}
    return data.get(key)


def refresh_openrouter_discovery(*, transport=None):
    settings = gen_models.runtime_settings()
    if not settings["enabled"] or not settings["openrouter_key"]:
        return
    entries, _status = gen_models.current_manifest()
    if not any(item.get("provider") == "openrouter" and item.get("enabled") for item in entries):
        return
    from bumparr.generation.providers.openrouter import OpenRouterAdapter
    adapter = OpenRouterAdapter(api_key=settings["openrouter_key"], transport=transport)
    adapter.discovery_snapshot(network=True)


def tick(*, transport=None, now=None):
    """One worker cycle. Safe to call from tests with a fake transport."""
    if not _TICK_LOCK.acquire(blocking=False):
        return
    try:
        _tick(transport=transport, now=now)
    finally:
        _TICK_LOCK.release()


def _tick(*, transport=None, now=None):
    now = time.time() if now is None else now
    service.recover_stale(now=now)
    try:
        refresh_openrouter_discovery(transport=transport)
    except Exception:
        pass
    settings = gen_models.runtime_settings()
    claimed = service.claim_queued(now=now) if settings["enabled"] else None
    if claimed is not None:
        submit_claimed(claimed, transport=transport)
    for job in service.jobs_in(POLL_STATES, now=now):
        poll_job(job, transport=transport)
    for job in service.jobs_in(("downloading", "processing"), now=now):
        try:
            ingest_job(job, transport=transport)
        except ProviderError as exc:
            out = service.ensure_pending_output(job, 0)
            service.mark_output_processing_failed(out["id"], exc.code, exc.message)
            service.complete_provider_job(job)
        except Exception as exc:
            # A landed file/descriptor survives DB or filesystem interruption.
            # Recovery retries registration, never provider creation.
            service.pause_recovery(job, "processing_interrupted", str(exc))
    staging = gen_models.staging_dir()
    if staging:
        gen_media.cleanup_staging(staging, keep=service.referenced_staging())


async def generation_loop():
    import asyncio
    from bumparr.generation import models as gen_models
    while True:
        try:
            await asyncio.to_thread(tick)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print("[generation] loop error: %s" % exc)
        settings = gen_models.runtime_settings()
        delay = settings["poll_seconds"]
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            raise
