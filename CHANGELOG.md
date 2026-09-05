# Changelog

## Unreleased

**Operator dashboard: station diagnostics, grouped operations, and a real jobs list**
- The Station view now says which of four different things is wrong, in the
  operator's own words and from explicit fields rather than a parsed sentence:
  *"Idle — no playlist client has requested this channel recently."*,
  *"Unavailable — conform at least one eligible item."*, *"Using slate — all
  playable candidates are currently gated."*, and *"Cannot conform — ffmpeg is
  unavailable in the service."* A station that could not be read says
  *"Station status unavailable; last successful update was …"* and keeps the
  last good body on screen rather than blanking it. Each channel shows now and
  next with their times and remaining duration, plus the last playlist request
  and the lookahead the channel reports — reading them never sets them, and a
  build that does not send them says so instead of showing a zero.
- All four handoff URLs — channel M3U, XMLTV guide, and the live and standby
  HLS playlists — are read-only fields with a **Copy** control that uses the
  Clipboard API where the browser grants it, falls back to selecting the field
  where it does not, and says which happened either way, inline and out loud.
  Focusing a URL still selects it.
- A channel can be opened in a video element only where the browser reports
  native HLS (`canPlayType("application/vnd.apple.mpegurl")`), and then only
  behind an explicit **Open preview**, under a note saying that opening it
  makes this page a real playlist client that may advance and report playout.
  Chromium and Firefox, which generally cannot play HLS natively, are offered
  the URL and *Open in external player (VLC, mpv, IINA)* rather than a video
  element that would never play. No remote HLS library is loaded either way.
  The preview is built by the press, is muted with `preload="none"`, never
  autoplays, survives the 20-second refresh without reopening the stream, and
  is detached when it is closed or the view is left.
- A **Conform** panel shows conformed/eligible, pending, ffmpeg and the last
  sweep with its counts and age, says out loud that conforming can be slow, and
  carries **Conform now** — which now disables only itself.
- Operations opens with the unauthenticated-API warning and groups every action
  by what it costs — add material, generate cards, refresh sources, prepare
  output, maintenance — with each group stating what it needs (grounded, the
  local model, network, ffmpeg) before it is run. Every supported card kind is
  offered, both housekeeping passes lead with the endpoint's own dry run, and
  destructive work is linked rather than duplicated: bulk kind deletion stays
  in the Library's danger zone, and `bumparr.prune --apply` and
  `--drop-category` are named as the CLI-only operations they are. Only the
  starter *run* stops to confirm.
- Starting a job no longer freezes the whole panel. Only the duplicate of the
  running action is disabled — the Station's **Conform now** and the Operations
  **Conform station** lock together, and nothing else does — so unrelated
  controls stay usable within the server's own concurrency. A `429` is reported
  as the server declining to start rather than as the work failing, and never
  costs the operator the text they had typed.
- **Recent jobs** is now one list from two registries: the server's
  `GET /api/jobs` merged by job id with the jobs this page started. The
  Overview shows the five newest as triage lines; Operations shows them all,
  each with its created and updated age, the bounded raw result or error in an
  expandable block, and **Retry** only where running it a second time is safe —
  never for the starter, an ingest of arbitrary text, or anything that deletes.
  Every working job is followed at three seconds whoever started it, a lost
  read keeps it *status unknown* and backs off to ten rather than inventing a
  failure, a job the server has forgotten ends as expired instead of as a
  success, and reaching a terminal state refreshes the counts, the station and
  the library. No poll outlives the view that started it.
- Fixed: the failed-job warning on the Overview scanned all twenty registry
  entries and could not be cleared. It is now bounded to the same five rows the
  panel below it shows, so refreshing the list clears it.

