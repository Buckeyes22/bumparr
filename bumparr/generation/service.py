"""Enqueue, claim, budget, state transitions, and review."""
import json
import hashlib
import sqlite3
import time
import uuid
import re
from pathlib import Path
from datetime import datetime, timezone

from bumparr import config, creative, db, paths
from bumparr.generation import models as gen_models
from bumparr.generation.providers import get_adapter
from bumparr.generation.providers.base import ProviderError, bound_text, redact

JOB_ACTIVE = frozenset({
    "queued", "submitting", "submitted", "running", "downloading",
    "processing", "cancel_requested", "submission_unknown",
})
JOB_TERMINAL = frozenset({"completed", "failed", "cancelled"})
CONCURRENCY_STATES = frozenset({
    "submitting", "submitted", "running", "downloading", "processing",
    "submission_unknown",
})
TRANSITIONS = {
    "queued": frozenset({"submitting", "cancelled", "failed"}),
    "submitting": frozenset({"submitted", "submission_unknown", "failed", "cancelled", "queued"}),
    "submitted": frozenset({"running", "downloading", "failed", "cancelled", "cancel_requested"}),
    "running": frozenset({"downloading", "failed", "cancelled", "cancel_requested", "submitted"}),
    "downloading": frozenset({"processing", "failed"}),
    "processing": frozenset({"completed", "failed"}),
    "cancel_requested": frozenset({"cancelled", "failed", "downloading", "running", "submitted"}),
    "submission_unknown": frozenset({"submitted", "running", "downloading", "failed"}),
    "completed": frozenset({"downloading", "processing"}),
    "failed": frozenset({"downloading", "processing"}),
    "cancelled": frozenset(),
}
PROPOSED_WEIGHT = 1.0
ERROR_LIMIT = 400


class GenerationError(Exception):
    def __init__(self, code, message, http=400):
        self.code = code
        self.message = bound_text(message)
        super().__init__(self.message)
        self.http = http


def utc_day(now=None):
    stamp = datetime.fromtimestamp(now if now is not None else time.time(), tz=timezone.utc)
    return stamp.strftime("%Y-%m-%d")


def new_job_id():
    return "gen:" + uuid.uuid4().hex


def new_output_id():
    return "genout:" + uuid.uuid4().hex


def _json(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True, default=str)


def _load_json(value, fallback):
    try:
        parsed = json.loads(value or "")
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback
    return parsed if parsed is not None else fallback


def _row(row):
    if row is None:
        return None
    return dict(row)


def public_status(now=None, *, worker_running=None):
    settings = gen_models.runtime_settings()
    entries, manifest = gen_models.current_manifest()
    aliases = []
    unavailable = []
    for entry in entries:
        info = describe_alias(entry, settings)
        if info.get("available"):
            aliases.append(info)
        else:
            unavailable.append(info)
    usage = budget_usage(utc_day(now))
    counts = job_counts()
    return {
        "enabled": settings["enabled"],
        "default_model": settings.get("default_model"),
        "dirs_ok": settings["dirs_ok"],
        "manifest": manifest,
        "models": aliases,
        "unavailable": unavailable,
        "budget": {
            "day": utc_day(now),
            "jobs": {"used": usage["jobs"], "cap": settings["daily_jobs"],
                     "remaining": max(0, settings["daily_jobs"] - usage["jobs"])},
            "video_seconds": {"used": usage["video_seconds"], "cap": settings["daily_video_seconds"],
                              "remaining": max(0, settings["daily_video_seconds"] - usage["video_seconds"])},
            "usd": {"used_microusd": usage["microusd"], "cap_microusd": settings["daily_microusd"],
                    "used": gen_models.micro_to_usd_str(usage["microusd"]),
                    "cap": str(settings["daily_usd"]),
                    "remaining_microusd": max(0, settings["daily_microusd"] - usage["microusd"])},
        },
        "queue": counts,
        "max_active": settings["max_active"],
        "worker": {"running": bool(worker_running)},
        "warnings": _status_warnings(settings),
    }


def _status_warnings(settings):
    notes = [
        "Bumparr has no authentication. Reverse-proxy auth is required before internet exposure.",
        "Generation uses a paid external API. Credentials never enable spending by themselves.",
    ]
    if not settings["dirs_ok"]:
        notes.append("GENERATION_STAGING_DIR / GENERATION_OUTPUT_DIR are invalid; generation is disabled.")
    return notes


def describe_alias(entry, settings=None, *, discovered=None):
    settings = settings or gen_models.runtime_settings()
    configured = gen_models.provider_configured(entry["provider"], settings)
    reason = None
    snapshot = None
    if not entry["enabled"]:
        reason = "disabled"
    elif not settings["enabled"]:
        reason = "generation_disabled"
    elif not configured:
        reason = "missing_key"
    else:
        try:
            snapshot = effective_snapshot(entry, discovered=discovered)
        except GenerationError as exc:
            reason = exc.code
            snapshot = None
        if snapshot is None and reason is None:
            reason = "unsupported_capability"
    available = reason is None and snapshot is not None and settings["enabled"] and configured
    return {
        "id": entry["id"],
        "provider": entry["provider"],
        "model": entry["model"],
        "output": entry["output"],
        "enabled": bool(entry["enabled"]),
        "configured": configured,
        "available": available,
        "reason": reason,
        "defaults": {
            "duration": entry["default_duration"],
            "resolution": entry["default_resolution"],
            "aspect_ratio": entry["default_aspect_ratio"],
            "mode": "text",
        },
        "capabilities": public_capabilities(snapshot) if snapshot else None,
        "privacy": (snapshot or {}).get("privacy"),
        "zdr": False if entry["provider"] == "openrouter" else None,
        "routing": (snapshot or {}).get("routing"),
    }


def public_capabilities(snapshot):
    if not snapshot:
        return None
    return {
        "modes": list(snapshot.get("modes") or []),
        "durations": list(snapshot.get("durations") or []),
        "resolutions": list(snapshot.get("resolutions") or []),
        "aspect_ratios": list(snapshot.get("aspect_ratios") or []),
        "prompt_limit": snapshot.get("prompt_limit"),
        "hash": snapshot.get("hash"),
        "privacy": snapshot.get("privacy"),
        "zdr": bool(snapshot.get("zdr")),
        "routing": snapshot.get("routing"),
    }


def list_models():
    settings = gen_models.runtime_settings()
    entries, _status = gen_models.current_manifest()
    return [describe_alias(entry, settings) for entry in entries if entry.get("enabled")]


def get_entry(alias):
    entries, _status = gen_models.current_manifest()
    for entry in entries:
        if entry["id"] == alias:
            return entry
    return None


