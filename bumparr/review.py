"""Read-only release-review artifacts: a ten-minute plan and standard breaks.

Exports an M3U/plan plus JSON/Markdown sidecars. Reuses existing media URIs;
does not concatenate, re-encode, download, render, probe, or write history.
Distribution metrics stay diagnostic. There is no subjective similarity score.
"""
import argparse
import json
import math
import os
import re
import stat
from pathlib import Path

from bumparr import config, creative, music, paths, simulate

_URI_SCHEME = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.-]*):")
_PLAYABLE_SCHEMES = frozenset({"http", "https"})

STANDARD_BREAKS = simulate.STANDARD_BREAKS
BREAK_TOLERANCE = simulate.BREAK_TOLERANCE
STATION_REVIEW_SECONDS = simulate.STATION_REVIEW_SECONDS
CHECKLIST_DOC = "docs/RELEASE_REVIEW.md"


def _m3u_attr(value):
    s = str(value or "")
    return s.replace('"', "'").replace("\n", " ").replace("\r", " ").strip()


def playable_media_uri(row):
    """Absolute local path or http(s) URL a player can open, else empty.

    Local files must be readable regular files inside ASSET_ROOT/OUTPUT_DIR.
    Traversal, missing files, directories, and non-http schemes are rejected.
    """
    uri = str((row or {}).get("uri") or "").strip()
    if not uri:
        return ""
    match = _URI_SCHEME.match(uri)
    if match:
        if match.group(1).lower() in _PLAYABLE_SCHEMES:
            return uri
        return ""
    path = paths.resolve_media(uri)
    if path is None:
        return ""
    try:
        resolved = Path(path).resolve()
        st = resolved.stat()
    except OSError:
        return ""
    if not stat.S_ISREG(st.st_mode) or not resolved.is_file():
        return ""
    if not os.access(resolved, os.R_OK):
        return ""
    return str(resolved)


def playable_rows(rows):
    """Live-review pool: only rows with verified playable media."""
    out = []
    for row in rows or []:
        media = playable_media_uri(row)
        if not media:
            continue
        item = dict(row)
        item["_media"] = media
        out.append(item)
    return out


def plan_item(row, resolved, *, now, relaxed=None, plan_only=False):
    """One sidecar item: ids, metadata, credits, provenance. No media bytes."""
    payload = simulate.payload_obj(row)
    resolved = resolved or creative.resolve_creative(row)
    item = {
        "id": row.get("id"),
        "type": row.get("type"),
        "kind": row.get("kind"),
        "title": row.get("title"),
        "duration": float(row.get("duration") or 0),
        "uri": row.get("uri") or "",
        "source": row.get("source") or "",
        "creative": {
            "family": resolved.get("family"),
            "roles": list(resolved.get("roles") or []),
            "energy": resolved.get("energy"),
            "audio": resolved.get("audio"),
            "template": resolved.get("template"),
            "brand_mode": resolved.get("brand_mode"),
            "text_heavy": bool(resolved.get("text_heavy")),
            "music_id": resolved.get("music_id"),
        },
        "provenance": simulate.provenance_state(row, resolved, now),
        "relaxed_rules": list(relaxed or []),
    }
    credits = music.credits_from_payload(payload)
    if credits:
        item["music_credits"] = credits
    if not plan_only:
        media = row.get("_media") or playable_media_uri(row)
        if media:
            item["media"] = media
    return item