**Operator dashboard: a library inspector and reversible curation**
- The Library toolbar is now labelled controls instead of chips: search, type,
  kind (from `status.by_kind`, with counts), state, page size (24/48/100 — the
  UI never asks for more than the documented maximum), a grid/list layout
  switch and **Clear filters**. Every filter change is written back to the hash
  query with `location.replace`, so the address bar is always a deep link to
  what is on screen and filtering costs no history entries. Results say
  **Showing N of TOTAL** using the `total` the API now reports (a build that
  does not report one says so rather than letting the loaded count stand in for
  the matched count), and **Load more** appends the next page.
- Cards no longer hide a delete behind a hover icon, and no longer grow a
  second enable button on some rows. Each card states its pool state in words —
  playable, parked, dead, unrendered — and carries one always-visible
  **Inspect** button. Video previews are muted, `preload="metadata"` and
  controlled; only one preview plays at a time; a live stream is a badge and a
  **Play live stream** button that builds the player only when pressed, under a
  note saying that doing so makes the page a real client of the station.
  Leaving the view pauses and detaches every media element it was showing.
- **Inspect** opens an item inspector — a native `<dialog>` with a fallback
  panel where the browser has no `HTMLDialogElement` — which reads
  `GET /api/bumpers/{id}?explain=true` once on open (a listing of 24 rows never
  carries 24 explanations). It shows the preview and card answer, identity,
  state, creative, the eligibility verdict with its ordered reasons and every
  selection factor, provenance and music credits, creation/play history, and a
  media URL with a **Copy** control that uses the Clipboard API where the
  browser grants it, falls back to selecting the field where it does not, and
  says which happened either way. Anything this build of the server does not send reads
  "Not available in this version." rather than as a blank or a zero.
- The inspector's primary action is the reversible one for the row's state:
  **Disable from rotation**, **Enable** for a parked row (relaying the server's
  `warning`), **Render card** for an unrendered card (a background job that
  appears in Recent jobs), and **Run revive (all retired)** for a dead one —
  named for the pool-wide sweep it actually is, because there is no per-item
  recheck endpoint. A mutation updates only the row it changed and refreshes
  the counts; it never resets the filters, the page offset or the scroll
  position. Whatever the server answers back — the rotation that will undo an
  enable, a file a delete could not finish removing — is rendered inside the
  dialog as well as announced, because the live region sits outside the modal
  and is inert under it.
- Permanent deletion now exists only in the inspector's danger zone and the
  Library's own **Danger zone**. Both confirmations name the item, state the
  file consequence in the endpoint's own terms, offer the `keep_file` /
  `keep_files` the API documents, and put **Cancel** first and focus it; the
  destructive button is never the default, and dismissing the dialog any way at
  all — Cancel or Escape — is a refusal that sends nothing. Deleting a whole
  kind additionally requires typing the kind name exactly first.
- Dialogs focus their heading on open, trap Tab only while modal, and return
  focus to whatever opened them. Because the inspector opens from any surface
  that draws a card, a route change closes it, aborts its read and releases its
  media at the route level rather than in one view's exit — so leaving the
  Composer tears down as thoroughly as leaving the Library. Grid/list layout is
  the one thing the page keeps in `localStorage`, and a browser that refuses
  storage still works.
**API: read-only jobs list and station diagnostics**
- `GET /api/jobs?limit=20` (1–50) is a pure, read-only view of the same
  in-memory job registry `/api/request/{job_id}` polls: `{jobs: [{id,
  request, status, created_at, updated_at, result}], count}`, newest first.
  `request` is clipped to 120 characters (trailing `…` when cut); `result` is
  clipped to 2000 characters as a string, or has its string values (including
  one level of nesting) clipped the same way as a dict, or is stringified and
  clipped for any other type — `null` stays `null` for a job still `working`.
  Clipping happens only in the response; the registry keeps full values, and
  internal fields such as `worker_active` never appear.
