# Operator frontend design enhancement plan

**Status:** implemented frontend baseline (F0–F6), with Generation integrated
in the combined checkout.

**Audit base:** `c38d140` plus product documents dated 2026-09-05. The phased
sections below preserve the pre-implementation audit and acceptance history;
descriptions of the old single-page surface are historical.

**Primary surface:** the existing web dashboard at `/`.

**Explicit non-goal:** a terminal UI or frontend-framework rewrite.

### Post-review job lifecycle closeout (2026-09-05)

The frontend branch covered late POST responses after navigation,
foreground-to-background job handoff, terminal ingest result updates, unique
merged running-job counts, stale registry snapshots, and watcher ownership on
re-entry. `Stop checking` is view-scoped; `Check now` resumes it, and leaving
and re-entering Operations starts a fresh check without cancelling server work.

Historical evidence was 311 Node tests and 605 Python tests on that standalone
branch. Those counts are not combined-branch totals. Chromium was checked;
Firefox was not run. Paid-provider, production-ingest, and deployment
acceptance remain outstanding.

The combined branch was subsequently validated with 729 Python tests and
326 Node tests (including all prior console and generation tests), plus
lint/compile/syntax checks, a real-API Chromium integration check, and a
network-disabled non-root container smoke. The readable six-view static
bundle is 216,599 bytes, below the unchanged 262,144-byte cap. See
[PR_SUMMARY.md](PR_SUMMARY.md) for the scope and remaining external evidence.

## Purpose

Build the existing dashboard into a focused operator console. It answers six
questions quickly:

1. Is the service, pool, and station healthy?
2. What material do I have, and should it remain on air?
3. What will a real break or station sequence feel like?
4. What background work is running or failed?
5. Which creative/profile/provenance rules produced this result?
6. Which paid generation jobs and candidates need my attention?

The frontend is not a viewer-facing channel player, marketing site, public
submission portal, or replacement for YAML configuration. It is an operator
tool over the existing API.

Read [PRODUCT_VISION.md](PRODUCT_VISION.md),
[ALIGNMENT_PLAN.md](ALIGNMENT_PLAN.md),
[GENERATION_PLAN.md](GENERATION_PLAN.md), [API.md](API.md), and
[STATION.md](STATION.md) before implementation. The alignment plan owns the
underlying creative metadata, selection, sequence, profile, and music
contracts. This plan owns how operators see and use them.

## Recommendation

Enhance the browser dashboard and keep the CLI for automation and recovery. Do
not build a TUI.

Bumparr's decisive operator tasks are visual and auditory: previewing type,
motion, sound, pacing, adjacent bumpers, and complete break packs. A TUI cannot
perform those tasks well and would duplicate API/CLI controls. The current
dependency-free HTML/CSS/JavaScript implementation suits the project's size
and deployment model. Improve it without React, a build pipeline, or another
service.

## Current frontend audit

### Pre-implementation audit (historical)

The dashboard is served by FastAPI from `bumparr/web/`:

| File | Current role |
|---|---|
| `bumparr/web/index.html` | One-page shell with ingest, pool, station, actions, log, and catalog. |
| `bumparr/web/app.js` | API calls, DOM rendering, filters, job polling, actions, and item controls. |
| `bumparr/web/style.css` | Dark two-column layout, cards, chips, buttons, and mobile collapse. |
| `bumparr/web/app.test.js` | Dependency-free Node tests with a small fake DOM, hostile-string safety, and job polling. |

Current operator capabilities:

- view total/playable counts and type distribution;
- browse by kind, search titles, and page through the pool;
- preview rendered video and card text;
- shuffle eligible items;
- find parked rows and enable them;
- delete an item or an entire kind;
- submit natural-language ingest requests;
- run card generation, source refresh, starter, tidy, and revive actions;
- see conform progress, now/next station state, and handoff URLs;
- start a conform job and poll action jobs to terminal state.

### Strengths to preserve

- No frontend build or package-manager dependency.
- Same-origin API and static assets.
- API strings use `textContent` or element properties rather than HTML.
- Destructive category deletion has explicit confirmation.
- Background actions return immediately and are polled.
- The interface works on a narrow screen.
- The aesthetic is restrained, dark, and appropriate for an operator console.