def render_m3u(items, title, *, plan_only=False):
    """Timed M3U. Live entries use only validated media; fixtures are plan-only."""
    lines = ["#EXTM3U", "#PLAYLIST:%s" % _m3u_attr(title)]
    if plan_only:
        lines.append("#EXT-X-Bumparr-Plan-Only:1")
        lines.append("# Fixture URIs are synthetic; the playable plan is review.json.")
        for item in items:
            duration = item.get("duration") or 0
            name = _m3u_attr(item.get("title") or item.get("id"))
            lines.append("#EXTINF:%.3f,%s" % (float(duration), name))
            lines.append("# bumparr-plan:%s" % _m3u_attr(item.get("id")))
        return "\n".join(lines) + "\n"
    for item in items:
        uri = item.get("media") or ""
        if not uri:
            continue
        duration = item.get("duration") or 0
        name = _m3u_attr(item.get("title") or item.get("id"))
        lines.append("#EXTINF:%.3f,%s" % (float(duration), name))
        lines.append(uri)
    return "\n".join(lines) + "\n"


def _break_sidecar(composed, requested, tolerance, placement, now, plan_only=False):
    items = [plan_item(cand.row, cand.creative, now=now,
                       relaxed=list(composed.relaxed_rules), plan_only=plan_only)
             for cand in composed.candidates]
    role_violations = sum(
        1 for cand in composed.candidates
        if not creative.role_compatible(cand.creative, placement, mode="break")
    )
    gated = sum(
        1 for cand in composed.candidates
        if not math_finite_positive(cand.score)
    )
    return {
        "requested": float(requested),
        "tolerance": float(tolerance),
        "placement": placement,
        "total": round(composed.total, 4),
        "gap": round(composed.gap, 4),
        "abs_error": round(abs(composed.gap), 4),
        "exact": bool(composed.exact),
        "count": len(items),
        "relaxed_rules": list(composed.relaxed_rules),
        "role_violations": role_violations,
        "gated_selections": gated,
        "items": items,
    }


def math_finite_positive(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number) and number > 0


def build_review(rows, *, seed, start, seconds=STATION_REVIEW_SECONDS,
                 tolerance=BREAK_TOLERANCE, pool="live", fixture=None,
                 commit=None, tz=None, tz_name=None):
    """Assemble the station plan, four break packs, and mix diagnostics."""
    plan_only = bool(fixture)
    if not plan_only:
        rows = playable_rows(rows)
    events = simulate.station_events(
        rows, seed=seed, start=start, seconds=seconds, tz=tz)
    mix = simulate.report_from_events(
        events, attempts=len(events), seed=seed, start=start, rows=rows,
        tz=tz, tz_name=tz_name)
    station_items = [
        plan_item(event["row"], event["creative"], now=start,
                  relaxed=event.get("relaxed"), plan_only=plan_only)
        for event in events if event.get("kind") == "pick"
    ]
    packs, _profile, tolerance = simulate.compose_standard_breaks(
        rows, seed=seed, start=start, tolerance=tolerance, tz=tz)
    mix["break_duration_error"] = simulate.summarize_break_error(packs, tolerance)
    breaks = {
        str(requested): _break_sidecar(
            composed, requested, tolerance, "any", start, plan_only=plan_only)
        for requested, composed in packs.items()
    }
    meta = {
        "seed": seed,
        "start": start,
        "station_seconds": float(seconds),
        "tolerance": float(tolerance),
        "pool": pool,
        "fixture": fixture,
        "plan_only": plan_only,
        "timezone": tz_name or mix.get("timezone") or "local",
        "profile": mix.get("profile") or simulate.profile_fingerprint(),
        "checklist": CHECKLIST_DOC,
    }
    if commit:
        meta["commit"] = commit
    station_total = round(sum(item["duration"] for item in station_items), 4)
    return {
        "meta": meta,
        "station": {
            "requested": float(seconds),
            "total": station_total,
            "gap": round(float(seconds) - station_total, 4),
            "count": len(station_items),
            "zero_score_picks": mix.get("zero_score_picks", 0),
            "relaxations": mix.get("relaxations", {}),
            "items": station_items,
        },
        "breaks": breaks,
        "mix": mix,
    }


