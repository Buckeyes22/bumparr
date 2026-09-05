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
 "parked": 40, "dead": 6, "unrendered": 12,
 "by_type": {"video": 210, "card": 150, "stream": 20, "image": 32},
 "by_kind": {"ambient": 40, "trivia": 60, ...},
 "profile": {"version": 1, "valid": true, "source": "shipped-default"},
 "music": {"version": 1, "valid": true, "source": "shipped-default",
           "enabled_beds": 0, "compatibility": false},
 "memory": {"refresh_seconds": 3600,
            "enabled_kinds": ["channel_statistics", "previously_on",
                              "viewer_achievement", "operator_message"],
            "channel": "station:live",
            "messages": {"version": 1, "valid": true,
                         "source": "shipped-default", "enabled": 0, "total": 1}}}
```

`playable_now` is the enabled-and-healthy count before dynamic seasonal and
duration filters. The gap to `total` is disabled or dead items.

`parked` is rows with `enabled=0`. `dead` is rows with `health='dead'`
(regardless of `enabled` — a row can be both). `unrendered` is card rows with
no media file yet (`type='card' AND (uri IS NULL OR uri='')`), regardless of
`enabled`. All three use the exact same definitions as `GET /api/bumpers`'s
`state` filter below, so the two never disagree. There is no package version
to report (Bumparr ships no version string anywhere), so no `version` key is
added here.

`profile` is the loaded channel profile's health, not the YAML path.
`source` is only `shipped-default`, `custom`, or `fallback-after-error`.
`valid` is false when runtime fell back to the full shipped default after an
invalid or missing operator file.

`music` is the loaded music-bed manifest's health, never a filesystem path.
`source` uses the same three tokens. `enabled_beds` is the count of enabled
manifest rows. `compatibility` is true only when `ALLOW_UNMANIFESTED_MUSIC=1`.

`memory` is channel-memory health, never a filesystem path. `channel` is the
only history source (`station:live`). `refresh_seconds` is `0` when the
background loop is disabled. `enabled_kinds` is the configured kind list
(empty means every memory kind is parked). `messages.source` uses the same
three tokens as `profile`/`music`. Status does not generate memory cards or
write `play_history`.

### `GET /api/bumpers`

Browse the whole pool, newest first. **Management view** — includes disabled
and unhealthy rows.

| Param | Default | Meaning |
|---|---|---|
| `type` | all | `video` \| `card` \| `stream` \| `image` |
| `kind` | all | any kind (`ambient`, `trivia`, `webcam`, `station_id`, …) |
| `enabled` | all | `true` for rows still on air, `false` for parked ones |
| `state` | `all` | `all` \| `playable` \| `parked` \| `dead` \| `unrendered` |
| `q` | none | title/kind search (maximum 100 characters) |
| `limit` | 200 | page size (1–1000) |
| `offset` | 0 | page offset (non-negative) |

Omitting `enabled` means *no filter*, not `enabled=false` — the default listing
keeps showing both. `?enabled=false` is how you find what the system parked
without paging the whole pool by eye; `POST /api/pool/enable` is the way back.

`state` narrows by operational health/renderedness and composes with every
filter above (AND, same as `enabled`/`type`/`kind`/`q`): `all` applies no
operational filter; `playable` is `enabled` + `health='ok'` + a resolvable
media URI (a stream's own `uri`, or a rendered file for anything else);
`parked` is `enabled=0` regardless of health; `dead` is `health='dead'`
regardless of `enabled`; `unrendered` is a card with no file yet. An invalid
value is a FastAPI 422 validation response, not a silent fallback to `all`.
`state=playable` additionally requires a media URI, so it can read smaller
than `/api/status`'s `playable_now` by exactly the enabled-and-healthy-but-
unrendered cards — `playable_now` does not check for a uri, `state=playable`
does.

Response: `{"count": N, "total": M, "bumpers": [{id, type, kind, source,
duration, title, tags, enabled, health, media_url, payload, creative,
music_credits?}]}`. `count` is the number of rows on this page; `total` is the
number matching every filter above **before** `limit`/`offset` — use it to
know how many pages exist. `payload` is the
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
 "last_conform": {"at": 1710000000.0, "conformed": 2, "failed": 0, "pruned": 1,
                   "skipped": 0, "ffmpeg": true},
 "urls": {"channel_m3u": "…/station/channel.m3u", "guide_xml": "…/station/guide.xml",
          "live": "…/station/live/index.m3u8", "standby": "…/station/standby/index.m3u8"},
 "channels": {"live": {"now": {}, "next": {}, "state": "active", "reason": "playing",
                        "last_playlist_request": 1710000005.2, "lookahead_seconds": 24},
              "standby": {"now": {}, "next": {}, "state": "idle", "reason": "no_recent_client",
                          "last_playlist_request": null, "lookahead_seconds": 24}}}
```

