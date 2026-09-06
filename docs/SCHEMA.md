# Database schema

One SQLite file at `DB_PATH` (WAL mode, 15s busy timeout — the DB is shared by
the app, the CLI subprocesses, and possibly a co-deployed player). Schema lives
in `bumparr/db.py`; this is the reference for what each column means. SQLite is
authoritative. The station conform cache is derived from `playables` and can
be rebuilt; it is not a second source of truth.

## `playables` — the registry

Every bumper of every type. This is the single source of truth: a file without
a row does not play, and a row is only playable when `enabled=1` and
`health='ok'`.

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PK | Stable, namespaced id. Conventions: `vid:<relpath>` (asset-scan), `clip:<stem>:<ts>` (produced), `card:<kind>:…` (cards — content-hash for grounded/seeds, `:seed:` / `:ts:` for generated), `stream:cam:<md5>` (direct cams), `stream:yt:<md5>` (YouTube cams), `img:<relpath>` (still images). |
| `type` | TEXT | `video` \| `card` \| `stream` \| `image`. |
| `kind` | TEXT | The category. Free-form: asset directories map to kinds via `seed.py`'s `CATEGORY` table (or the folder name becomes the kind), cards have their own kinds (`trivia`, `psa`, `number`, `on_this_day`, `weather`, `station_id`, `technical_difficulties`, `dead_air`, …), streams are `webcam`/`window`/…. Kinds are what seasonality, affinity, and pool management operate on. |
| `source` | TEXT | Provenance label: `nasa`, `archive`, `generated`, `seed`, `grounded`, `live-cam`, `youtube-live`, `user-added`, `loc`, `produced`, `render`, …. Descriptive, not load-bearing. |
| `uri` | TEXT | The media pointer. Videos/images: path relative to `ASSET_ROOT`; produced output: `bumpers/<path>` relative to `OUTPUT`; streams: the upstream HLS URL. **NULL until a card is rendered** — that NULL is what keeps unrendered cards out of `/playlist.m3u` and out of `media_url`. |
| `duration` | REAL | Seconds this item occupies the channel. The fill endpoint's contract depends on these being true, so writers set real measured durations (window captures re-probe on every re-capture). |
| `title` | TEXT | Display name. |
| `payload` | TEXT (JSON) | Per-type content. Cards: `lines` / `answer` / `number` / `meaning` / `reveal_after` / optional background query, creator/source/license metadata / `music` (legacy; compatibility mode only). Channel-memory cards also store `channel`, `history_ids`, `window_start`, `window_end`, `generated_at`, `valid_until`, and `memory_kind`. Produced clips: `from`, `window`, `audio`, `slam`, `branded`, `brand`, `base_weight`. Streams: `direct`, `label`, `region`, optional `proxy_hosts` CDN allowlist. Optional `creative` object (family, roles, energy, audio, text_heavy, template, render_seed, brand_mode, music_id) is namespaced here — not sibling columns. Optional `music_credits` snapshot (`id`, `title`, `creator`, `source_page`, `license`, `license_url`, `attribution`) is historical/export evidence; the manifest remains the config source. Missing values are inferred at read time by `bumparr.creative.resolve_creative`; there is no schema migration. |
| `tags` | TEXT | Comma string, freeform. |
| `weight` | REAL | **Declared** editorial weight — the `base` in the rotation model. The system never mutates it; seasonality multiplies at selection time. `0` = deliberately off air. |
| `enabled` | INTEGER | On/off switch. Dated cards (on_this_day) are parked here by the daily rotation; disabling is preferred over deleting because it is reversible. |
| `health` | TEXT | `ok` \| `dead`. Today the asset sweep (`seed.py`) is the only writer of `dead`: it parks a video/image row whose file it can no longer find, `enabled=0, health='dead'`. `/api/pool/revive` re-checks those and restores what is actually fine. The column is also the intended landing place for playback-failure reporting, which nothing ships yet. |
| `fail_count` | INTEGER | Reserved for that same playback-failure reporting — consecutive failures, reset on success. No writer today; `/api/pool/revive` clears it alongside `health` so the pair stays consistent if one arrives. |
| `last_played` | REAL | Unix ts of last air — the station playout writer updates it when an entry starts; it is the recency factor's input. |
| `play_count` | INTEGER | Lifetime plays — station playout increments it when an entry starts; it is the fatigue factor's input (relative to the pool median). |
| `created_at` | REAL | Unix ts. |
| (generated rows) | | Generated candidates use `id` `gen:<output-uuid>`, `source` `generated:<provider>`, `enabled=0`, `weight=0` until approval. `payload.generation` holds provider/model/prompt/cost/review snapshots. Generic `/api/pool/enable` cannot approve them. |

