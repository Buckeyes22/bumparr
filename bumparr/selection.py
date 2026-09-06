"""Computed eligibility: one filter so random, fill, and station cannot drift.

rotation.py owns the factors and the numeric score. This module is the shared
gate on top: keep only finite scores strictly greater than zero. Physical
availability (file, conform, type) stays with the caller because those rules
differ. An epsilon that revives a gated row is a bug, not a convenience.
"""
import datetime
import math

from bumparr import dayparts, rotation, seasons


def live_factors():
    """Season and daypart maps for right now, or empty maps if config fails.

    Selection must not crash because a YAML file is missing; an empty map
    means every kind scores 1.0 for that factor, which is the same
    degradation random and station already used.
    """
    return factors_at(None)


def instant(now, tz=None):
    """Aware datetime for a unix timestamp.

    `tz` pins the conversion (fixtures). When omitted, use config TIMEZONE
    or the process local zone. Never treat a naive fromtimestamp() as if it
    already lived in a different zone.
    """
    if now is None:
        return None
    now = float(now)
    zone = tz if tz is not None else dayparts._tz()
    if zone is not None:
        return datetime.datetime.fromtimestamp(now, tz=zone)
    return datetime.datetime.fromtimestamp(now).astimezone()


def factors_at(now=None, tz=None):
    """Season/daypart maps for a unix timestamp (or wall clock when now is None)."""
    aware = instant(now, tz) if now is not None else None
    try:
        if aware is None:
            season = seasons.factors_now()
        else:
            season = seasons.factors_now(aware.date())
    except Exception:
        season = {}
    try:
        if aware is None:
            daypart = dayparts.factors_now()
        else:
            daypart = dayparts.factors_now(aware, tz=tz)
    except Exception:
        daypart = {}
    return season, daypart


def scored_candidates(rows, *, season_factors=None, daypart_factors=None, now=None):
    """Rows whose computed score is finite and strictly greater than zero.

    Calls rotation.weights_for once. Does not decide file or conform
    availability: callers have different physical eligibility.
    """
    weights, ctx = rotation.weights_for(rows, season_factors, now, daypart_factors)
    positive = [(row, score) for row, score in zip(rows, weights)
                if math.isfinite(score) and score > 0]
    return positive, ctx


def _base_of(row):
    base = row.get("base")
    if base is None:
        base = row.get("weight") or 0.0
    return float(base)


def eligibility_reasons(row, ctx, *, has_media, now=None):
    """Hard-gate reasons in contract order; `eligible` only when none apply."""
    reasons = []
    if not row.get("enabled"):
        reasons.append("disabled")
    if (row.get("health") or "ok") != "ok":
        reasons.append("unhealthy")
    if not has_media:
        reasons.append("missing_media")
    if _base_of(row) <= 0:
        reasons.append("base_weight")
    kind = row.get("kind")
    season = float((ctx.get("season") or {}).get(kind, 1.0))
    daypart = float((ctx.get("daypart") or {}).get(kind, 1.0))
    if math.isfinite(season) and season <= 0:
        reasons.append("season")
    if math.isfinite(daypart) and daypart <= 0:
        reasons.append("daypart")
    computed = rotation.score(row, ctx, now)
    if not math.isfinite(computed):
        reasons.append("non_finite_score")
    return reasons or ["eligible"]


def json_factors(factors):
    """JSON-safe copy of rotation.explain() output."""
    out = {}
    for key, value in factors.items():
        if isinstance(value, float) and not math.isfinite(value):
            out[key] = None
        else:
            out[key] = value
    return out


def factor_view(row, ctx, now=None):
    """The `factors` object attached to explain responses."""
    return json_factors(rotation.explain(row, ctx, now))


def explain_row(row, ctx, *, has_media, now=None):
    """The API `selection` object for one inspected row."""
    reasons = eligibility_reasons(row, ctx, has_media=has_media, now=now)
    return {
        "eligible_now": reasons == ["eligible"],
        "reasons": reasons,
        "factors": factor_view(row, ctx, now),
    }
