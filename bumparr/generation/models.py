"""Model-manifest parsing, runtime settings, and capability intersection."""
import hashlib
import json
import re
import sys
import warnings
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

import yaml

from bumparr import config, creative

SHIPPED_MANIFEST = Path(__file__).resolve().parent.parent / "config_files" / "generation_models.yaml"

KNOWN_PROVIDERS = frozenset({"minimax", "openrouter"})
KNOWN_OUTPUTS = frozenset({"video"})
KNOWN_MODES = frozenset({"text", "first_frame", "last_frame", "first_last", "reference"})
IMPLEMENTED_MODES = {
    "minimax": frozenset({"text"}),
    "openrouter": frozenset({"text"}),
}
COST_UNITS = frozenset({"video_second"})
KIND_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,63}$")
ALIAS_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,79}$")
MICRO = Decimal("1000000")
ADAPTER_VERSION = "generation-core-g5"
_PROHIBITED = (
    "adult swim", "adultswim", "[as]", "williams street", "williamsstreet",
)
_SETTINGS_WARNED = False
_MANIFEST = None
_MANIFEST_STATUS = None


class ManifestError(ValueError):
    """The entire custom manifest is rejected."""


def usd_to_micro(value):
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ManifestError("invalid USD value") from exc
    if not amount.is_finite() or amount < 0:
        raise ManifestError("USD value must be a finite non-negative decimal")
    return int((amount * MICRO).to_integral_value(ROUND_HALF_UP))


def micro_to_usd_str(micro):
    if micro is None:
        return None
    return str((Decimal(int(micro)) / MICRO).quantize(Decimal("0.000001")))


def _clamp_int(raw, default, lo, hi):
    try:
        number = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if number < lo or number > hi:
        return default
    return number


def _positive_int(raw, default):
    try:
        number = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if number <= 0:
        return default
    return number


def _proper_descendant(candidate, root):
    try:
        resolved = Path(candidate).resolve()
        resolved_root = Path(root).resolve()
    except Exception:
        return None
    if resolved == resolved_root:
        return None
    try:
        if not resolved.is_relative_to(resolved_root):
            return None
    except AttributeError:
        try:
            resolved.relative_to(resolved_root)
        except ValueError:
            return None
    return resolved


def staging_dir():
    """Private staging under DATA_DIR, outside asset/output trees, or None if invalid."""
    root = Path(getattr(config, "DATA_DIR", "/data"))
    raw = (getattr(config, "GENERATION_STAGING_DIR", "") or "").strip()
    candidate = Path(raw) if raw else root / "generation-staging"
    resolved = _proper_descendant(candidate, root)
    if resolved is None:
        return None
    for blocked in (config.ASSET_ROOT, config.OUTPUT_DIR):
        try:
            blocked_root = Path(blocked).resolve()
            if resolved == blocked_root or resolved.is_relative_to(blocked_root):
                return None
            if blocked_root == resolved or blocked_root.is_relative_to(resolved):
                return None
        except Exception:
            return None
    return resolved


def output_dir():
    """Normalized-candidate directory, a proper contained descendant of ASSET_ROOT."""
    root = Path(config.ASSET_ROOT)
    raw = (getattr(config, "GENERATION_OUTPUT_DIR", "") or "").strip()
    candidate = Path(raw) if raw else root / "generated"
    return _proper_descendant(candidate, root)


def is_generation_output_path(path):
    dest = output_dir()
    if dest is None or path is None:
        return False
    try:
        Path(path).resolve().relative_to(dest)
        return True
    except Exception:
        return False


