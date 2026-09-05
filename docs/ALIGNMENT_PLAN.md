# Adult Swim-inspired product alignment execution plan

**Status:** execution spec. Phase 0 lands this contract; later phases implement runtime alignment. Do not read this file as completed runtime work.  
**Audit base:** `c38d140` on 2026-09-05  
**Execution scope:** Phases 0 through 6 below  
**Inputs:** the repository at the audit base,
[PRODUCT_VISION.md](PRODUCT_VISION.md), and
[CREATIVE_REFERENCE.md](CREATIVE_REFERENCE.md)

## How to use this document

This is the handoff document for implementing Bumparr's creative-product
alignment. It is intentionally self-contained: a new agent should be able to
begin with only the repository and this file, understand what exists, know
what must change, and verify each delivery slice without access to the
conversation that produced the plan.

Before changing code, read these files in order:

1. this plan;
2. [PRODUCT_VISION.md](PRODUCT_VISION.md) for the product contract;
3. [CREATIVE_REFERENCE.md](CREATIVE_REFERENCE.md) for the inspiration and
   originality boundary;
4. [ARCHITECTURE.md](ARCHITECTURE.md), [SCHEMA.md](SCHEMA.md),
   [ROTATION.md](ROTATION.md), [API.md](API.md), and [STATION.md](STATION.md);
5. the implementation and tests named in the phase being executed.

Implement phases in order. A phase may be delivered in multiple pull requests,
but do not start work whose listed dependencies are incomplete. Run focused
tests after each task and the full verification matrix at the end of each
delivery slice. Update documentation alongside behavior.

