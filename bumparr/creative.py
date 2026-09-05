"""Creative metadata resolver.

Structured values live under optional `payload.creative`. This module is the
only parser/resolver: writers persist what they know via `merge_creative` /
`with_creative`, and readers call `resolve_creative` so legacy rows and new
rows share one vocabulary. No schema migration.
"""
import hashlib
import json

FAMILIES = ("text", "scenic", "archive", "data", "window", "ident", "failure", "authored")
ROLES = ("any", "open", "inside", "close", "return", "ident", "standby")
ENERGIES = ("quiet", "neutral", "loud")
AUDIOS = ("native", "music", "designed", "silence", "unknown")
BRAND_MODES = ("reveal", "static", "none")
PERSIST_FIELDS = ("family", "roles", "energy", "audio", "text_heavy", "music_id")

KIND_FAMILY = {
    "station_id": "ident",
    "technical_difficulties": "failure",
    "dead_air": "failure",
    "testpattern": "failure",
    "weather": "data",
    "local_time": "data",
    "on_this_day": "data",
    "number": "data",
    "trivia": "data",
    "fun_facts": "data",
    "psa": "text",
    "corrections": "text",
    "achievements": "text",
    "coming_up": "text",
    "tiny_games": "text",
    "webcam": "window",
    "window": "window",
}

WINDOW_TAGS = frozenset({"window", "webcam", "cam"})
ARCHIVE_TAGS = frozenset({"archive", "gov", "government", "pd", "loc"})
ARCHIVE_SOURCES = frozenset({"archive", "nasa", "loc", "gov", "government"})
AUTHORED_SOURCES = frozenset({"user-added", "manual", "user"})
QUIET_FAMILIES = frozenset({"text", "data", "failure", "window", "scenic"})
TEXT_HEAVY_FAMILIES = frozenset({"text", "data"})
PLAYABLE_TYPES = frozenset({"video", "card", "stream", "image"})


def _as_row(row):
    if row is None:
        return {}
    if isinstance(row, dict):
        return row
    try:
        return dict(row)
    except Exception:
        return {}


def _payload(value):
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return {}
    if isinstance(value, str):
        try:
            parsed = json.loads(value or "{}")
        except Exception:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def _creative_obj(payload):
    raw = payload.get("creative")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {}
    return dict(raw) if isinstance(raw, dict) else {}


def _norm(value):
    return str(value or "").strip().lower()


def _kind(row):
    return _norm(row.get("kind"))


def _type(row):
    return _norm(row.get("type"))


def _source(row):
    return _norm(row.get("source"))


def _tags(row):
    raw = row.get("tags") or ""
    if isinstance(raw, (list, tuple, set)):
        parts = raw
    else:
        parts = str(raw).split(",")
    return {str(part).strip().lower() for part in parts if str(part).strip()}


def _normalize_roles(value):
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    out, seen = [], set()
    for item in value:
        role = _norm(item)
        if role in ROLES and role not in seen:
            seen.add(role)
            out.append(role)
    return out


def _valid_family(value):
    return isinstance(value, str) and value.strip() in FAMILIES


def _valid_energy(value):
    return isinstance(value, str) and value.strip() in ENERGIES


def _valid_audio(value):
    return isinstance(value, str) and value.strip() in AUDIOS


def _valid_brand(value):
    return isinstance(value, str) and value.strip() in BRAND_MODES


def _valid_template(value):
    return isinstance(value, str) and bool(value.strip())