def runtime_settings():
    """Parsed, clamped generation settings. Invalid daily caps fall back to defaults."""
    global _SETTINGS_WARNED
    enabled = str(getattr(config, "GENERATION_ENABLED", "0") or "") == "1"
    poll = _clamp_int(getattr(config, "GENERATION_POLL_SECONDS", "10"), 10, 5, 60)
    active = _clamp_int(getattr(config, "GENERATION_MAX_ACTIVE", "1"), 1, 1, 3)
    jobs = _positive_int(getattr(config, "GENERATION_DAILY_JOBS", "10"), 10)
    seconds = _positive_int(getattr(config, "GENERATION_DAILY_VIDEO_SECONDS", "60"), 60)
    download_mb = _positive_int(getattr(config, "GENERATION_DOWNLOAD_MAX_MB", "250"), 250)
    raw_usd = getattr(config, "GENERATION_DAILY_USD", "5.00")
    try:
        usd = Decimal(str(raw_usd))
        if not usd.is_finite() or usd <= 0:
            raise InvalidOperation("non-positive")
    except (InvalidOperation, TypeError, ValueError):
        usd = Decimal("5.00")
        if not _SETTINGS_WARNED:
            warnings.warn("GENERATION_DAILY_USD invalid; using 5.00", RuntimeWarning, stacklevel=2)
            _SETTINGS_WARNED = True
    if jobs == 10 and str(getattr(config, "GENERATION_DAILY_JOBS", "10")) not in ("10", 10):
        if not _SETTINGS_WARNED:
            warnings.warn("generation daily cap invalid; using defaults", RuntimeWarning, stacklevel=2)
            _SETTINGS_WARNED = True
    dirs_ok = staging_dir() is not None and output_dir() is not None
    return {
        "enabled": enabled and dirs_ok,
        "dirs_ok": dirs_ok,
        "default_model": (getattr(config, "GENERATION_DEFAULT_MODEL", "") or "").strip(),
        "minimax_key": (getattr(config, "MINIMAX_API_KEY", "") or "").strip(),
        "openrouter_key": (getattr(config, "OPENROUTER_API_KEY", "") or "").strip(),
        "poll_seconds": poll,
        "max_active": active,
        "daily_jobs": jobs,
        "daily_video_seconds": seconds,
        "daily_usd": usd,
        "daily_microusd": usd_to_micro(usd),
        "download_max_mb": download_mb,
        "download_max_bytes": download_mb * 1048576,
    }


def _unknown_keys(mapping, allowed, where):
    extra = [key for key in mapping if key not in allowed]
    if extra:
        raise ManifestError("unknown %s field: %s" % (where, extra[0]))


def _parse_entry(raw):
    if not isinstance(raw, dict):
        raise ManifestError("each model must be a mapping")
    _unknown_keys(raw, {
        "id", "provider", "model", "output", "enabled", "allowed_modes",
        "default_duration", "default_resolution", "default_aspect_ratio",
        "cost_ceiling",
    }, "model")
    alias = str(raw.get("id") or "").strip()
    if not ALIAS_RE.match(alias):
        raise ManifestError("invalid model id")
    provider = str(raw.get("provider") or "").strip()
    if provider not in KNOWN_PROVIDERS:
        raise ManifestError("unknown provider %r" % provider)
    model = str(raw.get("model") or "").strip()
    if not model or len(model) > 200:
        raise ManifestError("invalid provider model id")
    output = str(raw.get("output") or "").strip()
    if output not in KNOWN_OUTPUTS:
        raise ManifestError("unsupported output %r" % output)
    if "enabled" not in raw:
        raise ManifestError("enabled is required")
    if raw["enabled"] is not True and raw["enabled"] is not False:
        raise ManifestError("enabled must be a boolean")
    enabled = raw["enabled"]
    modes = raw.get("allowed_modes")
    if not isinstance(modes, list) or not modes:
        raise ManifestError("allowed_modes must be a non-empty list")
    allowed = []
    for item in modes:
        mode = str(item or "").strip()
        if mode not in KNOWN_MODES:
            raise ManifestError("unknown mode %r" % mode)
        if mode not in allowed:
            allowed.append(mode)
    try:
        duration = int(raw.get("default_duration"))
    except (TypeError, ValueError) as exc:
        raise ManifestError("default_duration must be an integer") from exc
    resolution = str(raw.get("default_resolution") or "").strip()
    ratio = str(raw.get("default_aspect_ratio") or "").strip()
    if not resolution or not ratio:
        raise ManifestError("default resolution and aspect ratio are required")
    ceiling = raw.get("cost_ceiling")
    cost_unit = None
    max_usd_per_unit = None
    if ceiling is not None:
        if not isinstance(ceiling, dict):
            raise ManifestError("cost_ceiling must be a mapping")
        _unknown_keys(ceiling, {"unit", "max_usd_per_unit"}, "cost_ceiling")
        cost_unit = str(ceiling.get("unit") or "").strip()
        if cost_unit not in COST_UNITS:
            raise ManifestError("unknown cost unit")
        try:
            max_usd_per_unit = Decimal(str(ceiling.get("max_usd_per_unit")))
        except InvalidOperation as exc:
            raise ManifestError("max_usd_per_unit must be a positive decimal") from exc
        if not max_usd_per_unit.is_finite() or max_usd_per_unit <= 0:
            raise ManifestError("max_usd_per_unit must be a positive decimal")
    if provider == "minimax" and (cost_unit is None or max_usd_per_unit is None):
        raise ManifestError("direct MiniMax aliases require cost_ceiling")
    return {
        "id": alias,
        "provider": provider,
        "model": model,
        "output": output,
        "enabled": enabled,
        "allowed_modes": tuple(allowed),
        "default_duration": duration,
        "default_resolution": resolution,
        "default_aspect_ratio": ratio,
        "cost_unit": cost_unit,
        "max_usd_per_unit": max_usd_per_unit,
    }


