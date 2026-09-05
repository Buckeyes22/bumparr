"""Truthful channel-memory cards from station:live history and local YAML.

Bumparr knows station requests caused entries to cross start times. It does
not know a human watched. Factual cards say "this channel has aired," never
"you watched." Preview, status, and simulation never call this module.
"""
import argparse
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

from bumparr import config, db
from bumparr.card_validation import pre_insert_check, validate_card
from bumparr.content_filter import weight_for
from bumparr.creative import ROLES, merge_creative, with_creative, with_presentation

SHIPPED_MESSAGES_FILE = (
    Path(__file__).resolve().parent.parent / "config_files" / "operator_messages.yaml"
)

SOURCE_CHANNEL = "station:live"
PLAYABLE_SOURCE = "channel-memory"
ALL_KINDS = (
    "channel_statistics",
    "previously_on",
    "viewer_achievement",
    "operator_message",
)
ACHIEVEMENTS = (("starts", 25), ("starts", 100))
RECENT_SHOW = 2
ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,79}$")
MAX_LINE = 120
MAX_STRING = 200
MESSAGE_KEYS = ("id", "lines", "enabled", "starts_at", "ends_at", "roles")
FORBIDDEN_VIEWER = (
    "you watched", "you've watched", "you have watched",
    "you unlocked", "you saw", "your viewing", "unique viewer",
)

_warned = False
_messages = None
_status = None


class MemoryConfigError(ValueError):
    """Strict validation failure for operator messages."""


def reset_runtime_state():
    """Drop cached operator-message status and the once-only warning."""
    global _warned, _messages, _status
    _warned = False
    _messages = None
    _status = None


def _warn_once(message):
    global _warned
    if _warned:
        return
    _warned = True
    print("[channel_memory] %s" % message)


def hour_window(now):
    """Hour bucket containing `now`: (start, end) unix seconds."""
    now = float(now)
    start = now - (now % 3600.0)
    return start, start + 3600.0


def channel_slug(channel):
    """Stable id fragment for a channel name."""
    token = re.sub(r"[^a-z0-9]+", "-", str(channel or "").strip().lower()).strip("-")
    return token or "channel"