### Problems to solve

| Area | Current problem | Consequence |
|---|---|---|
| Information architecture | Everything is on one scrolling page. | Health, curation, creation, and destructive work compete for attention. |
| Item inspection | Cards show basic metadata and hide actions on hover. | Operators cannot judge eligibility, provenance, creative data, or licensing; touch/keyboard users may miss delete. |
| Editorial control | Enabled items can be deleted but not reversibly disabled in the UI. | The easiest rejection path is unnecessarily destructive. |
| Break composition | Shuffle previews isolated items; no pack preview exists. | The operator cannot evaluate Bumparr's central experiential promise. |
| Station operations | Now/next and URLs exist, but failures are not explained. | Idle, gated, broken, and unconformed states are hard to distinguish. |
| Jobs | One transient text log represents all work. | Multiple jobs, terminal state, and context are unclear. |
| Loading/errors | Most fetch failures leave old or empty UI. | Stale state can look healthy and actions can feel ignored. |
| Accessibility | Hover-only controls and incomplete labels/live/focus behavior. | Keyboard, touch, and assistive operation is incomplete. |
| Responsive behavior | Columns collapse, but dense controls/URLs remain awkward. | Phone-based maintenance is difficult. |
| Configuration | Effective profile/manifest validity is invisible. | Operators cannot tell whether custom or fallback policy is active. |
| Security expectations | The app has no authentication. | A polished UI could falsely imply public exposure is safe. |

## Product and security boundaries

### The operator is the audience

Optimize for one trusted operator or a small trusted household/team managing a
self-hosted service. Use precise operational language. Do not add engagement
patterns, onboarding tours, social features, or viewer accounts.

### No authentication in this plan

The service has no authentication, and its API includes destructive and
resource-intensive actions. This plan does not implement auth. Instead:

- retain the warning against public exposure;
- show a compact “unprotected operator API” notice in Operations;
- never imply hiding a button is authorization;
- keep server safety checks independent of the UI;
- add no public uploads, arbitrary path inputs, or command controls.

If auth becomes required, design it as a separate backend security project for
every route—not a login-shaped frontend patch.

### Configuration remains file-owned

Show effective profile/music-manifest status, selected values, and validation
errors. Do not write YAML or environment variables from the browser. Browser
editing without auth, locking, provenance, and rollback is outside scope.

## Operator workflows

### A — morning health check

1. Open Overview.
2. See service reachability, playable/parked/dead counts, profile validity,
   conform progress, and live/standby state.
3. Follow a visible problem to Library, Station, or Operations.
4. Start a bounded correction and watch that specific job.

Success: health is understandable in under ten seconds; a problem never
appears as an unexplained zero or blank panel.

### B — curate the pool

1. Open Library with persistent filter/search state.
2. Filter by type, kind, and playable/parked/dead state; inspect an item.
3. Play media or view card content and metadata.
4. Understand why it is eligible/gated and where it came from.
5. Disable reversibly, re-enable, or deliberately delete.

Success: disable is the primary rejection action; deletion is secondary and
states its file consequences.

### C — review a break

1. Open Composer.
2. Choose 15/30/60/90 seconds or a bounded custom duration.
3. Choose placement, tolerance, maximum items, and allowed types.
4. Generate through `/api/bumpers/fill`.
5. Play in order and inspect running time, gap, and rule relaxations.
6. Inspect/disable a weak item and regenerate.

Success: a sequence is judged as an editorial unit, not as thumbnails.

### D — operate the station

1. Open Station.
2. See current/next, last playlist request, activity, and conform counts.
3. Copy HLS/M3U/XMLTV URLs with explicit feedback.
4. Start conform and follow its job without blocking unrelated controls.
5. Open live/standby in a native video element only on request when the browser
   reports native HLS support; otherwise copy/open the URL in an external player.

Success: “no client,” “nothing eligible,” “not conformed,” and “ffmpeg absent”
are distinct.

### E — generate and review original material

