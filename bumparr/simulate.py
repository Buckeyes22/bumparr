"""Read-only selection simulation: inspect mix without writing history.

Station playout is the shipped writer of play_history. This module snapshots
the enabled/healthy pool, mutates only in-memory copies of play counts and
timestamps, and reports what a seeded run of station choose_next would
have picked. It never calls station advance, never probes media, and
never writes the database.
"""
import argparse
import datetime
import json
import math
import random
import time

from bumparr import channel_profile, creative, dayparts, db, selection, sequence


def infer_audio(row):
    """Best-effort audio class from existing payload, without creative metadata."""
    payload = row.get("payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload or "{}")
        except Exception:
            payload = {}
    payload = payload or {}
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


def snapshot_pool():
    """Enabled, healthy rows as detached dicts. Does not touch files or history."""
    with db.conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM playables WHERE enabled=1 AND health='ok'").fetchall()]


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
    return {key: {"count": n, "share": round(n / picks, 4)}
            for key, n in sorted(counts.items(), key=lambda kv: kv[0])}


def run(rows, *, picks, seed, start):
    """Simulate `picks` selections against in-memory copies of `rows`."""
    pool = [dict(r) for r in rows]
    rng = random.Random(seed)
    profile = channel_profile.current()
    status = channel_profile.profile_status()
    chosen = []
    recent = []
    zero_score_picks = 0
    now = float(start)
    item_counts, kind_counts, family_counts = {}, {}, {}
    seasonal, daypart_counts, audio_counts = {}, {}, {}
    relaxation_counts = {name: 0 for name in sequence.RELAXATION_ORDER}
    role_violations = 0

    for _ in range(picks):
        season, daypart = selection.factors_at(now)
        scored, _ = selection.scored_candidates(
            pool, season_factors=season, daypart_factors=daypart, now=now)
        candidates = [sequence.Candidate(row, score, creative.resolve_creative(row))
                      for row, score in scored]
        picked, relaxed = sequence.choose_next(
            candidates, profile, recent[-5:], rng, mode="station")
        if picked is None:
            zero_score_picks += 1
            now += 10.0
            continue
        pick = picked.row
        resolved = picked.creative or {}
        chosen.append(pick)
        recent.append(picked)
        item_counts[pick["id"]] = item_counts.get(pick["id"], 0) + 1
        kind = pick.get("kind") or ""
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        family = resolved.get("family") or ""
        family_counts[family] = family_counts.get(family, 0) + 1
        bucket = _season_bucket(kind, season)
        seasonal[bucket] = seasonal.get(bucket, 0) + 1
        name = _daypart_name(now)
        daypart_counts[name] = daypart_counts.get(name, 0) + 1
        audio = resolved.get("audio") or infer_audio(pick)
        audio_counts[audio] = audio_counts.get(audio, 0) + 1
        if not creative.role_compatible(resolved, "any", mode="break"):
            role_violations += 1
        for rule in relaxed:
            if rule in relaxation_counts:
                relaxation_counts[rule] += 1
        pick["last_played"] = now
        pick["play_count"] = (pick.get("play_count") or 0) + 1
        duration = float(pick.get("duration") or 0) or 10.0
        now += duration

    exact_repeats = sum(1 for a, b in zip(chosen, chosen[1:]) if a["id"] == b["id"])
    same_kind_runs = 0
    run_len, prev = 0, object()
    for item in chosen:
        kind = item.get("kind") or ""
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
    for item in recent:
        if (item.creative or {}).get("text_heavy"):
            text_len += 1
        else:
            if text_len > max_text:
                text_runs += 1
            text_len = 0
    if text_len > max_text:
        text_runs += 1

    diag = sequence.sequence_diagnostics(
        [sequence._context_view(item) for item in recent])
    return {
        "picks": picks,
        "seed": seed,
        "start": start,
        "chosen": len(chosen),
        "zero_score_picks": zero_score_picks,
        "exact_repeats": exact_repeats,
        "same_kind_runs": same_kind_runs,
        "item_shares": _shares(item_counts, picks),
        "kind_shares": _shares(kind_counts, picks),
        "family_shares": _shares(family_counts, picks),
        "text_runs": text_runs,
        "role_violations": role_violations,
        "relaxations": dict(relaxation_counts),
        "profile": {"version": status.get("version", 1),
                    "source": status.get("source", "shipped-default")},
        "seasonal": dict(sorted(seasonal.items())),
        "daypart": dict(sorted(daypart_counts.items())),
        "audio": dict(sorted(audio_counts.items())),
        "music_repeats": diag["music_repeats"],
        "energy_jumps": diag["energy_jumps"],
        "treatment_shares": diag["treatment_shares"],
    }


def _positive_int(value):
    n = int(value)
    if n <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return n


def _print_report(report):
    print("picks=%d seed=%s start=%s chosen=%d zero-score=%d exact-repeats=%d "
          "same-kind-runs=%d text-runs=%d role-violations=%d music-repeats=%d "
          "energy-jumps=%d"
          % (report["picks"], report["seed"], report["start"], report["chosen"],
             report["zero_score_picks"], report["exact_repeats"],
             report["same_kind_runs"], report.get("text_runs", 0),
             report.get("role_violations", 0), report.get("music_repeats", 0),
             report.get("energy_jumps", 0)))
    print("kind_shares %s" % report["kind_shares"])
    print("family_shares %s" % report.get("family_shares", {}))
    print("relaxations %s" % report.get("relaxations", {}))
    print("profile %s" % report.get("profile", {}))
    print("seasonal %s" % report["seasonal"])
    print("daypart %s" % report["daypart"])
    print("audio %s" % report["audio"])
    print("treatment_shares %s" % report.get("treatment_shares", {}))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Simulate station selection without writing play history.")
    ap.add_argument("--seed", type=int, default=1,
                    help="RNG seed for reproducible picks")
    ap.add_argument("--picks", type=_positive_int, default=200,
                    help="how many picks to simulate")
    ap.add_argument("--start", type=float, default=None,
                    help="unix seconds for the first pick (default: now)")
    ap.add_argument("--json", action="store_true",
                    help="print the report as JSON")
    args = ap.parse_args(argv)
    start = time.time() if args.start is None else args.start
    db.init_db()
    report = run(snapshot_pool(), picks=args.picks, seed=args.seed, start=start)
    if args.json:
        print(json.dumps(report, sort_keys=True))
    else:
        _print_report(report)
    return report


if __name__ == "__main__":
    main()
