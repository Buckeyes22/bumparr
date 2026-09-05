"""Music-bed manifest: editorial identity, credits, and offline loudness.

The shipped YAML is empty-valid. Runtime skips invalid or unreadable entries;
`python -m bumparr.music --check` fails closed. Missing, disabled, or
unreadable beds become explicit silence. Never follow an escaping symlink.
"""
import argparse
import json
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

from bumparr import config, creative, paths

SHIPPED_MANIFEST_FILE = Path(__file__).resolve().parent / "config_files" / "music_beds.yaml"

ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,79}$")
MAX_PATH = 500
MAX_STRING = 500
SOUND_EXT = (".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac", ".opus")
BED_KEYS = (
    "id", "path", "title", "creator", "source_page", "license", "license_url",
    "attribution", "energy", "families", "enabled", "operator_owned",
)
REQUIRED = ("id", "path", "title", "creator", "license", "enabled")
CREDITS_KEYS = ("id", "title", "creator", "source_page", "license", "license_url",
                "attribution")

TARGET_LUFS = -16.0
TRUE_PEAK_DB = -1.5
LUFS_TOLERANCE = 1.0
FADE_IN_S = 0.4
FADE_OUT_S = 0.6
SAMPLE_RATE = 48000
CHANNELS = 2
AAC_BITRATE = "128k"

_LEGACY_PREFIX = "legacy."
_CC0 = frozenset({
    "cc0", "cc0-1.0", "cc-0", "cc 0", "public-domain", "public domain",
    "pd", "pdm", "cc0 1.0",
})

_warned = False
_current = None
_status = None


class MusicError(ValueError):
    """Strict validation failure for a music-bed manifest."""


@dataclass(frozen=True)
class Bed:
    """One manifest or compatibility-mode bed."""
    id: str
    path: str
    resolved_path: str
    title: str
    creator: str
    source_page: str
    license: str
    license_url: str
    attribution: str
    energy: str
    families: tuple
    enabled: bool
    operator_owned: bool


def reset_runtime_state():
    """Drop cached beds/status and the once-only runtime warning."""
    global _warned, _current, _status
    _warned = False
    _current = None
    _status = None


def allow_unmanifested():
    """True only when ALLOW_UNMANIFESTED_MUSIC is the exact string '1'."""
    return str(getattr(config, "ALLOW_UNMANIFESTED_MUSIC", "") or "").strip() == "1"


def _warn_once(message):
    global _warned
    if _warned:
        return
    _warned = True
    print("[music] %s" % message)


def _bound_string(value, label, *, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise MusicError("%s must be a string" % label)
    if len(value) > MAX_STRING:
        raise MusicError("%s exceeds %d characters" % (label, MAX_STRING))
    if required and not value.strip():
        raise MusicError("%s is required" % label)
    return value


def _clip_fades(duration):
    duration = max(0.05, float(duration))
    fade_in = min(FADE_IN_S, max(0.05, duration / 4.0))
    fade_out = min(FADE_OUT_S, max(0.05, duration / 4.0))
    if fade_in + fade_out >= duration:
        fade_in = fade_out = max(0.02, duration / 5.0)
    return duration, fade_in, fade_out


def _contained_file(root, rel):
    """Contained regular readable file, or None. Never follows an escaping symlink."""
    if not isinstance(rel, str) or not rel.strip() or len(rel) > MAX_PATH:
        return None
    if Path(rel).is_absolute() or rel.startswith("/") or rel.startswith("\\"):
        return None
    root = Path(root)
    candidate = root / rel
    contained = paths._contained(candidate, root)
    if contained is None:
        return None
    try:
        st = contained.lstat()
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode):
        # Resolve only after the lexical entry is inside the tree; reject
        # a link whose target escapes.
        if paths._contained(contained, root) is None:
            return None
        try:
            resolved = contained.resolve()
        except OSError:
            return None
        if paths._contained(resolved, root) is None:
            return None
        try:
            st = resolved.stat()
        except OSError:
            return None
        if not stat.S_ISREG(st.st_mode):
            return None
    elif not stat.S_ISREG(st.st_mode):
        return None
    if not os.access(contained, os.R_OK):
        return None
    if not contained.is_file():
        return None
    return contained


