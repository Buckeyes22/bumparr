"""Operator channel profile: voice, mix, sequence, presentation, and audio.

SQLite stays authoritative for playable rows. This file is process-level
policy loaded at startup (or first use). An invalid document is never
partially applied: runtime logs one warning and uses the full shipped
default; strict validation raises for tests and `python -m
bumparr.channel_profile --check`.
"""
import argparse
import copy
import math
import sys
from pathlib import Path

import yaml

from bumparr import config

SHIPPED_PROFILE_FILE = Path(__file__).resolve().parent / "config_files" / "channel_profile.yaml"

FAMILIES = ("text", "scenic", "archive", "data", "window", "ident", "failure", "authored")
AUDIO_TREATMENTS = ("native", "music", "designed", "silence", "unknown")
BRAND_MODES = ("reveal", "static", "none")
MIX_MODES = ("break", "station")
TOP_LEVEL = ("version", "voice", "mix", "sequence", "presentation", "audio")
VOICE_KEYS = ("persona", "favored_subjects", "boundaries", "avoid_phrases", "avoid_topics")
BOUNDARY_KEYS = (
    "allow_direct_address", "allow_profanity", "allow_politics", "allow_bleak_humor",
)
SEQUENCE_KEYS = (
    "max_text_run", "avoid_same_family", "prefer_exit_ident",
    "avoid_same_music", "avoid_large_energy_jump",
)
PRESENTATION_KEYS = ("default_template", "default_brand_mode")
AUDIO_KEYS = ("allowed", "target_lufs", "true_peak_db", "fallback")

_DEFAULT = {
    "version": 1,
    "voice": {
        "persona": "Concise, dry, observant, and lightly strange.",
        "favored_subjects": [],
        "boundaries": {
            "allow_direct_address": True,
            "allow_profanity": False,
            "allow_politics": False,
            "allow_bleak_humor": False,
        },
        "avoid_phrases": [],
        "avoid_topics": [],
    },
    "mix": {
        "break": {
            "text": 1.0, "scenic": 1.0, "archive": 1.0, "data": 1.0,
            "window": 0.8, "ident": 0.8, "failure": 0.2, "authored": 1.0,
        },
        "station": {
            "text": 1.0, "scenic": 1.0, "archive": 1.0, "data": 1.0,
            "window": 1.0, "ident": 0.7, "failure": 0.3, "authored": 1.0,
        },
    },
    "sequence": {
        "max_text_run": 2,
        "avoid_same_family": True,
        "prefer_exit_ident": True,
        "avoid_same_music": True,
        "avoid_large_energy_jump": True,
    },
    "presentation": {
        "default_template": "minimal_center",
        "default_brand_mode": "reveal",
    },
    "audio": {
        "allowed": ["native", "music", "designed", "silence", "unknown"],
        "target_lufs": -16.0,
        "true_peak_db": -1.5,
        "fallback": "silence",
    },
}

_warned = False
_current = None
_status = None


class ProfileError(ValueError):
    """Strict validation failure for a channel profile document."""


def default_profile():
    """Independent deep copy of the shipped defaults."""
    return copy.deepcopy(_DEFAULT)


def reset_runtime_state():
    """Drop cached profile/status and the once-only runtime warning."""
    global _warned, _current, _status
    _warned = False
    _current = None
    _status = None


def _warn_once(message):
    global _warned
    if _warned:
        return
    _warned = True
    print("[channel_profile] %s" % message)


def _unknown_keys(got, allowed, label):
    extra = [key for key in got if key not in allowed]
    if extra:
        raise ProfileError("unknown %s: %s" % (label, ", ".join(str(k) for k in extra)))


def _require_mapping(value, label):
    if not isinstance(value, dict):
        raise ProfileError("%s must be a mapping" % label)
    return value


def _require_bool(value, label):
    if not isinstance(value, bool):
        raise ProfileError("%s must be a boolean" % label)
    return value


def _finite_number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProfileError("%s must be a number" % label)
    number = float(value)
    if not math.isfinite(number):
        raise ProfileError("%s must be finite" % label)
    return number


def _in_range(value, lo, hi, label):
    number = _finite_number(value, label)
    if number < lo or number > hi:
        raise ProfileError("%s must be in %s..%s" % (label, lo, hi))
    return number


def _string_list(value, label):
    if not isinstance(value, list):
        raise ProfileError("%s must be a list of strings" % label)
    out, seen = [], set()
    for item in value:
        if not isinstance(item, str):
            raise ProfileError("%s entries must be strings" % label)
        text = item.strip()
        if not text:
            continue
        if len(text) > 200:
            text = text[:200]
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
        if len(out) >= 100:
            break
    return out