- `GET /api/station` adds, per channel, explicit `state` (`active` \| `idle`
  \| `unavailable`) and `reason` (`playing`, `slate`, `no_recent_client`, or
  `nothing_conformed`), plus read-only `last_playlist_request` and
  `lookahead_seconds`; and, at the top level, `last_conform` — null until a
  conform sweep has completed once in this process, then that sweep's `{at,
  conformed, failed, pruned, skipped, ffmpeg}`. All additions are additive;
  `/api/station` remains pure and never extends a timeline or writes play
  history.

**API: status counts, library state filter, reversible disable, single-card render**
- `GET /api/status` adds `parked`, `dead`, and `unrendered` counts, computed
  with the exact same SQL definitions `GET /api/bumpers?state=` uses, so the
  two can never disagree.
- `GET /api/bumpers` adds `total` (rows matching every filter before
  `limit`/`offset`; `count` stays the page size) and an optional `state` filter
  (`all` \| `playable` \| `parked` \| `dead` \| `unrendered`) that composes with
  the existing `type`/`kind`/`enabled`/`q` filters. An invalid `state` is a
  FastAPI 422.
- `POST /api/pool/disable?bumper_id=` is the reversible counterpart to
  `enable`: sets `enabled=0` only, never touching `health`, `uri`, or files.
  Returns `{id, enabled, changed}`, plus a `warning` when the dated-card
  rotation will re-enable an `on_this_day` card that belongs to today on its
  next pass — the one case in the code that actually undoes a disable.
- `POST /api/render/cards` accepts an optional `bumper_id` to render exactly
  one card (404 unknown, 400 non-card, before any job starts) instead of a
  batch pass; `bumparr.render_cards`'s CLI gained a matching `--id` flag.

**Operator dashboard: five views and a triage overview**
- The dashboard is now five hash-routed views — Overview, Library, Composer,
  Station, Operations — instead of one long column of panels. Every capability
  from the old page has exactly one home: the ask bar, the action buttons and
  the output log are Operations; the pool counts are Overview; browse is
  Library; the item/pack preview is Composer; the station panel and **Conform
  now** are Station. An unknown or empty hash is replaced (not pushed) with
  `#/overview`, the skip link's `#main` is still an ordinary in-page jump, and
  deep links, back and forward all work because the hash picks the view and
  page state alone decides what it shows. Below 760px the sidebar becomes a
  horizontally scrolling tab row; below 480px controls go to one column and ids
  and URLs wrap. Nothing hides behind a hover.
- Library filters travel in the hash query
  (`#/library?state=parked&kind=trivia&type=card&q=harbour`) and are read when
  the view is entered, so an overview warning can link straight to the rows it
  counted. `state` and `type` are checked against what `GET /api/bumpers`
  accepts and an unknown value is dropped rather than forwarded; the listing now
  uses the server's own `state` filter (the same SQL `/api/status` counts with)
  instead of `enabled=false`.
- The Overview is a triage view: actionable warnings before healthy detail, each
  derived from an explicit API field — no playable items, unrendered cards, a
  conform backlog, missing ffmpeg, an invalid or fallen-back channel profile or
  music manifest, and a failed job — each linking to the view that can fix it.
  Below them: service, pool counts (total, playable, parked, dead, unrendered,
  kinds), the station summary with compact now cards, configuration
  (profile/music source and validity, channel memory) and the five most recent
  jobs. A count this build of the server does not report is shown as "Not
  available in this version." and never as a zero. Overview reads are
  `GET /api/status` and `GET /api/station` only, so opening it cannot create or
  advance a station timeline.
- The header now carries the service pill, profile validity, the number of jobs
  this page is still waiting on, and the age of the last read; the footer
  carries the version (or "version not reported"), the *unprotected operator
  API* notice and a link to `/docs`. Jobs started from this page are listed on
  the overview with an honest empty state — there is no server-side jobs list
  yet, so it says "No jobs started from this page" rather than implying the
  server has been idle.
- The 20-second refresh now belongs to the two views that show live figures and
  reads only what they show. Leaving a view stops its clock and aborts the reads
  it left in flight, so a cancelled read can no longer leave a panel waiting on
  a request that no longer exists.