def _iter_sound_files(root):
    root = Path(root)
    if not root.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        keep = []
        for name in dirnames:
            child = Path(dirpath) / name
            if paths._contained(child, root) is not None and not child.is_symlink():
                keep.append(name)
        dirnames[:] = keep
        for name in filenames:
            child = Path(dirpath) / name
            if child.suffix.lower() not in SOUND_EXT:
                continue
            if _contained_file(root, str(child.relative_to(root))) is None:
                continue
            yield child


def _legacy_id(rel):
    token = re.sub(r"[^a-z0-9._-]+", ".", str(rel).strip().lower()).strip(".")
    ident = (_LEGACY_PREFIX + token)[:80]
    if not ID_RE.fullmatch(ident):
        ident = (_LEGACY_PREFIX + "%08x" % (abs(hash(rel)) % (16 ** 8)))[:80]
    return ident


def _uncredited_bed(rel, resolved, *, energy="neutral"):
    return Bed(
        id=_legacy_id(rel),
        path=rel,
        resolved_path=str(resolved),
        title="",
        creator="",
        source_page="",
        license="",
        license_url="",
        attribution="",
        energy=energy,
        families=tuple(creative.FAMILIES),
        enabled=True,
        operator_owned=True,
    )


def _parse_families(value, label):
    if isinstance(value, str):
        value = [part.strip() for part in value.split(",")]
    if not isinstance(value, (list, tuple)) or not value:
        raise MusicError("%s must be a non-empty list of families" % label)
    out, seen = [], set()
    for item in value:
        if not isinstance(item, str) or item.strip() not in creative.FAMILIES:
            raise MusicError("%s contains unknown family %r" % (label, item))
        token = item.strip()
        if token not in seen:
            seen.add(token)
            out.append(token)
    return tuple(out)


def _validate_bed(raw, *, sound_dir, seen_ids):
    if not isinstance(raw, dict):
        raise MusicError("each bed must be a mapping")
    extra = [key for key in raw if key not in BED_KEYS]
    if extra:
        raise MusicError("unknown bed fields: %s" % ", ".join(str(k) for k in extra))
    for key in REQUIRED:
        if key not in raw:
            raise MusicError("bed missing required field %s" % key)
    ident = _bound_string(raw.get("id"), "id", required=True).strip()
    if not ID_RE.fullmatch(ident):
        raise MusicError("invalid bed id %r" % ident)
    if ident in seen_ids:
        raise MusicError("duplicate bed id %r" % ident)
    rel = _bound_string(raw.get("path"), "path", required=True).strip()
    if len(rel) > MAX_PATH:
        raise MusicError("path exceeds %d characters" % MAX_PATH)
    resolved = _contained_file(sound_dir, rel)
    if resolved is None:
        raise MusicError("bed %s path is missing, unreadable, or not contained" % ident)
    energy = _bound_string(raw.get("energy"), "energy", required=True).strip()
    if energy not in creative.ENERGIES:
        raise MusicError("bed %s has unknown energy %r" % (ident, energy))
    enabled = raw.get("enabled")
    if not isinstance(enabled, bool):
        raise MusicError("bed %s enabled must be an explicit boolean" % ident)
    owned = raw.get("operator_owned", False)
    if not isinstance(owned, bool):
        raise MusicError("bed %s operator_owned must be a boolean" % ident)
    families = _parse_families(raw.get("families"), "bed %s families" % ident)
    title = _bound_string(raw.get("title"), "title")
    creator = _bound_string(raw.get("creator"), "creator")
    license_name = _bound_string(raw.get("license"), "license")
    source_page = _bound_string(raw.get("source_page"), "source_page")
    license_url = _bound_string(raw.get("license_url"), "license_url")
    attribution = _bound_string(raw.get("attribution"), "attribution")
    if not owned and attribution_required(license_name):
        if not (attribution.strip() or title.strip() or creator.strip()):
            raise MusicError("bed %s license requires credits" % ident)
    return Bed(
        id=ident,
        path=rel,
        resolved_path=str(resolved),
        title=title,
        creator=creator,
        source_page=source_page,
        license=license_name,
        license_url=license_url,
        attribution=attribution,
        energy=energy,
        families=families,
        enabled=enabled,
        operator_owned=owned,
    )


