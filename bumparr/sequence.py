"""Pure break composition and station adjacency.

Callers supply scored candidates, a profile, bounded recent context, and an
RNG. This module does not query SQLite, load files, read wall time, or mutate
history.
"""
import math
import random
from dataclasses import dataclass, field

from bumparr.creative import resolve_creative, role_compatible

RESTARTS = 240
RELAXATION_ORDER = ("exit_ident", "energy_jump", "same_family", "text_run", "same_music")
_RECENT_BOUND = 5


@dataclass
class Candidate:
    """Row, positive rotation score, and resolved creative data."""
    row: dict
    score: float
    creative: dict

    @property
    def id(self):
        return (self.row or {}).get("id")


@dataclass
class Composition:
    """Ordered break pack plus duration and relaxation diagnostics."""
    candidates: list = field(default_factory=list)
    total: float = 0.0
    gap: float = 0.0
    exact: bool = False
    relaxed_rules: list = field(default_factory=list)


def _as_candidate(item):
    if isinstance(item, Candidate):
        row = item.row if isinstance(item.row, dict) else {}
        creative = item.creative if isinstance(item.creative, dict) else {}
        score = item.score
    elif isinstance(item, (tuple, list)) and item:
        row = item[0] if isinstance(item[0], dict) else {}
        score = item[1] if len(item) > 1 else 0.0
        creative = item[2] if len(item) > 2 and isinstance(item[2], dict) else None
    elif isinstance(item, dict) and isinstance(item.get("row"), dict):
        row = item["row"]
        score = item.get("score", 0.0)
        creative = item.get("creative")
    else:
        return None
    try:
        score = float(score)
    except (TypeError, ValueError):
        return None
    if creative is None:
        creative = resolve_creative(row)
    elif not isinstance(creative, dict):
        creative = resolve_creative(row)
    return Candidate(row, score, dict(creative))