Each channel adds `state` (`active` \| `idle` \| `unavailable`) and `reason`:

| `state` | `reason` | Meaning |
|---|---|---|
| `active` | `playing` | `now` is a real, conformed item. |
| `active` | `slate` | `now` is the built-in brand slate — playable, but not real content. |
| `idle` | `no_recent_client` | Nothing is current, but the pool has conformed items; no playlist client has asked for this channel recently. |
| `unavailable` | `nothing_conformed` | Nothing has been conformed yet at all — the playlist route would 503. |

`last_playlist_request` (epoch seconds, or `null`) and `lookahead_seconds` come
straight from the channel; reading `/api/station` never sets or advances
either. Top-level `last_conform` is `null` until a conform sweep has completed
at least once in this process, then holds that sweep's stats — `ffmpeg absent`
needs no dedicated key beyond the existing top-level `ffmpeg: false`.

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

### `POST /api/pool/disable`

Turn one row off: `?bumper_id=<id>`. The reversible counterpart to `enable` —
sets `enabled=0` and touches nothing else: not `health`, not `uri`, not the
file, not history. This is "stop offering this," never "this is broken"
(that is `health`, which a sweep or a future failure reporter owns) or "this
is gone" (`DELETE /api/bumpers/{id}`, a different endpoint with its own
file-removal contract). Response: `{id, enabled, changed}` — `changed` is
`true` only if the row was enabled before this call — or 404 `{error}` if no
such id.

The same optional `warning` key as `enable`, but for the opposite direction:
present only when a schedule may put the row back regardless of this call.
Today that is exactly an `on_this_day` card that belongs to today — the
dated-card rotation (`bumparr.jobs.dated_card_loop`) enables every disabled
row matching today's date on its next pass (startup, then hourly), so
disabling one is undone almost immediately unless the operator knows to
expect it. A card for another day gets no warning (the rotation only ever
turns those off, never back on, so disabling one is not undone). A
config-owned live cam also gets no warning: `live_cams.load_cams` never sets
`enabled=1` on a row it finds in the YAML — refreshing a cam's `uri`/weight
never touches `enabled` — so a disabled cam stays disabled until an operator
re-enables it, no matter how many reloads happen. Absent for every other row;
the three keys above never change, and absence is never a promise of
permanence for `on_this_day` or config-owned rows either way.

### `POST /api/starter`

Run the shipped starter seeds (the suggested first pulls). Opt-in, spaced out
for the archives. Params: `dry_run`, `only_free` (skip stock-API entries),
`limit` (1–1000). Returns a background job id; poll it as below.

### `POST /api/render/cards`

Render text cards to MP4 so non-browser consumers can play them. Offline and
idempotent; already-rendered cards are skipped. Params: `limit` (render in
batches, 1–1000), `force`, `bumper_id` (maximum 200 characters). Returns a
background job id. Details in [RENDERING.md](RENDERING.md).

`bumper_id`, if given, renders exactly that one card instead of a batch pass —
validated before the job starts: 404 `{error: "not found"}` for an unknown id,
400 `{error: "not a card"}` if the row is not `type='card'`. The job label is
`render card <id>` (truncated to 80 characters), so it is identifiable in the
job list even while several renders run at once. `force` still applies.
`limit`/`bumper_id` are mutually exclusive in effect: batch behaviour with
`limit` is unchanged when `bumper_id` is absent.

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

### `GET /api/jobs?limit=20`

Read-only list of the same in-memory job registry, newest first, for an
operator overview (`limit`: 1–50, default 20). Pure: it never starts, cancels,
or otherwise changes a job.

```json
{"jobs": [{"id": "a3f1c9d4e7b2", "request": "more space ambient", "status": "done",
           "created_at": 1710000000.1, "updated_at": 1710000004.7,
           "result": "pulled 3 clip(s) into 'ambient': …"}],
 "count": 1}
```