def _persona(value):
    if not isinstance(value, str):
        raise ProfileError("voice.persona must be a string")
    return value.strip()[:1000]


def _mix_weights(value, label):
    mapping = _require_mapping(value, label)
    _unknown_keys(mapping, FAMILIES, "%s family" % label)
    missing = [name for name in FAMILIES if name not in mapping]
    if missing:
        raise ProfileError("%s missing families: %s" % (label, ", ".join(missing)))
    out = {}
    for name in FAMILIES:
        out[name] = _in_range(mapping[name], 0, 100, "%s.%s" % (label, name))
    return out


def _audio_treatment(value, label):
    if not isinstance(value, str):
        raise ProfileError("%s must be a string" % label)
    text = value.strip()
    if text not in AUDIO_TREATMENTS:
        raise ProfileError("unknown audio treatment %r for %s" % (value, label))
    return text


def validate_profile(doc):
    """Return a normalized profile or raise ProfileError. Never patches gaps."""
    mapping = _require_mapping(doc, "channel profile")
    _unknown_keys(mapping, TOP_LEVEL, "top-level section")
    missing = [key for key in TOP_LEVEL if key not in mapping]
    if missing:
        raise ProfileError("missing top-level sections: %s" % ", ".join(missing))
    if mapping["version"] != 1:
        raise ProfileError("version must be exactly 1")

    voice = _require_mapping(mapping["voice"], "voice")
    _unknown_keys(voice, VOICE_KEYS, "voice field")
    for key in VOICE_KEYS:
        if key not in voice:
            raise ProfileError("voice missing %s" % key)
    boundaries = _require_mapping(voice["boundaries"], "voice.boundaries")
    _unknown_keys(boundaries, BOUNDARY_KEYS, "voice.boundaries field")
    for key in BOUNDARY_KEYS:
        if key not in boundaries:
            raise ProfileError("voice.boundaries missing %s" % key)
        _require_bool(boundaries[key], "voice.boundaries.%s" % key)

    mix = _require_mapping(mapping["mix"], "mix")
    _unknown_keys(mix, MIX_MODES, "mix mode")
    for mode in MIX_MODES:
        if mode not in mix:
            raise ProfileError("mix missing %s" % mode)

    sequence = _require_mapping(mapping["sequence"], "sequence")
    _unknown_keys(sequence, SEQUENCE_KEYS, "sequence field")
    for key in SEQUENCE_KEYS:
        if key not in sequence:
            raise ProfileError("sequence missing %s" % key)
    max_run = sequence["max_text_run"]
    if isinstance(max_run, bool) or not isinstance(max_run, int):
        raise ProfileError("sequence.max_text_run must be an integer")
    if max_run < 1 or max_run > 20:
        raise ProfileError("sequence.max_text_run must be in 1..20")
    for key in SEQUENCE_KEYS:
        if key == "max_text_run":
            continue
        _require_bool(sequence[key], "sequence.%s" % key)

    presentation = _require_mapping(mapping["presentation"], "presentation")
    _unknown_keys(presentation, PRESENTATION_KEYS, "presentation field")
    for key in PRESENTATION_KEYS:
        if key not in presentation:
            raise ProfileError("presentation missing %s" % key)
    template = presentation["default_template"]
    if not isinstance(template, str) or not template.strip():
        raise ProfileError("presentation.default_template must be a non-empty string")
    brand = presentation["default_brand_mode"]
    if not isinstance(brand, str) or brand.strip() not in BRAND_MODES:
        raise ProfileError("unknown presentation.default_brand_mode")

    audio = _require_mapping(mapping["audio"], "audio")
    _unknown_keys(audio, AUDIO_KEYS, "audio field")
    for key in AUDIO_KEYS:
        if key not in audio:
            raise ProfileError("audio missing %s" % key)
    if not isinstance(audio["allowed"], list):
        raise ProfileError("audio.allowed must be a list")
    allowed = []
    seen = set()
    for item in audio["allowed"]:
        treatment = _audio_treatment(item, "audio.allowed")
        if treatment in seen:
            continue
        seen.add(treatment)
        allowed.append(treatment)
        if len(allowed) >= 100:
            break
    if not allowed:
        raise ProfileError("audio.allowed must not be empty")
    fallback = _audio_treatment(audio["fallback"], "audio.fallback")

    return {
        "version": 1,
        "voice": {
            "persona": _persona(voice["persona"]),
            "favored_subjects": _string_list(voice["favored_subjects"], "voice.favored_subjects"),
            "boundaries": {key: bool(boundaries[key]) for key in BOUNDARY_KEYS},
            "avoid_phrases": _string_list(voice["avoid_phrases"], "voice.avoid_phrases"),
            "avoid_topics": _string_list(voice["avoid_topics"], "voice.avoid_topics"),
        },
        "mix": {mode: _mix_weights(mix[mode], "mix.%s" % mode) for mode in MIX_MODES},
        "sequence": {
            "max_text_run": int(max_run),
            "avoid_same_family": bool(sequence["avoid_same_family"]),
            "prefer_exit_ident": bool(sequence["prefer_exit_ident"]),
            "avoid_same_music": bool(sequence["avoid_same_music"]),
            "avoid_large_energy_jump": bool(sequence["avoid_large_energy_jump"]),
        },
        "presentation": {
            "default_template": template.strip()[:200],
            "default_brand_mode": brand.strip(),
        },
        "audio": {
            "allowed": allowed,
            "target_lufs": _in_range(audio["target_lufs"], -36, -5, "audio.target_lufs"),
            "true_peak_db": _in_range(audio["true_peak_db"], -12, 0, "audio.true_peak_db"),
            "fallback": fallback,
        },
    }


