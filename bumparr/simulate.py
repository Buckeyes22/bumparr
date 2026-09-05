"""Read-only selection simulation: inspect mix without writing history.

Station playout is the shipped writer of play_history. This module snapshots
the enabled/healthy pool, mutates only in-memory copies of play counts and
timestamps, and reports what a seeded run of station choose_next would
have picked. It never calls station advance, never probes media, and
never writes the database. Distribution shares stay diagnostic.
"""
import argparse
import datetime
import hashlib
import json
import math
import random
import time
from pathlib import Path

from bumparr import channel_profile, creative, dayparts, db, selection, sequence

STANDARD_BREAKS = (15, 30, 60, 90)
BREAK_TOLERANCE = 1.5
STATION_REVIEW_SECONDS = 600.0
DEFAULT_FIXTURE = (
    Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "alignment_playables.json"
)
_ZERO_SCORE_GAP = 10.0
_SAFETY_PICKS = 2000


def infer_audio(row):
    """Best-effort audio class from existing payload, without creative metadata."""
    payload = payload_obj(row)
    audio = payload.get("audio")
    if isinstance(audio, str):
        audio = audio.lower()
        if audio.startswith("native"):
            return "native"
        if audio.startswith("bed:") or audio == "music":
            return "music"
        if audio in ("silent", "silence"):
            return "silence"
    if payload.get("music"):
        return "music"
    if row.get("type") in ("card", "image"):
        return "silence"
    return "unknown"


def payload_obj(row):
    """Parsed payload dict; never raises."""
    raw = (row or {}).get("payload")
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except Exception:
            return {}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw or "{}")
        except Exception:
            return {}
        return dict(parsed) if isinstance(parsed, dict) else {}
    return {}


def snapshot_pool():
    """Enabled, healthy rows as detached dicts. Does not touch files or history."""
    with db.conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM playables WHERE enabled=1 AND health='ok'").fetchall()]


def load_alignment_fixture(path=None):
    """Load the fixed capable/constrained playable document."""
    path = Path(path) if path is not None else DEFAULT_FIXTURE
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        raise ValueError("alignment fixture must be a JSON object")
    pools = doc.get("pools")
    if not isinstance(pools, dict) or "capable" not in pools or "constrained" not in pools:
        raise ValueError("alignment fixture needs pools.capable and pools.constrained")
    return doc


def fixture_rows(doc, pool="capable"):
    """Detached playable rows for one named pool."""
    pools = (doc or {}).get("pools") or {}
    spec = pools.get(pool)
    if not isinstance(spec, dict):
        raise ValueError("unknown fixture pool %r" % pool)
    rows = spec.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("fixture pool %r has no rows" % pool)
    return [dict(row) for row in rows]


def fixture_meta(doc):
    """Canonical seed/start/tolerance from the fixture document."""
    seed = int((doc or {}).get("seed") or 7)
    start = float((doc or {}).get("start") or 1_700_000_000.0)
    tolerance = float((doc or {}).get("tolerance") or BREAK_TOLERANCE)
    if not math.isfinite(tolerance) or tolerance < 0:
        tolerance = BREAK_TOLERANCE
    station_seconds = float((doc or {}).get("station_seconds") or STATION_REVIEW_SECONDS)
    if not math.isfinite(station_seconds) or station_seconds <= 0:
        station_seconds = STATION_REVIEW_SECONDS
    return {
        "seed": seed,
        "start": start,
        "tolerance": tolerance,
        "station_seconds": station_seconds,
        "break_seconds": list((doc or {}).get("break_seconds") or STANDARD_BREAKS),
        "gates": dict((doc or {}).get("gates") or {}),
    }


def profile_fingerprint(profile=None, status=None):
    """Version, source, and a stable hash of the operator profile. Never a path."""
    status = status or channel_profile.profile_status()
    profile = profile if isinstance(profile, dict) else channel_profile.current()
    blob = json.dumps(profile, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]
    source = status.get("source", "shipped-default")
    if source not in ("shipped-default", "custom", "fallback-after-error"):
        source = "fallback-after-error"
    try:
        version = int(profile.get("version") or status.get("version") or 1)
    except (TypeError, ValueError):
        version = 1
    return {"version": version, "source": source, "hash": digest}