This workflow exists only when [GENERATION_PLAN.md](GENERATION_PLAN.md) is
implemented and configured.

1. Open Generation and choose an operator-allowed model alias.
2. Review the real provider/model, capabilities, privacy/retention disclosure,
   remaining budgets, and exact submitted brief.
3. Submit one deliberate job and follow its durable state across reloads.
4. Preview each disabled output in its native modality.
5. Approve, reject, regenerate, or deliberately delete it.

Success: paid work is never hidden in the generic ask bar; no generated output
can air before explicit review; provider/model/reference/cost provenance remains
visible.

### F — add and maintain ordinary material

1. Open Operations.
2. Submit ingest or choose card/source/maintenance actions.
3. Confirm only meaningful cost or destructive consequences.
4. See every job's type, age, state, and bounded result/error.
5. Refresh affected pool/station panels on completion.

Success: long work stays visible to terminal state; one job does not block
read-only navigation.

## Information architecture

Use hash-driven views so navigation needs no server routes or router library:

| Hash/view | Purpose | Content |
|---|---|---|
| `#/overview` | Triage | Health, pool, station, jobs, actionable warnings |
| `#/library` | Curate | Filters, results, inspector, reversible state actions |
| `#/composer` | Review sequences | Break inputs, ordered timeline, playback, diagnostics |
| `#/station` | Operate HLS | Channels, previews, conform, handoff URLs, profile summary |
| `#/generation` | Generate/review | Allowed models, paid-job queue, candidate review and approval |
| `#/operations` | Create/maintain | Ingest, card/source refresh, starter, tidy/revive, jobs |

Unknown/empty hashes route to `#/overview`. Use anchors/buttons with
`aria-current="page"` and no full reload.

Desktop structure:

```text
+-----------------------------------------------------------------------+
| BUMPARR   service status                         profile | jobs | time |
+-------------+---------------------------------------------------------+
| Overview    | view title                         contextual action(s)  |
| Library     +---------------------------------------------------------+
| Composer    |                                                         |
| Station     |                    active view                          |
| Generation  |                                                         |
| Operations  |                                                         |
|             |                                                         |
+-------------+---------------------------------------------------------+
| version / unprotected API notice / documentation                      |
+-----------------------------------------------------------------------+
```

Below 760px, replace the sidebar with a horizontally scrollable tab row under
the header. Never hide workflows behind hover. Below 480px, use one-column
controls, wrap IDs/URLs, and make the inspector full-screen.

## Visual direction and tokens

Aim for a quiet broadcast control surface: utilitarian, legible, slightly
peculiar, and subordinate to reviewed media. Do not reproduce Adult Swim's
cards, typography, logo, or on-air composition.

Use tokens rather than scattered literals:

```css
:root {
  --bg: #0e1116;
  --surface-1: #161b22;
  --surface-2: #1d242d;
  --surface-3: #27313d;
  --border: #34404d;
  --text: #edf2f7;
  --muted: #9aa8b7;
  --accent: #72d6bd;
  --accent-strong: #45bfa3;
  --warning: #e8ba63;
  --danger: #ef7d7d;
  --info: #83aef1;
  --focus: #b8e8ff;
  --radius-sm: 4px;
  --radius-md: 8px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
}
```

Use system sans-serif for interface copy and system monospace for IDs, times,
URLs, factors, and job output. Load no remote fonts. Keep transitions below
200ms and honor reduced motion.

Status uses icon, word, and color together: Healthy/check/accent;
Working/progress/info; Attention/triangle/warning; Failed/cross/danger;
Offline/disconnected/muted-danger. Never communicate with red/green alone.

## Shared interaction model

### Application state

Use one explicit state object divided by concern:

```javascript
const STATE = {
  route: "overview",
  status: { value: null, loading: false, error: null },
  station: { value: null, loading: false, error: null },
  library: {
    filters: { q: "", kind: null, type: null, state: "all" },
    items: [], offset: 0, hasMore: false, loading: false, error: null,
    selectedId: null
  },
  composer: {
    seconds: 30, tolerance: 1.5, maxItems: 8,
    placement: "any", types: [], result: null, loading: false, error: null
  },
  generation: {
    summary: null, models: [], jobs: [], outputs: [],
    selectedJobId: null, selectedOutputId: null,
    loading: false, error: null
  },
  jobs: { items: [], polling: new Map(), error: null },
  notices: []
};
```