Owner decisions below are not permission gates. If the owner has not supplied
a different answer by the time a dependent phase is implemented, use the
conservative defaults in [Working product defaults](#working-product-defaults).
Do not invent a larger architecture to defer a decision.

## Objective

Make Bumparr reliably deliver its intended experience: original, curated,
Adult Swim-inspired interstitials that give a self-hosted channel a voice.
Preserve the strong acquisition, rendering, safety, rotation, duration-fill,
and HLS work already present. Add the missing product language, consistent
eligibility, small creative vocabulary, sequence policy, operator-owned voice,
intentional presentation, audio provenance, and experience-level evaluation.

This work must not turn Bumparr into a long-form programme scheduler, a public
social service, an Adult Swim asset scraper, or a visual/linguistic clone.

## Product context

### What Bumparr is

Bumparr is a self-hosted engine for making and serving short television
interstitials. The useful lesson from Adult Swim is not a particular logo,
font, card, joke, song, or piece of footage. It is the broadcast grammar:
short material at programme boundaries can establish channel voice, pacing,
time-awareness, music discovery, continuity, and a relationship with viewers.

Bumparr exposes that material in three modes:

| Mode | Responsibility | Existing surface |
|---|---|---|
| Bumper library | Create, ingest, inspect, enable, disable, render, and serve individual items. A downstream scheduler places them. | Registry, dashboard, `/playlist.m3u`, `/api/bumpers`, `/api/bumpers/random` |
| Break composer | Return an ordered set that fits a duration and optional placement. | `/api/bumpers/fill` exists, but currently solves duration without creative sequence grammar. |
| Live station | Play the bumper pool continuously as HLS and expose a restricted standby stream. | `/station/live`, `/station/standby`, conform cache, XMLTV, virtual-clock playout |

Bumparr does not schedule episodes, films, or general linear channels. Its live
station schedules only its own bumper pool. Keep that distinction clear in the
docs and UI.

### Desired viewer experience

A representative ten-minute station sample should feel programmed rather
than shuffled. It should mix text, imagery, data, archive texture, windows,
idents, failures, sound, and silence; avoid accidental repetition; respond to
time and actual channel history; and express one operator-owned voice. A
duration-bounded break should have a plausible opening/interior/exit shape
when the pool can provide it.

### Originality and rights boundary

- Never bundle or generate copied Adult Swim marks, card text, typography,
  footage, show material, or commercial music merely because the network used
  it.
- Never tell a model to imitate Adult Swim or a named creator.
- Use original, operator-owned, public-domain, or appropriately licensed
  content. Preserve attribution with the asset.
- Treat “Adult Swim-inspired” as the experience principles documented in
  `CREATIVE_REFERENCE.md`, not as a styling instruction.

## Current system snapshot

This section describes the audit-base implementation. Recheck it at the start
of a phase and amend this plan if prior work has legitimately changed it.

### Runtime and dependencies

- Python service: FastAPI/uvicorn.
- Persistence: SQLite through `bumparr.db.conn()`.
- Media: ffmpeg/ffprobe subprocesses and Pillow rendering.
- Configuration: environment variables in `bumparr/config.py` plus YAML/JSON
  under `bumparr/config_files/`.
- Frontend: dependency-free HTML/CSS/JavaScript under `bumparr/web/`.
- Tests: standard-library `unittest` and Node's built-in test runner.
- Do not add a framework or dependency when standard library/PyYAML suffices.

### Registry contract

`playables` in `bumparr/db.py` is the source of truth:

| Column | Current meaning |
|---|---|
| `id` | Stable playable identity. |
| `type` | `video`, `card`, `stream`, or `image`. |
| `kind` | Free-form editorial category such as `trivia`, `weather`, `station_id`, or `ambient`. |
| `source` | Provenance label, not currently a normalized rights record. |
| `uri` | Local path relative to `ASSET_ROOT`, or an upstream stream URL. Unrendered cards have no URI. |
| `duration` | Measured/intended playout seconds. |
| `payload` | JSON text with type-specific data. This plan adds namespaced creative metadata here. |
| `tags` | Comma-separated legacy tags. Use for inference, not new structured values. |
| `weight` | Operator-declared base score. `<= 0` means off air. Never mutate it for computed policy. |
| `enabled`, `health` | Static eligibility: only `enabled=1 AND health='ok'` may play. |
| `last_played`, `play_count` | Denormalized history used by rotation. Station playout is the shipped writer. |

`play_history` records actual station starts by channel. `playout` stores the
per-channel cursor. Schema migrations are additive only. This plan deliberately
does not require a migration: creative values belong in `payload` until query
evidence proves otherwise.

### Existing content flow

```text
ingest / seed / generators / live cams / source jobs
                      |
                      v
                SQLite playables
              /         |          \
       card render    API/M3U     station conform cache
                                      |
                                      v
                              virtual-clock HLS playout
                                      |
                                      v
                                 play_history
```

Heavy work—downloads, model calls, rendering, ffmpeg, and probes—already runs
outside playback requests. Preserve that invariant.

### Existing scoring model and known defect

`bumparr/rotation.py` computes:

```text
score = base × season × daypart × recency × affinity × fatigue
```

`rotation.weights_for(rows, season_factors, now, daypart_factors)` returns a
parallel score list and context. `rotation.explain(row, context, now)` returns
the factors. Scoring is computed, not stored.

At the audit base:

- station playout filters computed scores strictly greater than zero;
- `/api/bumpers/random` then applies `max(0.0001, weight)`, incorrectly reviving
  season/daypart gates;
- `/api/bumpers/fill` checks only stored base weight and does not apply current
  season/daypart/recency/affinity/fatigue;
- each path separately assembles its computed-eligibility result.

Treat this as an existing correctness defect, not merely an enhancement.

### Existing fill and station behavior

`GET /api/bumpers/fill` accepts `seconds`, `tolerance`, `max_items`, and
`types`. It performs 240 deterministic randomized restarts over distinct items,
preferring durations nearest the remaining gap. It returns `requested`,
`total`, signed `gap`, `exact`, `count`, and `bumpers`. Preserve those fields
and meanings. Sequence metadata may be additive.

`bumparr/station/conform.py` prepares immutable HLS segment sets outside the
request path. `bumparr/station/playout.py::Channel` extends a virtual timeline
only on playlist requests, chooses conformed eligible rows, reports actual
starts, and falls back to a built-in slate. Status snapshots are read-only.
Do not make profile loading, generation, rendering, or probing part of a
playlist request.

### Existing card and audio behavior

- `bumparr/generators/cards.py::PROMPTS` hard-codes the model-created voice for
  `psa`, `corrections`, `achievements`, `coming_up`, and `tiny_games`.
- `bumparr/card_validation.py` performs structural/content validation.
- `bumparr/render_cards.py` gives most ordinary cards one centered layout and
  appends a brand layer. Special builders exist for station IDs, dead air,
  local time, weather, and technical-difficulty cards.
- Cards may name `payload.music`; `_music_bed` resolves it under the asset
  root. Produced video scans `SOUND_DIR`, randomly beds some silent clips, and
  records only coarse audio data. There is no manifest or full credit chain.

### Current-state assessment

| Dimension | Alignment | Finding |
|---|---:|---|
| Content palette | Strong | Terse cards, facts/games, IDs, dead air, failures, time/weather, windows, ambient and archive content exist. |
| Identity | Strong | Brand/font controls and font roulette are distinct, but the reveal is overused. |
| Voice | Partial | Useful baseline tone is embedded in prompts; no operator profile or repetition policy. |
| Visual grammar | Partial | Special procedural families exist; ordinary cards mostly use one centered treatment. |
| Scoring | Strong | Factor model is explainable; endpoint eligibility is inconsistent. |
| Sequence composition | Weak | Duration is optimized, but role, family, text density, audio, and entry/exit are not. |
| Temporal awareness | Strong | Season, daypart, clock, date, and weather exist. |
| Music/sound | Partial | Native audio, beds, and silence exist mechanically; curation, rights, credits, and loudness are incomplete. |
| Audience relationship | Partial | Some concepts address viewers; grounded callbacks and curated mail are missing. |
| Delivery | Strong | Library/API, live HLS, standby HLS, and XMLTV are present. |
| Technical evaluation | Strong | Unit, media, security, and HLS checks exist. |
| Creative evaluation | Weak | No deterministic sequence simulation, review reel, or sequence report. |

## Non-negotiable engineering invariants

Every phase must preserve these rules:

1. SQLite remains authoritative. The station cache is derived.
2. `weight <= 0` or any computed `score <= 0` is a hard gate. No epsilon/floor
   may revive it.
3. A local file is advertised only after it exists and is usable. Cards remain
   unavailable to file consumers until rendering assigns a URI.
4. Playback/status requests do bounded reads and in-memory choice only; they do
   not call models, download, render, conform, or probe.
5. Status and preview never advance playout or write history.
6. New metadata is optional. Existing rows and clients continue to work.
7. Payload updates preserve unrelated keys; malformed payloads degrade safely.
8. Defaults never contain deployment hosts, identities, secrets, or addresses.
9. User paths retain existing containment and symlink protections.
10. Core randomness is injectable/seedable for reproducible tests/simulation.
11. No copied network assets or unlicensed defaults are added.
12. Do not add embeddings, recommendation services, an AI “vibe judge,” a
    general rules DSL, or a renderer plugin framework.

## Working product defaults

If the owner supplies no different choice, use these:

| Decision | Default for implementation |
|---|---|
| Primary onboarding promise | Lead with the bumper library and break composer; present live/standby HLS as showcase/failover. |
| Voice | Concise, dry, observant, lightly strange; no profanity, political persuasion, slurs, sexual material, or targeted cruelty in shipped examples. Direct address is allowed. |
| Music rights | Ship no commercial music. Redistributable defaults are public domain/CC0. Operator-added licensed/owned tracks require manifest metadata. |
| Placement data | Optional. Missing placement is `any`; existing callers do not change. |
| Viewer input | Local operator-curated file only; no accounts, upload, anonymous submission, or public write endpoint. |
| Branding | Preserve legacy renders. New templates choose `reveal`, `static`, or `none`; periodic idents carry continuity instead of a forced reveal on every new card. |

## Target contracts

These contracts keep phases and pull requests compatible.

### Creative payload metadata

Store structured metadata under optional `payload.creative`. Do not add sibling
fields for the same concepts or rewrite existing payload content.

```json
{
  "lines": ["The ordinary card payload remains unchanged."],
  "creative": {
    "family": "text",
    "roles": ["any"],
    "energy": "quiet",
    "audio": "silence",
    "text_heavy": true,
    "template": "minimal_center",
    "render_seed": 18430291,
    "brand_mode": "reveal",
    "music_id": null
  }
}
```

| Field | Allowed values / meaning |
|---|---|
| `family` | `text`, `scenic`, `archive`, `data`, `window`, `ident`, `failure`, `authored`. Broad mechanism, not existing `kind`. |
| `roles` | Any subset of `any`, `open`, `inside`, `close`, `return`, `ident`, `standby`. |
| `energy` | `quiet`, `neutral`, `loud`. |
| `audio` | `native`, `music`, `designed`, `silence`, `unknown`. |
| `text_heavy` | Boolean adjacency signal. |
| `template` | Phase 3 template id; missing means compatible default. |
| `render_seed` | Non-negative integer for stable variation. |
| `brand_mode` | `reveal`, `static`, `none`. |
| `music_id` | Phase 4 manifest id or null. |

Create `bumparr/creative.py` as the only parser/resolver, with behavior
equivalent to:

```python
resolve_creative(row) -> dict
merge_creative(payload, explicit_values) -> dict
role_compatible(creative, placement, mode="break") -> bool
```

`resolve_creative` returns a complete normalized dictionary. `merge_creative`
retains existing keys. These function and field names are the implementation
contract; change them only by first updating this plan and every dependent
slice.

Inference precedence:

1. valid explicit `payload.creative` value;
2. established legacy payload/tag evidence;
3. kind mapping;
4. type/source fallback;
5. conservative `unknown`/`neutral`/`any` default.

Initial family defaults:

| Evidence | Family |
|---|---|
| `station_id` | `ident` |
| `technical_difficulties`, `dead_air`, `testpattern` | `failure` |
| `weather`, `local_time`, `on_this_day`, `number`, `trivia`, `fun_facts` | `data` |
| `psa`, `corrections`, `achievements`, `coming_up`, `tiny_games` | `text` |
| `type=stream`, or `kind`/tags indicating window/webcam | `window` |
| Archive/government provenance or tags | `archive` |
| Explicit user/manual source | `authored` |
| Remaining image/video | `scenic` |
| Remaining card | `text` |

Initial role defaults preserve current usefulness:

- idents: `open`, `close`, `return`, `ident`;
- technical difficulties: `inside`, `standby`;
- dead air/windows: `any`, `inside`, `standby`;
- ordinary content: `any`, `inside`;
- unknown: `any`.

For break placement `open`, `inside`, or `close`, compatibility means roles
contain `any` or that placement; `return`/`ident` also satisfy `close`. For
placement `any`, accept all except items whose only role is `standby`. Standby
retains its kind allowlist and may use `standby`; live station is not narrowed
solely because an old row inferred a specialized role.

### Channel profile

Add `bumparr/config_files/channel_profile.yaml`, loader
`bumparr/channel_profile.py`, and optional `CHANNEL_PROFILE` path in
`bumparr/config.py`. Changes require restart; hot reload is not required.

```yaml
version: 1

voice:
  persona: "Concise, dry, observant, and lightly strange."
  favored_subjects: []
  boundaries:
    allow_direct_address: true
    allow_profanity: false
    allow_politics: false
    allow_bleak_humor: false
  avoid_phrases: []
  avoid_topics: []

mix:
  break: {text: 1.0, scenic: 1.0, archive: 1.0, data: 1.0,
          window: 0.8, ident: 0.8, failure: 0.2, authored: 1.0}
  station: {text: 1.0, scenic: 1.0, archive: 1.0, data: 1.0,
            window: 1.0, ident: 0.7, failure: 0.3, authored: 1.0}

sequence:
  max_text_run: 2
  avoid_same_family: true
  prefer_exit_ident: true
  avoid_same_music: true
  avoid_large_energy_jump: true

presentation:
  default_template: minimal_center
  default_brand_mode: reveal

audio:
  allowed: [native, music, designed, silence, unknown]
  target_lufs: -16.0
  true_peak_db: -1.5
  fallback: silence
```

Validation requirements:

- `version` is exactly `1`;
- reject unknown top-level sections and wrong structural types;
- reject unknown families/treatments and non-finite/negative mix weights;
- require family weights in `0..100`, `max_text_run` in `1..20`,
  `target_lufs` in `-36..-5`, and `true_peak_db` in `-12..0`;
- trim/deduplicate string lists, cap each at 100 entries, cap each entry at 200
  characters, and cap `persona` at 1000 characters;
- missing file returns an independent deep copy of defaults;
- runtime invalidity logs one actionable warning and uses the full default;
  strict validation raises clearly for tests/operators;
- never partially apply malformed config;
- implement `python -m bumparr.channel_profile --check` for strict validation;
- add `profile: {version, valid, source}` to `/api/status`, where `source` is
  only `shipped-default`, `custom`, or `fallback-after-error`—never a path.

Do not create arbitrary predicates, expression trees, templated Python, or
per-kind scripting. Existing seasons/dayparts own calendar/hour scoring.

### Shared selection and sequence interfaces

Create `bumparr/selection.py`; keep `rotation.py` responsible for factors and
numeric scoring. Required behavior:

```python
scored_candidates(rows, *, season_factors=None, daypart_factors=None, now=None)
    -> ([(row, positive_score), ...], rotation_context)
```

Call `rotation.weights_for` once and keep only
`math.isfinite(score) and score > 0`. Do not decide file/conform availability
here because callers have different physical eligibility. Make
`rotation.explain()["score"]` use `rotation.score` semantics, including zero
for base `<= 0`.

Create pure `bumparr/sequence.py` operations equivalent to:

```python
compose_break(candidates, seconds, tolerance, max_items, placement,
              profile, recent, rng) -> Composition
choose_next(candidates, profile, recent, rng, mode="station")
    -> (candidate_or_none, relaxed_rules)
```

A candidate carries row, positive rotation score, and resolved creative data.
`recent` is bounded caller-provided context. Neither operation queries SQLite,
loads files, reads wall time, or mutates history. `Composition` carries ordered
candidates, total, signed gap, tolerance result, and relaxed-rule names.

Hard rules, never relaxed:

- finite score greater than zero;
- caller has satisfied enabled/health/media/conform requirements;
- requested role compatibility;
- finite positive duration;
- no repeated id in a fixed break;
- `max_items` honored.

Soft rules, relaxed only in this order:

1. reserve/prefer an ident or return-capable exit for closing breaks;
2. avoid a direct `quiet` ↔ `loud` energy jump;
3. avoid same-family adjacency;
4. honor `max_text_run`;
5. avoid adjacent reuse of the same non-null `music_id`.

If the pool cannot satisfy soft rules, return the best duration result and list
relaxations. Do not return nothing because all items share a family. Station
avoids exact repetition while another positive candidate exists; if only the
previous item is positive, repeat it rather than air gated content or slate.

Reuse the bounded 240-restart duration search rather than adding an optimizer.
Combine rotation score with the mode's non-negative family preference. A zero
family preference is a hard profile gate; never floor it. Rank packs by: within
tolerance first, smaller absolute gap, fewer soft violations after ordering,
then higher summed preference score. Use only the supplied RNG for ties.

### Additive API contract

Preserve routes and existing response fields.

- `/api/bumpers/random` gains optional `explain=false`; true adds per-item
  `selection` factor data. Gated rows are never returned.
- `GET /api/bumpers/{id}` gains optional `explain=false`; true adds resolved
  `creative`, factor data, and `eligible_now`, including reasons for disabled,
  unhealthy, missing-media, and computed gates.
- `/api/bumpers/fill` gains `placement=any|open|inside|close`; existing
  `bumpers` becomes composed order. Add `composition` with `placement`,
  `relaxed_rules`, and `profile_version`.
- List/random/fill may add `creative`; never remove raw `payload` or core data.
- Preview/explain never writes history or counters.

Invalid placement is a FastAPI 4xx validation response, not fallback to `any`.
Use these response shapes so the frontend and tests do not invent alternatives:

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

Allowed reason strings are `disabled`, `unhealthy`, `missing_media`,
`base_weight`, `season`, `daypart`, `non_finite_score`, and `eligible`. Return
all applicable hard reasons in that order; use only `eligible` when none apply.
Random's explain object may omit `reasons` because returned rows are eligible,
but it uses the same `factors` field. Fill adds:

```json
{
  "composition": {
    "placement": "close",
    "relaxed_rules": ["exit_ident"],
    "profile_version": 1
  }
}
```

Allowed relaxation names are `exit_ident`, `energy_jump`, `same_family`,
`text_run`, and `same_music`, listed in the relaxation order above.

### Music manifest

Add `bumparr/config_files/music_beds.yaml`, `bumparr/music.py`, and optional
`MUSIC_MANIFEST`. An empty shipped manifest is valid.

```yaml
version: 1
beds:
  - id: night-room-01
    path: night-room-01.flac
    title: Night Room
    creator: Example Artist
    source_page: https://example.invalid/night-room
    license: CC0-1.0
    license_url: https://creativecommons.org/publicdomain/zero/1.0/
    attribution: ""
    energy: quiet
    families: [text, scenic, data]
    enabled: true
    operator_owned: false
```

Paths are relative to `SOUND_DIR` and use existing containment/symlink
discipline. Ids are unique. Required fields are `id`, `path`, `title`,
`creator`, `license`, and `enabled`; source/license URL/attribution may be empty
only when truthful for the license or operator-owned state. Runtime skips and
reports invalid/unreadable entries; strict validation fails clearly. Restrict
ids to `[a-z0-9][a-z0-9._-]{0,79}`, paths to 500 characters, other strings to
500 characters, and family lists to the eight known families. Implement
`python -m bumparr.music --check` as the strict operator validation command.

## Dependency map

```text
Phase 0 docs/catalog
      |
Phase 1 eligibility + explain + base simulation
      |
Phase 2 profile + creative resolver + composer
      |-------------------|
Phase 3 voice/templates   Phase 4 music/provenance
      |-------------------|
              Phase 5 channel memory
                       |
              Phase 6 release evaluation
```

Phases 3 and 4 may proceed in parallel only after Phase 2 contracts land.
Phase 5 consumes rather than redefines them. Phase 6 extends Phase 1's
simulation after all metadata exists.

## Phase 0 — establish the contract and remove contradictions

### Goal and files

Make the repository tell one truthful story. Inspect/update `README.md`,
`docs/README.md`, all three product documents, `docs/ARCHITECTURE.md`,
`docs/API.md`, `docs/INTEGRATION.md`, `docs/ROTATION.md`, `docs/SCHEMA.md`,
`docs/STATION.md`, `docs/CARDS.md`,
`bumparr/config_files/bumper_catalog.yaml`, and `CHANGELOG.md`.

### Tasks

1. Land/link the product documents.
2. Reconcile every scheduling claim: no episode/film scheduling; `/fill`
   composes bumper sets; station schedules only bumper showcase/failover.
3. State SQLite authority, derived cache, actual station history writer, and
   read-only status/preview behavior.
4. Describe `live` as showcase and `standby` as failover.
5. Audit all catalog content entries against code, tests, and documented routes
   (54 rows at the Phase 0 audit; do not invent a row to match a remembered count).
   Replace mechanism-like statuses with one `state`:
   - `shipped`: documented, reachable, and tested;
   - `partial`: mechanism exists but named concept is incomplete;
   - `proposed`: no implementation;
   - `blocked`: named dependency/rights decision prevents it;
   - `deferred`: deliberately outside near-term milestones.
6. Preserve production method separately as `mechanism` where useful. Require
   `implementation` evidence for `shipped`/`partial`, or `gap` for other states.
   Keep the catalog descriptive, not executable.
7. Mark channel statistics, previously-on, and viewer-history concepts
   accurately until Phase 5 lands.
8. Changelog this as a design contract, not completed runtime alignment.

### Verification and acceptance

- Inspect every result of
  `rg -n "not a scheduler|does not schedule|scheduler" README.md docs`.
- Parse the catalog with `yaml.safe_load`.
- Add `tests/test_catalog.py` asserting allowed states and evidence/gap.
- Verify relative links without adding a heavyweight docs dependency.
- Run `git diff --check`.
- Done when a new contributor can explain three modes/non-goals, every
  scheduling statement is consistent, and every catalog row is evidenced.

## Phase 1 — make selection truthful and observable

### Files

Create `bumparr/selection.py`, `bumparr/simulate.py`,
`tests/test_selection.py`, and `tests/test_simulate.py`. Modify
`bumparr/rotation.py`, `bumparr/app.py`, `bumparr/station/playout.py`, their
existing tests, API/rotation/CLI/architecture docs, and changelog.

### Tasks

1. Write failing helper tests for base zero/negative, season zero, daypart zero,
   positive score, and non-finite score handling.
2. Implement `scored_candidates` and align `rotation.explain` score semantics.
3. Replace station's local computed filtering with the helper while retaining
   conform/kind pool filtering and slate fallback.
4. Remove `/random`'s epsilon. Keep unique results and current bounds.
5. Apply shared scoring before `/fill` duration search, resolving season and
   daypart with the same guarded behavior as random/station.
6. Add explain API behavior. Build an inspected row's context from the current
   statically eligible pool so median/affinity match selection. Distinguish
   enabled, health, missing media, and dynamic score reasons.
7. Implement `python -m bumparr.simulate`:
   - snapshot enabled/healthy rows;
   - mutate only in-memory copies of play counts/timestamps;
   - accept integer `--seed`, positive integer `--picks`, Unix-seconds float
     `--start`, and `--json`;
   - never call station `advance()` or write the DB;
   - report item/kind shares, exact repeats, same-kind runs, zero-score picks,
     seasonal/daypart distribution, and inferred audio balance.
8. Test DB row/history/counter equality before/after simulation.

### Focused verification

```bash
python -W error::ResourceWarning -m unittest \
  tests.test_rotation tests.test_selection tests.test_app_api \
  tests.test_station_playout tests.test_simulate -v
```

Done when all three paths exclude score `<= 0`, explain matches selection,
default API fields remain compatible, seeded JSON is identical, and simulation
is proven read-only.

## Phase 2 — add creative metadata, profile, and break grammar

### Files

Create `bumparr/creative.py`, `bumparr/channel_profile.py`, the shipped YAML,
`bumparr/sequence.py`, and matching `tests/test_creative.py`,
`tests/test_channel_profile.py`, `tests/test_sequence.py`. Modify config, app,
station playout, simulation, all row producers (`ingest.py`, `seed.py`,
`produce.py`, `station_ids.py`, `live_cams.py`, `generators/*.py`), affected
tests/docs, and changelog.

### Tasks

1. Test profile missing/valid/invalid cases, wrong/unknown values,
   negative/NaN weights, deduplication, independent defaults, and strict versus
   runtime handling; then implement the target loader.
2. Test every creative inference mapping, explicit precedence, partial/malformed
   objects/JSON, legacy tags, and payload preservation; then implement resolver.
3. Make new content writers persist what they know via `merge_creative`. Do not
   duplicate merges or change stable factual identities unnecessarily.
4. Test pure composition: determinism, hard gates, unique ids, exact/near fit,
   max items, family/text/exit policy, relaxation order, one-family/one-item
   pools, zero family preference, malformed duration, and empty pool.
5. Implement bounded composer with no DB/file/time/global-RNG dependencies.
6. Integrate `/fill`, preserving existing fields and adding placement/composition.
7. Integrate station `choose_next` with the last five timeline entries as
   context. Add `family`, `text_heavy`, `energy`, `audio`, `template`, and
   `music_id` to the in-memory `Entry`; do not migrate DB. Preserve conformed-
   only playback, status purity, last-request staleness, slate, and standby.
8. Extend simulation with family share, text runs, role violations,
   relaxations, and profile source/version.
9. Add resolved creative data to API serialization without replacing payload.

### Focused verification

```bash
python -W error::ResourceWarning -m unittest \
  tests.test_selection tests.test_creative tests.test_channel_profile \
  tests.test_sequence tests.test_app_api tests.test_station_playout \
  tests.test_station_routes tests.test_simulate -v
```

Done when legacy rows resolve predictably, explicit metadata wins, capable
pools have no hard/repeat/text-run violation, constrained pools report soft
relaxations, and fill/station share policy without heavy request work.

## Phase 3 — make voice and presentation operator-owned

### Files

Prefer modifying the existing renderer rather than creating a framework. Add
`tests/test_voice_profile.py` and `tests/test_card_templates.py`. Modify
`generators/cards.py`, `card_validation.py`, `render_cards.py`, relevant card
producers, dashboard files/tests, card/config/API/render docs, and changelog.

### Tasks

1. Build prompts from fixed per-kind schema instructions + validated voice
   block + item count. Keep `_call_model` provider-agnostic and job-only.
2. Describe traits directly; never request imitation of a network/creator.
3. Add deterministic pre-insert checks for normalized duplicates against batch
   and existing same-kind text, repeated batch opening phrases, configured
   avoid phrases/topics with word boundaries, and existing length/shape rules.
   Reject per item and preserve added/rejected accounting.
4. Voice changes affect only new candidates; never rewrite old cards.
5. Implement a finite template set:
   - `minimal_center`: current centered behavior;
   - `minimal_corner`: sparse safe corner/edge text;
   - `image_caption`: background plus restrained safe-area caption;
   - `information_board`: weather/time/fact/number presentation;
   - `signal`: failure/dead-air presentation;
   - existing station-ident builders stay the ident family.
6. Define kind/family compatibility in code. Strict creation/preview rejects an
   incompatible explicit template; runtime falls back to documented default.
7. Persist template/render seed/brand mode for new items. For legacy items,
   derive seed from stable id hash and persist only during explicit render or
   refresh, never inspection/selection. Do not use process `hash()`.
8. Implement `reveal`, `static`, and `none` brand modes. Existing files remain
   unchanged until explicit rerender.
9. Add dashboard previews for one item and 15/30/60/90-second packs, showing
   creative data, provenance, factors, relaxations, and media. Reuse enable/
   delete. Use safe DOM creation/text, not HTML interpolation.

### Verification and acceptance

- Unit-test prompt construction without a model call.
- Test duplicate normalization across case/space/punctuation without substring
  false positives.
- Test template compatibility and deterministic seeds.
- Measure safe-area layout at 1920×1080 for long/short content.
- With ffmpeg, render/probe one card per template for streams and duration.
- Add Node tests for escaping, empty/error states, and preview purity.
- Done when new voice follows profile, renders are reproducible, ordinary cards
  gain constrained variety, branding timing varies deliberately, and preview
  writes no history.

## Phase 4 — make music and silence first-class editorial data

### Files

Create `bumparr/music.py`, empty valid `bumparr/config_files/music_beds.yaml`,
and `tests/test_music.py`. Modify config, produce, card rendering, creative and
sequence modules, API/dashboard, relevant docs/tests, and changelog.

### Tasks

1. Parse/validate the manifest: unique ids, contained regular readable paths,
   allowed energy/families, explicit enable. Never follow an escaping symlink.
2. Add exact legacy setting `ALLOW_UNMANIFESTED_MUSIC=1`, default off.
   Label legacy files operator-owned/uncredited; never fabricate credits.
3. Replace directory/path-only selection consumers with manifest records.
   Legacy `payload.music` works only in compatibility mode. New rows store
   `creative.music_id`.
4. Pair only enabled family/energy-compatible beds, avoiding recent music.
   Missing/disabled/unreadable becomes explicit silence without partial files.
5. Use one offline ffmpeg policy: target -16 LUFS, -1.5 dBTP ceiling, bounded
   excerpts with short fades, AAC 48 kHz stereo output. Do not normalize live
   streams in this phase.
6. Preserve native sound when selected. Keep `native`, `music`, `designed`, and
   `silence` distinct even though conform supplies HLS audio.
7. Snapshot credits into playable payload: id, title, creator, source page,
   license, license URL, attribution. Manifest remains config source; snapshot
   remains historical/export evidence.
8. Expose credits in API/preview. Put on-screen attribution only where a license
   requires it.
9. Extend sequence/simulation diagnostics for repeated beds, treatment shares,
   and large energy transitions.

### Focused verification

```bash
python -W error::ResourceWarning -m unittest \
  tests.test_music tests.test_render_hardening tests.test_processes \
  tests.test_sequence tests.test_simulate tests.test_app_api -v
```

Run ffmpeg/ffprobe fixtures when binaries exist. Done when all new music has a
manifest/operator-owned identity and durable credits, failure becomes silence,
measured output meets documented tolerance, and traversal/repeat regressions
are tested.

## Phase 5 — add truthful channel memory without a social network

### Files

Create `bumparr/generators/channel_memory.py`,
`bumparr/config_files/operator_messages.yaml`, and
`tests/test_channel_memory.py`. Modify jobs, startup/baseline registration,
render refresh integration, config/docs/catalog/dashboard, and changelog.

### Initial kinds and truth rules

| Kind | Source | Freshness/identity |
|---|---|---|
| `channel_statistics` | Registry and `play_history` for a named station channel. | Hourly bucket; record query window and `valid_until`. |
| `previously_on` | Recent reported history joined to current titles/kinds. | Hash channel plus ordered history ids/timestamps; no history means no card. |
| `viewer_achievement` | Deterministic thresholds over actual history, such as 25/100 reported starts. | One stable id per channel+achievement+threshold; never claim a unique viewer. |
| `operator_message` | Validated local YAML. | Stable authored id; optional start/end controls eligibility. |

Use truthful language. Bumparr knows station requests caused entries to cross
start times; it does not know a human watched. Say “this channel has aired,”
not “you watched,” absent future authenticated evidence.

Shipped disabled message example:

```yaml
version: 1
messages:
  - id: example-note
    lines: ["A locally authored message."]
    enabled: false
    starts_at: null
    ends_at: null
    roles: [any]
```

### Tasks

1. Implement pure row/time-to-payload functions; keep SQL in thin callers.
2. Initially restrict claims to `station:live`; never use preview/simulation.
3. Record source channel, history ids/aggregate window, generated timestamp,
   and `valid_until` in every factual payload.
4. Use stable/content-derived ids and idempotent inserts. For expiring
   aggregates, update safely, invalidate/refresh the render, and render outside
   playback.
5. Add a guarded configurable background refresh with `0` disable. Isolate
   failures and cancellation like existing jobs.
6. Validate operator messages: unique bounded id, 1–3 validated lines, types,
   parseable timestamps with start before end, allowed roles, no fetch. Park
   removed/disabled/expired rows rather than deleting them and document whether
   config or operator action owns enable state.
7. Pass cards through existing validation/content filters and creative metadata.
8. Show provenance/freshness/disabled state in dashboard. Add no public form,
   upload, write API, authentication, or user model.

### Verification and acceptance

Test empty history, preview/status/simulation purity, deterministic payloads/
ids, repeat-job idempotency, expiry, deleted history joins, non-viewer wording,
invalid messages, and disabling every memory kind. Done when all factual claims
are evidence/freshness-backed and operator messages are local, opt-in,
validated, and reversible.

## Phase 6 — evaluate the experience and establish release gates

### Files and artifacts

Create `docs/RELEASE_REVIEW.md` and
`tests/fixtures/alignment_playables.json`, then extend simulation/tests. The
review artifact is CLI-generated; do not add another dashboard feature in this
phase. Add only deterministic objective gates to CI.

### Tasks

1. Report item/kind/family/template/brand-mode shares; exact/family/template/
   music repeats; max text run; energy/audio shares; role/zero-score violations;
   relaxation counts; standard break duration error; missing/stale provenance;
   and branded/unbranded frequency.
2. Add a capable fixed fixture and an intentionally constrained fixture, with
   fixed timestamps/seeds.
3. CI asserts only objective invariants: no gated/hard-role selection,
   deterministic JSON, satisfiable run limits, valid media metadata, and
   documented 15/30/60/90-second duration tolerance.
4. Add a read-only review command exporting a fixed ten-minute station-style
   M3U/plan, four standard break packs, and JSON/Markdown sidecar with ids,
   metadata, credits, gaps, and relaxations. Reuse media; do not concatenate/
   re-encode unless operator experience proves necessary.
5. `RELEASE_REVIEW.md` asks whether output feels authored, has enough quiet,
   repeats jokes/compositions, uses roles coherently, balances branding, handles
   music/credits, and tells truthful data/history stories.
6. Record date, commit, profile version/hash, fixture/pool, reviewer, and notes.
   Never create an “Adult Swim similarity” score.
7. Keep distribution metrics diagnostic until real operation justifies gates.

Done when review artifacts reproduce from fixed input/seed, CI covers objective
contracts only, and a human has reviewed ten minutes plus 15/30/60/90-second
packs.

## Compatibility and migration rules

### Existing databases and payloads

- Infer missing creative data; do not bulk-rewrite rows at startup.
- Persist inferred render fields only during an explicit row update/render.
- Preserve unknown payload keys.
- A future need for indexed creative fields requires a separate migration
  proposal; it is not authorized here.

### Existing media and station cache

- Profile/voice changes do not invalidate old renders.
- Template/brand/audio rerenders use existing partial-then-replace safety.
- Changed rendered sources receive new conform keys; retain old usable
  renditions until replacements land.

### Existing clients

- New query parameters are optional and new fields additive.
- Existing fields keep their types and meaning.
- `/fill` keeps returning best effort and explicit gap when no exact fit exists.
- `/playlist.m3u` remains an unsequenced pool listing, not a break playlist.

### Configuration

- Ship valid conservative defaults and document path overrides.
- Runtime invalid config uses the whole default, warns once, and reports status.
- Strict validation exits nonzero/actionably.
- Never partially apply malformed profile/manifest data.

## Required verification for every delivery slice

Run focused phase tests, then from repository root:

```bash
python -m compileall -q bumparr
python -W error::ResourceWarning -m unittest discover -s tests -v
ruff check bumparr tests
node --check bumparr/web/app.js
node --test bumparr/web/app.test.js
git diff --check
docker compose config
```

For Docker/startup/mounted-config changes, also run the clean Compose smoke test
from `.github/workflows/ci.yml`. For render/conform/audio changes, run focused
ffmpeg/ffprobe integration tests and one real short fixture. CI network tests
must mock the network. Record actual commands/results/skips in each pull
request; do not rely on a fixed test-count claim.

## Implementer review checklist

Before completing a phase, review for:

- duplicated scoring or creative inference;
- any floor reviving zero score/family preference;
- payload replacement losing provenance/content;
- global RNG or wall clock inside pure composition;
- DB writes from status/explain/simulation/preview;
- ffmpeg/model/network work entering playback;
- traversal or escaping symlinks in config/music paths;
- unbounded text/list/config input;
- viewer claims unsupported by station history;
- imitation prompts, copied branding, or license assumptions;
- documentation describing future work as shipped.

## Recommended pull-request slices

1. Product contract and catalog truth — Phase 0.
2. Selection truth and simulation foundation — Phase 1.
3. Creative metadata and channel profile — Phase 2 loader/resolver.
4. Break and station sequence grammar — Phase 2 composer/integration.
5. Operator voice and restrained templates — Phase 3.
6. Audio manifest, normalization, and credits — Phase 4.
7. Truthful channel memory — Phase 5.
8. Experience reports and release review — Phase 6.

Each PR states phase/task coverage, API/config changes, compatibility, tests,
remaining work, and whether an owner default changed.

## Explicitly out of scope

- Public accounts, anonymous submissions, uploads, or moderation.
- Scraping Adult Swim or fan bumper archives.
- Bundled commercial recordings, show footage, copied cards, or network marks.
- General episode/movie scheduling.
- Live model/download/ffmpeg/ffprobe work in playback.
- Dynamic scripting, embeddings, recommendation services, distributed jobs, or
  a renderer plugin framework.
- Automatic subjective scoring or an “Adult Swim similarity” metric.
- Hand-authoring metadata for all old assets before inference is proven weak.

## Definition of complete alignment

The work is complete only when documentation/API/dashboard/station express the
same three modes; the catalog is truthful; all selectors honor strict gates;
old/new rows share one creative vocabulary; fill and station share coherent
adjacency policy; voice/presentation/branding/audio are operator-owned and
reproducible; music credits survive through output; channel-memory claims are
evidence/freshness-backed; observation never fabricates history; objective
invariants pass CI; and a repeatable human review has assessed the experience.

The result should feel like one peculiar channel speaking between programmes,
not unrelated files on shuffle, without copying the reference network.