def _as_unix(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, str) and value.strip():
        token = value.strip()
        try:
            return datetime.datetime.fromisoformat(token.replace("Z", "+00:00")).timestamp()
        except ValueError:
            try:
                number = float(token)
            except ValueError:
                return None
            return number if math.isfinite(number) else None
    return None


def provenance_state(row, resolved, now):
    """ok / missing / stale for one playable. Stale wins when both apply."""
    payload = payload_obj(row)
    missing = False
    stale = False
    if not str((row or {}).get("source") or "").strip():
        missing = True
    music_id = (resolved or {}).get("music_id")
    audio = (resolved or {}).get("audio")
    credits = payload.get("music_credits")
    credits = credits if isinstance(credits, dict) else None
    if audio == "music" or music_id:
        credit_id = str((credits or {}).get("id") or "").strip()
        if not credits or not credit_id:
            missing = True
        elif music_id and credit_id != str(music_id):
            stale = True
        elif not ((credits.get("title") or "").strip()
                  and (credits.get("creator") or "").strip()
                  and (credits.get("license") or "").strip()):
            missing = True
    if (resolved or {}).get("family") == "archive":
        license_name = payload.get("license") or (credits or {}).get("license")
        page = payload.get("source_page") or (credits or {}).get("source_page")
        if not str(license_name or "").strip() or not str(page or "").strip():
            missing = True
    valid_until = payload.get("valid_until")
    if valid_until is not None:
        ts = _as_unix(valid_until)
        try:
            now_ts = float(now)
        except (TypeError, ValueError):
            now_ts = None
        if ts is None or now_ts is None or not math.isfinite(now_ts) or ts < now_ts:
            stale = True
    if stale:
        return "stale"
    if missing:
        return "missing"
    return "ok"


def media_metadata_errors(row, resolved):
    """Objective field problems; empty means the item is structurally valid."""
    errors = []
    if not str((row or {}).get("id") or "").strip():
        errors.append("id")
    if (row or {}).get("type") not in creative.PLAYABLE_TYPES:
        errors.append("type")
    if not str((row or {}).get("kind") or "").strip():
        errors.append("kind")
    try:
        duration = float((row or {}).get("duration"))
    except (TypeError, ValueError):
        duration = float("nan")
    if not math.isfinite(duration) or duration <= 0:
        errors.append("duration")
    if not str((row or {}).get("uri") or "").strip():
        errors.append("uri")
    resolved = resolved or {}
    if resolved.get("family") not in creative.FAMILIES:
        errors.append("family")
    if resolved.get("energy") not in creative.ENERGIES:
        errors.append("energy")
    if resolved.get("audio") not in creative.AUDIOS:
        errors.append("audio")
    if resolved.get("brand_mode") not in creative.BRAND_MODES:
        errors.append("brand_mode")
    if resolved.get("template") not in creative.TEMPLATES:
        errors.append("template")
    return errors


def _season_bucket(kind, season_factors):
    factor = float((season_factors or {}).get(kind, 1.0))
    if not math.isfinite(factor):
        return "unknown"
    if factor <= 0:
        return "off"
    if factor > 1:
        return "boosted"
    if factor < 1:
        return "reduced"
    return "default"


def _daypart_name(now):
    try:
        hit = dayparts.current(datetime.datetime.fromtimestamp(now))
    except Exception:
        return "none"
    return hit[0] if hit else "none"


def _shares(counts, picks):
    denom = picks if picks else 0
    return {key: {"count": n, "share": round(n / denom, 4) if denom else 0.0}
            for key, n in sorted(counts.items(), key=lambda kv: kv[0])}