def _adapter_for(entry, settings=None):
    settings = settings or gen_models.runtime_settings()
    key = settings["minimax_key"] if entry["provider"] == "minimax" else settings["openrouter_key"]
    return get_adapter(entry["provider"], api_key=key)


def effective_snapshot(entry, *, discovered=None):
    if entry["provider"] == "openrouter":
        if discovered is None:
            adapter = _adapter_for(entry)
            discovered = adapter.discovered_model(entry["model"], network=False)
        if discovered is None:
            raise GenerationError(
                "capabilities_stale", "no safe current model contract is available", http=503)
        snapshot = gen_models.intersect_capabilities(entry, discovered)
    else:
        snapshot = gen_models.intersect_capabilities(entry)
    if snapshot is None:
        raise GenerationError("unsupported_capability", "model cannot honor Bumparr's 16:9 video contract",
                              http=503)
    return snapshot


def normalize_request(body, *, profile=None):
    if not isinstance(body, dict):
        raise GenerationError("invalid_request", "request must be an object", http=422)
    extra = [key for key in body if key not in (
        "model", "output", "mode", "prompt", "title", "kind", "duration",
        "resolution", "ratio", "creative",
    )]
    if extra:
        raise GenerationError("invalid_request", "unknown field %s" % extra[0], http=422)
    alias = str(body.get("model") or "").strip()
    entry = get_entry(alias)
    if entry is None or not entry.get("enabled"):
        raise GenerationError("disabled", "model alias is not allow-listed", http=503)
    output = str(body.get("output") or "video")
    mode = str(body.get("mode") or "text")
    if output != "video" or mode != "text":
        raise GenerationError("unsupported_capability", "only text-to-video is implemented", http=422)
    brief = str(body.get("prompt") or "").strip()
    if not brief:
        raise GenerationError("invalid_request", "creative brief is required", http=422)
    reason = gen_models.brief_rejected(brief, profile)
    if reason:
        raise GenerationError("invalid_request", reason, http=422)
    snapshot = effective_snapshot(entry)
    if mode not in snapshot["modes"]:
        raise GenerationError("unsupported_capability", "mode is not available", http=422)
    if len(brief) > int(snapshot["prompt_limit"]):
        raise GenerationError("invalid_request", "brief exceeds the model prompt limit", http=422)
    try:
        duration = int(body.get("duration", entry["default_duration"]))
    except (TypeError, ValueError) as exc:
        raise GenerationError("invalid_request", "duration must be an integer") from exc
    resolution = str(body.get("resolution") or entry["default_resolution"]).strip()
    ratio = str(body.get("ratio") or "16:9").strip()
    if duration not in snapshot["durations"]:
        raise GenerationError("unsupported_capability", "duration is not supported", http=422)
    if resolution not in snapshot["resolutions"]:
        raise GenerationError("unsupported_capability", "resolution is not supported", http=422)
    if ratio != "16:9":
        raise GenerationError("unsupported_capability", "this project fixes ratio to 16:9", http=422)
    try:
        kind = gen_models.validate_kind(body.get("kind") or "generated_short")
        title = gen_models.validate_title(body.get("title"), brief)
        creative_obj = gen_models.validate_creative(body.get("creative"))
    except ValueError as exc:
        raise GenerationError("invalid_request", str(exc), http=422) from exc
    submitted = brief + gen_models.technical_suffix()
    if len(submitted) > int(snapshot["prompt_limit"]):
        submitted = brief
    estimate = gen_models.estimate_microusd(snapshot, duration, resolution)
    settings = gen_models.runtime_settings()
    if estimate is None and settings["daily_microusd"] > 0:
        raise GenerationError("invalid_request", "cost cannot be estimated while a USD ceiling is enabled",
                              http=422)
    return {
        "entry": entry,
        "snapshot": snapshot,
        "operator_brief": brief,
        "submitted_prompt": submitted,
        "title": title,
        "kind": kind,
        "duration": duration,
        "resolution": resolution,
        "ratio": "16:9",
        "mode": "text",
        "creative": creative_obj,
        "estimate_microusd": estimate or 0,
        "settings": settings,
    }


def preflight(body, *, profile=None):
    settings = gen_models.runtime_settings()
    if not settings["dirs_ok"]:
        raise GenerationError("disabled", "generation directories are invalid", http=503)
    if not settings["enabled"]:
        raise GenerationError("disabled", "generation is not enabled", http=503)
    prepared = normalize_request(body, profile=profile)
    entry = prepared["entry"]
    if not gen_models.provider_configured(entry["provider"], prepared["settings"]):
        raise GenerationError("missing_key", "provider credential is not configured", http=503)
    usage = budget_usage(utc_day())
    return {
        "model": entry["id"],
        "provider": entry["provider"],
        "provider_model": entry["model"],
        "mode": "text",
        "operator_brief": prepared["operator_brief"],
        "submitted_prompt": prepared["submitted_prompt"],
        "title": prepared["title"],
        "kind": prepared["kind"],
        "duration": prepared["duration"],
        "resolution": prepared["resolution"],
        "ratio": "16:9",
        "creative": prepared["creative"],
        "capability_hash": prepared["snapshot"]["hash"],
        "privacy": prepared["snapshot"]["privacy"],
        "zdr": bool(prepared["snapshot"].get("zdr")),
        "routing": prepared["snapshot"]["routing"],
        "estimate": {
            "microusd": prepared["estimate_microusd"],
            "usd": gen_models.micro_to_usd_str(prepared["estimate_microusd"]),
            "video_seconds": prepared["duration"],
            "jobs": 1,
        },
        "budget_remaining": {
            "jobs": max(0, settings["daily_jobs"] - usage["jobs"]),
            "video_seconds": max(0, settings["daily_video_seconds"] - usage["video_seconds"]),
            "microusd": max(0, settings["daily_microusd"] - usage["microusd"]),
        },
        "paid_api": True,
        "preflight_token": preflight_token(prepared, utc_day(), usage),
    }


def preflight_token(prepared, day, usage):
    """Fingerprint server-normalized inputs, capabilities, price and budget.

    Not an authorization credential: create still performs every validation.
    A changed value requires the operator to inspect a new preview.
    """
    values = {key: prepared[key] for key in (
        "operator_brief", "submitted_prompt", "title", "kind", "duration",
        "resolution", "creative", "estimate_microusd",
    )}
    values.update(snapshot=prepared["snapshot"]["hash"], day=day, usage=usage,
                  caps={key: prepared["settings"][key] for key in (
                      "daily_jobs", "daily_video_seconds", "daily_microusd")})
    return hashlib.sha256(_json(values).encode()).hexdigest()