def validate_manifest(doc, *, sound_dir=None, skip_errors=False):
    """Return valid Bed records. Strict mode raises MusicError."""
    if not isinstance(doc, dict):
        raise MusicError("music manifest must be a mapping")
    extra = [key for key in doc if key not in ("version", "beds")]
    if extra:
        raise MusicError("unknown top-level fields: %s" % ", ".join(str(k) for k in extra))
    if doc.get("version") != 1:
        raise MusicError("music manifest version must be 1")
    beds = doc.get("beds")
    if beds is None:
        beds = []
    if not isinstance(beds, list):
        raise MusicError("beds must be a list")
    sound_dir = Path(sound_dir or config.SOUND_DIR)
    out, seen, errors = [], set(), []
    for raw in beds:
        try:
            ident = None
            if isinstance(raw, dict) and isinstance(raw.get("id"), str):
                ident = raw["id"].strip()
            bed = _validate_bed(raw, sound_dir=sound_dir, seen_ids=seen)
        except MusicError as exc:
            if not skip_errors:
                raise
            errors.append(str(exc))
            if ident:
                seen.add(ident)
            continue
        seen.add(bed.id)
        out.append(bed)
    if errors:
        _warn_once("skipped %d invalid music-bed entries. python -m bumparr.music --check"
                   % len(errors))
    return out


def _read_document(path):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        raise MusicError("could not read music manifest: %s" % exc) from exc
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise MusicError("music manifest is not valid YAML: %s" % exc) from exc
    return doc


def _origin_for(path):
    configured = (config.MUSIC_MANIFEST or "").strip()
    if configured:
        return "custom"
    try:
        if path is not None and Path(path).resolve() == SHIPPED_MANIFEST_FILE.resolve():
            return "shipped-default"
    except OSError:
        pass
    if path is None:
        return "shipped-default"
    return "custom"


def _record_status(valid, source, enabled_beds=0):
    global _status
    if source not in ("shipped-default", "custom", "fallback-after-error"):
        source = "fallback-after-error"
    _status = {
        "version": 1,
        "valid": bool(valid),
        "source": source,
        "enabled_beds": int(enabled_beds),
        "compatibility": allow_unmanifested(),
    }


def _legacy_beds(existing_ids):
    if not allow_unmanifested():
        return []
    out = []
    for path in _iter_sound_files(config.SOUND_DIR):
        try:
            rel = str(path.relative_to(Path(config.SOUND_DIR)))
        except ValueError:
            continue
        ident = _legacy_id(rel)
        if ident in existing_ids:
            continue
        contained = _contained_file(config.SOUND_DIR, rel)
        if contained is None:
            continue
        out.append(_uncredited_bed(rel, contained))
        existing_ids.add(ident)
    return out


def load_manifest(path=None, *, strict=False):
    """Load beds. Runtime skips bad rows; strict mode raises MusicError."""
    if path is None:
        configured = (config.MUSIC_MANIFEST or "").strip()
        path = Path(configured) if configured else SHIPPED_MANIFEST_FILE
    else:
        path = Path(path)
    origin = _origin_for(path)
    if not path.is_file():
        if strict:
            raise MusicError("music manifest not found: %s" % path)
        configured = (config.MUSIC_MANIFEST or "").strip()
        if configured and Path(configured) == path:
            _warn_once("music manifest %s is missing; using no beds" % path)
            _record_status(False, "fallback-after-error", 0)
        else:
            _record_status(True, "shipped-default", 0)
        return _legacy_beds(set())
    try:
        beds = validate_manifest(_read_document(path), skip_errors=not strict)
    except MusicError:
        if strict:
            raise
        _warn_once("invalid music manifest; using no manifested beds. "
                   "python -m bumparr.music --check")
        _record_status(False, "fallback-after-error", 0)
        return _legacy_beds(set())
    source = "custom" if origin == "custom" else "shipped-default"
    enabled = sum(1 for bed in beds if bed.enabled)
    _record_status(True, source, enabled)
    seen = {bed.id for bed in beds}
    return list(beds) + _legacy_beds(seen)


def _ensure():
    global _current
    if _current is None:
        _current = load_manifest(strict=False)
    return _current


def selectable_beds():
    """Enabled manifested beds, plus unmanifested files in compatibility mode."""
    return [bed for bed in _ensure() if bed.enabled]


def pick_bed(family, energy, rng, recent_ids=None, pool=None):
    """Choose an enabled family/energy-compatible bed, avoiding recent ids."""
    recent = set(recent_ids or ())
    pool = list(pool if pool is not None else selectable_beds())
    compatible = [bed for bed in pool
                  if bed.enabled and family in bed.families and bed.energy == energy]
    if not compatible:
        return None
    avoid = [bed for bed in compatible if bed.id not in recent]
    choices = avoid or compatible
    if rng is None:
        return choices[0]
    return rng.choice(choices)