## `generation_jobs` — durable paid generation

Additive. Remote workflow state does not live in `playables`.

Job execution status is separate from per-output `review_status`. Ambiguous
create (`submitting` without a stored provider job id) becomes
`submission_unknown` and never automatically creates another paid job.

The worker claims and resumes these rows across restarts; it does not create a
second provider job when a submission is ambiguous. Reservations, provider
identity, capability/pricing snapshots, and usage remain durable and secret
free. Local raw downloads live under `GENERATION_STAGING_DIR`; normalized
candidates live under `GENERATION_OUTPUT_DIR` and are quarantined until the
output row is registered.

Columns match `bumparr/db.py`: local id, provider/model aliases, briefs,
secret-free request/capability/usage JSON, provider job id, UTC `budget_day`,
integer micro-USD reservations, and timestamps. Money is never stored as
binary float.

## `generation_outputs` — one candidate per artifact

`processing_status` (`pending`/`processing`/`ready`/`failed`) is independent of
`review_status` (`pending`/`approved`/`rejected`/`deleted`). Approval is the
only writer that enables the linked playable and restores proposed weight
`1.0`.

Pending, rejected, and failed candidates remain review/audit records; they are
not playable and do not enter random, fill, M3U, or station selection. Deleting
an output preserves the job audit while removing its private media according to
the configured retention/cleanup rules.

Station timeline entries also keep in-memory `family`, `text_heavy`,
`energy`, `audio`, `template`, and `music_id` for adjacency. Those are not
columns; they are derived from `payload.creative` at pick time. No schema
migration.

### `payload.creative`

Optional namespaced metadata. Missing or partial objects are inferred at
read time; explicit valid fields win. Allowed values:

| Field | Allowed values / meaning |
|---|---|
| `family` | `text`, `scenic`, `archive`, `data`, `window`, `ident`, `failure`, `authored` |
| `roles` | subset of `any`, `open`, `inside`, `close`, `return`, `ident`, `standby` |
| `energy` | `quiet`, `neutral`, `loud` |
| `audio` | `native`, `music`, `designed`, `silence`, `unknown` |
| `text_heavy` | boolean adjacency signal |
| `template` | `minimal_center`, `minimal_corner`, `image_caption`, `information_board`, `signal`, `ident`. Missing means the compatible default. Strict creation/preview rejects an incompatible explicit value; runtime rendering falls back. |
| `render_seed` | non-negative integer for stable variation |
| `brand_mode` | `reveal`, `static`, `none` |
| `music_id` | Manifest id or null. New rows store this; legacy `payload.music` is compatibility-mode only. |

### `type='card'` lifecycle

`uri` NULL (payload only, browser-player visible) → `render_cards` writes the
MP4 and sets `uri` + `payload.branded/brand` → the card becomes a normal
playable. Volatile kinds (`local_time`, `weather`) additionally carry a TTL and
are re-rendered by the volatile-refresh loop; their `uri` is set but the file
expires.

### Upsert rule

`db.upsert_playable` is `INSERT OR IGNORE` — atomic and idempotent, so the
asset scan, generators, and a co-deployed player can all reseed concurrently
without UNIQUE-constraint races. Writers that need "did I insert?" check
`rowcount`/`total_changes`.

## `playout` — channel playout cursor

| Column | Meaning |
|---|---|
| `channel_id` | PK; which channel (the registry is per-pool, playout is per-channel). Station values are `station:live` and `station:standby`. |
| `current_id` | The playable currently airing. |
| `started_at` | Unix ts it started. |

The station playout is the shipped writer, upserting one cursor per channel as
entries air. Other players may also write their own channel values.
Status, preview, and dashboard inspection never write history. The rotation
model consumes history and the denormalized `last_played`/`play_count`
values.

## `play_history`

| Column | Meaning |
|---|---|
| `id` | autoincrement. |
| `channel_id` | which channel played it; station values are `station:live` and `station:standby`. |
| `playable_id` | the row played. |
| `played_at` | Unix ts. The station writes one row per aired entry; its built-in slate is never recorded. Status and preview never insert rows. |

Indexed on `(channel_id, played_at DESC)`. This is the raw feed; the
rotation model works off the denormalized `last_played`/`play_count` columns
so selection stays a single-table read. Channel-memory cards read
`station:live` rows only; `station:standby`, preview, and simulation are
never evidence. Status and preview never insert rows.

## Migrations

`db._migrate` is additive-only (create missing columns), run from
`init_db()`, which every entry point calls. Never drop or rename a column in
place — add a migration.