Do not treat DOM contents as state. Rendering must be safe to repeat.

### Fetch behavior

Add one `api(path, options)` wrapper in `app.js` that:

- checks `response.ok`;
- safely parses JSON and extracts server `error`;
- throws normalized status and human-safe message;
- supports `AbortController` for superseded library searches;
- applies a 15-second timeout to ordinary reads;
- does not time out server job duration—POST returns a job id and polling owns
  the long wait.

Debounce search 250ms. Discard results older than the current filter generation.
Refresh overview/station every 20 seconds only while the document is visible;
refresh immediately when visible again.

### Loading, empty, stale, and error states

Every region renders one explicit state: loading; populated; useful empty with
active filters; error with Retry; or stale last-known content marked with last
update time. Never replace failure with a blank panel or clear known-good data
before a successful replacement arrives.

### Notifications and jobs

Replace the single truncated log as primary feedback with:

- `aria-live="polite"` status/toasts for short results;
- Recent jobs with one row per job;
- bounded raw result/error in expandable `<details>`.

Poll each working job every three seconds until `done` or `error`; impose no
false five-minute success. On network failure, retain `status unknown`, back
off to ten seconds, and offer Retry. Stop terminal/expired polling.

### Dialogs and focus

Use native `<dialog>` with a simple fallback panel. Focus the heading/first
control on open; trap focus only while modal; Escape closes non-destructive
dialogs; return focus to the invoker. Destructive confirmation puts Cancel
first and focuses it by default.

## View specifications

### Overview

Show:

1. **Service:** online/offline, brand, version if available, last refresh.
2. **Pool:** total, playable, parked, dead, unrendered cards, types.
3. **Station:** ffmpeg, conformed/eligible/pending, live/standby.
4. **Configuration:** profile and music-manifest source/validity when shipped.

Show actionable warnings before healthy detail: no playable items; unrendered
enabled cards; conform backlog; missing ffmpeg; invalid profile fallback;
invalid music; recent failed job. Link each to the relevant view/filter. Derive
health from explicit API fields, never parsed human strings.

Show five recent jobs and compact now cards. Overview reads never create or
advance station timelines.

### Library toolbar and results

Toolbar:

- labeled search;
- type: all/video/card/image/stream;
- kind from status counts;
- state: all/playable/parked/dead/unrendered;
- Clear filters;
- matched and loaded counts;
- grid/list density saved in `localStorage`.

Add creative-family filtering only after Phase 2 metadata exists.

Each card shows preview, kind/type, title, duration or LIVE, explicit state,
family/audio when known, and an always-visible Inspect button. Video uses
`preload="metadata"`. Only one preview plays. Pointer hover may preview muted;
touch/keyboard requires Play. Never auto-open a live stream.

Move delete out of a hover icon. Permanent delete exists only in the inspector
or explicit bulk danger flow.

### Item inspector

Show:

- media/text preview and answer where applicable;
- id, title, type, kind, source, duration, tags;
- enabled, health, rendered state;
- family, roles, energy, audio, text-heavy, template, brand mode;
- base and current selection factors;
- eligibility and ordered reasons;
- payload provenance, background attribution, music credits;
- creation/last-played time and play count;
- copyable media URL.

Primary reversible action:

- enabled: `Disable from rotation`;
- parked: `Enable`, including ownership warning;
- dead: `Recheck media` or next step;
- unrendered card: `Render card` background job.

Put delete in a Danger zone. Confirmation says whether the file is removed,
offers `Keep media file` where supported, names the item, and does not focus the
destructive button. Bulk kind deletion requires typing the exact kind.

### Composer

Controls:

- 15/30/60/90-second presets;
- custom `0 < seconds <= 86400`;
- tolerance `0..3600`, default 1.5;
- max items `1..40`, default 8;
- placement any/open/inside/close;
- optional type checkboxes;
- Compose break.