**Operator dashboard: truthful states and accessible foundations**
- Every panel (Pool, Station, Preview, Browse) now renders exactly one explicit
  state: loading, populated, useful empty, error with Retry, or last-known
  content marked stale with its update time. A failed read no longer clears
  known-good content or leaves a blank panel looking healthy. Status is shown
  as icon plus word plus colour, never colour alone.
- One `api()` wrapper normalizes every request: it checks the response, parses
  JSON safely, extracts the server's `error`, and throws a bounded single-line
  message with a status. Ordinary reads time out after 15 s; job POSTs opt out,
  because the job id returns immediately and polling owns the long wait.
- A lost status read is never reported as a failed job. Polling keeps
  `status unknown`, backs off to 10 s and keeps asking; only a 404 ends it, and
  no five-minute success is invented. The ask bar and the Actions panel share
  one poller, and both hand their controls back as soon as a read cannot reach
  the server, offering **Check now** and **Stop checking** while checking
  continues in the background — a network outage can no longer leave a form or
  a panel of buttons permanently disabled. A superseded job stops being polled
  and cannot overwrite newer feedback.
- Library search is debounced 250 ms, superseded reads are aborted, and answers
  older than the current filter generation are discarded. The periodic
  20-second overview/station refresh does nothing while the tab is hidden and
  refreshes immediately when it becomes visible again.
- Accessibility: a skip link, `<main>`/`<nav>`/`<header>`/`<footer>` landmarks
  with one `<h1>`, visible labels on the ask and filter inputs, an
  `aria-live="polite"` status region as the primary short-result surface,
  visible `:focus-visible` rings, reduced-motion support, and per-card
  delete/enable controls that are always visible, named, and 44px targets
  instead of hover-only glyphs.
- Client state is one explicit object divided by concern; rendering is safe to
  repeat and containers are cleared with `replaceChildren()`. Styling moved to
  the documented token set (`--bg`/`--surface-*`/`--accent`/`--focus`/spacing)
  with system sans and monospace faces and no remote assets.
- `docs/FRONTEND_PLAN.md` is linked from the docs index, the alignment plan,
  and the API dashboard section.

**Truthful channel memory and local operator messages**
- `bumparr/generators/channel_memory.py` builds `channel_statistics`,
  `previously_on`, `viewer_achievement`, and `operator_message` cards from
  `station:live` `play_history` and a local YAML file. Claims are evidence-
  and freshness-backed (`channel`, `history_ids` or aggregate window,
  `generated_at`, `valid_until`). Language is “this channel has aired,” never
  “you watched.” Preview, status, and simulation never write history or
  memory cards. Playback does not generate them.
- Stable/content-derived ids and idempotent upserts. Expiring aggregates
  update in place, clear `uri` when factual content changes, and re-render
  outside playback. `CHANNEL_MEMORY_REFRESH` (default 3600s, `0` disables the
  loop) isolates kind failures and cancellation like other jobs. Empty
  `CHANNEL_MEMORY_KINDS` parks every memory kind rather than deleting it.
- Operator messages are local YAML (`OPERATOR_MESSAGES`, shipped disabled
  example). Unique bounded ids, 1–3 validated lines, parseable timestamps
  with start before end, allowed roles, no fetch. Config `enabled` plus the
  time window own eligibility; removed/disabled/expired rows are parked.
  No public form, upload, write API, authentication, or user model.
- `/api/status` adds `memory: {refresh_seconds, enabled_kinds, channel,
  messages}` (`messages.source` is never a filesystem path). Dashboard shows
  provenance, freshness, and parked state.

**Music manifest, credits, and offline loudness**
- `bumparr/music.py` plus shipped empty-valid `config_files/music_beds.yaml`.
  Manifest ids, contained regular readable paths, energy/families, and
  explicit enable. Runtime skips invalid/unreadable rows; `python -m
  bumparr.music --check` is strict. `MUSIC_MANIFEST` optional;
  `ALLOW_UNMANIFESTED_MUSIC=1` (default off) is the only compatibility
  switch for directory scan and legacy `payload.music`. Those files are
  operator-owned and uncredited; credits are never fabricated.