def budget_usage(day):
    with db.conn(readonly=_db_exists()) as c:
        try:
            rows = c.execute(
                "SELECT reserved_jobs, reserved_video_seconds, reserved_cost_microusd, "
                "actual_cost_microusd FROM generation_jobs WHERE budget_day=?",
                (day,),
            ).fetchall()
        except sqlite3.OperationalError:
            return {"jobs": 0, "video_seconds": 0, "microusd": 0}
    jobs = seconds = micro = 0
    for row in rows:
        jobs += int(row["reserved_jobs"] or 0)
        seconds += int(row["reserved_video_seconds"] or 0)
        reserved = int(row["reserved_cost_microusd"] or 0)
        actual = row["actual_cost_microusd"]
        actual = int(actual) if actual is not None else 0
        micro += max(reserved, actual)
    return {"jobs": jobs, "video_seconds": seconds, "microusd": micro}


def _db_exists():
    from pathlib import Path
    return Path(config.DB_PATH).is_file()


def job_counts():
    counts = {state: 0 for state in list(JOB_ACTIVE) + list(JOB_TERMINAL)}
    if not _db_exists():
        return counts
    with db.conn(readonly=True) as c:
        try:
            rows = c.execute("SELECT status, COUNT(*) n FROM generation_jobs GROUP BY status").fetchall()
        except sqlite3.OperationalError:
            return counts
    for row in rows:
        counts[row["status"]] = int(row["n"])
    return counts


def active_concurrency():
    if not _db_exists():
        return 0
    with db.conn(readonly=True) as c:
        row = c.execute(
            "SELECT COUNT(*) n FROM generation_jobs WHERE status IN (%s)"
            % ",".join("?" * len(CONCURRENCY_STATES)),
            tuple(CONCURRENCY_STATES),
        ).fetchone()
    return int(row["n"] if row else 0)