def _duration(row):
    try:
        value = float((row or {}).get("duration"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return value


def _cand_duration(candidate):
    return _duration(candidate.row)


def _finite_number(value, default=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _seq(profile):
    seq = (profile or {}).get("sequence") or {}
    try:
        max_run = int(seq.get("max_text_run", 2))
    except (TypeError, ValueError):
        max_run = 2
    if isinstance(seq.get("max_text_run"), bool):
        max_run = 2
    if max_run < 1:
        max_run = 1
    return {
        "max_text_run": max_run,
        "avoid_same_family": bool(seq.get("avoid_same_family", True)),
        "prefer_exit_ident": bool(seq.get("prefer_exit_ident", True)),
        "avoid_same_music": bool(seq.get("avoid_same_music", True)),
        "avoid_large_energy_jump": bool(seq.get("avoid_large_energy_jump", True)),
    }


def _mix_weight(profile, mode, family):
    mix = (profile or {}).get("mix") or {}
    weights = mix.get(mode)
    if not isinstance(weights, dict):
        weights = mix.get("break") if isinstance(mix.get("break"), dict) else {}
    if family not in weights:
        return 1.0
    weight = _finite_number(weights[family], default=0.0)
    if weight < 0:
        return 0.0
    return weight


def _preference(candidate, profile, mode):
    weight = _mix_weight(profile, mode, (candidate.creative or {}).get("family"))
    score = candidate.score
    if not math.isfinite(score) or score <= 0 or weight <= 0:
        return 0.0
    return score * weight


def _hard_ok(candidate, placement, profile, mode):
    if not math.isfinite(candidate.score) or candidate.score <= 0:
        return False
    if _cand_duration(candidate) is None:
        return False
    family = (candidate.creative or {}).get("family")
    if _mix_weight(profile, mode, family) <= 0:
        return False
    if mode == "break" and not role_compatible(candidate.creative, placement, mode="break"):
        return False
    return True


def _context_view(item):
    if item is None:
        return None
    if isinstance(item, Candidate):
        creative = item.creative or {}
        return {
            "id": item.id,
            "family": creative.get("family"),
            "text_heavy": bool(creative.get("text_heavy")),
            "energy": creative.get("energy"),
            "music_id": creative.get("music_id"),
            "roles": list(creative.get("roles") or []),
        }
    if isinstance(item, dict):
        creative = item.get("creative") if isinstance(item.get("creative"), dict) else None
        if creative is not None:
            return {
                "id": item.get("id") or item.get("item_id"),
                "family": creative.get("family"),
                "text_heavy": bool(creative.get("text_heavy")),
                "energy": creative.get("energy"),
                "music_id": creative.get("music_id"),
                "roles": list(creative.get("roles") or []),
            }
        if "family" in item or "item_id" in item:
            return {
                "id": item.get("id") or item.get("item_id"),
                "family": item.get("family"),
                "text_heavy": bool(item.get("text_heavy")),
                "energy": item.get("energy"),
                "music_id": item.get("music_id"),
                "roles": list(item.get("roles") or []),
            }
    return {
        "id": getattr(item, "item_id", None) or getattr(item, "id", None),
        "family": getattr(item, "family", None),
        "text_heavy": bool(getattr(item, "text_heavy", False)),
        "energy": getattr(item, "energy", None),
        "music_id": getattr(item, "music_id", None),
        "roles": list(getattr(item, "roles", None) or []),
    }


def _recent_views(recent):
    views = []
    for item in list(recent or [])[-_RECENT_BOUND:]:
        view = _context_view(item)
        if view is not None:
            views.append(view)
    return views


def _is_exit(creative):
    roles = set((creative or {}).get("roles") or [])
    return (creative or {}).get("family") == "ident" or bool(roles & {"return", "ident"})


def _pair_violations(prev, cur, seq_flags):
    names = []
    if seq_flags["avoid_large_energy_jump"]:
        if {prev.get("energy"), cur.get("energy")} == {"quiet", "loud"}:
            names.append("energy_jump")
    if seq_flags["avoid_same_family"]:
        family = cur.get("family")
        if family and family == prev.get("family"):
            names.append("same_family")
    if seq_flags["avoid_same_music"]:
        music_id = cur.get("music_id")
        if music_id and music_id == prev.get("music_id"):
            names.append("same_music")
    return names


def _text_run_violations(views, seq_flags, recent_views):
    max_run = seq_flags["max_text_run"]
    run = 0
    for item in recent_views:
        run = run + 1 if item.get("text_heavy") else 0
    count = 0
    for item in views:
        if item.get("text_heavy"):
            run += 1
            if run > max_run:
                count += 1
        else:
            run = 0
    return count


def _exit_violation(views, placement, seq_flags):
    if placement != "close" or not seq_flags["prefer_exit_ident"]:
        return 0
    if not views:
        return 0
    return 0 if _is_exit(views[-1]) else 1


def _violation_total(views, placement, seq_flags, recent_views):
    total = _exit_violation(views, placement, seq_flags)
    total += _text_run_violations(views, seq_flags, recent_views)
    chain = list(recent_views)
    for item in views:
        if chain:
            total += len(_pair_violations(chain[-1], item, seq_flags))
        chain.append(item)
    return total


def _relaxed_rules(views, placement, seq_flags, recent_views):
    counts = {name: 0 for name in RELAXATION_ORDER}
    counts["exit_ident"] = _exit_violation(views, placement, seq_flags)
    counts["text_run"] = _text_run_violations(views, seq_flags, recent_views)
    chain = list(recent_views)
    for item in views:
        if chain:
            for name in _pair_violations(chain[-1], item, seq_flags):
                counts[name] += 1
        chain.append(item)
    return [name for name in RELAXATION_ORDER if counts[name]]


def _append_violations(view, recent_views, seq_flags):
    names = []
    if recent_views:
        names.extend(_pair_violations(recent_views[-1], view, seq_flags))
    if _text_run_violations([view], seq_flags, recent_views):
        names.append("text_run")
    seen = set()
    ordered = []
    for name in RELAXATION_ORDER:
        if name in names and name not in seen:
            seen.add(name)
            ordered.append(name)
    return ordered


def _eligible(candidates, placement, profile, mode, seconds=None, tolerance=0.0):
    out, seen = [], set()
    for item in candidates or []:
        cand = _as_candidate(item)
        if cand is None or cand.id is None or cand.id in seen:
            continue
        if not _hard_ok(cand, placement, profile, mode):
            continue
        duration = _cand_duration(cand)
        if seconds is not None and duration > seconds + tolerance:
            continue
        seen.add(cand.id)
        out.append(cand)
    return out


def _duration_search(pool, seconds, tolerance, max_items, rng):
    candidates = list(pool)
    rng.shuffle(candidates)
    picks, total, used = [], 0.0, set()
    while len(picks) < max_items:
        remaining = seconds - total
        fits = [c for c in candidates
                if c.id not in used and _cand_duration(c) <= remaining + tolerance]
        if not fits:
            break
        fits.sort(key=lambda c: abs(_cand_duration(c) - remaining))
        window = fits[:4]
        chosen = window[rng.randrange(len(window))]
        picks.append(chosen)
        used.add(chosen.id)
        total += _cand_duration(chosen)
        if abs(seconds - total) <= 0.05:
            break
    return picks


def _order_pack(items, placement, profile, recent_views, rng, mode):
    seq_flags = _seq(profile)
    remaining = list(items)
    reserved = None
    if placement == "close" and seq_flags["prefer_exit_ident"]:
        exits = [c for c in remaining if _is_exit(c.creative)]
        if exits:
            ranked = [(-_preference(c, profile, mode), rng.random(), c) for c in exits]
            ranked.sort(key=lambda row: (row[0], row[1]))
            reserved = ranked[0][2]
            remaining = [c for c in remaining if c.id != reserved.id]
    ordered = []
    chain = list(recent_views)
    while remaining:
        scored = []
        for cand in remaining:
            view = _context_view(cand)
            vcount = 0
            if chain:
                vcount += len(_pair_violations(chain[-1], view, seq_flags))
            if _text_run_violations([view], seq_flags, chain):
                vcount += 1
            scored.append((vcount, -_preference(cand, profile, mode), rng.random(), cand))
        scored.sort(key=lambda row: (row[0], row[1], row[2]))
        chosen = scored[0][3]
        remaining = [c for c in remaining if c.id != chosen.id]
        ordered.append(chosen)
        chain.append(_context_view(chosen))
    if reserved is not None:
        ordered.append(reserved)
    return ordered


def _empty(seconds):
    gap = seconds if math.isfinite(seconds) else 0.0
    return Composition([], 0.0, gap, False, [])


def _rng(rng):
    return rng if rng is not None else random.Random(0)


def compose_break(candidates, seconds, tolerance, max_items, placement,
                  profile, recent, rng):
    """Return a duration-bounded, policy-ordered break pack."""
    rng = _rng(rng)
    profile = profile or {}
    try:
        seconds = float(seconds)
    except (TypeError, ValueError):
        seconds = float("nan")
    if not math.isfinite(seconds) or seconds <= 0:
        return _empty(0.0 if not math.isfinite(seconds) else seconds)
    try:
        tolerance = float(tolerance)
    except (TypeError, ValueError):
        tolerance = 0.0
    if not math.isfinite(tolerance) or tolerance < 0:
        tolerance = 0.0
    if isinstance(max_items, bool):
        return _empty(seconds)
    try:
        max_items = int(max_items)
    except (TypeError, ValueError):
        return _empty(seconds)
    if max_items < 1:
        return _empty(seconds)
    if not isinstance(placement, str):
        placement = "any"
    else:
        placement = placement.strip().lower() or "any"
    recent_views = _recent_views(recent)
    eligible = _eligible(candidates, placement, profile, "break", seconds, tolerance)
    if not eligible:
        return _empty(seconds)
    packs = []
    for _ in range(RESTARTS):
        attempt_rng = random.Random(rng.randrange(2 ** 31))
        picked = _duration_search(eligible, seconds, tolerance, max_items, attempt_rng)
        if not picked:
            continue
        packs.append(_order_pack(picked, placement, profile, recent_views,
                                 attempt_rng, "break"))
    if not packs:
        return _empty(seconds)
    seq_flags = _seq(profile)
    keyed = []
    for pack in packs:
        views = [_context_view(c) for c in pack]
        total = sum(_cand_duration(c) for c in pack)
        gap = seconds - total
        abs_gap = abs(gap)
        in_tol = abs_gap <= tolerance
        vcount = _violation_total(views, placement, seq_flags, recent_views)
        pref = sum(_preference(c, profile, "break") for c in pack)
        keyed.append(((not in_tol, abs_gap, vcount, -pref, rng.random()), pack, total, gap, in_tol, views))
    keyed.sort(key=lambda row: row[0])
    _key, pack, total, gap, in_tol, views = keyed[0]
    return Composition(pack, total, gap, bool(in_tol and pack),
                       _relaxed_rules(views, placement, seq_flags, recent_views))


def _weighted_pick(pool, profile, mode, rng):
    weights = [_preference(c, profile, mode) for c in pool]
    if any(w > 0 for w in weights):
        return rng.choices(pool, weights=weights, k=1)[0]
    return pool[rng.randrange(len(pool))]


def choose_next(candidates, profile, recent, rng, mode="station"):
    """Pick one next item; never air gated content when a positive option exists."""
    rng = _rng(rng)
    profile = profile or {}
    recent_views = _recent_views(recent)
    hard = _eligible(candidates, "any", profile, mode)
    if not hard:
        return None, []
    prev_id = recent_views[-1]["id"] if recent_views else None
    if prev_id is not None and any(c.id != prev_id for c in hard):
        hard = [c for c in hard if c.id != prev_id]
    seq_flags = _seq(profile)
    enforced = [name for name in RELAXATION_ORDER
                if name != "exit_ident" or mode == "break"]
    pick = None
    for i in range(len(enforced) + 1):
        still = set(enforced[i:])
        pool = []
        for cand in hard:
            violated = set(_append_violations(_context_view(cand), recent_views, seq_flags))
            if violated & still:
                continue
            pool.append(cand)
        if pool:
            pick = _weighted_pick(pool, profile, mode, rng)
            break
    if pick is None:
        pick = _weighted_pick(hard, profile, mode, rng)
    return pick, _append_violations(_context_view(pick), recent_views, seq_flags)
