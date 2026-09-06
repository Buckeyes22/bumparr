"""OpenRouter asynchronous video adapter. Discovery-driven; not MiniMax-shaped."""
import json
import time
from pathlib import Path

from bumparr import config
from bumparr.generation import models as gen_models
from bumparr.generation.providers.base import (
    ProviderError, StdlibTransport, bound_text, map_http_error,
)

ORIGIN = "https://openrouter.ai"
MODELS_PATH = "/api/v1/videos/models"
CREATE_PATH = "/api/v1/videos"
QUERY_PATH = "/api/v1/videos/"
CONTENT_PATH = "/api/v1/videos/%s/content?index=0"
KNOWN_STATUSES = frozenset({
    "pending", "in_progress", "completed", "failed", "cancelled", "expired",
})
CACHE_SECONDS = 3600
CACHE_NAME = "generation-openrouter-discovery.json"


class OpenRouterAdapter:
    name = "openrouter"
    origin = ORIGIN

    def __init__(self, *, api_key="", transport=None, discovery=None, now=None):
        self.api_key = (api_key or "").strip()
        self.transport = transport or StdlibTransport(ORIGIN)
        self._discovery = discovery
        self._now = now or time.time

    def _headers(self, *, json_content=False):
        if not self.api_key:
            raise ProviderError("missing_key", "OpenRouter API key is not configured")
        headers = {
            "Authorization": "Bearer %s" % self.api_key,
            "Accept": "application/json",
        }
        if json_content:
            headers["Content-Type"] = "application/json"
        return headers

    def cache_path(self):
        root = Path(getattr(config, "DATA_DIR", "/data"))
        return root / CACHE_NAME

    def discovery_snapshot(self, *, refresh=False, network=False):
        """Return the cached catalog. Network only when explicitly requested."""
        if refresh:
            network = True
        if self._discovery is not None and not refresh:
            snap = self._discovery
            if snap.get("expires_at", 0) > self._now():
                return snap
            if not network:
                return None
        now = self._now()
        cached = self._load_cache()
        if cached and cached.get("expires_at", 0) > now and not refresh:
            self._discovery = cached
            return cached
        if not network:
            return None
        if not self.api_key:
            raise ProviderError("capabilities_stale", "OpenRouter discovery is unavailable")
        resp = self.transport.request("GET", MODELS_PATH, headers=self._headers())
        if resp.status >= 400:
            raise map_http_error(resp.status, resp.body.decode("utf-8", "replace"))
        parsed = _parse_models(resp.json())
        snapshot = {
            "fetched_at": now,
            "expires_at": now + CACHE_SECONDS,
            "models": parsed,
        }
        self._store_cache(snapshot)
        self._discovery = snapshot
        return snapshot

    def _load_cache(self):
        path = self.cache_path()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("models"), list):
            return None
        return data

    def _store_cache(self, snapshot):
        path = self.cache_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(snapshot), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass

    def discovered_model(self, slug, *, network=False):
        snap = self.discovery_snapshot(network=network)
        if not snap:
            return None
        for item in snap.get("models") or []:
            if item.get("id") == slug:
                return item
        return None

    def capabilities(self, entry, *, network=False):
        found = self.discovered_model(entry["model"], network=network)
        if found is None:
            return None
        return gen_models.intersect_capabilities(entry, found)

    def estimate(self, request, capabilities):
        duration = int(request.get("duration") or 0)
        micro = gen_models.estimate_microusd(
            capabilities, duration, request.get("resolution"))
        if micro is None:
            raise ProviderError("invalid_request",
                                "OpenRouter cost cannot be estimated without discovered pricing")
        return {
            "microusd": micro,
            "usd": gen_models.micro_to_usd_str(micro),
            "unit": "video_second",
            "duration": duration,
        }

    def submit(self, request):
        body = {
            "model": request["provider_model"],
            "prompt": request["submitted_prompt"],
            "duration": int(request["duration"]),
            "resolution": request["resolution"],
            "aspect_ratio": "16:9",
        }
        try:
            resp = self.transport.request(
                "POST", CREATE_PATH, headers=self._headers(json_content=True), json_body=body)
        except ProviderError:
            raise
        if resp.status not in (200, 201, 202):
            raise map_http_error(resp.status, resp.body.decode("utf-8", "replace"))
        data = resp.json()
        if not isinstance(data, dict):
            raise ProviderError("provider_unavailable", "OpenRouter create response was not an object")
        job_id = data.get("id")
        if not isinstance(job_id, str) or not job_id.strip() or len(job_id) > 128:
            raise ProviderError("provider_unavailable", "OpenRouter create did not return a job id")
        if "/" in job_id or ".." in job_id or job_id.strip() != job_id:
            raise ProviderError("provider_unavailable", "OpenRouter job id is not usable")
        return {
            "provider_job_id": job_id.strip(),
            "provider_generation_id": bound_text(data.get("generation_id"), 80) if data.get("generation_id") else None,
            "raw_status": str(data.get("status") or "pending"),
        }

    def query(self, provider_job_id):
        job_id = _safe_job_id(provider_job_id)
        path = QUERY_PATH + job_id
        resp = self.transport.request("GET", path, headers=self._headers())
        if resp.status >= 400:
            raise map_http_error(resp.status, resp.body.decode("utf-8", "replace"))
        data = resp.json()
        if not isinstance(data, dict):
            raise ProviderError("provider_unavailable", "OpenRouter poll response was not an object")
        status = str(data.get("status") or "")
        if status not in KNOWN_STATUSES:
            if status:
                return {"state": "unknown_nonterminal", "provider_status": status, "warning": True}
            raise ProviderError("provider_unavailable", "OpenRouter poll omitted status")
        result = {
            "provider_status": status,
            "provider_generation_id": bound_text(data.get("generation_id"), 80) if data.get("generation_id") else None,
            "routed_provider": _routed_provider(data),
            "usage": _usage(data.get("usage")),
        }
        if status == "pending":
            result["state"] = "submitted"
        elif status == "in_progress":
            result["state"] = "running"
        elif status == "completed":
            result["state"] = "succeeded"
            result["download_url"] = ORIGIN + (CONTENT_PATH % job_id)
            result["authenticated_download"] = True
        elif status == "failed":
            result["state"] = "failed"
            result["error_code"] = "provider_unavailable"
            result["error_message"] = bound_text(data.get("error") or "OpenRouter video failed")
        elif status == "cancelled":
            result["state"] = "cancelled"
            result["error_code"] = "cancelled"
            result["error_message"] = bound_text(data.get("error") or "OpenRouter cancelled the job")
        else:
            result["state"] = "failed"
            result["error_code"] = "provider_expired"
            result["error_message"] = bound_text(data.get("error") or "OpenRouter job expired")
        return result

    def fetch(self, result, staging_dir, limits):
        job_id = _safe_job_id((result or {}).get("provider_job_id") or "")
        path = CONTENT_PATH % job_id
        url = ORIGIN + path
        from bumparr.generation import media as gen_media
        dest = gen_media.download_untrusted(
            url, staging_dir, limits,
            auth_origin=ORIGIN,
            auth_header="Bearer %s" % self.api_key,
        )
        return [{"path": dest, "ordinal": 0, "modality": "video"}]