Call `/api/bumpers/fill`; never reproduce composition in JavaScript.

Render a horizontal timeline on desktop and ordered stack on mobile. Each item
shows order, title/kind/family, duration, audio, role, and brand mode. Relative
width may show duration but retain readable minimum and text duration.

Summary example:

```text
Requested 30.0s | Composed 29.4s | Gap +0.6s | Within tolerance
```

`gap = requested - total`: positive is underfilled, negative overfilled. Use
server `exact` as “within tolerance,” not literal zero. Display relaxed rules
in an Attention panel with plain explanations, never only a tooltip.

Provide Play sequence, Previous, Next, Stop. Advance on media `ended`; payload-
only cards display for declared duration. Show index and elapsed/remaining.
Stop/reset on new composition or route exit. Local preview never reports play
history. After disabling/deleting an item, mark the pack stale and require
recomposition rather than silent substitution.

### Station

For live/standby show:

- active, idle/no recent client, unavailable, or unknown;
- now/next with times and remaining duration;
- last playlist request/lookahead when exposed;
- explicit Open preview when native HLS is supported (no autoplay);
- copyable HLS URL.

Show conform progress, pending, last sweep, and ffmpeg. Conform disables only
its action while its job runs. Explain that it can be slow.

Copy M3U/XMLTV/HLS through Clipboard API with selection fallback and visible
success/failure. Focusing a URL still selects it.

| Condition | Operator message |
|---|---|
| No timeline | “Idle — no playlist client has requested this channel recently.” |
| No conformed items | “Unavailable — conform at least one eligible item.” |
| No positive candidates | “Using slate — all playable candidates are currently gated.” |
| ffmpeg absent | “Cannot conform — ffmpeg is unavailable in the service.” |
| API failure | “Station status unavailable; last successful update was …” |

Status reads do not advance history. Opening HLS is a real client and may
advance/report playout; label that before Play. Chromium and Firefox generally
do not provide native HLS playback. Detect support with
`video.canPlayType("application/vnd.apple.mpegurl")`; when unsupported, show
Copy URL and “Open in external player” guidance instead of a broken video.
Do not add a remote HLS script or a frontend media dependency in this plan.

### Generation

This view depends on [GENERATION_PLAN.md](GENERATION_PLAN.md) Phases G1–G5 and
must stay absent or clearly unavailable before the backend exists.

Show only configured model aliases whose effective capabilities are current.
The create panel names the real adapter/provider/model, supported options,
privacy/retention behavior, remaining local budgets, and exact submitted prompt.
It never accepts a raw provider slug, URL, filesystem path, API key, or arbitrary
provider parameter. It obtains the exact prompt and estimate from server
preflight, then treats creation-time revalidation failures as changed state,
not as permission to submit stale values. Paid submission requires an explicit
summary confirmation.

Render durable execution state separately from output review state. The queue
survives reload/restart through server data. Review video with sound, images at
useful scale, and text as the eventual card payload. Approve/reject operates on
one output, not every sibling from a job. Regenerate creates a visibly new paid
job. The view explains that generated candidates are disabled and score-zero
until approval, and that approved cards/rendered media still follow ordinary
render/conform timing.

OpenRouter video must explicitly say it is not Zero Data Retention eligible;
when OpenRouter routes to another provider, show both layers when known. Never
infer privacy, price, or capability from a model name.

### Operations

Separate actions by consequence:

1. Add material: natural-language request and bounded examples.
2. Generate cards: supported kinds with grounded/model badges and item count.
3. Refresh sources: capture windows/fetch queue.
4. Prepare output: render cards/conform station.
5. Maintenance: previews where supported, revive, links to CLI-only destructive
   operations.

Disable only the duplicate action while a job runs; keep unrelated controls
available within backend concurrency. Preserve form values on capacity error.
Show grounded/model/network/ffmpeg requirements before execution. Confirm
starter downloads and destructive work; routine refresh needs no modal.

Recent jobs shows action, created/updated age, status, result, and Retry only
where repetition is safe. Never invent retry for destructive work.