def render_markdown(review):
    """Human-readable sidecar. Checklist lives in RELEASE_REVIEW.md."""
    meta = review.get("meta") or {}
    station = review.get("station") or {}
    lines = [
        "# Bumparr release-review artifact",
        "",
        "Generated by `python -m bumparr.review`. Reuses media URIs; does not",
        "concatenate or re-encode. There is no automatic subjective score and",
        "no Adult Swim similarity metric. Record a human review in `%s`."
        % CHECKLIST_DOC,
        "",
        "## Record",
        "",
        "- seed: `%s`" % meta.get("seed"),
        "- start: `%s`" % meta.get("start"),
        "- pool: `%s`" % meta.get("pool"),
        "- fixture: `%s`" % (meta.get("fixture") or "live"),
        "- profile version: `%s`" % ((meta.get("profile") or {}).get("version")),
        "- profile hash: `%s`" % ((meta.get("profile") or {}).get("hash")),
        "- profile source: `%s`" % ((meta.get("profile") or {}).get("source")),
        "- commit: `%s`" % (meta.get("commit") or "(record in RELEASE_REVIEW.md)"),
        "- date / reviewer / notes: record in `%s`" % CHECKLIST_DOC,
        "",
        "## Ten-minute station plan",
        "",
        "requested `%s`s, total `%s`s, gap `%s`s, items `%s`, zero-score `%s`"
        % (station.get("requested"), station.get("total"), station.get("gap"),
           station.get("count"), station.get("zero_score_picks")),
        "",
        "relaxations: `%s`" % json.dumps(station.get("relaxations") or {},
                                         sort_keys=True),
        "",
        "| # | id | dur | kind | family | template | brand | audio | credits | provenance | relaxed |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for i, item in enumerate(station.get("items") or [], 1):
        credits = item.get("music_credits") or {}
        credit = credits.get("id") or ""
        creative_obj = item.get("creative") or {}
        lines.append(
            "| %d | `%s` | %s | %s | %s | %s | %s | %s | %s | %s | %s |"
            % (i, item.get("id"), item.get("duration"), item.get("kind"),
               creative_obj.get("family"), creative_obj.get("template"),
               creative_obj.get("brand_mode"), creative_obj.get("audio"),
               credit, item.get("provenance"),
               ",".join(item.get("relaxed_rules") or [])))
    lines.extend(["", "## Standard break packs", ""])
    for seconds in STANDARD_BREAKS:
        pack = (review.get("breaks") or {}).get(str(seconds)) or {}
        lines.append(
            "### %ss (placement `%s`)"
            % (seconds, pack.get("placement", "any")))
        lines.append("")
        lines.append(
            "total `%s`s, gap `%s`s, abs_error `%s`s, exact `%s`, "
            "relaxed `%s`"
            % (pack.get("total"), pack.get("gap"), pack.get("abs_error"),
               pack.get("exact"),
               json.dumps(pack.get("relaxed_rules") or [], sort_keys=True)))
        lines.append("")
        ids = [item.get("id") for item in pack.get("items") or []]
        lines.append("items: `%s`" % json.dumps(ids, sort_keys=False))
        lines.append("")
    mix = review.get("mix") or {}
    lines.extend([
        "## Diagnostic mix (not CI gates)",
        "",
        "```json",
        json.dumps({
            "family_shares": mix.get("family_shares"),
            "template_shares": mix.get("template_shares"),
            "brand_mode_shares": mix.get("brand_mode_shares"),
            "energy_shares": mix.get("energy_shares"),
            "audio": mix.get("audio"),
            "provenance": mix.get("provenance"),
            "branded_unbranded": mix.get("branded_unbranded"),
            "exact_repeats": mix.get("exact_repeats"),
            "family_repeats": mix.get("family_repeats"),
            "template_repeats": mix.get("template_repeats"),
            "music_repeats": mix.get("music_repeats"),
            "max_text_run": mix.get("max_text_run"),
            "text_run_limit": mix.get("text_run_limit"),
            "relaxations": mix.get("relaxations"),
            "break_duration_error": mix.get("break_duration_error"),
        }, sort_keys=True, indent=2),
        "```",
        "",
    ])
    return "\n".join(lines)


def write_artifacts(review, out_dir):
    """Write station M3U, four break M3Us, review.json, and review.md."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    plan_only = bool((review.get("meta") or {}).get("plan_only"))
    station_items = (review.get("station") or {}).get("items") or []
    (out / "station.m3u").write_text(
        render_m3u(station_items, "Bumparr ten-minute station plan",
                   plan_only=plan_only),
        encoding="utf-8")
    for seconds in STANDARD_BREAKS:
        pack = (review.get("breaks") or {}).get(str(seconds)) or {}
        (out / ("break-%s.m3u" % seconds)).write_text(
            render_m3u(pack.get("items") or [],
                       "Bumparr %ss break pack" % seconds,
                       plan_only=plan_only),
            encoding="utf-8")
    (out / "review.json").write_text(
        json.dumps(review, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    (out / "review.md").write_text(render_markdown(review), encoding="utf-8")
    return out


def _load_rows(args):
    if args.fixture:
        doc = simulate.load_alignment_fixture(args.fixture)
        meta = simulate.fixture_meta(doc)
        pool = args.pool
        rows = simulate.fixture_rows(doc, pool)
        seed = meta["seed"] if args.seed is None else args.seed
        start = meta["start"] if args.start is None else args.start
        seconds = meta["station_seconds"] if args.seconds is None else args.seconds
        tolerance = meta["tolerance"] if args.tolerance is None else args.tolerance
        fixture_label = str(Path(args.fixture))
        tz_name = meta["timezone"]
        return (rows, seed, start, seconds, tolerance, pool, fixture_label,
                tz_name, simulate.load_tz(tz_name))
    if args.start is None:
        raise SystemExit("pass --start UNIX when reviewing the live pool")
    try:
        rows = playable_rows(simulate.snapshot_pool())
    except FileNotFoundError:
        raise SystemExit("database does not exist: %s" % config.DB_PATH)
    seed = 7 if args.seed is None else args.seed
    start = args.start
    seconds = STATION_REVIEW_SECONDS if args.seconds is None else args.seconds
    tolerance = BREAK_TOLERANCE if args.tolerance is None else args.tolerance
    return rows, seed, start, seconds, tolerance, "live", None, None, None


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Export a read-only ten-minute plan and 15/30/60/90 packs.")
    ap.add_argument("--seed", type=int, default=None,
                    help="RNG seed (fixture default, else 7)")
    ap.add_argument("--start", type=float, default=None,
                    help="unix seconds for the first pick")
    ap.add_argument("--seconds", type=float, default=None,
                    help="station plan length (default 600)")
    ap.add_argument("--tolerance", type=float, default=None,
                    help="break duration tolerance (default 1.5)")
    ap.add_argument("--fixture", default=None,
                    help="alignment playable JSON instead of the live pool")
    ap.add_argument("--pool", default="capable",
                    choices=("capable", "constrained"),
                    help="named fixture pool (with --fixture)")
    ap.add_argument("--out", default=None,
                    help="directory for M3U/JSON/Markdown artifacts")
    ap.add_argument("--json", action="store_true",
                    help="print review.json to stdout")
    ap.add_argument("--commit", default=None,
                    help="optional git commit recorded in the sidecar")
    args = ap.parse_args(argv)
    (rows, seed, start, seconds, tolerance, pool, fixture,
     tz_name, tz) = _load_rows(args)
    review = build_review(
        rows, seed=seed, start=start, seconds=seconds, tolerance=tolerance,
        pool=pool, fixture=fixture, commit=args.commit,
        tz=tz, tz_name=tz_name)
    if args.out:
        write_artifacts(review, args.out)
    if args.json:
        print(json.dumps(review, sort_keys=True))
    elif not args.out:
        print(render_markdown(review))
    return review


if __name__ == "__main__":
    main()