def _safe_job_id(value):
    job_id = str(value or "").strip()
    if not job_id or "/" in job_id or ".." in job_id or len(job_id) > 128:
        raise ProviderError("invalid_request", "invalid OpenRouter job id")
    return job_id


def _parse_models(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ProviderError("capabilities_stale", "OpenRouter models response was not a list")
    out = []
    for item in payload["data"][:200]:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        if not model_id or len(model_id) > 200:
            continue
        durations = []
        for value in item.get("supported_durations") or []:
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            if 1 <= number <= 120:
                durations.append(number)
        resolutions = [str(x).strip() for x in (item.get("supported_resolutions") or [])
                       if str(x).strip()][:32]
        ratios = [str(x).strip() for x in (item.get("supported_aspect_ratios") or [])
                  if str(x).strip()][:16]
        passthrough = [str(x).strip() for x in (item.get("allowed_passthrough_parameters") or [])
                       if str(x).strip()][:32]
        skus = item.get("pricing_skus") if isinstance(item.get("pricing_skus"), dict) else {}
        pricing = {}
        for key, val in list(skus.items())[:16]:
            pricing[str(key)[:80]] = str(val)[:32]
        out.append({
            "id": model_id,
            "canonical_slug": str(item.get("canonical_slug") or model_id)[:200],
            "name": bound_text(item.get("name"), 120),
            "supported_durations": durations,
            "supported_resolutions": resolutions,
            "supported_aspect_ratios": ratios,
            "allowed_passthrough_parameters": passthrough,
            "pricing_skus": pricing,
        })
    return out


def _usage(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    cost = raw.get("cost")
    try:
        from decimal import Decimal, InvalidOperation
        amount = Decimal(str(cost))
        if amount.is_finite() and 0 <= amount <= Decimal("100000"):
            out["cost_usd"] = str(amount)
            out["cost_microusd"] = gen_models.usd_to_micro(amount)
    except (InvalidOperation, TypeError, ValueError, Exception):
        pass
    if raw.get("is_byok") in (True, False):
        out["is_byok"] = bool(raw["is_byok"])
    return out


def _routed_provider(data):
    for key in ("provider", "routed_provider"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return bound_text(value, 80)
        if isinstance(value, dict):
            name = value.get("name") or value.get("id")
            if name:
                return bound_text(name, 80)
    return None
