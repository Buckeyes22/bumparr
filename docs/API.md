# API reference

## Contents

- [Status and pool inspection](#status--pool-inspection)
- [The output contract](#the-output-contract)
- [Station](#station)
- [Management actions](#management-actions)
- [Stream proxy](#stream-proxy)
- [Media and static](#media-and-static)
- [Dashboard](#dashboard)

Bumparr is a FastAPI service on port `8780`. Everything below is the full
surface; the dashboard (see [Dashboard](#dashboard)) only uses part of it.
Base URL: `http://<host>:8780`. All URLs in responses are absolute — set
`PUBLIC_URL` behind a reverse proxy (see [CONFIG.md](CONFIG.md)).

## Status / pool inspection

### `GET /api/status`

Pool overview.

```json
{"brand": "Bumparr", "total": 412, "playable_now": 350,
 "by_type": {"video": 210, "card": 150, "stream": 20, "image": 32},
 "by_kind": {"ambient": 40, "trivia": 60, ...},
 "profile": {"version": 1, "valid": true, "source": "shipped-default"},
 "music": {"version": 1, "valid": true, "source": "shipped-default",
           "enabled_beds": 0, "compatibility": false}}
```

`playable_now` is the enabled-and-healthy count before dynamic seasonal and
duration filters. The gap to `total` is disabled or dead items.

`profile` is the loaded channel profile's health, not the YAML path.
`source` is only `shipped-default`, `custom`, or `fallback-after-error`.
`valid` is false when runtime fell back to the full shipped default after an
invalid or missing operator file.

`music` is the loaded music-bed manifest's health, never a filesystem path.
`source` uses the same three tokens. `enabled_beds` is the count of enabled
manifest rows. `compatibility` is true only when `ALLOW_UNMANIFESTED_MUSIC=1`.

### `GET /api/bumpers`

Browse the whole pool, newest first. **Management view** — includes disabled
and unhealthy rows.

| Param | Default | Meaning |
|---|---|---|
| `type` | all | `video` \| `card` \| `stream` \| `image` |
| `kind` | all | any kind (`ambient`, `trivia`, `webcam`, `station_id`, …) |
| `enabled` | all | `true` for rows still on air, `false` for parked ones |
| `q` | none | title/kind search (maximum 100 characters) |
| `limit` | 200 | page size (1–1000) |
| `offset` | 0 | page offset (non-negative) |

Omitting `enabled` means *no filter*, not `enabled=false` — the default listing
keeps showing both. `?enabled=false` is how you find what the system parked
without paging the whole pool by eye; `POST /api/pool/enable` is the way back.

Response: `{"count": N, "bumpers": [{id, type, kind, source, duration, title,
tags, enabled, health, media_url, payload, creative, music_credits?}]}`. `payload` is the
parsed JSON card content (lines/answer/number/meaning/…), null-ish for plain
media. `creative` is the resolved vocabulary from `bumparr.creative` (family,
roles, energy, audio, …); it does not replace `payload`. `music_credits` is
additive when a payload snapshot exists (`id`, `title`, `creator`,
`source_page`, `license`, `license_url`, `attribution`) and is omitted
otherwise.

### `GET /api/bumpers/{bumper_id}`

One bumper as JSON: every registry column plus `media_url` and resolved
`creative`. 404 if unknown. `payload` remains the stored JSON (string on this
detail route); `creative` is additive. `music_credits` is additive when the
payload snapshot exists.

| Param | Default | Meaning |
|---|---|---|
| `explain` | `false` | if true, add a `selection` object with `eligible_now`, `reasons`, and `factors` |

`explain` is a boolean query flag (FastAPI's normal boolean parsing). Preview/explain never writes history or counters. Context for median and affinity is the current statically eligible pool (`enabled=1 AND health='ok'`), so the factors match selection. Allowed `reasons` are `disabled`, `unhealthy`, `missing_media`, `base_weight`, `season`, `daypart`, `non_finite_score`, and `eligible`. All applicable hard reasons are returned in that order; `eligible` is used only when none apply.

```json
{
  "selection": {
    "eligible_now": false,
    "reasons": ["disabled"],
    "factors": {
      "base": 1.0,
      "season": 0.0,
      "daypart": 1.0,
      "recency": 1.0,
      "affinity": 1.0,
      "fatigue": 1.0,
      "score": 0.0
    }
  }
}
```

## The output contract

These are the endpoints a channel generator or player pulls from. `/random`
and `/fill` share `selection.scored_candidates` with station playout
([ROTATION.md](ROTATION.md)): a stored `weight <= 0` or computed `score <= 0`
is a hard gate, and no epsilon/floor may revive it. `/fill` composes a
duration-bounded bumper set with optional placement (not a programme
schedule); `/playlist.m3u` is an unsequenced pool listing for a downstream
scheduler.

### `GET /api/bumpers/random`

| Param | Default | Meaning |
|---|---|---|
| `count` | 5 | how many (1–100) |
| `max_duration` | none | cap, 0–86,400 seconds (non-video items only) |
| `types` | all | comma list, e.g. `video,card` |
| `explain` | `false` | if true, add per-item `selection.factors` |

Response: `{"count": N, "bumpers": [{id, type, kind, title, duration, source,
media_url, payload, creative, music_credits?}]}`. Only enabled + healthy items with a finite
computed score strictly greater than zero are candidates. Gated rows are never
returned. Default fields stay the same when `explain` is omitted except for
the additive `creative` object; with `explain=true` each bumper also has
`selection.factors` (reasons may be omitted because returned rows are
eligible). `explain` is a boolean query flag. `creative` never replaces
`payload`.

### `GET /api/bumpers/fill`

The break-composer contract: return an ordered bumper set that fits N seconds.
This is not a programme schedule and does not know what a downstream channel
will air next. Shared scoring runs first (the same season/daypart resolution
as `/random` and the station); then `sequence.compose_break` reuses the
bounded 240-restart duration search and applies placement/family/text/exit
policy — see the `fill` docstring in `bumparr/app.py` for why.

| Param | Default | Meaning |
|---|---|---|
| `seconds` | *required* | the gap to fill (maximum 86,400) |
| `tolerance` | 1.5 | acceptable over/under, seconds (maximum 3,600) |
| `max_items` | 8 | ceiling on set size (1–40) |
| `types` | all | comma list |
| `placement` | `any` | `any` \| `open` \| `inside` \| `close` |
| `explain` | `false` | if true, add per-item `selection.factors` (same as `/random`) |

Response: `{"requested": 47, "total": 46.9, "gap": 0.1, "exact": true,
"count": 6, "bumpers": [...], "composition": {"placement": "close",
"relaxed_rules": ["exit_ident"], "profile_version": 1}}`. Each bumper
includes additive `creative` alongside `payload` and `source`. `bumpers` is composed
order. Preview/explain never writes history. A pool without short denominations will report a wider `gap` rather
than return a bad fit — check `exact`/`gap`, not just `count`. Score `<= 0`
items are excluded before the duration search. Invalid `placement` is a
FastAPI 4xx validation response, not fallback to `any`. Allowed
`relaxed_rules` names are `exit_ident`, `energy_jump`, `same_family`,
`text_run`, and `same_music`, listed in that order. `/fill` still returns
best effort and an explicit gap when no exact fit exists.

## Station

`live` is a bumper showcase; `standby` is branded failover. The station
schedules only its own bumper pool. SQLite is authoritative; the conform
cache is derived. `GET /api/station` is read-only: it does not extend a
timeline or write play history.

- `GET /station/{channel}/index.m3u8` — sliding HLS playlist (`live` showcase, `standby` failover); unknown channels return 404.
- `GET /station/seg/{key}/{number}.ts` — static pre-conformed HLS segment cache.
- `GET /station/channel.m3u` — M3U source listing both channels with XMLTV ids.
- `GET /station/guide.xml` — XMLTV guide for the live and standby channels.
- `GET /api/station` — status, conform progress, handoff URLs, and now/next data (inspection only).
- `POST /api/station/conform?limit=25` — starts a background conform pass (1–1000 items).

`GET /api/station` returns:

```json
{"ffmpeg": true, "conformed": 12, "eligible": 14, "pending": 2,
 "urls": {"channel_m3u": "…/station/channel.m3u", "guide_xml": "…/station/guide.xml",
          "live": "…/station/live/index.m3u8", "standby": "…/station/standby/index.m3u8"},
 "channels": {"live": {"now": {}, "next": {}}, "standby": {"now": {}, "next": {}}}}
```

A playlist returns 503 when nothing has been conformed yet; run the conform action and try again.
Set `PUBLIC_URL` to an address reachable by the consumer, since playlists and
the status handoff URLs are absolute.

### `GET /playlist.m3u`

Unsequenced M3U of every playable bumper (streams, and video/card entries that
have a rendered file), absolute URLs, for a downstream scheduler. This is a
pool listing, not a break playlist and not a programme schedule. Unrendered
cards are absent; weather/local-time renders are refreshed automatically on
their TTLs.

### `GET /healthz`

Liveness probe: `{"ok": true, "service": "bumparr"}`.

## Management actions

> [!CAUTION]
> Bumparr has no authentication. Anyone who can reach this service can launch
> download/render subprocesses and use the destructive endpoints below. Do not
> expose it directly to the public internet.

### `DELETE /api/bumpers/{bumper_id}`

Remove one bumper: registry row **and** file (an orphaned file would be
re-registered by the next asset scan). `?keep_file=true` keeps the media.
Streams only lose their row. Response: `{deleted, kind, title, file_removed,
dir_removed, cleanup_failed}`. A true `cleanup_failed` means the DB row is gone
but a hidden recoverable quarantine file remains for manual cleanup.

### `DELETE /api/pool/kind/{kind}`

Remove a whole category — the usual fix when a search returned junk. Also
removes the now-empty source directory. `?keep_files=true` keeps media.
Response: `{kind, removed, dirs_removed, failed[]}`.

### `POST /api/pool/tidy`

Delete zero-byte files (failed downloads) and empty category directories.
`?dry_run=true` to preview. Response: `{zero_byte_files, empty_dirs,
removed_files[], removed_dirs[], dry_run}`.

### `POST /api/pool/revive`

Re-check items the asset sweep retired: it parks a row whose file it cannot
find (`enabled=0, health='dead'`), and a missing file is sometimes a late mount
rather than a lost one. A local file ffprobe can still read is restored to
`enabled=1, health='ok'`. `on_this_day` cards are
excluded — their `enabled=0` is calendar rotation, not retirement. Live streams
are skipped; use `POST /api/pool/enable` for those. `?dry_run=true` to preview.
Response: `{checked, restored, still_dead, skipped_streams, dry_run}`.

### `POST /api/pool/enable`

Turn one parked item back on: `?bumper_id=<id>`. `enabled` is operator intent —
loaders and sweeps park rows (a cam dropped from `live_cams.yaml`, a file the
asset sweep could not find) but never un-park them, so this is how you say
otherwise. Use it for live streams, which `revive` cannot verify. Health is left
untouched. Response: `{id, enabled, changed}`, or 404 `{error}` if no such id.

An optional fourth key, `warning`, is present only when the row's `enabled` is
not the operator's to hold. Today that is one case: `on_this_day` cards, which
the calendar parks and un-parks by date. Enabling one is allowed — you named the
id, that is the decision — but the dated-card rotation
(`bumparr.jobs.dated_card_loop`, on startup and hourly thereafter) will park it
again on its next pass unless the card belongs to today. The warning says which
of the two it is, decided with the rotation's own date test
(`on_this_day.is_todays_card`), so it cannot promise one thing and the next pass
do another. Absent for every other row; the three keys above never change.

For a cam dropped from `live_cams.yaml`, do it in this order: **re-add the entry
to the YAML, reload or restart so the cam is in the configured set again, and
only then POST enable.** `load_cams` parks every `source='live-cam'` row outside
the configured set on every run, so enabling a cam the file still does not list
lasts exactly until the next restart. Putting the entry back is what stops the
parking; enabling is what undoes the park already recorded, because the loader
never re-enables a cam it does find. Both steps, in that order.

### `POST /api/starter`

Run the shipped starter seeds (the suggested first pulls). Opt-in, spaced out
for the archives. Params: `dry_run`, `only_free` (skip stock-API entries),
`limit` (1–1000). Returns a background job id; poll it as below.

### `POST /api/render/cards`

Render text cards to MP4 so non-browser consumers can play them. Offline and
idempotent; already-rendered cards are skipped. Params: `limit` (render in
batches, 1–1000), `force`. Returns a background job id. Details in
[RENDERING.md](RENDERING.md).

### `POST /api/generate/{kind}`

Generate more cards of a kind (default 20, `?n=`). Routing by kind:

| Kind | Producer |
|---|---|
| `trivia`, `fun_facts`, `number` | grounded sources (Open Trivia DB, Wikipedia, vendored facts) |
| `on_this_day` | Wikipedia on-this-day feed |
| `weather` | Open-Meteo (one card for the home location) |
| `psa`, `corrections`, `achievements`, `coming_up`, `tiny_games` | the local model (starter seeds first; needs `LLM_BASE`) |

Returns a background job id. Its completed result contains `{kind, ok, output}`.
400 for unknown kinds.

### `POST /api/request` + `GET /api/request/{job_id}`

Natural-language "pull this into rotation" — a URL, "more trivia", or a vibe
("5 stoner clips"). Returns **immediately** with a job id; the work runs in
the background because downloads and captures can take minutes.

```text
POST /api/request  {"text": "more space ambient"}
  -> {"job_id": "a3f…", "status": "working", "result": "working on it…"}

GET /api/request/a3f…
  -> {"status": "done", "result": "pulled 3 clip(s) into 'ambient': …"}
```

The same registry handles starter/render/generate/source actions. `status` is
`working` | `done` | `error`. Jobs are in-memory, capped at 100, retain finished
results for at least an hour, and run at most two blocking actions concurrently.

### `POST /api/sources/{action}`

Run a source maintenance pass now (they also run on schedule):

| Action | Does |
|---|---|
| `capture-windows` | re-snapshot the YouTube-backed live cams |
| `fetch-queue` | retry pending public-domain downloads |

Returns a background job id. 400 for other actions.

## Stream proxy

For live streams whose feeds don't send CORS headers, browsers are pointed at
the same-origin proxy instead of the upstream URL:

- `GET /api/stream/{pid}/index.m3u8` — the upstream master playlist with every
  URI rewritten to route back through the proxy.
- `GET /api/stream/{pid}/seg/{token}` — one URI using an HMAC-signed token bound
  to that stream id; nested playlists are rewritten again, segments relay
  byte-for-byte. Cross-origin CDNs must be listed in that cam's `proxy_hosts`.

You rarely call these directly: `media_url` on a stream row already points
here when the cam isn't CORS-direct.

## Media and static

| Path | Serves |
|---|---|
| `/media/bumpers/…` | Bumparr's own produced output (OUTPUT tree) |
| `/media/…` | source assets (ASSET_ROOT) |
| `/web/…` | dashboard assets |
| `/` | the dashboard itself |

## Dashboard

`/` is a single-page dashboard over the API above:

- **Ask bar** — the `POST /api/request` flow with polling; the way to pull in
  URLs, request card kinds, or search by vibe without touching the API.
- **Pool** — `/api/status` counts and type bars; **Browse the pool** —
  `/api/bumpers` with text filter, kind filters, a **parked only** chip
  (`?enabled=false`, combining with the kind and text filters rather than
  replacing them), shuffle preview, per-item delete, and a per-item **enable**
  button that appears only on rows the listing reports as parked (`POST
  /api/pool/enable`, relaying any `warning` to the log). The shuffle preview
  reads `/api/bumpers/random`, which returns only live rows and no `enabled`
  key, so no card there carries the button.
- **Preview** — one item (`GET /api/bumpers/random?count=1&explain=true`) and
  15/30/60/90-second packs (`GET /api/bumpers/fill?seconds=N&explain=true`).
  Cards show creative data, provenance, factors, media, and pack relaxations.
  Enable/delete are reused. Preview is GET-only: it does not call station
  `advance()`, write play history, or mutate `play_count`/`last_played`.
  DOM is created with text/property assignment, never HTML interpolation.
- **Actions** — one click per management endpoint: generate the card kinds,
  recapture live cams / run the fetch queue (`/api/sources/*`), preview or run
  the starter seeds, tidy, and revive.
- **Log** — the tail of the last action's output.

The dashboard has no state of its own; it is a thin client over the endpoints
in this file, so anything the UI can do, curl can do.