def load_manifest(strict=False):
    """Return (entries, status). Invalid custom files enable no remote models."""
    configured = (getattr(config, "GENERATION_MODELS", "") or "").strip()
    path = Path(configured) if configured else SHIPPED_MANIFEST
    source = "custom" if configured else "shipped-default"
    try:
        text = Path(path).read_text(encoding="utf-8")
        doc = yaml.safe_load(text)
    except FileNotFoundError as exc:
        if strict:
            raise ManifestError("manifest not found") from exc
        return [], {"version": 1, "valid": False, "source": "fallback-after-error", "count": 0}
    except (OSError, yaml.YAMLError) as exc:
        if strict:
            raise ManifestError("manifest unreadable") from exc
        return [], {"version": 1, "valid": False, "source": "fallback-after-error", "count": 0}
    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        err = ManifestError("manifest must be a mapping")
        if strict:
            raise err
        return [], {"version": 1, "valid": False, "source": "fallback-after-error", "count": 0}
    extra = [key for key in doc if key not in ("models", "version")]
    if extra:
        if strict:
            raise ManifestError("unknown manifest field: %s" % extra[0])
        return [], {"version": 1, "valid": False, "source": "fallback-after-error", "count": 0}
    models = doc.get("models", [])
    if models is None:
        models = []
    if not isinstance(models, list):
        if strict:
            raise ManifestError("models must be a list")
        return [], {"version": 1, "valid": False, "source": "fallback-after-error", "count": 0}
    entries = []
    seen = set()
    try:
        for raw in models:
            entry = _parse_entry(raw)
            if entry["id"] in seen:
                raise ManifestError("duplicate model id %s" % entry["id"])
            seen.add(entry["id"])
            entries.append(entry)
    except ManifestError:
        if strict:
            raise
        return [], {"version": 1, "valid": False, "source": "fallback-after-error", "count": 0}
    return entries, {"version": 1, "valid": True, "source": source, "count": len(entries)}


def current_manifest():
    global _MANIFEST, _MANIFEST_STATUS
    if _MANIFEST is None:
        _MANIFEST, _MANIFEST_STATUS = load_manifest(strict=False)
    return _MANIFEST, _MANIFEST_STATUS


def reset_manifest_cache():
    global _MANIFEST, _MANIFEST_STATUS
    _MANIFEST = None
    _MANIFEST_STATUS = None


def minimax_h3_capabilities():
    """Built-in MiniMax-H3 V2 snapshot for text-to-video (G0–G5)."""
    return {
        "provider": "minimax",
        "provider_model": "MiniMax-H3",
        "provider_model_canonical": "MiniMax-H3",
        "output": "video",
        "modes": ["text"],
        "durations": list(range(4, 16)),
        "resolutions": ["768P", "2K"],
        "aspect_ratios": ["16:9"],
        "async_job": True,
        "poll_seconds": 10,
        "prompt_limit": 7000,
        "generate_audio": True,
        "supports_cancel": False,
        "pricing_unit": "video_second",
        "zdr": False,
        "routing": "direct",
        "adapter_version": "minimax-h3-v2-g5",
        "privacy": "Hosted MiniMax API; not a ZDR claim. See current MiniMax terms.",
    }