## Required API support

All additions are additive and documented in `docs/API.md`.

| Need | Existing support | Required addition |
|---|---|---|
| Overview | `/api/status`, `/api/station` | Parked/dead/unrendered counts and profile/manifest status when available. |
| Library | `/api/bumpers` | Add `total`; support existing filters plus health/bounded state filter. |
| Detail | `/api/bumpers/{id}` | Alignment explain and creative metadata. |
| Reversible rejection | Enable only | `POST /api/pool/disable?bumper_id=...` returning `{id, enabled, changed, warning?}`. |
| Render one | Batch render | Bounded `bumper_id` on `POST /api/render/cards`, validating a card id. |
| Break preview | `/api/bumpers/fill` | Phase 2 placement, ordered composition, creative data, relaxations. |
| Station diagnosis | `/api/station` | Explicit state/reason, last request, last conform summary, no advancement. |
| Jobs | Per-id status | Read-only `GET /api/jobs?limit=20` with bounded summaries. |
| Credits/config | Not normalized | Alignment Phase 2/4 status/payload contracts. |
| Generated content | Not shipped | Generation-plan summary/models/preflight/jobs/outputs APIs; no browser-held keys. |

Missing future fields render “Not available in this version.” Do not block
early slices or fake data.

### State-filter semantics

If `state` is added to `/api/bumpers`:

- `all`: no operational-state filter;
- `playable`: enabled, healthy, and media URL available;
- `parked`: `enabled=0` regardless of health;
- `dead`: `health='dead'`;
- `unrendered`: card with null/empty URI.

`count` remains page rows; additive `total` is rows matching filters before
pagination. Preserve limits and escaped search.

### Disable semantics

Disable changes only `enabled=0`; it never changes health or files. Return a
warning when calendar/config ownership may later alter it. Do not promise
permanence for `on_this_day` or config-owned cams. Test API before UI wiring.

## Accessibility requirements

- One `<h1>` and ordered landmarks/headings; add a skip link.
- Every input has a visible label; placeholders are supplementary.
- Prefer native controls.
- Full keyboard access and visible `:focus-visible`.
- 44×44px primary/destructive touch targets.
- Correct dialog focus/return.
- `aria-current`, `aria-live`, `aria-busy`, and named icon buttons.
- Text/icon labels in addition to color.
- WCAG AA contrast.
- 200% zoom and 320px width without lost actions/page scrolling.
- Reduced motion; no flashing/glitch operator animation.
- Muted video defaults, visible controls, never sound autoplay.

## Performance limits

- Keep static HTML/CSS/JS under 150 KiB uncompressed, excluding media.
- Keep static HTML/CSS/JS under **256 KiB (262,144 B) uncompressed**, excluding
  media, and serve it compressed.

  This was 150 KiB, which was measured unreachable during F6 and revised rather
  than quietly failed. At the F6 audit base the three files were 226,286 B;
  stripping *every* comment from all three landed at 169,722 B, and stripping
  every comment **and** all indentation and blank lines still landed at
  156,526 B — 2,926 B over, having destroyed exactly the invariant
  documentation this plan asks to keep and made a build-step-free codebase
  unmaintainable. There is no arrangement of "tidy without removing capability"
  that reaches 150 KiB, and F5 added to it.

  The revised cap is what the design supports with its contracts intact, and
  `node --test bumparr/web/app.test.js` asserts the three-file total against it
  so it stops drifting. What actually crosses the wire is gzipped by
  `SelectiveGZip(minimum_size=1000)` in `bumparr/app.py`, wrapping Starlette's
  `GZipMiddleware`: `app.js` is roughly
  a quarter of its on-disk size compressed, which is the number a browser and a
  reverse proxy care about. Media is excluded on purpose — `/media`,
  `/station/seg` and `/api/stream` serve bytes that are already compressed, and
  a request carrying a `Range` header is passed through on any path, because a
  compressed `206` cannot be seeked. `tests/test_app_api.py` asserts all of it
  over a real HTTP server.