def station_events(rows, *, seed, start, picks=None, seconds=None):
    """Seeded choose_next loop. Mutates only copies. Never writes history."""
    pool = [dict(r) for r in rows]
    rng = random.Random(seed)
    profile = channel_profile.current()
    recent = []
    events = []
    now = float(start)
    elapsed = 0.0
    attempts = 0
    limit = picks if picks is not None else _SAFETY_PICKS
    target = None if seconds is None else float(seconds)
    while attempts < limit:
        if target is not None and elapsed >= target:
            break
        attempts += 1
        season, daypart = selection.factors_at(now)
        scored, _ = selection.scored_candidates(
            pool, season_factors=season, daypart_factors=daypart, now=now)
        candidates = [sequence.Candidate(row, score, creative.resolve_creative(row))
                      for row, score in scored]
        picked, relaxed = sequence.choose_next(
            candidates, profile, recent[-5:], rng, mode="station")
        if picked is None:
            events.append({
                "kind": "gap", "row": None, "creative": None, "score": 0.0,
                "relaxed": [], "at": now, "duration": _ZERO_SCORE_GAP,
            })
            now += _ZERO_SCORE_GAP
            elapsed += _ZERO_SCORE_GAP
            continue
        pick = picked.row
        resolved = picked.creative or creative.resolve_creative(pick)
        duration = float(pick.get("duration") or 0) or _ZERO_SCORE_GAP
        events.append({
            "kind": "pick", "row": pick, "creative": resolved,
            "score": float(picked.score), "relaxed": list(relaxed or []),
            "at": now, "duration": duration,
        })
        recent.append(picked)
        pick["last_played"] = now
        pick["play_count"] = (pick.get("play_count") or 0) + 1
        now += duration
        elapsed += duration
    return events


def compose_standard_breaks(rows, *, seed, start, tolerance=BREAK_TOLERANCE,
                            placement="any"):
    """Four documented fill durations from the unscored-then-scored start pool."""
    profile = channel_profile.current()
    season, daypart = selection.factors_at(start)
    scored, _ = selection.scored_candidates(
        rows, season_factors=season, daypart_factors=daypart, now=start)
    candidates = [sequence.Candidate(row, score, creative.resolve_creative(row))
                  for row, score in scored]
    packs = {}
    try:
        tolerance = float(tolerance)
    except (TypeError, ValueError):
        tolerance = BREAK_TOLERANCE
    if not math.isfinite(tolerance) or tolerance < 0:
        tolerance = BREAK_TOLERANCE
    for seconds in STANDARD_BREAKS:
        composed = sequence.compose_break(
            candidates, float(seconds), tolerance, 8, placement,
            profile, [], random.Random(seed))
        packs[int(seconds)] = composed
    return packs, profile, tolerance


def summarize_break_error(packs, tolerance=BREAK_TOLERANCE):
    """Diagnostic duration error for already-composed 15/30/60/90 packs."""
    seconds = {}
    for requested, composed in packs.items():
        gap = composed.gap
        seconds[str(int(requested))] = {
            "requested": float(requested),
            "total": round(composed.total, 4),
            "gap": round(gap, 4),
            "abs_error": round(abs(gap), 4),
            "within_tolerance": bool(composed.exact),
            "count": len(composed.candidates),
            "relaxed_rules": list(composed.relaxed_rules),
        }
    return {"tolerance": tolerance, "seconds": seconds}


def break_duration_error(rows, *, seed, start, tolerance=BREAK_TOLERANCE):
    """Diagnostic duration error for 15/30/60/90. Not a subjective score."""
    packs, _profile, tolerance = compose_standard_breaks(
        rows, seed=seed, start=start, tolerance=tolerance)
    return summarize_break_error(packs, tolerance)