- New rows store `creative.music_id` and a `payload.music_credits` snapshot
  (`id`, `title`, `creator`, `source_page`, `license`, `license_url`,
  `attribution`). Missing, disabled, or unreadable beds become explicit
  silence with no partial file. Native sound is preserved. `native`,
  `music`, `designed`, and `silence` stay distinct. Live streams are not
  normalized.
- One offline ffmpeg policy for beds: −16 LUFS, −1.5 dBTP, bounded excerpts
  with short fades, AAC 48 kHz stereo. On-screen attribution only when a
  license requires it. API/preview expose additive `music_credits`.
  `/api/status` adds `music: {version, valid, source, enabled_beds,
  compatibility}` (never a filesystem path).
- Simulation reports music repeats, treatment shares, and large energy
  transitions.

**Operator voice and restrained card templates**
- Model card prompts are built from fixed per-kind schema instructions plus
  the validated channel-profile voice block and the item count. Traits are
  described directly; prompts never request imitation of a network or named
  creator. `_call_model` stays provider-agnostic and job-only.
- Pre-insert checks reject normalized duplicates (batch and existing
  same-kind text), repeated batch opening phrases, configured avoid
  phrases/topics with word boundaries, and existing length/shape defects.
  Voice changes affect only new candidates.
- Finite templates: `minimal_center`, `minimal_corner`, `image_caption`,
  `information_board`, `signal`, plus existing ident builders. Kind/family
  compatibility is in `bumparr.creative`. Strict creation/preview rejects an
  incompatible explicit template; runtime falls back to the documented
  default. New items persist template, `render_seed`, and `brand_mode`.
  Legacy seeds are derived from a stable id hash and persisted only during
  explicit render/refresh.
- Brand modes `reveal`, `static`, and `none`. Existing files stay until an
  explicit rerender. Dashboard previews one item and 15/30/60/90s packs
  (creative, provenance, factors, relaxations, media) via GET only.

**Break and station sequence grammar**
- `bumparr.sequence` composes duration-bounded breaks and station adjacency
  from scored candidates, resolved creative data, and the channel profile.
  Hard gates (score, duration, role, unique ids, `max_items`, zero family
  preference) are never relaxed. Soft rules relax only as
  `exit_ident`, `energy_jump`, `same_family`, `text_run`, `same_music`.
- `GET /api/bumpers/fill` gains `placement=any|open|inside|close` (invalid
  values are FastAPI 4xx, not fallback to `any`) and additive `composition`
  `{placement, relaxed_rules, profile_version}`. Existing `requested` /
  `total` / signed `gap` / `exact` / `count` / `bumpers` are preserved;
  `bumpers` is composed order. `/playlist.m3u` stays an unsequenced pool.
- Station `choose_next` uses the last five timeline entries. In-memory
  `Entry` carries `family`, `text_heavy`, `energy`, `audio`, `template`,
  and `music_id` without a schema migration. Conformed-only playback,
  status purity, last-request staleness, slate, and standby are unchanged.
- `python -m bumparr.simulate` reports family shares, text runs, role
  violations, relaxations, and profile source/version.

**Creative resolver + channel profile**
- Optional `payload.creative` holds family/roles/energy/audio and related
  fields. `bumparr.creative` is the only parser: `resolve_creative` infers a
  complete dict for legacy rows; `merge_creative` preserves unrelated payload
  keys. New writers persist what they know. No schema migration.
- Shipped `bumparr/config_files/channel_profile.yaml` plus
  `CHANNEL_PROFILE` override. Invalid files warn once and use the full
  default. `python -m bumparr.channel_profile --check` is strict.
  `/api/status` adds `profile: {version, valid, source}` where `source` is
  `shipped-default`, `custom`, or `fallback-after-error`.
- List/random/fill/detail responses add resolved `creative` without replacing
  `payload`.