def _legacy_payload_bed(payload):
    if not allow_unmanifested():
        return None
    rel = payload.get("music")
    if not isinstance(rel, str) or not rel.strip():
        return None
    contained = _contained_file(config.ASSET_ROOT, rel.strip())
    if contained is None:
        return None
    return _uncredited_bed(rel.strip(), contained)


def resolve_playable(payload, row=None):
    """Bed for this payload, or None (explicit silence).

    New rows use creative.music_id. Legacy payload.music is honoured only when
    ALLOW_UNMANIFESTED_MUSIC=1. Missing, disabled, or unreadable → None.
    """
    payload = payload if isinstance(payload, dict) else {}
    music_id = None
    creative_obj = payload.get("creative")
    if isinstance(creative_obj, dict) and isinstance(creative_obj.get("music_id"), str):
        music_id = creative_obj.get("music_id")
        music_id = music_id.strip() if music_id else None
    if not music_id and row is not None:
        music_id = creative.resolve_creative(row).get("music_id")
    if music_id:
        for bed in _ensure():
            if bed.id != music_id:
                continue
            if not bed.enabled:
                return None
            if _contained_file(config.SOUND_DIR, bed.path) is None:
                return None
            return bed
        return None
    return _legacy_payload_bed(payload)


def snapshot_credits(bed):
    """Historical/export credits. Never fabricates missing fields."""
    if bed is None:
        return None
    return {
        "id": bed.id,
        "title": bed.title or "",
        "creator": bed.creator or "",
        "source_page": bed.source_page or "",
        "license": bed.license or "",
        "license_url": bed.license_url or "",
        "attribution": bed.attribution or "",
    }


def public_credits(raw):
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in CREDITS_KEYS:
        value = raw.get(key)
        out[key] = "" if value is None and key != "id" else value
    if out.get("id") in ("", None) and not any(out.get(k) for k in CREDITS_KEYS if k != "id"):
        return None
    return out


def credits_from_payload(payload):
    if not isinstance(payload, dict):
        return None
    return public_credits(payload.get("music_credits"))


def apply_playable_audio(payload, bed, *, preserve_non_music=False):
    """Merge music_id/audio/credits. Preserves unrelated payload keys."""
    base = dict(payload) if isinstance(payload, dict) else {}
    if bed is None:
        current = base.get("creative") if isinstance(base.get("creative"), dict) else {}
        audio = current.get("audio")
        if preserve_non_music and audio in ("native", "designed"):
            return base
        base.pop("music_credits", None)
        return creative.merge_creative(base, {"audio": "silence", "music_id": None})
    base = creative.merge_creative(base, {"audio": "music", "music_id": bed.id})
    base["music_credits"] = snapshot_credits(bed)
    return base


def attribution_required(license_name):
    token = re.sub(r"[\s_]+", "-", str(license_name or "").strip().lower())
    if not token or token in _CC0:
        return False
    return token.startswith("cc-by") or token.startswith("ccby")


def onscreen_attribution(credits):
    """On-screen text only when the license requires it and credits are truthful."""
    if not isinstance(credits, dict):
        return ""
    if not attribution_required(credits.get("license")):
        return ""
    text = str(credits.get("attribution") or "").strip()
    if text:
        return text[:200]
    title = str(credits.get("title") or "").strip()
    creator = str(credits.get("creator") or "").strip()
    if title and creator:
        return ("%s — %s" % (title, creator))[:200]
    return (title or creator)[:200]


def audio_filter(duration, offset=0.0):
    """One offline ffmpeg filter: bounded excerpt, fades, -16 LUFS, -1.5 dBTP."""
    duration, fade_in, fade_out = _clip_fades(duration)
    fade_out_at = max(0.0, duration - fade_out)
    parts = []
    if offset and offset > 0:
        parts.append("atrim=start=%.3f:duration=%.3f" % (offset, duration))
        parts.append("asetpts=PTS-STARTPTS")
    else:
        parts.append("atrim=duration=%.3f" % duration)
        parts.append("asetpts=PTS-STARTPTS")
    parts.append("afade=t=in:st=0:d=%.3f" % fade_in)
    parts.append("afade=t=out:st=%.3f:d=%.3f" % (fade_out_at, fade_out))
    parts.append("loudnorm=I=%.1f:TP=%.1f:LRA=11" % (TARGET_LUFS, TRUE_PEAK_DB))
    parts.append("aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo"
                 % SAMPLE_RATE)
    return ",".join(parts)