def enqueue(body, *, profile=None, now=None, parent_job_id=None,
            expected_preflight=None, require_preflight=False):
    settings = gen_models.runtime_settings()
    if not settings["enabled"]:
        raise GenerationError("disabled", "generation is not enabled", http=503)
    prepared = normalize_request(body, profile=profile)
    if not gen_models.provider_configured(prepared["entry"]["provider"], prepared["settings"]):
        raise GenerationError("missing_key", "provider credential is not configured", http=503)
    now = time.time() if now is None else now
    day = utc_day(now)
    job_id = new_job_id()
    request = {
        "duration": prepared["duration"],
        "resolution": prepared["resolution"],
        "ratio": "16:9",
        "mode": "text",
        "output": "video",
    }
    with db.conn(immediate=True) as c:
        rebook_midnight(c, now=now)
        if require_preflight or expected_preflight is not None:
            if expected_preflight != preflight_token(prepared, day, _budget_usage_locked(c, day)):
                raise GenerationError("preflight_changed", "Run preflight again: request, capabilities or budget changed",
                                      http=409)
        _ensure_budget_locked(c, prepared, day)
        c.execute(
            """INSERT INTO generation_jobs (
                 id, parent_job_id, status, provider, model_alias, provider_model,
                 provider_model_canonical, output_modality, mode, operator_brief,
                 submitted_prompt, title, kind, request_json, references_json,
                 creative_json, capability_json, budget_day, reserved_jobs,
                 reserved_video_seconds, reserved_cost_microusd, created_at, updated_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (job_id, parent_job_id, "queued", prepared["entry"]["provider"],
             prepared["entry"]["id"], prepared["entry"]["model"],
             prepared["snapshot"].get("provider_model_canonical"),
             "video", "text", prepared["operator_brief"], prepared["submitted_prompt"],
             prepared["title"], prepared["kind"], _json(request), "[]",
             _json(prepared["creative"]), _json(prepared["snapshot"]),
             day, 1, prepared["duration"], prepared["estimate_microusd"], now, now),
        )
    return get_job(job_id)


def _ensure_budget_locked(c, prepared, day):
    settings = prepared["settings"]
    usage = _budget_usage_locked(c, day)
    jobs, seconds, micro = usage["jobs"], usage["video_seconds"], usage["microusd"]
    if jobs + 1 > settings["daily_jobs"]:
        raise GenerationError("budget_exhausted", "daily job cap reached", http=409)
    if seconds + prepared["duration"] > settings["daily_video_seconds"]:
        raise GenerationError("budget_exhausted", "daily video-second cap reached", http=409)
    if micro + prepared["estimate_microusd"] > settings["daily_microusd"]:
        raise GenerationError("budget_exhausted", "daily USD cap reached", http=409)


def _budget_usage_locked(c, day):
    row = c.execute(
        "SELECT COALESCE(SUM(reserved_jobs),0), COALESCE(SUM(reserved_video_seconds),0), "
        "COALESCE(SUM(CASE WHEN actual_cost_microusd IS NOT NULL AND actual_cost_microusd > reserved_cost_microusd "
        "THEN actual_cost_microusd ELSE reserved_cost_microusd END),0) "
        "FROM generation_jobs WHERE budget_day=?",
        (day,),
    ).fetchone()
    jobs, seconds, micro = (int(row[0]), int(row[1]), int(row[2])) if row else (0, 0, 0)
    return {"jobs": jobs, "video_seconds": seconds, "microusd": micro}


def get_job(job_id):
    with db.conn(readonly=True) as c:
        row = c.execute("SELECT * FROM generation_jobs WHERE id=?", (job_id,)).fetchone()
        outputs = []
        if row is not None:
            outputs = [dict(r) for r in c.execute(
                "SELECT * FROM generation_outputs WHERE job_id=? ORDER BY ordinal", (job_id,)).fetchall()]
    if row is None:
        raise GenerationError("invalid_request", "job not found", http=404)
    return public_job(dict(row), outputs)


def public_job(row, outputs=None):
    request = _load_json(row.get("request_json"), {})
    capability = _load_json(row.get("capability_json"), {})
    creative_obj = _load_json(row.get("creative_json"), {})
    usage = _load_json(row.get("usage_json"), {})
    return {
        "id": row["id"],
        "parent_job_id": row.get("parent_job_id"),
        "status": row["status"],
        "provider": row["provider"],
        "model_alias": row["model_alias"],
        "provider_model": row["provider_model"],
        "provider_model_canonical": row.get("provider_model_canonical"),
        "mode": row["mode"],
        "title": row["title"],
        "kind": row["kind"],
        "operator_brief": row["operator_brief"],
        "submitted_prompt": row["submitted_prompt"],
        "request": request,
        "creative": creative_obj,
        "capability_hash": capability.get("hash"),
        "privacy": capability.get("privacy"),
        "zdr": bool(capability.get("zdr")),
        "routing": capability.get("routing"),
        "provider_job_id": row.get("provider_job_id"),
        "usage": usage,
        "budget_day": row["budget_day"],
        "reserved": {
            "jobs": row["reserved_jobs"],
            "video_seconds": row["reserved_video_seconds"],
            "microusd": row["reserved_cost_microusd"],
        },
        "actual_cost_microusd": row.get("actual_cost_microusd"),
        "error_code": row.get("error_code"),
        "error_message": redact(row.get("error_message") or ""),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "submitted_at": row.get("submitted_at"),
        "completed_at": row.get("completed_at"),
        "outputs": [public_output(item) for item in (outputs or [])],
        "next_step": next_step(row["status"], outputs or []),
    }


def public_output(row):
    meta = _load_json(row.get("metadata_json"), {})
    return {
        "id": row["id"],
        "job_id": row["job_id"],
        "ordinal": row["ordinal"],
        "modality": row["modality"],
        "processing_status": row["processing_status"],
        "review_status": row["review_status"],
        "playable_id": row.get("playable_id"),
        "uri": row.get("media_path"),
        "sha256": row.get("output_sha256"),
        "duration": meta.get("duration"),
        "audio": meta.get("audio"),
        "review_reason": row.get("review_reason"),
        "error_code": meta.get("error_code"),
        "error_message": bound_text(meta.get("error_message")),
        "created_at": row["created_at"],
        "reviewed_at": row.get("reviewed_at"),
    }


def next_step(status, outputs):
    if status == "queued":
        return "waiting locally for the generation worker"
    if status == "submitting":
        return "submitting to the named provider"
    if status == "submitted":
        return "queued at the named provider"
    if status == "running":
        return "generating"
    if status == "downloading":
        return "downloading the untrusted result"
    if status == "processing":
        return "validating and normalizing"
    if status == "submission_unknown":
        return "ambiguous submission — reconcile from the provider dashboard"
    if status == "failed":
        return "failed; regenerate only as a new job"
    if status == "cancelled":
        return "cancelled"
    if status == "completed":
        pending = [o for o in outputs if o.get("review_status") == "pending"
                   and o.get("processing_status") == "ready"]
        if pending:
            return "awaiting review"
        failed = [o for o in outputs if o.get("processing_status") == "failed"]
        if failed:
            return "local processing failed; retry processing without a new provider job"
        return "complete"
    return status


def list_jobs(*, status=None, provider=None, limit=50, offset=0):
    clauses = []
    args = []
    if status:
        clauses.append("status=?")
        args.append(status)
    if provider:
        clauses.append("provider=?")
        args.append(provider)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with db.conn(readonly=True) as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM generation_jobs %s ORDER BY created_at DESC LIMIT ? OFFSET ?"
            % where, args + [limit, offset]).fetchall()]
        out = []
        for row in rows:
            outputs = [dict(o) for o in c.execute(
                "SELECT * FROM generation_outputs WHERE job_id=? ORDER BY ordinal",
                (row["id"],)).fetchall()]
            out.append(public_job(row, outputs))
    return out


def list_outputs(*, review_status="pending", limit=50, offset=0):
    with db.conn(readonly=True) as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM generation_outputs WHERE review_status=? "
            "ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            (review_status, limit, offset)).fetchall()]
    return [public_output(row) for row in rows]


def cas(c, job_id, current, new_status, fields=None, now=None):
    if new_status not in TRANSITIONS.get(current, frozenset()):
        return False
    now = time.time() if now is None else now
    assignments = ["status=?", "updated_at=?"]
    values = [new_status, now]
    for key, value in (fields or {}).items():
        assignments.append("%s=?" % key)
        values.append(value)
    values.extend([job_id, current])
    cur = c.execute(
        "UPDATE generation_jobs SET %s WHERE id=? AND status=?" % ", ".join(assignments),
        values,
    )
    return cur.rowcount == 1


def fail_job(c, job, code, message, *, release=False, now=None):
    now = time.time() if now is None else now
    fields = {
        "error_code": code,
        "error_message": bound_text(message, ERROR_LIMIT),
        "completed_at": now,
    }
    if release:
        fields.update({"reserved_jobs": 0, "reserved_video_seconds": 0, "reserved_cost_microusd": 0})
    return cas(c, job["id"], job["status"], "failed", fields, now=now)


def cancel_job(job_id):
    with db.conn() as c:
        row = c.execute("SELECT * FROM generation_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise GenerationError("invalid_request", "job not found", http=404)
        job = dict(row)
        if job["status"] == "queued":
            now = time.time()
            if not cas(c, job_id, "queued", "cancelled", {
                "reserved_jobs": 0, "reserved_video_seconds": 0,
                "reserved_cost_microusd": 0, "completed_at": now,
                "error_code": "cancelled", "error_message": "cancelled before submission",
            }, now=now):
                raise GenerationError("invalid_request", "job state changed", http=409)
        elif job["status"] in JOB_TERMINAL:
            raise GenerationError("invalid_request", "job is already terminal", http=409)
        else:
            raise GenerationError(
                "invalid_request",
                "provider cancel is not implemented; local cancel after submit would not stop billing",
                http=409,
            )
    return get_job(job_id)


def reconcile(job_id, body):
    if not isinstance(body, dict):
        raise GenerationError("invalid_request", "request must be an object", http=422)
    extra = [key for key in body if key not in ("provider_job_id", "not_accepted")]
    if extra:
        raise GenerationError("invalid_request", "unknown field %s" % extra[0], http=422)
    with db.conn() as c:
        row = c.execute("SELECT * FROM generation_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise GenerationError("invalid_request", "job not found", http=404)
        job = dict(row)
        if job["status"] != "submission_unknown":
            raise GenerationError("invalid_request", "only submission_unknown jobs can be reconciled",
                                  http=409)
        if body.get("not_accepted"):
            now = time.time()
            cas(c, job_id, "submission_unknown", "failed", {
                "error_code": "confirmed_not_submitted",
                "error_message": "operator confirmed the provider did not accept the job",
                "reserved_jobs": 0, "reserved_video_seconds": 0,
                "reserved_cost_microusd": 0, "completed_at": now,
            }, now=now)
        else:
            provider_job_id = str(body.get("provider_job_id") or "").strip()
            if not provider_job_id:
                raise GenerationError("invalid_request", "provider_job_id or not_accepted is required",
                                      http=422)
            # An alias may have been removed or repointed since acceptance.
            # Reconcile through the historical provider, not today's alias.
            adapter = _adapter_for(job)
            try:
                result = adapter.query(provider_job_id)
            except ProviderError as exc:
                raise GenerationError(exc.code, exc.message, http=409) from exc
            state = result.get("state")
            target = "submitted"
            if state == "running":
                target = "running"
            elif state == "succeeded":
                target = "downloading"
            elif state in ("failed", "cancelled"):
                raise GenerationError("invalid_request", "provider job is already terminal", http=409)
            now = time.time()
            cas(c, job_id, "submission_unknown", target, {
                "provider_job_id": provider_job_id,
                "submitted_at": now,
            }, now=now)
    return get_job(job_id)


def regenerate(job_id, body=None, *, require_preflight=False):
    job = get_job(job_id)
    payload = {
        "model": job["model_alias"],
        "output": "video",
        "mode": job["mode"],
        "prompt": (body or {}).get("prompt") or job["operator_brief"],
        "title": (body or {}).get("title") or job["title"],
        "kind": job["kind"],
        "duration": job["request"].get("duration"),
        "resolution": job["request"].get("resolution"),
        "ratio": "16:9",
        "creative": {
            "roles": list((job.get("creative") or {}).get("roles") or ["inside"]),
            "energy": (job.get("creative") or {}).get("energy") or "quiet",
        },
    }
    if body:
        extra = [key for key in body if key not in ("prompt", "title", "preflight_token")]
        if extra:
            raise GenerationError("invalid_request", "unknown field %s" % extra[0], http=422)
        if "prompt" in body:
            payload["prompt"] = body["prompt"]
        if "title" in body:
            payload["title"] = body["title"]
    return enqueue(payload, parent_job_id=job_id,
                   expected_preflight=(body or {}).get("preflight_token"),
                   require_preflight=require_preflight)


def claim_queued(*, now=None):
    settings = gen_models.runtime_settings()
    if not settings["enabled"]:
        return None
    now = time.time() if now is None else now
    with db.conn(immediate=True) as c:
        rebook_midnight(c, now=now)
        if _over_budget(c, utc_day(now), settings):
            return None
        if int(c.execute(
                "SELECT COUNT(*) FROM generation_jobs WHERE status IN (%s)"
                % ",".join("?" * len(CONCURRENCY_STATES)),
                tuple(CONCURRENCY_STATES)).fetchone()[0]) >= settings["max_active"]:
            return None
        row = c.execute(
            "SELECT * FROM generation_jobs WHERE status='queued' "
            "AND (next_attempt_at IS NULL OR next_attempt_at<=?) "
            "ORDER BY created_at LIMIT 1",
            (now,),
        ).fetchone()
        if row is None:
            return None
        job = dict(row)
        if not cas(c, job["id"], "queued", "submitting", now=now):
            return None
        job["status"] = "submitting"
        return job


def pre_submit_gate(job):
    """Revalidate alias, credential, and remaining budget before a paid create.

    Already-accepted work is not gated here. Returns False if the claim was
    reverted or failed without contacting a provider.
    """
    settings = gen_models.runtime_settings()
    if not settings["enabled"]:
        with db.conn() as c:
            cas(c, job["id"], "submitting", "queued", {
                "error_code": "disabled",
                "error_message": "generation is disabled",
            })
        return False
    entry = get_entry(job["model_alias"])
    if entry is None or not entry.get("enabled"):
        fail_current(job, "disabled", "model alias is no longer allow-listed", release=True)
        return False
    try:
        snapshot = effective_snapshot(entry)
        if (entry["provider"] != job["provider"] or entry["model"] != job["provider_model"]
                or snapshot["hash"] != _load_json(job["capability_json"], {}).get("hash")):
            raise GenerationError("preflight_changed", "queued model contract changed; preflight a new job")
    except GenerationError as exc:
        fail_current(job, exc.code, exc.message, release=True)
        return False
    if not gen_models.provider_configured(entry["provider"], settings):
        fail_current(job, "missing_key", "provider credential is not configured", release=True)
        return False
    day = job.get("budget_day") or utc_day()
    with db.conn(immediate=True) as c:
        current = c.execute("SELECT status FROM generation_jobs WHERE id=?", (job["id"],)).fetchone()
        if not current or current["status"] != "submitting":
            return False
        if _over_budget(c, day, settings):
            cas(c, job["id"], "submitting", "queued", {
                "error_code": "budget_exhausted", "error_message": "daily cap reached before submission"})
            return False
        return True


def _over_budget(c, day, settings):
    usage = _budget_usage_locked(c, day)
    return any(usage[key] > settings[cap] for key, cap in (
        ("jobs", "daily_jobs"), ("video_seconds", "daily_video_seconds"), ("microusd", "daily_microusd")))


def pause_recovery(job, code, message, *, now=None, delay=60):
    """Keep an accepted job; retry after delay (missing key, backoff)."""
    now = time.time() if now is None else now
    with db.conn() as c:
        c.execute(
            "UPDATE generation_jobs SET error_code=?, error_message=?, "
            "next_attempt_at=?, attempt_count=attempt_count+1, updated_at=? WHERE id=?",
            (code, bound_text(message), now + delay, now, job["id"]),
        )


def backoff_query(job, *, now=None):
    now = time.time() if now is None else now
    attempts = int(job.get("attempt_count") or 0) + 1
    delay = min(300, 5 * (2 ** min(attempts, 6)))
    with db.conn() as c:
        c.execute(
            "UPDATE generation_jobs SET error_code=?, error_message=?, "
            "next_attempt_at=?, attempt_count=?, updated_at=? WHERE id=?",
            ("provider_unavailable", bound_text("query will retry"),
             now + delay, attempts, now, job["id"]),
        )


def recover_stale(*, now=None, stale_after=120):
    now = time.time() if now is None else now
    cutoff = now - stale_after
    recovered = []
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM generation_jobs WHERE status='submitting' AND updated_at < ?",
            (cutoff,)).fetchall()]
        for job in rows:
            if job.get("provider_job_id"):
                cas(c, job["id"], "submitting", "submitted", now=now)
                recovered.append(job["id"])
                continue
            cas(c, job["id"], "submitting", "submission_unknown", {
                "error_code": "submission_unknown",
                "error_message": "process died during provider create; not resubmitted",
            }, now=now)
            recovered.append(job["id"])
    return recovered


def rebook_midnight(c, now=None):
    now = time.time() if now is None else now
    today = utc_day(now)
    rows = [dict(r) for r in c.execute(
        "SELECT * FROM generation_jobs WHERE status='queued' AND budget_day != ?",
        (today,)).fetchall()]
    settings = gen_models.runtime_settings()
    usage_row = c.execute(
        "SELECT COALESCE(SUM(reserved_jobs),0), COALESCE(SUM(reserved_video_seconds),0), "
        "COALESCE(SUM(CASE WHEN actual_cost_microusd IS NOT NULL AND actual_cost_microusd > reserved_cost_microusd "
        "THEN actual_cost_microusd ELSE reserved_cost_microusd END),0) "
        "FROM generation_jobs WHERE budget_day=?",
        (today,),
    ).fetchone()
    jobs, seconds, micro = (int(usage_row[0]), int(usage_row[1]), int(usage_row[2]))
    for job in rows:
        need_jobs = int(job["reserved_jobs"] or 0)
        need_seconds = int(job["reserved_video_seconds"] or 0)
        need_micro = int(job["reserved_cost_microusd"] or 0)
        if (jobs + need_jobs > settings["daily_jobs"]
                or seconds + need_seconds > settings["daily_video_seconds"]
                or micro + need_micro > settings["daily_microusd"]):
            fail_job(c, job, "budget_exhausted", "UTC day rolled over without remaining capacity",
                     release=True, now=now)
            continue
        c.execute(
            "UPDATE generation_jobs SET budget_day=?, updated_at=? WHERE id=? AND status='queued'",
            (today, now, job["id"]),
        )
        jobs += need_jobs
        seconds += need_seconds
        micro += need_micro


def record_submission(job, submission, *, now=None):
    now = time.time() if now is None else now
    with db.conn() as c:
        ok = cas(c, job["id"], "submitting", "submitted", {
            "provider_job_id": submission["provider_job_id"],
            "provider_generation_id": submission.get("provider_generation_id"),
            "provider_request_id": submission.get("provider_request_id"),
            "submitted_at": now,
        }, now=now)
        if not ok:
            return False
    return True


def mark_submission_unknown(job, message, *, now=None):
    now = time.time() if now is None else now
    with db.conn() as c:
        cas(c, job["id"], job["status"], "submission_unknown", {
            "error_code": "submission_unknown",
            "error_message": bound_text(message),
        }, now=now)


def apply_query(job, result, *, now=None):
    now = time.time() if now is None else now
    state = result.get("state")
    usage = result.get("usage") or {}
    fields = {"usage_json": _json(usage), "attempt_count": 0, "next_attempt_at": None,
              "error_code": None, "error_message": None}
    if usage.get("cost_microusd") is not None:
        fields["actual_cost_microusd"] = int(usage["cost_microusd"])
    if result.get("provider_generation_id"):
        fields["provider_generation_id"] = result["provider_generation_id"]
    with db.conn() as c:
        current = dict(c.execute("SELECT * FROM generation_jobs WHERE id=?", (job["id"],)).fetchone())
        if current["status"] in JOB_TERMINAL:
            return
        # Polls can repeat the same state. Persist usage and clear backoff even
        # when no state transition is needed (and also on terminal failures).
        c.execute("UPDATE generation_jobs SET usage_json=?, actual_cost_microusd=COALESCE(?, actual_cost_microusd), "
                  "attempt_count=0, next_attempt_at=NULL, error_code=NULL, error_message=NULL WHERE id=?",
                  (_json(usage), fields.get("actual_cost_microusd"), job["id"]))
        if state == "submitted":
            cas(c, job["id"], current["status"], "submitted", fields, now=now)
        elif state == "running":
            cas(c, job["id"], current["status"], "running", fields, now=now)
        elif state == "succeeded":
            cas(c, job["id"], current["status"], "downloading", fields, now=now)
        elif state == "failed":
            fail_job(c, current, result.get("error_code") or "provider_unavailable",
                     result.get("error_message") or "provider failed", release=False, now=now)
        elif state == "cancelled":
            cas(c, job["id"], current["status"], "cancelled", {
                **fields,
                "error_code": "cancelled",
                "error_message": result.get("error_message") or "provider cancelled",
                "completed_at": now,
            }, now=now)
        elif state == "unknown_nonterminal":
            c.execute(
                "UPDATE generation_jobs SET attempt_count=attempt_count+1, updated_at=?, "
                "error_message=? WHERE id=?",
                (now, bound_text("unknown provider status %s" % result.get("provider_status")),
                 job["id"]),
            )


def mark_processing(job, *, now=None):
    now = time.time() if now is None else now
    with db.conn() as c:
        cas(c, job["id"], "downloading", "processing", now=now)


def complete_with_outputs(job, artifacts, *, now=None):
    now = time.time() if now is None else now
    with db.conn(immediate=True) as c:
        current = dict(c.execute("SELECT * FROM generation_jobs WHERE id=?", (job["id"],)).fetchone())
        for artifact in artifacts:
            output_id = artifact["output_id"]
            playable_id = artifact["playable_id"]
            c.execute(
                """INSERT OR IGNORE INTO generation_outputs (
                     id, job_id, ordinal, modality, processing_status, review_status,
                     playable_id, output_sha256, media_path, metadata_json, created_at, updated_at
                   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (output_id, job["id"], artifact["ordinal"], "video",
                 artifact.get("processing_status", "ready"),
                 artifact.get("review_status", "pending"),
                 playable_id, artifact.get("sha256"), artifact.get("media_path"),
                 _json(artifact.get("metadata") or {}), now, now),
            )
            if artifact.get("playable"):
                db.insert_generated_playable(c, artifact["playable"])
            c.execute(
                "UPDATE generation_outputs SET processing_status='ready', playable_id=?, output_sha256=?, "
                "media_path=?, metadata_json=?, updated_at=? WHERE id=? AND review_status='pending'",
                (playable_id, artifact.get("sha256"), artifact.get("media_path"),
                 _json(artifact.get("metadata") or {}), now, output_id))
        cas(c, job["id"], current["status"], "completed", {
            "completed_at": now, "error_code": None, "error_message": None, "next_attempt_at": None,
            "attempt_count": 0}, now=now)


def fail_current(job, code, message, *, release=False, now=None):
    with db.conn() as c:
        current = dict(c.execute("SELECT * FROM generation_jobs WHERE id=?", (job["id"],)).fetchone())
        fail_job(c, current, code, message, release=release, now=now)


def load_job(job_id):
    with db.conn(readonly=True) as c:
        row = c.execute("SELECT * FROM generation_jobs WHERE id=?", (job_id,)).fetchone()
    return dict(row) if row else None


def jobs_in(states, *, now=None):
    if not _db_exists():
        return []
    now = time.time() if now is None else now
    with db.conn(readonly=True) as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM generation_jobs WHERE status IN (%s) "
            "AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY updated_at"
            % ",".join("?" * len(states)),
            tuple(states) + (now,),
        ).fetchall()]