**Runtime selection truth + read-only simulation**
- `/api/bumpers/random`, `/api/bumpers/fill`, and station playout share
  `selection.scored_candidates`: only finite computed scores strictly greater
  than zero are eligible. The previous `/random` epsilon floor that revived
  gated rows is gone; `/fill` applies the same season/daypart/recency/
  affinity/fatigue scoring before its duration search.
- `GET /api/bumpers/random?explain=true` and `GET /api/bumpers/{id}?explain=true`
  add factor data. Inspected rows use the statically eligible pool for
  median/affinity. Preview/explain never writes history.
- `python -m bumparr.simulate` reports a seeded mix (item/kind shares,
  repeats, zero-score picks, seasonal/daypart distribution, inferred audio)
  against in-memory copies only. It does not write the database.
- This is not sequence grammar or creative metadata (those remain later
  phases).

**Design contract** (not completed runtime alignment).
- Lands the product/creative contract: [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md),
  [docs/CREATIVE_REFERENCE.md](docs/CREATIVE_REFERENCE.md),
  [docs/ALIGNMENT_PLAN.md](docs/ALIGNMENT_PLAN.md).
- Reconciles scheduling language: Bumparr is not a long-form programme
  scheduler; `/fill` composes duration-bounded bumper sets; `/playlist.m3u`
  is an unsequenced pool listing; `live` is a bumper showcase; `standby` is
  failover.
- Reclassifies `bumparr/config_files/bumper_catalog.yaml` with truthful
  `state` values (`shipped` / `partial` / `proposed` / `blocked` /
  `deferred`) plus `implementation` or `gap` evidence.
- Runtime alignment (selection, sequence grammar, voice profile, music
  manifest, channel memory, review reel) is **not** completed by this change.

Security + correctness pass (plan: [docs/FIX_PLAN.md](docs/FIX_PLAN.md)).

**Station**
- The pool now runs as two live HLS channels, `live` and `standby`, with a
  channel M3U and an XMLTV guide, so Dispatcharr can carry Bumparr as a
  channel and use standby as branded failover. Items are conformed once
  into splice-safe segments by a background job; nothing encodes at serve
  time.
- The playout is the first writer of play history: `last_played`,
  `play_count` and `play_history` now move, which wakes the recency,
  affinity and fatigue factors.
- Dayparts (`config_files/dayparts.yaml`): time-of-day windows as a
  rotation factor and as the guide's programme blocks.
- New settings: `STATION_*`, `STANDBY_KINDS` (see CONFIG.md).
- Conform cache keys now include the active output profile and still duration;
  branding changes invalidate the slate, and old renditions remain available
  until their replacements successfully land.
- Status polling is side-effect free, reconnect staleness follows the last HLS
  playlist request, and zero-score seasonal/daypart candidates stay off air.
- MPEG-TS station segments are served explicitly as `video/mp2t` on every
  supported Python/OS MIME database.

**Security**
- Stream proxy: per-cam signed tokens, same-origin/CDN allowlist with redirect
  validation, and bounded reads (closes a local-file/SSRF primitive).
- Archive fetch + ingest: metadata filenames are sanitized and contained,
  downloads are capped on actual bytes and landed atomically.
- Media deletes resolve through one contained resolver (escapes delete the row
  only); the container runs as non-root with a `/healthz` healthcheck.
- Dashboard builds server-derived content with DOM APIs rather than HTML strings.

**Correctness**
- Contained deletes preserve symlink entries instead of resolving filesystem
  operations onto their targets; staging and archive temporary names remain
  valid even when source metadata reaches filesystem component limits.
- Generic `get`/`fetch` weather requests remain weather-data cards unless an
  explicit media noun or clip count asks for footage; dashboard actions keep
  polling until the server reports a terminal state.
- `/api/bumpers` honors bounded `limit`/`offset`; `/random` returns up to
  `count` (default 5); M3U keeps commas inside quoted titles; `status`
  accumulates `by_kind` across types.