def report_from_events(events, *, attempts, seed, start, rows=None):
    """Summarize station events. Shares are diagnostic, not CI gates."""
    profile = channel_profile.current()
    status = channel_profile.profile_status()
    chosen_events = [event for event in events if event.get("kind") == "pick"]
    zero_score_picks = sum(1 for event in events if event.get("kind") == "gap")
    item_counts, kind_counts, family_counts = {}, {}, {}
    template_counts, brand_counts, energy_counts = {}, {}, {}
    seasonal, daypart_counts, audio_counts = {}, {}, {}
    relaxation_counts = {name: 0 for name in sequence.RELAXATION_ORDER}
    role_violations = 0
    gated_selections = 0
    invalid_media_metadata = 0
    provenance_counts = {"ok": 0, "missing": 0, "stale": 0}
    branded = 0
    unbranded = 0
    recent_views = []

    for event in chosen_events:
        pick = event["row"]
        resolved = event.get("creative") or {}
        ident = pick.get("id")
        item_counts[ident] = item_counts.get(ident, 0) + 1
        kind = pick.get("kind") or ""
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        family = resolved.get("family") or ""
        family_counts[family] = family_counts.get(family, 0) + 1
        template = resolved.get("template") or ""
        template_counts[template] = template_counts.get(template, 0) + 1
        brand = resolved.get("brand_mode") or ""
        brand_counts[brand] = brand_counts.get(brand, 0) + 1
        energy = resolved.get("energy") or ""
        energy_counts[energy] = energy_counts.get(energy, 0) + 1
        bucket = _season_bucket(kind, selection.factors_at(event["at"])[0])
        seasonal[bucket] = seasonal.get(bucket, 0) + 1
        name = _daypart_name(event["at"])
        daypart_counts[name] = daypart_counts.get(name, 0) + 1
        audio = resolved.get("audio") or infer_audio(pick)
        audio_counts[audio] = audio_counts.get(audio, 0) + 1
        if not creative.role_compatible(resolved, "any", mode="break"):
            role_violations += 1
        if not math.isfinite(event.get("score") or 0) or event.get("score") <= 0:
            gated_selections += 1
        if media_metadata_errors(pick, resolved):
            invalid_media_metadata += 1
        state = provenance_state(pick, resolved, start)
        provenance_counts[state] = provenance_counts.get(state, 0) + 1
        if brand == "none":
            unbranded += 1
        else:
            branded += 1
        for rule in event.get("relaxed") or []:
            if rule in relaxation_counts:
                relaxation_counts[rule] += 1
        recent_views.append(sequence._context_view(
            sequence.Candidate(pick, event.get("score") or 0.0, resolved)))

    exact_repeats = 0
    family_repeats = 0
    template_repeats = 0
    prev_id = prev_family = prev_template = object()
    for event in chosen_events:
        pick = event["row"]
        resolved = event.get("creative") or {}
        ident = pick.get("id")
        family = resolved.get("family") or ""
        template = resolved.get("template") or ""
        if ident == prev_id:
            exact_repeats += 1
        if family and family == prev_family:
            family_repeats += 1
        if template and template == prev_template:
            template_repeats += 1
        prev_id, prev_family, prev_template = ident, family, template

    same_kind_runs = 0
    run_len, prev = 0, object()
    for event in chosen_events:
        kind = event["row"].get("kind") or ""
        if kind == prev:
            run_len += 1
        else:
            if run_len >= 2:
                same_kind_runs += 1
            run_len, prev = 1, kind
    if run_len >= 2:
        same_kind_runs += 1

    max_text = int((profile.get("sequence") or {}).get("max_text_run") or 2)
    text_runs = 0
    text_len = 0
    observed_max_text = 0
    for event in chosen_events:
        if (event.get("creative") or {}).get("text_heavy"):
            text_len += 1
            if text_len > observed_max_text:
                observed_max_text = text_len
        else:
            if text_len > max_text:
                text_runs += 1
            text_len = 0
    if text_len > max_text:
        text_runs += 1

    diag = sequence.sequence_diagnostics(recent_views)
    chosen_n = len(chosen_events)
    return {
        "picks": attempts,
        "seed": seed,
        "start": start,
        "chosen": chosen_n,
        "zero_score_picks": zero_score_picks,
        "gated_selections": gated_selections,
        "invalid_media_metadata": invalid_media_metadata,
        "exact_repeats": exact_repeats,
        "family_repeats": family_repeats,
        "template_repeats": template_repeats,
        "same_kind_runs": same_kind_runs,
        "item_shares": _shares(item_counts, attempts),
        "kind_shares": _shares(kind_counts, attempts),
        "family_shares": _shares(family_counts, attempts),
        "template_shares": _shares(template_counts, attempts),
        "brand_mode_shares": _shares(brand_counts, attempts),
        "energy_shares": _shares(energy_counts, attempts),
        "text_runs": text_runs,
        "max_text_run": observed_max_text,
        "text_run_limit": max_text,
        "role_violations": role_violations,
        "relaxations": dict(relaxation_counts),
        "profile": profile_fingerprint(profile, status),
        "seasonal": dict(sorted(seasonal.items())),
        "daypart": dict(sorted(daypart_counts.items())),
        "audio": dict(sorted(audio_counts.items())),
        "music_repeats": diag["music_repeats"],
        "energy_jumps": diag["energy_jumps"],
        "treatment_shares": diag["treatment_shares"],
        "provenance": provenance_counts,
        "branded_unbranded": {
            "branded": {"count": branded,
                        "share": round(branded / chosen_n, 4) if chosen_n else 0.0},
            "unbranded": {"count": unbranded,
                          "share": round(unbranded / chosen_n, 4) if chosen_n else 0.0},
        },
    }