def _unlink(path):
    try:
        Path(path).unlink()
    except OSError:
        pass


def _loudnorm_stats(stderr):
    text = stderr or ""
    start, end = text.rfind("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def normalize_excerpt(src, dest, duration, offset=0.0):
    """Write AAC 48 kHz stereo at the offline loudness policy, or raise.

    Failure unlinks `dest` so a partial file cannot be muxed.
    """
    dest = Path(dest)
    duration, fade_in, fade_out = _clip_fades(duration)
    offset = max(0.0, float(offset or 0.0))
    measure = (
        "atrim=start=%.3f:duration=%.3f,asetpts=PTS-STARTPTS,"
        "loudnorm=I=%.1f:TP=%.1f:LRA=11:print_format=json"
        % (offset, duration, TARGET_LUFS, TRUE_PEAK_DB)
    )
    try:
        first = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src),
             "-t", "%.3f" % (duration + offset + 0.1),
             "-af", measure, "-f", "null", "-"],
            capture_output=True, text=True, timeout=120)
        stats = _loudnorm_stats(first.stderr)
        fade_out_at = max(0.0, duration - fade_out)
        loud = "loudnorm=I=%.1f:TP=%.1f:LRA=11" % (TARGET_LUFS, TRUE_PEAK_DB)
        if stats and stats.get("input_i") is not None:
            loud = (
                "loudnorm=I=%.1f:TP=%.1f:LRA=11:measured_I=%s:measured_LRA=%s:"
                "measured_TP=%s:measured_thresh=%s:offset=%s:linear=true"
                % (TARGET_LUFS, TRUE_PEAK_DB,
                   stats.get("input_i"), stats.get("input_lra"),
                   stats.get("input_tp"), stats.get("input_thresh"),
                   stats.get("target_offset"))
            )
        filt = ",".join([
            "atrim=start=%.3f:duration=%.3f" % (offset, duration),
            "asetpts=PTS-STARTPTS",
            "afade=t=in:st=0:d=%.3f" % fade_in,
            "afade=t=out:st=%.3f:d=%.3f" % (fade_out_at, fade_out),
            loud,
            "aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo" % SAMPLE_RATE,
        ])
        second = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(src), "-af", filt, "-t", "%.3f" % duration,
             "-c:a", "aac", "-b:a", AAC_BITRATE, "-ar", str(SAMPLE_RATE),
             "-ac", str(CHANNELS), str(dest)],
            capture_output=True, text=True, timeout=180)
        if second.returncode != 0 or not dest.is_file() or dest.stat().st_size == 0:
            raise RuntimeError((second.stderr or first.stderr or "ffmpeg loudness failed")[-500:])
    except Exception:
        _unlink(dest)
        raise


def measure_loudness(path):
    """Return loudnorm JSON for an existing file, or None."""
    try:
        run = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
             "-af", "loudnorm=I=%.1f:TP=%.1f:print_format=json" % (TARGET_LUFS, TRUE_PEAK_DB),
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        return None
    return _loudnorm_stats(run.stderr)


def manifest_status():
    """Status `music` object. Never a filesystem path."""
    _ensure()
    status = dict(_status or {
        "version": 1, "valid": True, "source": "shipped-default",
        "enabled_beds": 0, "compatibility": False,
    })
    if status.get("source") not in ("shipped-default", "custom", "fallback-after-error"):
        status["source"] = "fallback-after-error"
    status["version"] = 1
    status["valid"] = bool(status.get("valid"))
    status["enabled_beds"] = int(status.get("enabled_beds") or 0)
    status["compatibility"] = allow_unmanifested()
    return {
        "version": status["version"],
        "valid": status["valid"],
        "source": status["source"],
        "enabled_beds": status["enabled_beds"],
        "compatibility": status["compatibility"],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="Validate the operator music-bed manifest.")
    ap.add_argument("--check", action="store_true",
                    help="strict-validate MUSIC_MANIFEST or the shipped default")
    args = ap.parse_args(argv)
    if not args.check:
        ap.error("pass --check to strictly validate the music manifest")
    configured = (config.MUSIC_MANIFEST or "").strip()
    path = Path(configured) if configured else SHIPPED_MANIFEST_FILE
    try:
        load_manifest(path, strict=True)
    except MusicError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