- Trivia auto-labels bare options and rejects mixed labels; weather refresh
  preserves stats/uri/operator tuning; the number baseline is idempotent
  across restarts; `seasons` is report-only without `--apply`.
- `resolve_cams` was removed (snapshot/direct cams in `live_cams.yaml` are the
  maintained path); dashboard search now covers the full registry server-side.

**Recovery**
- `POST /api/pool/revive` now clears a park it can verify: rows the asset sweep
  retired (`enabled=0, health='dead'`) return to rotation when `ffprobe` can
  still read the file. It previously restored `health` alone, and rotation
  requires both, so a parked row stayed dark permanently.
- `POST /api/pool/enable` un-parks one named item — the way back for a live cam
  parked when its entry left `live_cams.yaml`, which has no local file to
  verify. Restoring one is ordered: re-add to the YAML, reload, then enable,
  because the loader parks what is unconfigured but never re-enables what is.
- `/api/bumpers` accepts `?enabled=`, and the dashboard gains a parked-only
  filter and a per-card enable control, so finding a parked item no longer
  means reading ids out of a JSON page.
- Date-rotated cards are excluded from the revive sweep, and enabling one by
  name warns rather than refuses; a single payload matcher now backs the
  rotation, the generator quota, and that warning, so they cannot disagree.
- `prune --drop-category` names every unregistered file it will delete while
  previewing, and compares paths by real directory and entry name so a
  symlinked media root stops reporting registered files twice.

**Ops**
- Default Compose storage now uses writable Docker-managed volumes, so a clean
  checkout starts under the non-root UID without host-directory ownership work.
- CI runs `compileall`, ResourceWarning-strict tests, targeted Ruff, JavaScript
  syntax/DOM tests, and a clean-checkout Compose build/start/write smoke step;
  compose warns the `:ro` dev mount shadows release pins.
- Assumes a trusted LAN: no auth on the dashboard or the POST/DELETE endpoints.

## v0.1.0 — first public release

First release. A bumper generator for the *arr stack: point it at source media
and it builds and maintains a self-refreshing pool of TV bumpers and
interstitials that any channel generator can consume.

**Output**
- `GET /playlist.m3u` — absolute-URL M3U of every playable bumper.
- `GET /api/bumpers/fill?seconds=N` — a *set* of bumpers summing to a gap,
  solved as subset-sum rather than greedy, so a break doesn't end in dead air.
- `GET /api/bumpers/random`, `/api/status`, and per-bumper lookup.

**Bumper kinds**
- Video from your own media and public-domain archives.
- Live "window" cams — open direct-HLS feeds play genuinely live and ship
  enabled. YouTube-backed snapshot cams are supported but ship disabled; a
  commented template in `live_cams.yaml` shows how to add your own.
- Text cards: grounded trivia and fun-facts, verified numbers, plus surreal
  PSAs, fake corrections, achievements and more.
- Procedural station IDs and technical-difficulties cards.

**Works without a model.** Grounded cards come from real sources, procedural
kinds are code, and every model-generated kind ships a built-in starter set —
so a fresh install with no endpoint still has content in every kind. Point
`LLM_BASE` at any OpenAI-compatible endpoint to generate more, in your own
voice. The model diversifies the pool; it is not required.

**Content integrity.** Factual cards are grounded in real sources rather than
invented, and `card_validation` rejects malformed cards at generation time
(unlabelled options with a bare-letter answer, either/or prompts asserting an
answer, truncated facts, placeholder numbers).

**Notes**
- No YouTube entries ship enabled. Whether to scrape YouTube is the operator's
  call, so Bumparr keeps the capability (`yt-dlp` is installed) but leaves it
  switched off by default.
- With no `PUBLIC_URL` set, emitted URLs are derived from the incoming request.
  Bumparr warns if that derivation is a loopback address, since those URLs
  cannot be reached by any other host, container or player.
- Bundled fonts are SIL OFL. No media assets ship with Bumparr.
