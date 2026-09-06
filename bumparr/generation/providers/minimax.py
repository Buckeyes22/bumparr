"""Direct MiniMax H3 V2 text-to-video adapter."""
from bumparr.generation import models as gen_models
from bumparr.generation.providers.base import (
    ProviderError, StdlibTransport, bound_text, map_http_error,
)

ORIGIN = "https://api.minimax.io"
CREATE_PATH = "/v2/video_generation"
QUERY_PATH = "/v2/query/video_generation/"
KNOWN_STATUSES = frozenset({"queued", "running", "succeeded", "failed", "cancelled"})


class MiniMaxAdapter:
    name = "minimax"
    origin = ORIGIN

    def __init__(self, *, api_key="", transport=None):
        self.api_key = (api_key or "").strip()
        self.transport = transport or StdlibTransport(ORIGIN)

    def _headers(self):
        if not self.api_key:
            raise ProviderError("missing_key", "MiniMax API key is not configured")
        return {
            "Authorization": "Bearer %s" % self.api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def capabilities(self, entry):
        return gen_models.intersect_capabilities(entry)

    def estimate(self, request, capabilities):
        duration = int(request.get("duration") or 0)
        micro = gen_models.estimate_microusd(
            capabilities, duration, request.get("resolution"))
        if micro is None:
            raise ProviderError("invalid_request", "cost cannot be estimated for this MiniMax alias")
        return {
            "microusd": micro,
            "usd": gen_models.micro_to_usd_str(micro),
            "unit": "video_second",
            "duration": duration,
        }

    def submit(self, request):
        prompt = request["submitted_prompt"]
        if len(prompt) > 7000:
            raise ProviderError("invalid_request", "prompt exceeds MiniMax 7000-character limit")
        body = {
            "model": "MiniMax-H3",
            "content": [{"type": "text", "text": prompt}],
            "resolution": request["resolution"],
            "duration": int(request["duration"]),
            "ratio": "16:9",
        }
        try:
            resp = self.transport.request(
                "POST", CREATE_PATH, headers=self._headers(), json_body=body)
        except ProviderError:
            raise
        if resp.status >= 400:
            raise map_http_error(resp.status, resp.body.decode("utf-8", "replace"))
        data = resp.json()
        if not isinstance(data, dict):
            raise ProviderError("provider_unavailable", "MiniMax create response was not an object")
        task_id = data.get("task_id")
        if not isinstance(task_id, str) or not task_id.strip() or len(task_id) > 128:
            raise ProviderError("provider_unavailable", "MiniMax create did not return a task_id")
        request_id = data.get("request_id")
        if request_id is not None:
            request_id = bound_text(request_id, 80)
        return {
            "provider_job_id": task_id.strip(),
            "provider_request_id": request_id,
            "raw_status": "queued",
        }

    def query(self, provider_job_id):
        job_id = str(provider_job_id or "").strip()
        if not job_id or "/" in job_id or ".." in job_id:
            raise ProviderError("invalid_request", "invalid MiniMax task id")
        path = QUERY_PATH + job_id
        resp = self.transport.request("GET", path, headers=self._headers())
        if resp.status >= 400:
            raise map_http_error(resp.status, resp.body.decode("utf-8", "replace"))
        data = resp.json()
        if not isinstance(data, dict) or not isinstance(data.get("task"), dict):
            raise ProviderError("provider_unavailable", "MiniMax query response was not a task object")
        task = data["task"]
        status = str(task.get("status") or "")
        if status not in KNOWN_STATUSES:
            if status:
                return {"state": "unknown_nonterminal", "provider_status": status, "warning": True}
            raise ProviderError("provider_unavailable", "MiniMax query omitted status")
        result = {
            "provider_status": status,
            "provider_model": bound_text(task.get("model"), 80),
            "usage": _usage(task.get("usage")),
        }
        if status == "queued":
            result["state"] = "submitted"
        elif status == "running":
            result["state"] = "running"
        elif status == "succeeded":
            content = task.get("content") if isinstance(task.get("content"), dict) else {}
            url = content.get("url")
            if not isinstance(url, str) or not url.startswith("https://"):
                raise ProviderError("download_rejected", "MiniMax success omitted an https content URL")
            result["state"] = "succeeded"
            result["download_url"] = url
            result["duration"] = task.get("duration")
            result["resolution"] = task.get("resolution")
            result["ratio"] = task.get("ratio")
        elif status == "failed":
            err = task.get("error") if isinstance(task.get("error"), dict) else {}
            result["state"] = "failed"
            result["error_code"] = "provider_moderation" if str(err.get("code")) == "1026" else "provider_unavailable"
            result["error_message"] = bound_text(err.get("message") or "MiniMax task failed")
        else:
            result["state"] = "cancelled"
            result["error_code"] = "cancelled"
            result["error_message"] = "MiniMax cancelled the task"
        return result

    def fetch(self, result, staging_dir, limits):
        url = (result or {}).get("download_url")
        if not url:
            raise ProviderError("download_rejected", "no MiniMax download URL")
        from bumparr.generation import media as gen_media
        path = gen_media.download_untrusted(url, staging_dir, limits, auth_origin=None)
        return [{"path": path, "ordinal": 0, "modality": "video"}]


def _usage(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key in ("total_seconds", "input_seconds", "output_seconds", "input_image_count",
                "input_audio_seconds"):
        try:
            value = int(raw[key])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= value <= 10_000:
            out[key] = value
    return out