def intersect_capabilities(entry, discovered=None):
    """Bumparr rules ∩ adapter implementation ∩ manifest ∩ discovery."""
    implemented = IMPLEMENTED_MODES.get(entry["provider"], frozenset())
    modes = [mode for mode in entry["allowed_modes"] if mode in implemented]
    if entry["provider"] == "minimax":
        if entry["model"] != "MiniMax-H3":
            return None
        base = minimax_h3_capabilities()
        durations = [d for d in base["durations"]]
        resolutions = list(base["resolutions"])
        ratios = list(base["aspect_ratios"])
        prompt_limit = base["prompt_limit"]
        pricing = {"unit": entry["cost_unit"], "usd_per_unit": str(entry["max_usd_per_unit"])}
        routing = "direct"
        zdr = False
        privacy = base["privacy"]
        canonical = "MiniMax-H3"
        generate_audio = True
        passthrough = []
    elif entry["provider"] == "openrouter":
        if not isinstance(discovered, dict):
            return None
        if discovered.get("id") != entry["model"]:
            return None
        durations = [int(x) for x in (discovered.get("supported_durations") or []) if _safe_int(x)]
        resolutions = [str(x) for x in (discovered.get("supported_resolutions") or []) if str(x).strip()]
        ratios = [str(x) for x in (discovered.get("supported_aspect_ratios") or []) if str(x).strip()]
        if "16:9" not in ratios:
            return None
        ratios = ["16:9"]
        prompt_limit = 7000
        pricing = _openrouter_pricing(discovered)
        routing = "openrouter-unpinned"
        zdr = False
        privacy = (
            "OpenRouter video is not Zero Data Retention eligible. Output is "
            "retained briefly for retrieval. Downstream provider is not pinned."
        )
        canonical = str(discovered.get("canonical_slug") or entry["model"])
        generate_audio = True
        passthrough = [str(x) for x in (discovered.get("allowed_passthrough_parameters") or [])
                       if str(x).strip()][:32]
        base = {"adapter_version": "openrouter-video-g5"}
    else:
        return None
    if not modes or not durations or not resolutions:
        return None
    if entry["default_duration"] not in durations:
        return None
    if entry["default_resolution"] not in resolutions:
        return None
    if entry["default_aspect_ratio"] != "16:9":
        return None
    snapshot = {
        "provider": entry["provider"],
        "provider_model": entry["model"],
        "provider_model_canonical": canonical,
        "output": "video",
        "modes": modes,
        "durations": durations,
        "resolutions": resolutions,
        "aspect_ratios": ratios,
        "async_job": True,
        "poll_seconds": max(10, runtime_settings()["poll_seconds"]),
        "prompt_limit": prompt_limit,
        "generate_audio": generate_audio,
        "supports_cancel": False,
        "pricing": pricing,
        "zdr": zdr,
        "routing": routing,
        "passthrough": passthrough,
        "adapter_version": base.get("adapter_version", ADAPTER_VERSION),
        "privacy": privacy,
        "manifest_id": entry["id"],
    }
    snapshot["hash"] = snapshot_hash(snapshot)
    return snapshot