Each entry's `request` (the job label) is truncated to 120 characters with a
trailing `…` when cut; `result` is truncated to 2000 characters if a string,
or — if a dict — kept as a dict with its string values (including one level
of nesting) truncated the same way; any other type is stringified and then
truncated. `null` results (a job still `working`) stay `null`. Truncation
happens only in this response; the registry itself is untouched. Internal
bookkeeping fields (such as `worker_active`) never appear here.

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

`/` is a single-page dashboard over the API above. Its structure, panel states,
accessibility rules, and visual tokens are specified in
[FRONTEND_PLAN.md](FRONTEND_PLAN.md).

Navigation is hash-driven — five views, no server routes and no router library:
`#/overview`, `#/library`, `#/composer`, `#/station`, `#/operations`. An unknown
or empty hash is *replaced* with `#/overview` (replaced, not pushed, so a typo
never becomes a stop on the way back); a plain fragment such as the skip link's
`#main` is left to the browser. Deep links and back/forward work because the
hash decides which view is shown and the page's own state decides what it holds,
so every view can be re-rendered without a reload. Library filters travel in the
hash query — `#/library?state=parked&kind=trivia&type=card&q=harbour` — read on
entry and written back (with `location.replace`, so filtering costs no history
entries) on every change; `state` and `type` are checked against the values
`GET /api/bumpers` accepts and an unknown one is dropped rather than forwarded.
Leaving a view stops its refresh clock, aborts the reads it left in flight,
closes any modal it had open, and pauses and detaches its media.

- **Overview** (`#/overview`) — triage. Reads `GET /api/status` and
  `GET /api/station`, and nothing else, so opening it never creates or advances
  a station timeline. Actionable warnings come first, each derived from an
  explicit field — never from a parsed human string — and each linking to the
  view that can fix it: no playable items (`playable_now == 0`), unrendered
  cards (`unrendered > 0`), a conform backlog (`station.pending > 0`), missing
  ffmpeg (`station.ffmpeg === false`), a channel profile or music manifest that
  is invalid or fell back, and a job started from this page that failed. A
  field this build of the server does not send raises no warning and is shown as
  "Not available in this version." rather than as a zero. Then the healthy
  detail: service (brand, version, last refresh), pool counts (total, playable,
  parked, dead, unrendered, kinds and the type bars), the station summary with
  compact now cards per channel, configuration (profile and music-manifest
  source/validity, plus channel memory) and the five most recent jobs.
- **Library** (`#/library`) — `/api/bumpers` behind a toolbar of labelled
  controls: search, type, kind (built from `status.by_kind`, counts included),
  state, page size (24/48/100 — the UI never asks for more than 100),
  grid/list layout, and **Clear filters**. Every filter composes on the server
  and travels in the hash query above, written back with `location.replace` on
  each change so the address bar is always a deep link to what is on screen.
  Results report **Showing N of TOTAL** from `total`, and **Load more** appends
  the next page. Each card shows a preview, kind, title, duration or **LIVE**,
  its pool state in words (playable / parked / dead / unrendered), the creative
  line when the server sends one, and an always-visible **Inspect** button —
  the card's only action control. Video is `preload="metadata"`, muted and
  controlled; only one preview plays at a time; a live stream is a badge and a
  **Play live stream** button that builds the player only when pressed, under a
  note that doing so makes the page a real client of the station. Grid/list
  layout is the one thing kept in `localStorage`.
- **Item inspector** — an always-available **Inspect** on every card opens a
  modal (native `<dialog>`, with a `role="dialog"` fallback panel where
  `HTMLDialogElement` is undefined) and reads
  `GET /api/bumpers/{id}?explain=true` once, on open — the listing never
  carries `selection`, `uri` or the history columns. It shows the media/text
  preview and card answer, identity (id, title, type, kind, source, duration,
  tags), state (enabled, health, rendered, base weight, failures), creative
  (family, roles, energy, audio, text-heavy, template, brand mode), selection
  (eligible now, the ordered `reasons` with a plain reading of each, and every
  factor including `base` and `score`), provenance (registered and payload
  source, background attribution, music credits), history (created, last
  played, play count) and the media URL as a read-only field with a **Copy**
  control — the Clipboard API where the browser grants it, a selection to copy
  by hand where it does not, and a visible sentence either way, since a silent
  Copy button cannot be told from a broken one. The primary action is the
  reversible one for the state: **Disable from rotation**
  (`POST /api/pool/disable`), **Enable** (`POST /api/pool/enable`) for a parked
  row, **Render card** (`POST /api/render/cards?bumper_id=`, a background job
  that appears in Recent jobs) for an unrendered card, and — because there is
  no per-item recheck endpoint — **Run revive (all retired)**
  (`POST /api/pool/revive`) for a dead one, labelled as the pool-wide sweep it
  is. A mutation updates only the row it changed and refreshes the counts: it
  never resets filters, page offset or scroll, and any `warning` the server
  answers with is rendered inside the dialog as well as announced. Focus goes to
  the heading on open and back to the Inspect button on close; Escape closes it;
  Tab is trapped while it is modal. The inspector is opened from any surface
  that draws a card, so a route change — from the Composer as much as the
  Library — closes it and aborts its read.