- Server pagination: 24 default, UI maximum 100.
- Fetch detail/explain only when inspector opens unless already returned.
- At most one active media preview.
- Video `preload="metadata"`; never preload catalog HLS.
- Store only route/density/benign filters locally—no responses, jobs, URLs, or
  secrets.
- Clean timers, aborts, media, and listeners on route change.

## JavaScript structure

Keep one script unless genuinely unmanageable. Organize `app.js` as:

1. constants/state;
2. safe DOM helpers;
3. API/error/abort helpers;
4. routing;
5. shared badges/dialog/toast/job components;
6. Overview;
7. Library;
8. Composer/playback;
9. Station;
10. Generation;
11. Operations/jobs;
12. lifecycle/visibility/boot;
13. CommonJS exports for tests.
10. Operations/jobs;
11. lifecycle/visibility/boot;
12. CommonJS exports for tests.

Prefer pure `formatDuration`, `formatAge`, `selectionLabel`, `gapLabel`, and
`stationState`. API content enters only through `textContent`, safe properties,
or `URLSearchParams`; never `innerHTML`, CSS text, event strings, or unsafe URL
schemes. Static trusted HTML in `index.html` is fine. Clear containers with
`replaceChildren()` rather than `innerHTML = ""`.

## Testing strategy

### Node tests

Extend the fake DOM rather than adding jsdom/npm unless browser APIs cannot be
modeled simply. Test:

- hostile strings in every new component;
- safe URL/id construction;
- non-2xx, invalid JSON, timeout, and abort;
- stale search suppression;
- routing and `aria-current`;
- status/selection/gap labels;
- terminal, expired, unknown, and network-failed job polling;
- one-media-at-a-time cleanup;
- disable/enable/render/delete request contracts;
- cancellation sends no destructive request;
- composer order and relaxations;
- route exit stops playback/timers;
- missing future metadata;
- station reads versus explicit HLS Play.

### Python API tests

Test parameter bounds/enums; page count versus total; state semantics; disable
warnings/no deletion; one-card render validation/job; job list bounds,
truncation, expiry; station diagnostic purity; fill preview purity; and hostile
literal strings remaining JSON data.

### Manual browser matrix

Verify current Firefox and Chromium at 1440×900, 1024×768, and 390×844; keyboard
only; 200% zoom; reduced motion; offline-after-load; empty DB; hundreds of
items; long/malformed/hostile data; and long, failed, expired, concurrent jobs.
Confirm no uncaught errors, unwanted autoplay, or polling after route exit.

## Delivery plan

### F0 — foundations and truthful states

**Dependencies:** current API.

- Link this plan from docs/alignment.
- Add landmarks, labels, skip link, live region, focus/reduced-motion styles.
- Add normalized API errors, panel loading/error/stale state, safe clearing,
  visibility refresh, search cancellation.
- Expand fake-DOM tests.
- Preserve layout/capabilities in this slice.

Done when existing actions work, failures never look like healthy emptiness,
all controls are keyboard-visible, and hostile-string tests pass.

### F1 — navigation and overview

**Dependencies:** additive counts helpful, not required.

- Add hash navigation/responsive shell.
- Move current panels into one discoverable home each.
- Build summaries/warnings from explicit fields.
- Add last-updated/stale markers and recent-job placeholder.
- Preserve deep links/back/forward.

Done when navigation works desktop/mobile, capabilities are not duplicated or
lost, and overview creates no station history.

### F2 — library inspector and reversible curation

**Dependencies:** total/state filter, disable, detail explain when available.

- Build toolbar, result states, density, pagination.
- Replace hover delete with Inspect/action access.
- Build inspector with media, state, metadata, history, URLs.
- Make disable primary; wire enable/recheck/single-render.
- Put deletion behind Danger flows.
- Refresh affected rows/counts without resetting filters/scroll.

Done when keyboard/touch can inspect/disable/enable/delete, deletion is
secondary, filter state survives inspection, and totals paginate correctly.

### F3 — break composer

**Dependencies:** Alignment Phase 2 `/fill` contract.

- Build validated controls/presets.
- Render ordered timeline, summary, creative labels, relaxations.
- Implement local sequential preview with one medium active.
- Connect inspector/disable.
- Mark packs stale after mutation.