def snapshot_hash(snapshot):
    payload = {k: snapshot[k] for k in sorted(snapshot) if k != "hash"}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _safe_int(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return False
    return number > 0 and number <= 120


def _openrouter_pricing(discovered):
    skus = discovered.get("pricing_skus") or {}
    if not isinstance(skus, dict):
        return None
    parsed = {}
    if len(skus) > 32:
        return None
    for key, val in skus.items():
        # Unknown dimensions (audio, quality, per-job fees, etc.) cannot safely
        # be ignored when enforcing a spending ceiling.
        if not re.fullmatch(r"per-video-second(?:-(?:480p|720p|768p|1080p|1k|2k|4k))?", str(key).lower()):
            return None
        try:
            amount = Decimal(str(val))
        except (InvalidOperation, TypeError, ValueError):
            return None
        if amount.is_finite() and amount > 0:
            parsed[str(key)[:80]] = str(amount)
        else:
            return None
    if not parsed:
        return None
    base = parsed.get("per-video-second") or parsed.get("per_video_second") or parsed.get("video-second")
    return {"unit": "video_second", "usd_per_unit": base, "skus": parsed,
            "sku": "per-video-second" if base else None}


def provider_configured(provider, settings=None):
    settings = settings or runtime_settings()
    if provider == "minimax":
        return bool(settings["minimax_key"])
    if provider == "openrouter":
        return bool(settings["openrouter_key"])
    return False


def technical_suffix():
    return " 16:9 composition, no letterboxing, no logos or legible on-screen text."


def validate_kind(kind):
    value = str(kind or "generated_short").strip() or "generated_short"
    if not KIND_RE.match(value):
        raise ValueError("invalid kind")
    return value


def validate_title(title, brief):
    value = str(title or "").strip()
    if not value:
        value = re.sub(r"\s+", " ", brief).strip()[:80] or "Generated bumper"
    if not (1 <= len(value) <= 120):
        raise ValueError("title must be 1–120 characters")
    return value


def validate_creative(raw):
    data = raw if isinstance(raw, dict) else {}
    extra = [key for key in data if key not in ("roles", "energy")]
    if extra:
        raise ValueError("unknown creative field")
    roles = data.get("roles") or ["inside"]
    if not isinstance(roles, list) or not roles:
        raise ValueError("creative.roles required")
    cleaned = []
    for role in roles:
        if role not in creative.ROLES:
            raise ValueError("unknown role")
        if role not in cleaned:
            cleaned.append(role)
    energy = data.get("energy") or "quiet"
    if energy not in creative.ENERGIES:
        raise ValueError("unknown energy")
    return {"roles": cleaned, "energy": energy, "family": "authored",
            "text_heavy": False, "brand_mode": "none"}


def brief_rejected(brief, profile=None):
    text = " " + str(brief or "").lower() + " "
    for phrase in _PROHIBITED:
        if phrase in text:
            return "brief names a prohibited studio, network, or creator"
    voice = {}
    if isinstance(profile, dict):
        voice = profile.get("voice") or {}
    for phrase in voice.get("avoid_phrases") or []:
        token = str(phrase or "").strip().lower()
        if token and token in text:
            return "brief contains a configured avoid phrase"
    return None


def resolve_unit_price(pricing, resolution=None):
    """Pick the resolution-specific SKU when present, else the base per-second price."""
    pricing = pricing if isinstance(pricing, dict) else {}
    skus = dict(pricing.get("skus") or {})
    if pricing.get("usd_per_unit") and "per-video-second" not in skus:
        skus["per-video-second"] = str(pricing["usd_per_unit"])
    if resolution:
        wanted = str(resolution).strip().lower().replace(" ", "")
        for key, val in skus.items():
            token = str(key).lower()
            if token in ("per-video-second", "per_video_second", "video-second"):
                continue
            suffix = token.replace("per-video-second-", "").replace("per_video_second_", "")
            suffix = suffix.replace("per-video-second_", "")
            if suffix == wanted:
                return val
    return (skus.get("per-video-second") or skus.get("per_video_second")
            or skus.get("video-second") or pricing.get("usd_per_unit"))


def estimate_microusd(snapshot, duration, resolution=None):
    pricing = (snapshot or {}).get("pricing") or {}
    unit_price = resolve_unit_price(pricing, resolution)
    if not unit_price:
        return None
    try:
        amount = Decimal(str(unit_price)) * Decimal(int(duration))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if not amount.is_finite() or amount < 0:
        return None
    return int((amount * MICRO).to_integral_value(ROUND_HALF_UP))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--check" not in argv and "-c" not in argv:
        print("usage: python -m bumparr.generation.models --check", file=sys.stderr)
        return 2
    try:
        entries, status = load_manifest(strict=True)
    except ManifestError as exc:
        print("generation models: FAIL %s" % exc, file=sys.stderr)
        return 1
    print("generation models: ok (%d alias(es), %s)" % (len(entries), status["source"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