def generated_review_state(playable_id):
    if not playable_id or not _db_exists():
        return None
    with db.conn(readonly=True) as c:
        try:
            row = c.execute(
                "SELECT review_status FROM generation_outputs WHERE playable_id=?",
                (playable_id,),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
    return row["review_status"] if row else None


def payload_generation_review(payload_text):
    data = _load_json(payload_text, {})
    gen = data.get("generation") if isinstance(data, dict) else None
    if not isinstance(gen, dict):
        return None
    review = gen.get("review") if isinstance(gen.get("review"), dict) else {}
    return review.get("status")


def blocks_generic_enable(playable_id, payload_text=None, source=None):
    if str(source or "").startswith("generated:"):
        status = generated_review_state(playable_id) or payload_generation_review(payload_text)
        if status in ("pending", "rejected", None):
            if status != "approved":
                return True
    status = generated_review_state(playable_id)
    return status in ("pending", "rejected")


def approve_output(output_id):
    now = time.time()
    with db.conn() as c:
        out = c.execute("SELECT * FROM generation_outputs WHERE id=?", (output_id,)).fetchone()
        if out is None:
            raise GenerationError("invalid_request", "output not found", http=404)
        out = dict(out)
        if out["processing_status"] != "ready" or out["review_status"] != "pending":
            raise GenerationError("invalid_request", "output is not awaiting review", http=409)
        playable = c.execute("SELECT * FROM playables WHERE id=?", (out["playable_id"],)).fetchone()
        if playable is None:
            raise GenerationError("invalid_request", "candidate playable is missing", http=409)
        playable = dict(playable)
        if playable.get("enabled"):
            raise GenerationError("invalid_request", "playable is already enabled", http=409)
        path = paths.resolve_media(playable.get("uri") or "")
        if path is None or not path.is_file():
            raise GenerationError("invalid_request", "candidate file is missing", http=409)
        digest = _sha256_file(path)
        if out.get("output_sha256") and digest != out["output_sha256"]:
            raise GenerationError("invalid_request", "checksum mismatch", http=409)
        payload = _load_json(playable.get("payload"), {})
        generation = payload.get("generation") if isinstance(payload.get("generation"), dict) else {}
        generation["review"] = {"status": "approved", "reviewed_at": now}
        payload["generation"] = generation
        tags = ",".join(
            t for t in (playable.get("tags") or "").split(",") if t and t != "pending-review")
        cur = c.execute(
            "UPDATE generation_outputs SET review_status='approved', reviewed_at=?, updated_at=? "
            "WHERE id=? AND review_status='pending' AND processing_status='ready'",
            (now, now, output_id),
        )
        if cur.rowcount != 1:
            raise GenerationError("invalid_request", "output is not awaiting review", http=409)
        c.execute(
            "UPDATE playables SET enabled=1, weight=?, payload=?, tags=? WHERE id=? AND enabled=0",
            (PROPOSED_WEIGHT, _json(payload), tags, playable["id"]),
        )
        if c.execute("SELECT enabled FROM playables WHERE id=?", (playable["id"],)).fetchone()["enabled"] != 1:
            raise GenerationError("invalid_request", "approval could not enable the playable", http=409)
    return public_output(_load_output(output_id))


def reject_output(output_id, reason=""):
    now = time.time()
    reason = bound_text(reason, 200)
    with db.conn() as c:
        out = c.execute("SELECT * FROM generation_outputs WHERE id=?", (output_id,)).fetchone()
        if out is None:
            raise GenerationError("invalid_request", "output not found", http=404)
        out = dict(out)
        if out["processing_status"] != "ready" or out["review_status"] != "pending":
            raise GenerationError("invalid_request", "output is not awaiting review", http=409)
        cur = c.execute(
            "UPDATE generation_outputs SET review_status='rejected', review_reason=?, "
            "reviewed_at=?, updated_at=? WHERE id=? AND review_status='pending'",
            (reason, now, now, output_id),
        )
        if cur.rowcount != 1:
            raise GenerationError("invalid_request", "output is not awaiting review", http=409)
        if out.get("playable_id"):
            playable = c.execute("SELECT payload FROM playables WHERE id=?",
                                 (out["playable_id"],)).fetchone()
            if playable is not None:
                payload = _load_json(playable["payload"], {})
                generation = payload.get("generation") if isinstance(payload.get("generation"), dict) else {}
                generation["review"] = {"status": "rejected", "reviewed_at": now}
                payload["generation"] = generation
                c.execute(
                    "UPDATE playables SET enabled=0, weight=0, payload=? WHERE id=?",
                    (_json(payload), out["playable_id"]),
                )
    return public_output(_load_output(output_id))


def mark_output_deleted(playable_id):
    if not playable_id:
        return
    now = time.time()
    with db.conn() as c:
        c.execute(
            "UPDATE generation_outputs SET review_status='deleted', updated_at=? "
            "WHERE playable_id=?",
            (now, playable_id),
        )


def delete_output(output_id):
    """Quarantine this terminal output's files; restore all on DB failure."""
    staged = []
    try:
        with db.conn(immediate=True) as c:
            out = c.execute("SELECT * FROM generation_outputs WHERE id=?", (output_id,)).fetchone()
            if out is None:
                raise GenerationError("invalid_request", "output not found", http=404)
            out = dict(out)
            job = c.execute("SELECT status FROM generation_jobs WHERE id=?", (out["job_id"],)).fetchone()
            if job and job["status"] not in JOB_TERMINAL:
                raise GenerationError("invalid_request", "cannot delete an active output", http=409)
            playable_id = out.get("playable_id")
            row = c.execute("SELECT uri FROM playables WHERE id=?", (playable_id,)).fetchone()
            targets = [paths.resolve_media(row["uri"] or "")] if row else []
            if re.fullmatch(r"genout:[0-9a-f]{32}", output_id):
                stem = output_id.replace(":", "-")
                for root, suffix in ((gen_models.staging_dir(), ".bin"), (gen_models.output_dir(), ".mp4")):
                    if root:
                        targets.append(paths._contained(Path(root) / (stem + suffix), root))
            for path in dict.fromkeys(targets):
                if path is not None:
                    staged.append((path, paths.stage_delete(path)))
            if playable_id:
                c.execute("DELETE FROM playables WHERE id=?", (playable_id,))
            c.execute(
                "UPDATE generation_outputs SET review_status='deleted', updated_at=? WHERE id=?",
                (time.time(), output_id),
            )
    except Exception:
        for original, quarantine in reversed(staged):
            paths.restore_delete(original, quarantine)
        raise
    for original, quarantine in staged:
        try:
            paths.finish_delete(quarantine)
        except OSError:
            pass
    return {"deleted": True, "output_id": output_id, "playable_id": playable_id}


def retry_processing(output_id):
    with db.conn(immediate=True) as c:
        out = c.execute("SELECT * FROM generation_outputs WHERE id=?", (output_id,)).fetchone()
        if out is None:
            raise GenerationError("invalid_request", "output not found", http=404)
        out = dict(out)
        if out["processing_status"] != "failed" or out["review_status"] == "deleted":
            raise GenerationError("invalid_request", "only failed local processing can be retried",
                                  http=409)
        job = dict(c.execute("SELECT * FROM generation_jobs WHERE id=?", (out["job_id"],)).fetchone())
        if not job.get("provider_job_id"):
            raise GenerationError("invalid_request", "no provider job remains to retrieve", http=409)
        if job["status"] not in ("completed", "failed"):
            raise GenerationError("invalid_request", "job is already active", http=409)
        cas(c, job["id"], job["status"], "downloading", {
            "completed_at": None, "next_attempt_at": None, "attempt_count": 0,
            "error_code": None, "error_message": None})
        c.execute(
            "UPDATE generation_outputs SET processing_status='pending', updated_at=? WHERE id=?",
            (time.time(), output_id),
        )
    return get_job(out["job_id"])


def ensure_pending_output(job, ordinal=0, *, now=None):
    now = time.time() if now is None else now
    with db.conn(immediate=True) as c:
        row = c.execute(
            "SELECT * FROM generation_outputs WHERE job_id=? AND ordinal=?",
            (job["id"], ordinal),
        ).fetchone()
        if row is not None:
            return dict(row)
        output_id = new_output_id()
        c.execute(
            """INSERT INTO generation_outputs (
                 id, job_id, ordinal, modality, processing_status, review_status,
                 metadata_json, created_at, updated_at
               ) VALUES (?,?,?,?,?,?,?,?,?)""",
            (output_id, job["id"], ordinal, "video", "pending", "pending",
             "{}", now, now),
        )
        row = c.execute("SELECT * FROM generation_outputs WHERE id=?", (output_id,)).fetchone()
        return dict(row)


def record_staging_path(output_id, staging_path, *, now=None):
    now = time.time() if now is None else now
    with db.conn() as c:
        row = c.execute("SELECT metadata_json FROM generation_outputs WHERE id=?",
                        (output_id,)).fetchone()
        meta = _load_json(row["metadata_json"] if row else "{}", {})
        meta["staging_path"] = str(staging_path)
        c.execute(
            "UPDATE generation_outputs SET metadata_json=?, processing_status='processing', updated_at=? WHERE id=?",
            (_json(meta), now, output_id),
        )


def record_landed(output_id, artifact):
    """Persist checksum/descriptor before the final playable transaction."""
    with db.conn() as c:
        row = c.execute("SELECT metadata_json FROM generation_outputs WHERE id=?", (output_id,)).fetchone()
        meta = _load_json(row["metadata_json"], {})
        meta["landed"] = artifact
        c.execute("UPDATE generation_outputs SET metadata_json=? WHERE id=?", (_json(meta), output_id))


def referenced_staging():
    with db.conn(readonly=True) as c:
        return [meta["staging_path"] for row in c.execute(
            "SELECT metadata_json FROM generation_outputs WHERE processing_status != 'ready' AND review_status != 'deleted'")
            if (meta := _load_json(row["metadata_json"], {})).get("staging_path")]


def mark_output_processing_failed(output_id, code, message, *, now=None):
    now = time.time() if now is None else now
    with db.conn() as c:
        row = c.execute("SELECT metadata_json FROM generation_outputs WHERE id=?",
                        (output_id,)).fetchone()
        meta = _load_json(row["metadata_json"] if row else "{}", {})
        meta["error_code"] = code
        meta["error_message"] = bound_text(message)
        c.execute(
            "UPDATE generation_outputs SET processing_status='failed', metadata_json=?, "
            "updated_at=? WHERE id=?",
            (_json(meta), now, output_id),
        )


def complete_provider_job(job, *, now=None):
    """Mark execution complete after provider success, even if local processing failed."""
    now = time.time() if now is None else now
    with db.conn() as c:
        current = dict(c.execute("SELECT * FROM generation_jobs WHERE id=?", (job["id"],)).fetchone())
        if current["status"] in JOB_TERMINAL:
            return
        cas(c, job["id"], current["status"], "completed", {
            "completed_at": now,
            "error_code": current.get("error_code"),
            "error_message": current.get("error_message"),
        }, now=now)


def _load_output(output_id):
    with db.conn(readonly=True) as c:
        row = c.execute("SELECT * FROM generation_outputs WHERE id=?", (output_id,)).fetchone()
    if row is None:
        raise GenerationError("invalid_request", "output not found", http=404)
    return dict(row)


def _sha256_file(path):
    import hashlib
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_playable(job, artifact):
    now = time.time()
    output_id = artifact["output_id"]
    playable_id = "gen:" + output_id.split(":", 1)[-1]
    uri = artifact["uri"]
    payload = {
        "generation": {
            "ai_generated": True,
            "provider": job["provider"],
            "model_alias": job["model_alias"],
            "provider_model": job["provider_model"],
            "provider_model_canonical": job.get("provider_model_canonical"),
            "output_id": output_id,
            "mode": job["mode"],
            "generation_id": job["id"],
            "provider_job_id": job.get("provider_job_id"),
            "operator_brief": job["operator_brief"],
            "submitted_prompt": job["submitted_prompt"],
            "requested": _load_json(job.get("request_json"), {}),
            "actual": artifact.get("actual") or {},
            "references": [],
            "usage": _load_json(job.get("usage_json"), {}),
            "cost": {
                "reserved_microusd": job.get("reserved_cost_microusd"),
                "actual_microusd": job.get("actual_cost_microusd"),
            },
            "capability_snapshot_hash": _load_json(job.get("capability_json"), {}).get("hash"),
            "generated_at": now,
            "sha256": artifact.get("sha256"),
            "review": {"status": "pending", "reviewed_at": None},
            "proposed_weight": PROPOSED_WEIGHT,
        }
    }
    creative_obj = _load_json(job.get("creative_json"), {})
    payload = creative.with_presentation(payload, {
        "id": playable_id, "type": "video", "kind": job["kind"],
        "source": "generated:%s" % job["provider"],
    })
    payload = creative.merge_creative(payload, {
        "family": "authored",
        "roles": creative_obj.get("roles") or ["inside"],
        "energy": creative_obj.get("energy") or "quiet",
        "audio": artifact.get("audio") or "silence",
        "text_heavy": False,
        "brand_mode": "none",
        "music_id": None,
    })
    tags = "ai-generated,pending-review,%s,%s" % (job["provider"], job["model_alias"])
    return {
        "id": playable_id,
        "type": "video",
        "kind": job["kind"],
        "source": "generated:%s" % job["provider"],
        "uri": uri,
        "duration": artifact.get("duration") or 0,
        "title": job["title"],
        "payload": _json(payload),
        "tags": tags,
        "created_at": now,
    }