Done when standard packs review end-to-end, gap language is correct, server
order is preserved, and preview does not write history.

### F4 — station and operations

**Dependencies:** job list and station diagnostics.

- Build distinct station states and capability-gated preview/external-player
  fallback.
- Add Copy, conform progress, last sweep.
- Organize actions by consequence/requirement.
- Add jobs with terminal/unknown/error and details.
- Poll per job and refresh affected views.
- Show unprotected-API warning.

Done when idle differs from broken/gated/unconformed, long jobs are never
falsely successful or abandoned at five minutes, and copy/preview work mobile.

### F5 — creative and provenance insight

**Dependencies:** Alignment Phases 2–4.

- Show family/role/energy/audio/template/brand mode.
- Visualize factor multiplication and zero gate.
- Show profile source/version/fallback read-only.
- Show media/music creator/source/license/attribution.
- Warn on missing provenance without blocking curation.

Done when selection/presentation are explainable, credits are safe/complete,
missing fields remain compatible, and config stays read-only.

### F5G — generated-content creation and review

**Dependencies:** Generation Plan Phases G1–G5 and frontend F0–F2.

- Add `#/generation`, configured-model states, paid-service/privacy disclosure,
  capability-derived controls, and exact prompt preview.
- Add durable job queue with truthful provider and local-processing states.
- Add modality-appropriate output preview and per-output approve/reject/delete.
- Show provider/model/canonical id, references, usage/cost, checksum, and review
  provenance without exposing secrets, signed URLs, or absolute paths.
- Protect pending candidates in the Library inspector from generic enable/revive
  actions and direct operators to Generation review.

Done when H3 direct and OpenRouter video can be created and reviewed without
special UI forks, reload restores state, hostile values remain text, and no
pending candidate can be enabled through a generic control.

### F6 — accessibility, performance, release polish

**Dependencies:** F0–F5 and F5G when generated-content UI is included in the
release.
### F6 — accessibility, performance, release polish

**Dependencies:** F0–F5.

- Complete manual matrix.
- Fix focus/contrast/zoom/touch/motion/screen-reader issues.
- Audit timers, stale requests, cleanup, payload size.
- Test empty/large/degraded fixtures and destruction confirmations.
- Update screenshots/user docs after behavior stabilizes.

Done when accessibility requirements pass, payload stays within target, views
leak no polling/media, and full verification passes.

## Alignment dependencies

| Frontend capability | Alignment phase |
|---|---|
| Selection explanation | Phase 1 |
| Creative labels/profile | Phase 2 |
| Ordered Composer | Phase 2 |
| Templates/brand modes | Phase 3 |
| Music credits/audio | Phase 4 |
| Memory provenance | Phase 5 |
| Release review | Phase 6 CLI artifacts; no extra dashboard view initially |

Generated-content UI separately depends on [GENERATION_PLAN.md](GENERATION_PLAN.md):
G4 for the generic review surface and direct H3, G5 for OpenRouter/multi-model,
G6 for reference pickers, G7 for images, and G8 for invented cards.

F0–F2 must show unavailable data honestly rather than fake future fields.

## Full verification

```bash
node --check bumparr/web/app.js
node --test bumparr/web/app.test.js
python -W error::ResourceWarning -m unittest discover -s tests -v
ruff check bumparr tests
python -m compileall -q bumparr
git diff --check
docker compose config
```

For API/runtime changes, also run CI's clean Compose smoke flow. Complete the
manual browser matrix for affected views.

## Definition of frontend complete

An operator can understand health without logs; inspect eligibility and
provenance; reject reversibly before deletion; compose/play ordered breaks
without history mutation; diagnose live/standby; monitor honest job states;
create and separately review generated candidates when generation is enabled;
see effective creative/config/rights information without browser config writes;
and perform essential work by keyboard, touch, narrow viewport, and reduced
motion. Empty, offline, stale, malformed, and failed states remain actionable.

The result remains a small same-origin operator console, never pretends to add
authentication, and keeps reviewed media—not interface ornament—at the center.