def run(rows, *, picks, seed, start):
    """Simulate `picks` selections against in-memory copies of `rows`."""
    events = station_events(rows, seed=seed, start=start, picks=picks)
    report = report_from_events(events, attempts=picks, seed=seed, start=start, rows=rows)
    report["break_duration_error"] = break_duration_error(
        rows, seed=seed, start=start)
    return report


def _positive_int(value):
    n = int(value)
    if n <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return n


def _print_report(report):
    print("picks=%d seed=%s start=%s chosen=%d zero-score=%d exact-repeats=%d "
          "family-repeats=%d template-repeats=%d same-kind-runs=%d "
          "text-runs=%d max-text-run=%d role-violations=%d music-repeats=%d "
          "energy-jumps=%d gated-selections=%d"
          % (report["picks"], report["seed"], report["start"], report["chosen"],
             report["zero_score_picks"], report["exact_repeats"],
             report.get("family_repeats", 0), report.get("template_repeats", 0),
             report["same_kind_runs"], report.get("text_runs", 0),
             report.get("max_text_run", 0),
             report.get("role_violations", 0), report.get("music_repeats", 0),
             report.get("energy_jumps", 0), report.get("gated_selections", 0)))
    print("kind_shares %s" % report["kind_shares"])
    print("family_shares %s" % report.get("family_shares", {}))
    print("template_shares %s" % report.get("template_shares", {}))
    print("brand_mode_shares %s" % report.get("brand_mode_shares", {}))
    print("energy_shares %s" % report.get("energy_shares", {}))
    print("relaxations %s" % report.get("relaxations", {}))
    print("profile %s" % report.get("profile", {}))
    print("seasonal %s" % report["seasonal"])
    print("daypart %s" % report["daypart"])
    print("audio %s" % report["audio"])
    print("treatment_shares %s" % report.get("treatment_shares", {}))
    print("provenance %s" % report.get("provenance", {}))
    print("branded_unbranded %s" % report.get("branded_unbranded", {}))
    print("break_duration_error %s" % report.get("break_duration_error", {}))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Simulate station selection without writing play history.")
    ap.add_argument("--seed", type=int, default=None,
                    help="RNG seed (default 1, or the fixture seed with --fixture)")
    ap.add_argument("--picks", type=_positive_int, default=200,
                    help="how many picks to simulate")
    ap.add_argument("--start", type=float, default=None,
                    help="unix seconds for the first pick (default: now)")
    ap.add_argument("--json", action="store_true",
                    help="print the report as JSON")
    ap.add_argument("--fixture", default=None,
                    help="alignment playable JSON instead of the live pool")
    ap.add_argument("--pool", default="capable",
                    choices=("capable", "constrained"),
                    help="named fixture pool (with --fixture)")
    args = ap.parse_args(argv)
    if args.fixture:
        doc = load_alignment_fixture(args.fixture)
        rows = fixture_rows(doc, args.pool)
        meta = fixture_meta(doc)
        start = meta["start"] if args.start is None else args.start
        seed = meta["seed"] if args.seed is None else args.seed
    else:
        start = time.time() if args.start is None else args.start
        seed = 1 if args.seed is None else args.seed
        db.init_db()
        rows = snapshot_pool()
    report = run(rows, picks=args.picks, seed=seed, start=start)
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        _print_report(report)
    return report


if __name__ == "__main__":
    main()
