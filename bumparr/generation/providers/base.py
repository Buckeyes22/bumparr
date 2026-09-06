"""Shared protocol objects, JSON HTTP, error mapping, and redaction."""
import json
import http.client
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

MAX_JSON_BODY = 2 * 1024 * 1024
READ_TIMEOUT = 45
SENTINEL_PATTERNS = (
    re.compile(r"(?i)(authorization:\s*bearer\s+)\S+"),
    re.compile(r"(?i)(x-api-key:\s*)\S+"),
    re.compile(r"(?i)(api[_-]?key=)[^&\s]+"),
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_JSON_OPENER = urllib.request.build_opener(_NoRedirect())


class ProviderError(Exception):
    """Mapped provider or protocol failure."""

    def __init__(self, code, message, *, http=None, retryable=False, accepted=False):
        self.code = code
        self.message = bound_text(message)
        super().__init__(self.message)
        self.http = http
        self.retryable = retryable
        self.accepted = accepted


def configured_secrets():
    """Live credentials that must never appear in logs, DB, or API bodies."""
    try:
        from bumparr import config
        from bumparr.generation import models as gen_models
        settings = gen_models.runtime_settings()
        values = [
            settings.get("minimax_key"), settings.get("openrouter_key"),
            getattr(config, "MINIMAX_API_KEY", ""),
            getattr(config, "OPENROUTER_API_KEY", ""),
            getattr(config, "LLM_API_KEY", ""),
        ]
    except Exception:
        values = []
    out = []
    for item in values:
        token = str(item or "").strip()
        if token and token not in out:
            out.append(token)
    return out


def _scrub_url(match):
    # Provider URL signatures can be in either the path or query, under
    # arbitrary names. Error prose has no need to retain a download URL.
    return "[redacted URL]"


def redact(value, extra=None):
    text = str(value or "")
    secrets = list(extra or ()) + configured_secrets()
    for secret in secrets:
        if secret:
            text = text.replace(str(secret), "[redacted]")
    for pattern in SENTINEL_PATTERNS:
        text = pattern.sub(r"\1[redacted]", text)
    text = re.sub(r"https?://[^\s\"']+", _scrub_url, text)
    return text


def bound_text(value, limit=400):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return redact(text)[:limit]


def map_http_error(status, body_text=""):
    snippet = bound_text(body_text, 200)
    if status == 401:
        return ProviderError("auth_failed", "provider rejected the credential", http=401)
    if status == 402:
        return ProviderError("insufficient_balance", "provider account cannot fund this request", http=402)
    if status == 422:
        return ProviderError("provider_moderation", "provider rejected the content", http=422)
    if status == 429:
        return ProviderError("rate_limited", "provider asked Bumparr to slow down",
                             http=429, retryable=True)
    if status == 400:
        lowered = snippet.lower()
        if "task_id" in lowered or "invalid task" in lowered:
            return ProviderError("provider_expired", "provider job can no longer be queried", http=400)
        return ProviderError("invalid_request", snippet or "provider rejected the request", http=400)
    if status in (500, 502, 503, 504, 529):
        return ProviderError("provider_unavailable", "provider is unavailable",
                             http=status, retryable=True)
    return ProviderError("provider_unavailable", "unexpected provider status %s" % status,
                         http=status)


class TransportResponse:
    def __init__(self, status, headers, body, url=""):
        self.status = int(status)
        self.headers = headers or {}
        self.body = body if isinstance(body, (bytes, bytearray)) else bytes(body or b"")
        self.url = url

    def json(self):
        if len(self.body) > MAX_JSON_BODY:
            raise ProviderError("provider_unavailable", "provider JSON exceeded bound")
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProviderError("provider_unavailable", "provider JSON was not an object") from exc


class StdlibTransport:
    """stdlib HTTP to a single origin. Tests inject a fake transport instead."""

    def __init__(self, origin, timeout=READ_TIMEOUT):
        self.origin = origin.rstrip("/")
        self.timeout = timeout

    def request(self, method, path, *, headers=None, json_body=None, timeout=None):
        parsed = urlparse(self.origin)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ProviderError("provider_unavailable", "provider origin is not https")
        if not path.startswith("/"):
            raise ProviderError("invalid_request", "path must be absolute")
        url = self.origin + path
        data = None
        req_headers = dict(headers or {})
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, method=method.upper(), headers=req_headers)
        try:
            with _JSON_OPENER.open(req, timeout=timeout or self.timeout) as resp:
                final = resp.geturl() if hasattr(resp, "geturl") else url
                if (urlparse(final).scheme != "https"
                        or urlparse(final).netloc.lower() != parsed.netloc.lower()):
                    raise ProviderError("provider_unavailable", "provider redirected off origin")
                body = resp.read(MAX_JSON_BODY + 1)
                if len(body) > MAX_JSON_BODY:
                    raise ProviderError("provider_unavailable", "provider JSON exceeded bound")
                return TransportResponse(resp.status, dict(resp.headers), body, final)
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308):
                exc.close()
                raise ProviderError("provider_unavailable",
                                    "provider redirect is not followed") from exc
            try:
                body = exc.read(MAX_JSON_BODY + 1) if exc.fp is not None else b""
            finally:
                exc.close()
            raise map_http_error(exc.code, body.decode("utf-8", "replace")) from exc
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise ProviderError("provider_unavailable", "transport failure",
                                retryable=method.upper() == "GET") from exc


def require_https_origin(url, expected_origin):
    parsed = urlparse(url)
    expected = urlparse(expected_origin)
    if parsed.scheme != "https" or parsed.netloc.lower() != expected.netloc.lower():
        raise ProviderError("download_rejected", "result URL is not the provider origin")
    return parsed