def parse_timestamp(value, label):
    """ISO-8601 string or null -> unix seconds. Naive values are UTC."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise MemoryConfigError("%s must be a string or null" % label)
    text = value.strip()
    if not text:
        raise MemoryConfigError("%s is empty" % label)
    if len(text) > MAX_STRING:
        raise MemoryConfigError("%s exceeds %d characters" % (label, MAX_STRING))
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise MemoryConfigError("%s is not a parseable timestamp" % label) from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def enabled_kinds():
    """Configured memory kinds, in canonical order. Empty disables every kind."""
    raw = str(getattr(config, "CHANNEL_MEMORY_KINDS", "") or "")
    wanted = {part.strip() for part in raw.split(",") if part.strip()}
    return tuple(kind for kind in ALL_KINDS if kind in wanted)


def evidence(channel, now, *, history_ids=None, window_start=None,
             window_end=None, valid_until=None):
    """Provenance recorded on every factual payload."""
    ids = []
    for item in history_ids or ():
        try:
            ids.append(int(item))
        except (TypeError, ValueError):
            continue
    return {
        "channel": channel,
        "history_ids": ids,
        "window_start": window_start,
        "window_end": window_end,
        "generated_at": float(now),
        "valid_until": None if valid_until is None else float(valid_until),
    }


def _ago(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "less than a minute"
    if seconds < 3600:
        minutes = seconds // 60
        return "1 minute" if minutes == 1 else "%d minutes" % minutes
    hours = seconds // 3600
    if hours < 48:
        return "1 hour" if hours == 1 else "%d hours" % hours
    days = hours // 24
    return "1 day" if days == 1 else "%d days" % days


def _clip_line(text):
    text = " ".join(str(text or "").split())
    if len(text) <= MAX_LINE:
        return text
    return text[: MAX_LINE - 1].rstrip() + "…"


def statistics_id(channel):
    return "card:channel_statistics:" + channel_slug(channel)


def previously_on_id(channel, entries):
    body = json.dumps(
        {"channel": channel, "history": [[int(i), float(t)] for i, t in entries]},
        separators=(",", ":"),
    )
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    return "card:previously_on:" + digest


def achievement_id(channel, key, threshold):
    return "card:viewer_achievement:%s:%s:%s" % (
        channel_slug(channel), key, int(threshold))


def operator_message_id(authored_id):
    return "card:operator_message:" + authored_id


def statistics_payload(history_rows, registry_live, now, channel=SOURCE_CHANNEL,
                       last_ident_at=None):
    """Pure: registry + history rows -> statistics payload."""
    window_start, window_end = hour_window(now)
    rows = list(history_rows or ())
    total = len(rows)
    in_window_rows = [row for row in rows
                      if window_start <= float(row["played_at"]) < window_end]
    in_window = len(in_window_rows)
    lines = []
    if total == 0:
        lines.append("This channel has not yet aired a bumper.")
    else:
        noun = "bumper" if total == 1 else "bumpers"
        lines.append("This channel has aired %d %s." % (total, noun))
        if in_window:
            start_noun = "start" if in_window == 1 else "starts"
            lines.append("This hour: %d reported %s." % (in_window, start_noun))
    live = int(registry_live or 0)
    item_noun = "item" if live == 1 else "items"
    pool_line = "The pool currently holds %d playable %s." % (live, item_noun)
    ident_line = None
    if last_ident_at is not None:
        ident_line = "An ident last crossed a start %s ago." % _ago(now - float(last_ident_at))
    if ident_line and len(lines) < 3:
        lines.append(ident_line)
    elif len(lines) < 3:
        lines.append(pool_line)
    payload = {
        "lines": [_clip_line(line) for line in lines[:3]],
        "memory_kind": "channel_statistics",
        "source": PLAYABLE_SOURCE,
    }
    payload.update(evidence(
        channel, now,
        history_ids=[row["id"] for row in in_window_rows],
        window_start=window_start,
        window_end=window_end,
        valid_until=window_end,
    ))
    return payload


def previously_on_payload(joined_rows, now, channel=SOURCE_CHANNEL):
    """Pure: recent history joined to current titles/kinds. None if empty."""
    surviving = []
    for row in joined_rows or ():
        title = (row.get("title") or "").strip()
        kind = (row.get("kind") or "").strip()
        if not title and not kind:
            continue
        surviving.append(row)
        if len(surviving) >= RECENT_SHOW:
            break
    if not surviving:
        return None
    lines = ["Previously on this channel"]
    for row in surviving:
        kind = (row.get("kind") or "item").strip() or "item"
        title = (row.get("title") or "").strip() or "an untitled bumper"
        lines.append(_clip_line("%s — %s" % (kind, title)))
    entries = [(int(row["id"]), float(row["played_at"])) for row in surviving]
    played = [float(row["played_at"]) for row in surviving]
    window_start, window_end = min(played), max(played)
    _, hour_end = hour_window(now)
    payload = {
        "lines": lines[:3],
        "memory_kind": "previously_on",
        "source": PLAYABLE_SOURCE,
    }
    payload.update(evidence(
        channel, now,
        history_ids=[row["id"] for row in surviving],
        window_start=window_start,
        window_end=window_end,
        valid_until=hour_end,
    ))
    payload["_id"] = previously_on_id(channel, entries)
    return payload


def achievement_payloads(start_count, now, channel=SOURCE_CHANNEL,
                         history_ids=None, first_at=None, last_at=None):
    """Pure: one payload per reached start-count threshold."""
    count = int(start_count or 0)
    out = []
    for key, threshold in ACHIEVEMENTS:
        if count < threshold:
            continue
        noun = "bumper" if threshold == 1 else "bumpers"
        lines = ["This channel has aired %d %s." % (threshold, noun)]
        payload = {
            "lines": lines,
            "memory_kind": "viewer_achievement",
            "source": PLAYABLE_SOURCE,
            "achievement": key,
            "threshold": threshold,
        }
        payload.update(evidence(
            channel, now,
            history_ids=history_ids,
            window_start=first_at,
            window_end=last_at,
            valid_until=None,
        ))
        payload["_id"] = achievement_id(channel, key, threshold)
        out.append(payload)
    return out


def message_eligible(message, now):
    """Whether a validated operator message should be on air at `now`."""
    if not message.get("enabled"):
        return False
    starts = message.get("starts_at")
    ends = message.get("ends_at")
    if starts is not None and float(now) < float(starts):
        return False
    if ends is not None and float(now) >= float(ends):
        return False
    return True


def operator_message_payload(message, now, channel=SOURCE_CHANNEL):
    """Pure: validated message dict -> payload, or None if ineligible."""
    lines = [str(line) for line in (message.get("lines") or [])]
    payload = {
        "lines": lines,
        "memory_kind": "operator_message",
        "source": PLAYABLE_SOURCE,
        "message_id": message["id"],
        "roles": list(message.get("roles") or ("any",)),
    }
    payload.update(evidence(
        channel, now,
        history_ids=(),
        window_start=message.get("starts_at"),
        window_end=message.get("ends_at"),
        valid_until=message.get("ends_at"),
    ))
    payload["_id"] = operator_message_id(message["id"])
    payload["_eligible"] = message_eligible(message, now)
    return payload


def _bound_string(value, label, *, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise MemoryConfigError("%s must be a string" % label)
    if len(value) > MAX_STRING:
        raise MemoryConfigError("%s exceeds %d characters" % (label, MAX_STRING))
    if required and not value.strip():
        raise MemoryConfigError("%s is required" % label)
    return value


def validate_message(raw, seen_ids):
    """Strict-validate one YAML message mapping. Returns a normalized dict."""
    if not isinstance(raw, dict):
        raise MemoryConfigError("each message must be a mapping")
    extra = [key for key in raw if key not in MESSAGE_KEYS]
    if extra:
        raise MemoryConfigError("unknown message fields: %s" % ", ".join(str(k) for k in extra))
    ident = _bound_string(raw.get("id"), "id", required=True).strip()
    if not ID_RE.fullmatch(ident):
        raise MemoryConfigError("invalid message id %r" % ident)
    if ident in seen_ids:
        raise MemoryConfigError("duplicate message id %r" % ident)
    lines_raw = raw.get("lines")
    if not isinstance(lines_raw, list):
        raise MemoryConfigError("message %s lines must be a list" % ident)
    lines = []
    for item in lines_raw:
        if not isinstance(item, str):
            raise MemoryConfigError("message %s lines must be strings" % ident)
        text = item.strip()
        if not text:
            raise MemoryConfigError("message %s has an empty line" % ident)
        if len(text) > MAX_LINE:
            raise MemoryConfigError("message %s line exceeds %d characters" % (ident, MAX_LINE))
        lines.append(text)
    if not 1 <= len(lines) <= 3:
        raise MemoryConfigError("message %s must have 1–3 lines" % ident)
    enabled = raw.get("enabled")
    if not isinstance(enabled, bool):
        raise MemoryConfigError("message %s enabled must be an explicit boolean" % ident)
    starts_at = parse_timestamp(raw.get("starts_at"), "message %s starts_at" % ident)
    ends_at = parse_timestamp(raw.get("ends_at"), "message %s ends_at" % ident)
    if starts_at is not None and ends_at is not None and starts_at >= ends_at:
        raise MemoryConfigError("message %s starts_at must be before ends_at" % ident)
    roles_raw = raw.get("roles", ["any"])
    if isinstance(roles_raw, str):
        roles_raw = [part.strip() for part in roles_raw.split(",")]
    if not isinstance(roles_raw, (list, tuple)) or not roles_raw:
        raise MemoryConfigError("message %s roles must be a non-empty list" % ident)
    roles, seen_roles = [], set()
    for item in roles_raw:
        if not isinstance(item, str) or item.strip() not in ROLES:
            raise MemoryConfigError("message %s has unknown role %r" % (ident, item))
        token = item.strip()
        if token not in seen_roles:
            seen_roles.add(token)
            roles.append(token)
    cleaned, reason = validate_card("operator_message", {"lines": lines})
    if cleaned is None:
        raise MemoryConfigError("message %s failed card validation: %s" % (ident, reason))
    return {
        "id": ident,
        "lines": list(cleaned.get("lines") or lines),
        "enabled": enabled,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "roles": tuple(roles),
    }


def _messages_path():
    configured = str(getattr(config, "OPERATOR_MESSAGES", "") or "").strip()
    return Path(configured) if configured else SHIPPED_MESSAGES_FILE


def _source_label(path):
    try:
        if path.resolve() == SHIPPED_MESSAGES_FILE.resolve():
            return "shipped-default"
    except OSError:
        pass
    return "custom"


def load_operator_messages(*, strict=False):
    """Load and validate operator messages. Runtime skips bad rows; strict fails."""
    path = _messages_path()
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if strict:
            raise MemoryConfigError("operator messages file is missing") from None
        _warn_once("operator messages file is missing; skipping")
        return [], {"version": 1, "valid": False, "source": "fallback-after-error",
                    "enabled": 0, "total": 0, "applied": False}
    except (OSError, yaml.YAMLError) as exc:
        if strict:
            raise MemoryConfigError("operator messages are unreadable: %s" % exc) from exc
        _warn_once("operator messages unreadable; skipping")
        return [], {"version": 1, "valid": False, "source": "fallback-after-error",
                    "enabled": 0, "total": 0, "applied": False}
    if not isinstance(raw, dict):
        if strict:
            raise MemoryConfigError("operator messages document must be a mapping")
        _warn_once("operator messages document is not a mapping; skipping")
        return [], {"version": 1, "valid": False, "source": "fallback-after-error",
                    "enabled": 0, "total": 0, "applied": False}
    version = raw.get("version", 1)
    if version != 1:
        if strict:
            raise MemoryConfigError("operator messages version must be 1")
        _warn_once("operator messages version is not 1; skipping")
        return [], {"version": 1, "valid": False, "source": "fallback-after-error",
                    "enabled": 0, "total": 0, "applied": False}
    rows = raw.get("messages")
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        if strict:
            raise MemoryConfigError("messages must be a list")
        _warn_once("operator messages list is invalid; skipping")
        return [], {"version": 1, "valid": False, "source": "fallback-after-error",
                    "enabled": 0, "total": 0, "applied": False}
    messages, seen, skipped = [], set(), 0
    for item in rows:
        try:
            parsed = validate_message(item, seen)
        except MemoryConfigError:
            if strict:
                raise
            skipped += 1
            continue
        seen.add(parsed["id"])
        messages.append(parsed)
    if skipped:
        _warn_once("skipped %d invalid operator message(s)" % skipped)
    status = {
        "version": 1,
        "valid": skipped == 0,
        "source": _source_label(path),
        "enabled": sum(1 for msg in messages if msg["enabled"]),
        "total": len(messages),
        "applied": True,
    }
    if status["source"] not in ("shipped-default", "custom", "fallback-after-error"):
        status["source"] = "fallback-after-error"
    return messages, status


def messages_status():
    """Status fragment for /api/status. Never a filesystem path."""
    global _messages, _status
    if _status is None:
        _messages, _status = load_operator_messages(strict=False)
    status = dict(_status or {
        "version": 1, "valid": True, "source": "shipped-default",
        "enabled": 0, "total": 0,
    })
    if status.get("source") not in ("shipped-default", "custom", "fallback-after-error"):
        status["source"] = "fallback-after-error"
    return {
        "version": 1,
        "valid": bool(status.get("valid")),
        "source": status["source"],
        "enabled": int(status.get("enabled") or 0),
        "total": int(status.get("total") or 0),
    }


def memory_status():
    """`/api/status` memory object. Never a filesystem path."""
    try:
        refresh_seconds = int(getattr(config, "CHANNEL_MEMORY_REFRESH", 3600) or 0)
    except (TypeError, ValueError):
        refresh_seconds = 3600
    return {
        "refresh_seconds": refresh_seconds,
        "enabled_kinds": list(enabled_kinds()),
        "channel": SOURCE_CHANNEL,
        "messages": messages_status(),
    }


def fetch_history(c, channel=SOURCE_CHANNEL):
    """Thin SQL: reported starts for one station channel, oldest first."""
    return [dict(row) for row in c.execute(
        "SELECT id, playable_id, played_at FROM play_history "
        "WHERE channel_id=? ORDER BY played_at ASC, id ASC",
        (channel,)).fetchall()]


def fetch_joined_recent(c, channel=SOURCE_CHANNEL, limit=20):
    """Thin SQL: recent history left-joined to current titles/kinds."""
    return [dict(row) for row in c.execute(
        "SELECT h.id AS id, h.playable_id AS playable_id, h.played_at AS played_at, "
        "p.title AS title, p.kind AS kind "
        "FROM play_history h LEFT JOIN playables p ON p.id = h.playable_id "
        "WHERE h.channel_id=? ORDER BY h.played_at DESC, h.id DESC LIMIT ?",
        (channel, int(limit))).fetchall()]


def fetch_registry_live(c):
    """Thin SQL: enabled-and-healthy playable count."""
    row = c.execute(
        "SELECT COUNT(*) AS n FROM playables WHERE enabled=1 AND health='ok'"
    ).fetchone()
    return int(row["n"] if row else 0)


def fetch_last_ident_at(c, channel=SOURCE_CHANNEL):
    """Thin SQL: most recent station_id start still joinable to the pool."""
    row = c.execute(
        "SELECT h.played_at AS played_at FROM play_history h "
        "JOIN playables p ON p.id = h.playable_id "
        "WHERE h.channel_id=? AND p.kind='station_id' "
        "ORDER BY h.played_at DESC, h.id DESC LIMIT 1",
        (channel,)).fetchone()
    return None if row is None else float(row["played_at"])


def _parse_payload(raw):
    if isinstance(raw, dict):
        return dict(raw)
    try:
        parsed = json.loads(raw or "{}")
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _content_key(payload):
    return (
        tuple(payload.get("lines") or []),
        payload.get("channel"),
        tuple(payload.get("history_ids") or []),
        payload.get("window_start"),
        payload.get("window_end"),
        payload.get("valid_until"),
        payload.get("memory_kind"),
        payload.get("threshold"),
        payload.get("message_id"),
    )


def _voice():
    try:
        from bumparr import channel_profile
        return (channel_profile.current() or {}).get("voice") or {}
    except Exception:
        return {}


def _accept_card(kind, payload):
    """Structural + voice checks. Duplicate-of-self is expected on upsert."""
    cleaned, reason = validate_card(kind, payload)
    if cleaned is None:
        print("[channel_memory] rejected %s: %s" % (kind, reason))
        return None
    body = dict(payload)
    body["lines"] = list(cleaned.get("lines") or payload.get("lines") or [])
    skip = pre_insert_check(
        kind, body, voice=_voice(),
        batch_texts=set(), batch_openings=set(),
        existing_texts=set())
    if skip:
        print("[channel_memory] rejected %s: %s" % (kind, skip))
        return None
    return body


def _upsert(c, pid, kind, title, payload, enabled, now):
    """Insert or update one memory card. Clears uri when factual content changes."""
    payload = dict(payload)
    payload.pop("_id", None)
    payload.pop("_eligible", None)
    existing_row = c.execute(
        "SELECT payload, uri FROM playables WHERE id=?", (pid,)).fetchone()
    meta = {"id": pid, "type": "card", "kind": kind, "source": PLAYABLE_SOURCE,
            "tags": "channel-memory,%s" % kind}
    text = " ".join(str(x) for x in (payload.get("lines") or []))
    weight = weight_for(0.7, text)
    if existing_row is None:
        stored = with_presentation(payload, meta)
        if payload.get("roles"):
            stored = merge_creative(stored, {"roles": payload["roles"]})
            stored.pop("roles", None)
        c.execute(
            "INSERT INTO playables (id,type,kind,source,uri,duration,title,payload,tags,"
            "weight,enabled,health,last_played,play_count,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,'ok',0,0,?)",
            (pid, "card", kind, PLAYABLE_SOURCE, None, config.CARD_DEFAULT_DURATION,
             title, json.dumps(stored), "channel-memory,%s" % kind, weight,
             1 if enabled else 0, now))
        return "inserted"
    existing = _parse_payload(existing_row["payload"])
    merged = {**existing, **payload}
    merged.pop("_id", None)
    merged.pop("_eligible", None)
    stored = with_creative(merged, meta)
    if payload.get("roles"):
        stored = merge_creative(stored, {"roles": payload["roles"]})
        stored.pop("roles", None)
    changed = _content_key(existing) != _content_key(stored)
    if changed:
        c.execute(
            "UPDATE playables SET title=?, payload=?, enabled=?, weight=?, kind=?, "
            "uri=NULL WHERE id=?",
            (title, json.dumps(stored), 1 if enabled else 0, weight, kind, pid))
        return "updated"
    c.execute(
        "UPDATE playables SET title=?, payload=?, enabled=?, weight=?, kind=? WHERE id=?",
        (title, json.dumps(stored), 1 if enabled else 0, weight, kind, pid))
    return "unchanged"


def _park_kind(c, kind, keep_ids=()):
    keep = [i for i in keep_ids if i]
    if keep:
        c.execute(
            "UPDATE playables SET enabled=0 WHERE source=? AND kind=? AND enabled!=0 "
            "AND id NOT IN (%s)" % ",".join("?" * len(keep)),
            (PLAYABLE_SOURCE, kind, *keep))
    else:
        c.execute(
            "UPDATE playables SET enabled=0 WHERE source=? AND kind=? AND enabled!=0",
            (PLAYABLE_SOURCE, kind))


def _refresh_statistics(c, history, live, last_ident_at, now):
    payload = statistics_payload(
        history, live, now, SOURCE_CHANNEL, last_ident_at=last_ident_at)
    accepted = _accept_card("channel_statistics", payload)
    if accepted is None:
        return None
    pid = statistics_id(SOURCE_CHANNEL)
    title = accepted["lines"][0][:80]
    _upsert(c, pid, "channel_statistics", title, accepted, True, now)
    return pid


def _refresh_previously_on(c, joined, now):
    payload = previously_on_payload(joined, now, SOURCE_CHANNEL)
    if payload is None:
        _park_kind(c, "previously_on")
        return None
    accepted = _accept_card("previously_on", payload)
    if accepted is None:
        _park_kind(c, "previously_on")
        return None
    pid = payload["_id"]
    accepted.pop("_id", None)
    title = accepted["lines"][0][:80]
    _upsert(c, pid, "previously_on", title, accepted, True, now)
    _park_kind(c, "previously_on", keep_ids=(pid,))
    return pid


def _refresh_achievements(c, history, now):
    first_at = float(history[0]["played_at"]) if history else None
    last_at = float(history[-1]["played_at"]) if history else None
    keep = []
    for payload in achievement_payloads(
            len(history), now, SOURCE_CHANNEL,
            history_ids=(), first_at=first_at, last_at=last_at):
        accepted = _accept_card("viewer_achievement", payload)
        if accepted is None:
            continue
        pid = payload["_id"]
        accepted.pop("_id", None)
        title = accepted["lines"][0][:80]
        _upsert(c, pid, "viewer_achievement", title, accepted, True, now)
        keep.append(pid)
    _park_kind(c, "viewer_achievement", keep_ids=keep)
    return keep


def _refresh_operator_messages(c, now):
    messages, status = load_operator_messages(strict=False)
    global _messages, _status
    _messages, _status = messages, status
    if not status.get("applied", True):
        return None
    keep = []
    for message in messages:
        payload = operator_message_payload(message, now, SOURCE_CHANNEL)
        eligible = payload.pop("_eligible")
        pid = payload.pop("_id")
        accepted = _accept_card("operator_message", payload)
        if accepted is None:
            continue
        title = accepted["lines"][0][:80]
        _upsert(c, pid, "operator_message", title, accepted, eligible, now)
        keep.append(pid)
    _park_kind(c, "operator_message", keep_ids=keep)
    return keep


def refresh(*, now=None, render=False, kinds=None):
    """Upsert memory cards for station:live. SQL stays in this caller.

    `render=True` re-renders unrendered/invalidated cards outside playback.
    Disabled kinds are parked, never deleted. Returns a per-kind result dict.
    """
    now = time.time() if now is None else float(now)
    active = tuple(kinds) if kinds is not None else enabled_kinds()
    results = {}
    with db.conn() as c:
        history = fetch_history(c, SOURCE_CHANNEL)
        joined = fetch_joined_recent(c, SOURCE_CHANNEL)
        live = fetch_registry_live(c)
        last_ident_at = fetch_last_ident_at(c, SOURCE_CHANNEL)
        for kind in ALL_KINDS:
            if kind not in active:
                try:
                    _park_kind(c, kind)
                    results[kind] = "disabled"
                except Exception as exc:
                    print("[channel_memory] %s park error: %s" % (kind, exc))
                    results[kind] = "error"
                continue
            try:
                if kind == "channel_statistics":
                    results[kind] = _refresh_statistics(
                        c, history, live, last_ident_at, now)
                elif kind == "previously_on":
                    results[kind] = _refresh_previously_on(c, joined, now)
                elif kind == "viewer_achievement":
                    results[kind] = _refresh_achievements(c, history, now)
                elif kind == "operator_message":
                    results[kind] = _refresh_operator_messages(c, now)
            except Exception as exc:
                print("[channel_memory] %s refresh error: %s" % (kind, exc))
                results[kind] = "error"
        c.commit()
    if render:
        try:
            from bumparr import render_cards
            render_kinds = [kind for kind in active if results.get(kind) != "error"]
            if render_kinds:
                render_cards.render_all(kinds=render_kinds)
        except Exception as exc:
            print("[channel_memory] render error: %s" % exc)
    return results


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Validate operator messages or refresh channel-memory cards.")
    ap.add_argument("--check", action="store_true",
                    help="strict-validate OPERATOR_MESSAGES or the shipped default")
    ap.add_argument("--refresh", action="store_true",
                    help="upsert memory cards from station:live history (no render)")
    args = ap.parse_args(argv)
    if args.check:
        try:
            load_operator_messages(strict=True)
        except MemoryConfigError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print("ok")
        return 0
    if args.refresh:
        db.init_db()
        refresh(render=False)
        print("ok")
        return 0
    ap.error("pass --check or --refresh")
    return 2


if __name__ == "__main__":
    sys.exit(main())