- **Deletion** — permanent deletion exists only in the inspector's danger zone
  and in the Library's own **Danger zone**; no card carries a delete control.
  Both confirmations name the item, state the file consequence in the
  endpoint's terms, offer the `keep_file` / `keep_files` the endpoint documents,
  and put **Cancel** first and focus it; the destructive button is never the
  default, and dismissing the dialog any way at all — Cancel or Escape —
  resolves as a refusal and sends nothing. Bulk kind deletion
  (`DELETE /api/pool/kind/{kind}`) additionally requires typing the kind name
  exactly before its confirm button works. A `cleanup_failed` response keeps
  the inspector open carrying that news, because it is the only surface that
  said so.
- **Composer** (`#/composer`) — review a break as an editorial unit. Labelled
  controls (15/30/60/90-second presets, a custom duration `0 < s <= 86400`,
  tolerance `0..3600` defaulting to 1.5, maximum items `1..40` defaulting to 8,
  placement any/open/inside/close, and optional video/card/image/stream
  checkboxes — ticking none asks for every type) build one request:
  `GET /api/bumpers/fill?seconds&tolerance&max_items&placement&types&explain=true`.
  Anything out of the range the endpoint documents disables **Compose break**
  and is named in words, so an invalid request is never sent. Composition is
  never reproduced in the browser: the answer is rendered in the server's order,
  as a horizontal timeline on desktop and an ordered stack below 760px, each
  item carrying its order number, title, kind, family, duration, audio, role,
  brand mode and an **Inspect** button. One summary line reads
  `Requested 30.0s | Composed 29.4s | Gap +0.6s | Within tolerance`, where
  `gap = requested - total` (positive underfilled, negative overfilled) and
  "within tolerance" is the server's `exact`, never a comparison with zero.
  Every token in `composition.relaxed_rules` is spelled out as a sentence in an
  Attention panel rather than a tooltip. **Play sequence / Previous / Next /
  Stop** preview the break locally: one medium at a time, advancing on the
  medium's `ended` and on the declared duration for a payload-only card, with
  the item index and elapsed/remaining shown; a live stream keeps its own Play
  button so the sequence never opens one. Playback stops and resets on a new
  composition and on leaving the view. After a disable, enable, render or delete
  through the inspector the break is marked **Stale — recompose to reflect
  changes** and Play is disabled: no item is ever substituted client-side. The
  whole view is GET-only — it does not call station `advance()`, write play
  history, or mutate `play_count`/`last_played`.
- **Station** (`#/station`) — `/api/station`: now/next per channel, conform
  progress, the handoff URLs, and **Conform now**
  (`POST /api/station/conform`).
- **Operations** (`#/operations`) — the **ask bar** (`POST /api/request` with
  polling; the way to pull in URLs, request card kinds, or search by vibe
  without touching the API), one click per management endpoint (generate the
  card kinds, recapture live cams / run the fetch queue via `/api/sources/*`,
  preview or run the starter seeds, tidy, revive), and the **action output**
  log.
- **Shell** — the header carries the service status pill, compact profile
  validity, the number of jobs this page is still waiting on, and how old the
  last read is; the footer carries the version (or "version not reported" — the
  server ships no version string), the *unprotected operator API* notice and a
  link to `/docs`.
- **States** — short results are announced in an `aria-live` region; every
  region renders one explicit state: loading, populated, useful empty, error
  with Retry, or last-known content marked stale with its update time. A failed
  read never clears known-good content. Overview and Station refresh every 20 s
  while the tab is visible, and at once when it becomes visible again.

Jobs listed on the overview are only the ones this page started; there is no
server-side jobs list yet, and the empty state says so rather than implying the
server has been idle.

The dashboard persists nothing of its own — no accounts, no stored responses —
and is a thin client over the endpoints in this file, so anything the UI can do,
curl can do.