def _valid_seed(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _valid_music_id(value):
    return value is None or (isinstance(value, str) and bool(value.strip()))


def _valid_field(key, value):
    if key == "family":
        return _valid_family(value)
    if key == "roles":
        return bool(_normalize_roles(value))
    if key == "energy":
        return _valid_energy(value)
    if key == "audio":
        return _valid_audio(value)
    if key == "text_heavy":
        return isinstance(value, bool)
    if key == "template":
        return _valid_template(value)
    if key == "render_seed":
        return _valid_seed(value)
    if key == "brand_mode":
        return _valid_brand(value)
    if key == "music_id":
        return _valid_music_id(value)
    return False


def _infer_family(row, tags):
    kind = _kind(row)
    if kind in KIND_FAMILY:
        return KIND_FAMILY[kind]
    if tags & WINDOW_TAGS:
        return "window"
    if tags & ARCHIVE_TAGS:
        return "archive"
    typ = _type(row)
    if typ == "stream":
        return "window"
    source = _source(row)
    if source in ARCHIVE_SOURCES:
        return "archive"
    if source in AUTHORED_SOURCES:
        return "authored"
    if typ in ("video", "image"):
        return "scenic"
    if typ == "card":
        return "text"
    return "scenic"


def _infer_roles(row, family):
    kind = _kind(row)
    if family == "ident" or kind == "station_id":
        return ["open", "close", "return", "ident"]
    if kind == "technical_difficulties":
        return ["inside", "standby"]
    if kind == "dead_air" or family == "window" or kind in ("window", "webcam"):
        return ["any", "inside", "standby"]
    typ = _type(row)
    if typ not in PLAYABLE_TYPES and kind not in KIND_FAMILY:
        return ["any"]
    return ["any", "inside"]


def _infer_energy(family):
    return "quiet" if family in QUIET_FAMILIES else "neutral"


def _legacy_audio(payload, typ):
    audio = payload.get("audio")
    if isinstance(audio, str):
        token = audio.strip().lower()
        if token.startswith("native"):
            return "native"
        if token.startswith("bed:") or token == "music":
            return "music"
        if token in ("silent", "silence"):
            return "silence"
        if token in AUDIOS:
            return token
    if payload.get("music"):
        return "music"
    if typ == "stream":
        return "native"
    if typ in ("card", "image"):
        return "silence"
    return "unknown"


def _render_seed(row):
    ident = str(row.get("id") or "")
    digest = hashlib.sha256(("bumparr:render:" + ident).encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def resolve_creative(row):
    """Complete normalized creative dict for a playable row."""
    row = _as_row(row)
    payload = _payload(row.get("payload"))
    explicit = _creative_obj(payload)
    tags = _tags(row)
    family = explicit["family"].strip() if _valid_family(explicit.get("family")) else _infer_family(row, tags)
    roles = _normalize_roles(explicit.get("roles")) or _infer_roles(row, family)
    energy = explicit["energy"].strip() if _valid_energy(explicit.get("energy")) else _infer_energy(family)
    audio = explicit["audio"].strip() if _valid_audio(explicit.get("audio")) else _legacy_audio(payload, _type(row))
    if isinstance(explicit.get("text_heavy"), bool):
        text_heavy = explicit["text_heavy"]
    else:
        text_heavy = family in TEXT_HEAVY_FAMILIES
    if _valid_template(explicit.get("template")):
        template = explicit["template"].strip()[:200]
    else:
        template = None
    render_seed = explicit["render_seed"] if _valid_seed(explicit.get("render_seed")) else _render_seed(row)
    if _valid_brand(explicit.get("brand_mode")):
        brand_mode = explicit["brand_mode"].strip()
    else:
        brand_mode = "none" if family in ("ident", "failure") else "reveal"
    if _valid_music_id(explicit.get("music_id")):
        music_id = None if explicit.get("music_id") is None else explicit["music_id"].strip()
    else:
        music_id = None
    return {
        "family": family,
        "roles": list(roles),
        "energy": energy,
        "audio": audio,
        "text_heavy": bool(text_heavy),
        "template": template,
        "render_seed": int(render_seed),
        "brand_mode": brand_mode,
        "music_id": music_id,
    }


def merge_creative(payload, explicit_values):
    """Return a payload dict with creative merged; unrelated keys are kept."""
    base = _payload(payload)
    merged = _creative_obj(base)
    if isinstance(explicit_values, dict):
        for key, value in explicit_values.items():
            if not _valid_field(key, value):
                continue
            if key == "roles":
                merged[key] = _normalize_roles(value)
            elif key == "template":
                merged[key] = value.strip()[:200]
            elif key == "music_id":
                merged[key] = None if value is None else value.strip()
            elif key in ("family", "energy", "audio", "brand_mode"):
                merged[key] = value.strip()
            else:
                merged[key] = value
    base["creative"] = merged
    return base


def with_creative(payload, row):
    """Persist inferred non-render creative fields onto a payload."""
    base = _payload(payload)
    row = dict(_as_row(row))
    row["payload"] = base
    resolved = resolve_creative(row)
    return merge_creative(base, {key: resolved[key] for key in PERSIST_FIELDS})


def role_compatible(creative, placement, mode="break"):
    """Whether resolved creative may occupy `placement`.

    Break `open`/`inside`/`close` need `any` or that placement; `return` and
    `ident` also satisfy `close`. Placement `any` accepts everything except a
    standby-only item. Station mode is not narrowed by specialized roles.
    """
    if mode != "break":
        return True
    roles = set(_normalize_roles((creative or {}).get("roles")))
    if not isinstance(placement, str):
        placement = "any"
    placement = placement.strip().lower() or "any"
    if placement == "any":
        return roles != {"standby"}
    if placement in ("open", "inside", "close"):
        if "any" in roles or placement in roles:
            return True
        return placement == "close" and bool(roles & {"return", "ident"})
    return False