def _origin_for(path):
    configured = (config.CHANNEL_PROFILE or "").strip()
    if configured:
        return "custom"
    try:
        if path is not None and Path(path).resolve() == SHIPPED_PROFILE_FILE.resolve():
            return "shipped-default"
    except OSError:
        pass
    if path is None:
        return "shipped-default"
    return "custom"


def _read_document(path):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise ProfileError("could not read channel profile: %s" % exc) from exc
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ProfileError("channel profile is not valid YAML: %s" % exc) from exc
    return doc


def load_profile(path=None, *, strict=False):
    """Load and normalize a profile.

    A missing file returns an independent deep copy of defaults. Runtime
    invalidity logs one warning and returns the full default. Strict mode
    raises ProfileError. Malformed documents are never partially applied.
    """
    if path is None:
        configured = (config.CHANNEL_PROFILE or "").strip()
        path = Path(configured) if configured else SHIPPED_PROFILE_FILE
    else:
        path = Path(path)
    origin = _origin_for(path)
    if not path.is_file():
        if strict:
            raise ProfileError("channel profile not found: %s" % path)
        configured = (config.CHANNEL_PROFILE or "").strip()
        # A missing operator path is a runtime error. A missing explicit
        # argument (or shipped file) just means "use the in-code defaults".
        if configured and Path(configured) == path:
            _warn_once("channel profile %s is missing; using shipped defaults" % path)
            _record_status(False, "fallback-after-error")
        else:
            _record_status(True, "shipped-default")
        return default_profile()
    try:
        normalized = validate_profile(_read_document(path))
    except ProfileError as exc:
        if strict:
            raise
        _warn_once("invalid channel profile (%s); using shipped defaults. "
                   "python -m bumparr.channel_profile --check" % exc)
        _record_status(False, "fallback-after-error")
        return default_profile()
    source = "custom" if origin == "custom" else "shipped-default"
    _record_status(True, source)
    return normalized


def _record_status(valid, source):
    global _status
    if source not in ("shipped-default", "custom", "fallback-after-error"):
        source = "fallback-after-error"
    _status = {"version": 1, "valid": bool(valid), "source": source}


def _ensure():
    global _current
    if _current is None:
        _current = load_profile()
    return _current


def current():
    """Cached runtime profile (independent copy). Reloaded only on restart."""
    return copy.deepcopy(_ensure())


def profile_status():
    """Status `profile` object: version, valid, source. Never a filesystem path."""
    _ensure()
    status = dict(_status or {"version": 1, "valid": True, "source": "shipped-default"})
    if status.get("source") not in ("shipped-default", "custom", "fallback-after-error"):
        status["source"] = "fallback-after-error"
    status["version"] = 1
    status["valid"] = bool(status.get("valid"))
    return {"version": status["version"], "valid": status["valid"],
            "source": status["source"]}


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Validate the operator channel profile.")
    ap.add_argument("--check", action="store_true",
                    help="strict-validate CHANNEL_PROFILE or the shipped default")
    args = ap.parse_args(argv)
    if not args.check:
        ap.error("pass --check to strictly validate the channel profile")
    configured = (config.CHANNEL_PROFILE or "").strip()
    path = Path(configured) if configured else SHIPPED_PROFILE_FILE
    try:
        load_profile(path, strict=True)
    except ProfileError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
