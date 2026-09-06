# First-class generative content system plan

**Status:** proposed execution specification; no new generation-provider
integration is currently claimed as shipped

**Research checked:** 2026-09-05 against the MiniMax H3 V2 and OpenRouter text,
image, video, discovery, routing, and privacy documentation

**Initial adapters:** MiniMax's hosted H3 API and OpenRouter

**Initial output:** review-gated audiovisual bumper videos

**Later outputs on the same core:** generated images and invented text cards

**Explicitly out of scope:** downloading or serving model weights

## Purpose

Build a durable, provider-neutral generation system for original,
operator-directed Bumparr content. MiniMax H3 is the first high-value model,
but it must enter through a small provider contract that can also drive other
video models through OpenRouter and later create images and invented text cards.

“First-class” means more than accepting downloaded files. An operator can
choose an allowed model, preview the exact request and estimated charge, create,
monitor, inspect, approve, reject, trace, schedule, and delete a candidate
through the same registry and editorial system as every other bumper.

The integration must preserve Bumparr's central product contract:

- generation creates candidates, never automatic programming decisions;
- no paid or computationally heavy operation runs in a playback request;
- SQLite remains authoritative;
- a file is not eligible to air until it is valid, registered, explicitly
  approved, enabled, healthy, and positively scored;
- generated work follows the operator's channel identity and does not imitate
  Adult Swim or another named artist, studio, network, or living creator;
- the operator can understand the provider, source, prompt, model, references, cost
  units, review state, and final media treatment of every generated item.

Read these documents before implementation:

1. [PRODUCT_VISION.md](PRODUCT_VISION.md)
2. [CREATIVE_REFERENCE.md](CREATIVE_REFERENCE.md)
3. [ARCHITECTURE.md](ARCHITECTURE.md)
4. [SCHEMA.md](SCHEMA.md)
5. [FRONTEND_PLAN.md](FRONTEND_PLAN.md)
6. this plan

When they conflict, the product and originality boundaries in the first two
documents win.

## Decision summary

Implement one compact generation core with explicit adapters. Do not begin with
local inference and do not build a dynamically loaded plugin framework.

The core owns durable jobs, model allow-listing, capability checks, spend
reservations, reference validation, result ingestion, review, provenance, and
playable registration. An adapter owns only the provider protocol: request
construction, submit/query semantics, provider status/error mapping, and safe
result retrieval.

Initial adapters:

| Adapter | Why it exists | Initial scope |
|---|---|---|
| `minimax` | Complete first-party H3 V2 contract | H3 text-to-video first; H3 frame/reference modes next |
| `openrouter` | One account and API across multiple current video models, then image/text | Capability-discovered text-to-video first; frame images only where advertised |
| `openai_compatible` | Preserve Bumparr's existing self-hosted/cloud card-model option | Existing invented-card generation during migration; no media generation |

OpenRouter is not merely an OpenAI-compatible chat endpoint anymore. Its
current API includes dedicated image and asynchronous video generation, plus
model endpoints that publish supported durations, resolutions, aspect ratios,
frame inputs, audio behavior, passthrough fields, and pricing units. The
implementation must use those media endpoints rather than trying to force video
through `/chat/completions`.

The current MiniMax documentation exposes H3 through:

```text
POST /v2/video_generation
GET  /v2/query/video_generation/{task_id}
```

Creation returns a provider `task_id`. Querying returns `queued`, `running`,
`succeeded`, `failed`, or `cancelled`; on success, `task.content.url` is the
download URL. MiniMax recommends polling about every ten seconds. The API is
therefore already asynchronous, and Bumparr must persist its side of the job
rather than wrapping the entire operation in `app.py`'s transient `_JOBS`
dictionary.

OpenRouter's current video API is:

```text
GET  /api/v1/videos/models
POST /api/v1/videos
GET  /api/v1/videos/{job_id}
GET  /api/v1/videos/{job_id}/content?index=0
```

OpenRouter currently identifies H3 as `minimax/hailuo-3`; MiniMax's direct API
identifies it as `MiniMax-H3`. These are provider-scoped identifiers, not a
single global name. Store both the operator-facing model alias and the exact
provider model/canonical identifier used for each job.

Use direct `MiniMax-H3`, not an older Hailuo model, for the first direct
adapter. H3 supports:

- text-to-video;
- first-frame, last-frame, and first-plus-last-frame generation;
- reference generation using images, videos, and/or audio;
- `768P` and `2K` output;
- integer durations from 4 through 15 seconds;
- explicit `16:9` output for text and reference generation.

Those capabilities align closely with Bumparr's short interstitial format.
OpenRouter's live catalog exposes a different H3 subset, and other OpenRouter
models expose still different capabilities. Never infer an OpenRouter model's
contract from the direct provider's documentation.

H3 Max and other OpenRouter video models can be admitted through the operator's
model allow-list once their discovered capabilities satisfy Bumparr's required
16:9 video contract. Adding a model using an existing adapter should be
configuration plus tests, not new scheduler or playback code.

### Reviewed capability matrix

This is design evidence as of the research date, not a forever-static runtime
catalog:

| Route | Provider model id | Video contract observed | Inputs relevant to Bumparr |
|---|---|---|---|
| MiniMax direct | `MiniMax-H3` | 4–15s integers, `768P`/`2K`, 16:9 | text; first/last frames; reference images/video/audio; native audio-video |
| OpenRouter | `minimax/hailuo-3` | 5–15s in its video-model descriptor, `2K`, 16:9 | text; first/last frames; generated audio; only other references if discovery explicitly adds them |
| OpenRouter other video models | manifest alias → discovered slug | model-specific | never assumed; use `/api/v1/videos/models` |
| OpenRouter image models | manifest alias → discovered slug | model-specific image parameters | text and only advertised reference-image modes |
| OpenRouter text models | manifest alias → catalog slug | text/structured-output capability | invented cards only |

The direct and routed H3 rows are not fallback substitutes. If an operator
selects one, preserve that route. Capability discovery may remove an unavailable
choice, but must never silently move a direct job to OpenRouter or vice versa.

**Implementation research note (re-checked 2026-09-05):** MiniMax's create
OpenAPI now also documents `MiniMax-H3-Max` (480P/768P, 5–15s, text and
first/last frame only; no reference; no 2K). G0–G5 still implements
`MiniMax-H3` text-to-video only; H3-Max and frame/reference stay unavailable
until G6 / a later allow-listed adapter mode. OpenRouter's guide still forbids
trusting `polling_url` / `unsigned_urls` for this project (reconstruct
`/api/v1/videos/{job_id}` and `/content`), and video remains not ZDR-eligible.
Repo CI is `unittest discover`, not pytest. See
[GENERATION_IMPLEMENTATION_STATUS.md](GENERATION_IMPLEMENTATION_STATUS.md).

## Hosted API and local-weight distinction

H3 is API-based for this project. MiniMax separately publishes H3-Base weights
and documents local serving, but that is not required to call the hosted API.
The local example's multi-GPU requirements do not apply to the proposed
Bumparr integration.

The open-weight community license, MiniMax hosted API terms, OpenRouter terms,
and selected downstream provider's terms are different decision surfaces.
Bumparr will neither ship nor download weights. Operators must still accept and
comply with applicable current terms, content rules, pricing, territorial
availability, and output-use conditions. The project must link to live terms
instead of embedding a claim that they permit a particular use. This plan is an
engineering specification, not legal advice.

OpenRouter adds a routing layer; it does not replace downstream-provider rights
or privacy review. Model/provider capability and policy metadata are captured at
submission so a later catalog change cannot rewrite what happened historically.

## Product outcome

The finished experience should be:

1. The operator opens the Generation view.
2. Bumparr shows only configured, enabled, capability-compatible model aliases;
   provider/model identifiers and privacy routing remain visible in details.
3. The operator chooses video, image, or invented card where implemented,
   writes an original creative brief, chooses supported options and references,
   and sees the paid-service consequence before submitting.
4. Bumparr validates the request, provider capability snapshot, and durable
   budget before contacting the selected provider.
5. The job remains visible across page reloads and service restarts.
6. On success, Bumparr safely obtains, validates, normalizes or structurally
   validates, and registers each output as disabled and awaiting review.
7. The operator watches, views, or reads it as appropriate, inspects its
   provenance, and approves or rejects it.
8. Approval makes it eligible under ordinary rendering, scoring, conformance,
   and sequencing rules.
9. Rejection keeps it out of rotation and leaves an auditable record; deletion
   remains a separate deliberate action.

The generated clip should feel like a piece selected for a channel, not a raw
model demo.

## Non-goals

- Local media-model inference, model downloads, GPU scheduling, or ComfyUI
  integration. The existing OpenAI-compatible text endpoint remains supported.
- Automatic unattended prompt generation and spending in the first release.
- Generating long-form programmes, promos for copyrighted shows, or synthetic
  replicas of real people.
- Mirroring every model in a provider catalog or allowing arbitrary model ids.
- A dynamically installed provider/plugin marketplace. Adapters are reviewed
  code; models are operator allow-listed data.
- Public prompt submission or public uploads.
- Calling any generation provider from station, playlist, random, fill, status,
  or preview request paths.
- Automatically enabling a generated result.
- Treating provider moderation as Bumparr's complete editorial review.
- Uploading arbitrary filesystem paths or allowing URL-based SSRF.
- Using generated outputs to train another model.
- Hard-coding current dollar prices, which can change independently of code.

## Current Bumparr architecture relevant to this work

| Concern | Existing implementation | Generation-system implication |
|---|---|---|
| Authority | SQLite `playables` | Approved outputs become ordinary playables. |
| Transient actions | `app.py` `_JOBS` | Not durable enough for paid remote jobs. |
| Background work | `jobs.py` lifespan loops | Add one bounded generation worker loop. |
| Content metadata | JSON `playables.payload` | Store a stable generation/provenance snapshot. |
| Editorial gate | `enabled`, `health`, `weight` | Land generated rows disabled until approval. |
| Creative metadata | `payload.creative` | Reuse family, roles, energy, audio, and brand fields. |
| Selection | `selection.py` and `sequence.py` | No provider/model-specific scoring path. |
| Station media | `station/conform.py` | Approved output conforms like any other video. |
| File safety | `paths.py`, capped downloads | Reuse containment and fail-closed network rules. |
| Operator UI | dependency-free `bumparr/web/` | Add generation and review workflows without a framework. |
| API security | no authentication | Feature is opt-in and documented for trusted networks only. |

## Architectural invariants

An implementation is wrong if it violates any of these:

1. No new provider create call is made when generation or its provider/model is
   disabled, unconfigured, over budget, or given an invalid request. Already
   accepted durable jobs may still be queried and retrieved while new
   generation is disabled, as defined in recovery.
2. The API key is never stored in SQLite, returned by an endpoint, written to a
   log, included in an exception, or sent to the browser.
3. Provider task state survives process restart.
4. Restart recovery never blindly submits a second paid generation.
5. Downloaded bytes are untrusted until validation and normalization finish.
6. A candidate cannot appear in random, fill, M3U, or station output before
   explicit approval.
7. Approval uses existing eligibility and sequence policy; it creates no
   provider-only bypass.
8. Rejection, cancellation, failure, and deletion are distinct states.
9. Reference inputs come only from explicitly selected, contained Bumparr
   assets; arbitrary server paths are never accepted.
10. Simulation, status, list, preview, and review reads never contact a provider or
    mutate playout history.
11. Tests never call or spend against a real generation API.
12. Through G0–G7, existing installations behave exactly as before when
    generation settings are absent. G8 is an explicit migration of already
    configured model-generated invented cards: commands/config remain accepted,
    model-free paths remain unchanged, and model outputs gain the review gate
    described in that phase.

## Deliberately small system shape

Add one domain package, two explicit provider adapters, two small SQLite tables,
one background loop, a small API surface, and one operator view:

```text
operator POST
    |
    v
generation_jobs row (queued; durable)
    |
    v
jobs.generation_loop
    |
    +--> selected adapter --> provider job id --> poll if asynchronous
    |                                              |
    |                                              v
    +<---------------------------------------- result descriptor
    |
    v
capped temporary download --> ffprobe --> normalize --> sha256
    |
    v
generation_outputs row + disabled playable + pending review
    |
    +--> approve --> normal selection/conform/station
    +--> reject  --> remains disabled
```

Do not add Redis, Celery, a webhook receiver, a second service, a frontend
framework, entry-point plugin loading, or a generic workflow engine. Two small
adapter classes are sufficient evidence for the core interface; do not invent
extension points that neither adapter needs.

## Configuration contract

Add these settings to `bumparr/config.py`, `.env.example`, and
`docs/CONFIG.md`:

| Variable | Default | Contract |
|---|---|---|
| `GENERATION_ENABLED` | `0` | Exact `1` enables paid/remote submission. Every other value is off. |
| `GENERATION_MODELS` | bundled `config_files/generation_models.yaml` | Path to the operator allow-list of provider/model aliases and safe defaults; the bundled file contains `models: []`. |
| `GENERATION_DEFAULT_MODEL` | empty | Alias from the manifest; empty requires an explicit choice. |
| `MINIMAX_API_KEY` | empty | Bearer credential. Presence alone does not enable spending. |
| `OPENROUTER_API_KEY` | empty | OpenRouter bearer credential. Presence alone does not enable spending. |
| `LLM_API_KEY` | empty | Optional credential for the legacy OpenAI-compatible text adapter. |
| `GENERATION_POLL_SECONDS` | `10` | Base poll interval, clamped 5–60; adapters may enforce a higher documented minimum. |
| `GENERATION_MAX_ACTIVE` | `1` | Concurrent submitted/running provider jobs, clamped 1–3. |
| `GENERATION_DAILY_JOBS` | `10` | Maximum provider-accepted jobs per UTC day. |
| `GENERATION_DAILY_VIDEO_SECONDS` | `60` | Maximum provider-accepted requested video seconds per UTC day. |
| `GENERATION_DAILY_USD` | `5.00` | Estimated local daily ceiling; configure provider account/key/workspace limits where available. |
| `GENERATION_DOWNLOAD_MAX_MB` | `250` | Actual streamed-byte ceiling for one media output. |
| `GENERATION_STAGING_DIR` | `DATA_DIR/generation-staging` | Private raw/partial staging; must not be beneath a statically served media root. |
| `GENERATION_OUTPUT_DIR` | `ASSET_ROOT/generated` | Proper contained descendant used only for normalized candidates; it may not equal `ASSET_ROOT`. |

Do not make known hosted provider origins arbitrary in production. Use
`https://api.minimax.io` and `https://openrouter.ai` as adapter constants. Unit
tests inject a fake transport/client object rather than redirecting production
code through an arbitrary URL. A future regional provider endpoint must be a
strict enumerated option reviewed with its terms and API contract.

### Model manifest

Add `bumparr/config_files/generation_models.yaml`, shipping as `models: []` so a
fresh install cannot spend. The checked-in file may include commented examples
but no enabled remote model.

```yaml
models:
  - id: h3-direct
    provider: minimax
    model: MiniMax-H3
    output: video
    enabled: true
    allowed_modes: [text, first_frame, last_frame, first_last, reference]
    default_duration: 8
    default_resolution: 768P
    default_aspect_ratio: "16:9"
    cost_ceiling:
      unit: video_second
      max_usd_per_unit: "0.20"  # operator-reviewed; example, not a quoted price

  - id: h3-openrouter
    provider: openrouter
    model: minimax/hailuo-3
    output: video
    enabled: true
    allowed_modes: [text, first_frame, last_frame]
    default_duration: 8
    default_resolution: 2K
    default_aspect_ratio: "16:9"
```

The manifest is an operator allow-list, not a second catalog. It contains only
stable choices and editorial defaults. It cannot enlarge a provider's live or
built-in capabilities. Effective capability is the intersection of:

```text
Bumparr modality rules
  ∩ adapter implementation
  ∩ manifest allow-list
  ∩ provider/model capability snapshot
```

Validate the entire manifest with `python -m bumparr.generation.models --check`.
Duplicate aliases, unknown providers/outputs/modes, arbitrary URLs, unknown
fields, or invalid default combinations reject the whole custom manifest and
leave no remote model enabled. Missing credentials and a currently incompatible
discovery snapshot make only the affected otherwise-valid alias unavailable.
Runtime must never partially reinterpret an invalid entry into a looser request.

Configuration behavior:

- `GENERATION_ENABLED=1` without the selected provider's key reports that model
  alias `configured=false` and rejects creation without making a request.
- A key with `GENERATION_ENABLED=0` reports provider configured but generation
  disabled.
- `GENERATION_OUTPUT_DIR` must resolve as a proper descendant of `ASSET_ROOT`
  without traversing an escaping symlink; invalid configuration disables
  generation before work lands.
- `GENERATION_STAGING_DIR` must resolve as a proper descendant of `DATA_DIR`
  and outside `ASSET_ROOT` and `OUTPUT`. Raw, partial, base64-decoded, and
  pre-normalized provider bytes must never be reachable through `/media`.
- `/api/status` may expose enabled/configured, safe model aliases, defaults, budget usage,
  queue counts, and last non-sensitive error. It must never expose the key,
  prompt bodies, provider URLs, or raw provider responses.
- Parse numeric settings as finite bounded values. Invalid or non-positive daily
  caps fall back to their safe defaults with one bounded warning; zero never
  means unlimited. Parse monetary values with `Decimal`, not `float`.
- Queued jobs provisionally reserve daily job/video-second/USD capacity; provider
  acceptance makes that usage non-releasable even if output later fails. Failed
  paid work must not evade the cap.
- A request whose cost cannot be estimated may not proceed while a local USD
  ceiling is enabled. The manifest may provide an operator-reviewed conservative
  maximum unit price for direct providers without a discovery price.
- Encourage provider-enforced account, key, or workspace spending limits where
  the selected service offers them. Local accounting protects normal operation
  but cannot be a financial guarantee across multiple Bumparr instances or
  out-of-band account use.
- Read and validate the manifest at process startup. File changes take effect
  after a restart; do not add a partial hot-reload path to the first release.

## Persistent data model

Add additive `generation_jobs` and `generation_outputs` tables in
`bumparr/db.py`. Do not put remote workflow state into `playables` and do not
overload `play_history`.

```sql
CREATE TABLE IF NOT EXISTS generation_jobs (
  id                 TEXT PRIMARY KEY,
  parent_job_id      TEXT,
  status             TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model_alias        TEXT NOT NULL,
  provider_model     TEXT NOT NULL,
  provider_model_canonical TEXT,
  output_modality    TEXT NOT NULL,
  mode               TEXT NOT NULL,
  operator_brief     TEXT NOT NULL,
  submitted_prompt   TEXT NOT NULL,
  title              TEXT NOT NULL,
  kind               TEXT NOT NULL,
  request_json       TEXT NOT NULL DEFAULT '{}',
  references_json    TEXT NOT NULL DEFAULT '[]',
  creative_json      TEXT NOT NULL DEFAULT '{}',
  capability_json    TEXT NOT NULL DEFAULT '{}',
  provider_job_id    TEXT,
  provider_generation_id TEXT,
  provider_request_id TEXT,
  usage_json         TEXT NOT NULL DEFAULT '{}',
  budget_day         TEXT NOT NULL,
  reserved_jobs      INTEGER NOT NULL DEFAULT 0,
  reserved_video_seconds INTEGER NOT NULL DEFAULT 0,
  reserved_cost_microusd INTEGER NOT NULL DEFAULT 0,
  actual_cost_microusd INTEGER,
  error_code         TEXT,
  error_message      TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    REAL,
  created_at         REAL NOT NULL,
  updated_at         REAL NOT NULL,
  submitted_at       REAL,
  completed_at       REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_provider_job
  ON generation_jobs(provider, provider_job_id)
  WHERE provider_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generation_status_updated
  ON generation_jobs(status, updated_at);

CREATE TABLE IF NOT EXISTS generation_outputs (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  modality           TEXT NOT NULL,
  processing_status  TEXT NOT NULL,
  review_status      TEXT NOT NULL,
  playable_id        TEXT,
  output_sha256      TEXT,
  media_path         TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  review_reason      TEXT,
  created_at         REAL NOT NULL,
  updated_at         REAL NOT NULL,
  reviewed_at        REAL,
  UNIQUE(job_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_generation_output_review
  ON generation_outputs(review_status, updated_at);
```

Implementation details:

- Job `id` is a collision-resistant local id such as `gen:<uuidhex>`; output
  ids add a bounded ordinal.
- `parent_job_id` links an explicit regenerate/retry to its source job without
  rewriting either audit record; it is NULL for an original request.
- Separate execution status from output review status. One image or text request
  may produce multiple candidates, and approving one must not approve siblings.
- `operator_brief` and `submitted_prompt` are preserved because editorial provenance and regeneration require
  it. The UI must warn operators not to put secrets or private personal data in
  prompts.
- `request_json` is a normalized, secret-free request, not a raw HTTP body.
- `request_json` records the multimodal rights/privacy acknowledgement timestamp
  when references are present; absence fails preflight rather than being
  inferred from submission.
- `references_json` stores playable ids, roles, source hashes, and the media
  metadata used at submission. It never stores base64 bodies.
- `creative_json` stores the requested roles, energy, and related metadata
  before a playable exists.
- `capability_json` freezes the provider/model capabilities, pricing inputs, and
  adapter version used by preflight. Never claim the current catalog describes
  an old job.
- `usage_json` stores only documented, bounded usage fields from the successful
  query response.
- Parse configured and discovered prices with decimal arithmetic, then store
  reserved/reported money as integer micro-US-dollars. Never use binary floating
  point for cap enforcement. Budget usage for a job is the greater of its
  accepted reservation and reported actual charge when known.
- `generation_outputs` stores one candidate per returned artifact. `media_path`
  is contained and relative; it is NULL for a text candidate before rendering.
- Error messages are normalized and length-capped; raw HTTP bodies are not
  persisted.
- The output/job relationship is enforced by service transactions and indexes;
  do not introduce cascade deletion. The generation audit record may outlive a
  deleted playable, and current database connections do not enable foreign-key
  enforcement.

Use transactions and compare-and-set updates (`WHERE status = ?`) when a worker
claims or advances a job. Multiple app processes are not a supported topology,
but the database contract should still prevent two loops in one deployment
from claiming the same queued row.

## State machine

Allowed local states are deliberately split between provider/local execution
and editorial review:

```text
queued
  -> submitting
  -> submitted
  -> running
  -> downloading
  -> processing
  -> completed

queued/submitted/running -> cancel_requested -> cancelled
any active state -> failed
submitting -> submission_unknown (only during crash recovery)
submission_unknown -> submitted | running | downloading (verified provider id)
submission_unknown -> failed (operator-confirmed not accepted)

per-output processing_status:
pending -> processing -> ready | failed
failed -> processing (explicit local retry only; never provider create)

per-output review_status:
pending -> approved | rejected | deleted
approved | rejected -> deleted
```

Rules:

- `queued` has incurred no provider request.
- Set `submitting` and commit before the create call.
- Store `provider_job_id`, set `submitted`, and commit immediately after a
  successful create response.
- Unless an adapter has a documented idempotency key that Bumparr actually
  sends, a process death after provider acceptance but before job-id commit must
  change stale `submitting` rows to `submission_unknown`. It must not resubmit
  automatically and risk a duplicate charge.
- `submission_unknown` is excluded from the automatic worker. It remains
  visible and retains its budget reservation until deliberate reconciliation:
  a verified provider job id resumes at the provider's observed state, while an
  operator-confirmed “not accepted” outcome becomes `failed` with code
  `confirmed_not_submitted` and releases the provisional reservation.
- For a provider `queued` response retain local `submitted`; for provider
  `running`, use local `running`.
- `completed`, `failed`, and `cancelled` are terminal execution states. Retrying creates a new local generation
  linked in the response as a retry; it never rewinds or overwrites the old row.
- Cancellation before submission prevents spending. Cancellation after
  submission is best-effort only unless the selected adapter documents and
  implements a supported cancel endpoint. The UI must say that local cancellation may not cancel provider
  billing or execution.
- A local processing retry is valid only when a complete private staged artifact
  remains or the same accepted asynchronous provider job can be queried again.
  It may repeat retrieval/validation/normalization, never provider creation.
- An output may become processing `ready` only with a structurally valid
  candidate and disabled playable row in one final transaction. The separate
  review status remains `pending` until an operator acts.
- Only the approval endpoint can set output review state `approved` and enable
  its row.
- A DB failure after the normalized file lands leaves an unregistered contained
  file that the next recovery pass can reconcile by generation id and checksum.
- A job becomes `completed` once the provider operation and all local output
  processing attempts are terminal. Individual outputs may be processing
  `ready` with review `pending`, or processing `failed`; partial success is
  preserved. A provider failure before
  any result descriptor makes the job `failed`.

Budget reservation is also transactional. Enqueueing reserves conservative
job/video-second/USD amounts so rapid requests cannot fill a queue past a cap.
These are provisional until provider acceptance. Cancellation or a definitive
provider rejection before acceptance releases them; provider acceptance or an
ambiguous network outcome retains them. `budget_day` is the UTC calendar date
the reservation belongs to. If a queued job crosses midnight, the worker must
atomically move its reservation to the new day and re-check capacity before
claiming it. Actual reported cost is recorded separately; if it exceeds the
estimate, remaining local budget may go negative and further submissions stop.
Completion time does not move an accepted reservation to another day.
An unresolved `submission_unknown` also occupies one active-concurrency slot;
uncertainty must not open capacity for additional spend.

Synchronous provider APIs still use this state machine. The worker sets
`submitting`, calls once, and immediately persists bounded returned text in its
output row or writes media to a private durable staging artifact, together with
the secret-free descriptor and provider request/generation identifier. It then
proceeds to processing without polling. If the process dies after the provider
may have accepted the request but before that durable commit, recovery uses
`submission_unknown` and never resubmits automatically. HTTP request threads
only enqueue work; they never wait on a “synchronous” provider.

## Generation core and provider adapters

Create a small `bumparr/generation/` package:

```text
generation/
  models.py             model-manifest parsing and capability intersection
  service.py            enqueue, claim, state transitions, budget, review
  worker.py             provider-independent execution and recovery loop
  media.py              untrusted image/video result validation and normalization
  providers/
    base.py              typed protocol and shared result/error objects
    minimax.py           direct MiniMax H3 V2
    openrouter.py        OpenRouter video, image, and chat APIs by phase
    openai_compatible.py compatibility adapter for existing invented cards
```

This is a code organization, not a plugin system. `providers/__init__.py`
contains an explicit mapping from the three known provider names to adapter
constructors. There is no import-by-string, entry-point discovery, arbitrary
URL, or generic passthrough dictionary.

Adding a future provider means implementing this same narrow contract, adding
its fixed HTTPS origin and environment-only credential explicitly, registering
it in that mapping, extending manifest validation, and landing recorded fake
protocol tests for every claimed modality/state/error. Adding another model to
MiniMax or OpenRouter needs only an allow-list entry and capability fixtures when
the existing adapter already expresses its contract. Neither operation may add
provider branches to selection, review, or playback.

The narrow adapter protocol should express only demonstrated differences:

```python
class GenerationProvider(Protocol):
    def capabilities(self, model: ModelConfig) -> CapabilitySnapshot: ...
    def estimate(self, request: GenerationRequest,
                 capabilities: CapabilitySnapshot) -> CostEstimate: ...
    def submit(self, request: GenerationRequest) -> ProviderSubmission: ...
    def query(self, provider_job_id: str) -> ProviderResult: ...
    def fetch(self, result: ProviderResult,
              staging_dir: Path, limits: DownloadLimits) -> list[RawOutput]: ...
```

`query` may return an explicit `not_applicable` result for synchronous image or
text APIs. `fetch` may decode a bounded base64 result or securely download media;
it never registers a playable. Optional cancellation is a declared capability,
not a required method that adapters fake.

### Capability snapshot

Normalize provider capabilities into a bounded internal structure:

- provider, provider model id, canonical/versioned model id when available;
- output modality (`video`, `image`, `text_card`);
- supported input and generation modes;
- allowed durations, resolutions, aspect ratios, sizes, and output counts;
- supported reference types/counts and reference byte/media constraints;
- audio-generation and deterministic-seed support;
- provider-specific option names Bumparr intentionally supports;
- synchronous/asynchronous behavior and recommended polling interval;
- discoverable pricing units and values;
- data retention/training/routing properties the provider actually exposes;
- retrieval timestamp and adapter contract version.

The frontend never submits an arbitrary parameter merely because it appears in
discovery. The adapter has a code-reviewed parameter allow-list, and effective
capabilities are narrowed by the model manifest. Unknown capability fields are
preserved only in a bounded raw hash/version for diagnostics, not reflected into
provider requests.

### MiniMax direct adapter

Use:

```text
POST https://api.minimax.io/v2/video_generation
GET  https://api.minimax.io/v2/query/video_generation/{task_id}
```

Build the multimodal `content[]` array from validated internal references.
Map `queued`, `running`, `succeeded`, `failed`, and `cancelled`. On success,
retrieve `task.content.url` with the untrusted-result downloader. The adapter's
built-in capability declaration reflects the reviewed H3 V2 docs; it must be
versioned and rechecked before release. MiniMax currently limits task queries
to tasks from the preceding seven days; surface an older unrecoverable task as
`provider_expired`, retain its audit/spend record, and never resubmit it
automatically.

### OpenRouter adapter

Use the dedicated endpoint for the requested modality:

```text
GET  https://openrouter.ai/api/v1/videos/models
POST https://openrouter.ai/api/v1/videos
GET  https://openrouter.ai/api/v1/videos/{job_id}
GET  https://openrouter.ai/api/v1/videos/{job_id}/content?index=N

GET  https://openrouter.ai/api/v1/images/models
POST https://openrouter.ai/api/v1/images

GET  https://openrouter.ai/api/v1/models
POST https://openrouter.ai/api/v1/chat/completions
```

Video submission maps OpenRouter `pending`, `in_progress`, `completed`, and
`failed` into core states, and defensively maps the documented terminal webhook
states `cancelled` and `expired` if polling returns them. `expired` is a stable
provider failure, not permission to create a replacement. Reconstruct
poll/content paths from the validated job id rather than trusting a returned
`polling_url` or `unsigned_urls` value. The content endpoint requires the
OpenRouter credential; credentials are sent only to the exact OpenRouter origin
and stripped before any validated cross-origin redirect.

OpenRouter image and chat responses are synchronous but still run in the
durable worker. Image base64 is decoded with preallocation/decoded-byte caps,
then treated as untrusted media. Invented cards require strict JSON Schema when
the selected model advertises it and `require_parameters` can enforce support;
the existing structural and content validation remains authoritative.

Refresh OpenRouter model discovery in a background cache with an expiry of at
least one hour. Creation performs preflight against a fresh-enough snapshot and
stores it on the job. If discovery is unavailable and no unexpired snapshot
exists, fail closed before spending. Do not expose all discovered models to the
operator; expose only manifest aliases whose current capabilities still match.
Do not refresh discovery merely because a status/models page was read. The
worker refreshes only when generation is enabled, a key is configured, and at
least one enabled OpenRouter alias needs it; durable accepted-job recovery is
the only provider activity allowed while new generation is disabled.

OpenRouter can route among downstream providers. Its current video contract
documents provider-specific passthrough options but does not document the same
pin/no-fallback controls available on its image/chat routes. Do not send those
chat/image fields to video or claim a downstream provider is fixed. The video
alias must explicitly disclose routed-provider uncertainty before submission,
and the job records the routed provider when a response exposes it. If policy
requires a fixed downstream provider and the video endpoint cannot enforce one,
preflight must reject that alias rather than pretend. Image/chat phases may use
their documented pin, fallback, data-collection, and parameter-support controls.

OpenRouter documents that asynchronous video generation is not eligible for
Zero Data Retention because output must be retained for retrieval. Do not send
`zdr=true` for video and do not label it ZDR. For text/image requests, use
`provider.data_collection="deny"` and optional ZDR only when documented and
configured; a request that cannot meet the selected privacy policy must fail
closed rather than silently loosen it.

### OpenAI-compatible compatibility adapter

Preserve `LLM_BASE`, `LLM_MODEL`, and `LLM_DISABLE_THINKING`. Add optional
`LLM_API_KEY` bearer auth so an operator can point the existing card path at a
hosted OpenAI-compatible endpoint. `LLM_BASE=https://openrouter.ai/api/v1` plus
an OpenRouter key can continue to work, but new installations should prefer the
named `openrouter` adapter so model discovery, cost, provider routing, and
provenance are available.

Migrate `generators/cards.py` to call the core text-card operation only after
the media workflow is stable. Preserve its CLI, seeds, prompts, validation,
grounded/non-grounded boundary, and existing `LLM_*` behavior. This refactor
must not make factual cards model-generated.

An existing nonempty `LLM_BASE` is already an operator opt-in to that model
call. In G8, the same card CLI/API action may keep using it without requiring a
new remote model alias, but its model-created candidates become durable and
review-pending instead of immediately eligible. `GENERATION_ENABLED` continues
to gate the new general-purpose Generation HTTP surface and named
MiniMax/OpenRouter adapters. Document this one editorial behavior change in the
release notes; seeded/model-free card output remains unchanged.

### Shared HTTP requirements

HTTP requirements:

- use the standard-library HTTP stack already used by Bumparr for fixed-origin
  provider JSON calls; isolate result downloading behind the peer-aware helper;
  do not add a provider SDK;
- send each bearer credential only to its adapter's exact approved origin;
- use connect/read/overall timeouts;
- cap response bodies before JSON parsing;
- validate response content types and object shapes;
- map 400, 401, 402, 422, 429, and 5xx into stable internal error codes;
- retry query and download transport failures with bounded exponential backoff
  and jitter;
- do not automatically retry an ambiguous create request;
- honor `Retry-After` when it is valid and bounded;
- never include authorization headers on a cross-origin result request;
- redact credentials and signed URLs from logs and errors.

Provider status mapping must reject unknown values rather than treating them as
success. Unknown nonterminal values may remain pending with a bounded warning;
an unknown response shape is a failed protocol operation, not a playable.

## Request contract and validation

### Initial text-to-video request

```json
{
  "model": "h3-direct",
  "output": "video",
  "mode": "text",
  "prompt": "An original creative brief…",
  "title": "Optional operator title",
  "kind": "generated_short",
  "duration": 8,
  "resolution": "768P",
  "ratio": "16:9",
  "creative": {
    "roles": ["inside"],
    "energy": "quiet"
  }
}
```

Shared validation:

- model is a configured manifest alias, never a raw provider slug;
- output/mode/options are supported by the effective capability intersection;
- prompt is required, trimmed, and no longer than the selected model's limit
  (7,000 characters for direct H3 at the time of this review);
- title is 1–120 characters after deriving a safe default when omitted;
- kind uses the project's bounded kind-token validation and defaults to
  `generated_short`;
- duration and resolution are values from the stored effective capabilities;
- ratio is fixed to `16:9` for text generation in this project;
- creative roles and energy use `bumparr.creative` allow-lists;
- family is fixed to `authored`, `text_heavy=false`, and audio is resolved only
  after probing the result;
- `brand_mode` is `none` because no local brand mark has yet been rendered into
  these bytes; do not claim `reveal` metadata for a reveal that does not exist;
- prompt matching is advisory, but reject explicit requests to reproduce Adult
  Swim branding or other prohibited configured phrases before spending.

Do not silently modify the operator's creative content. Bumparr may append a
short technical suffix that requests 16:9 composition, no letterboxing, and no
logos or legible text, but the stored provenance must retain both the operator
brief and the exact submitted prompt.

### Multimodal video requests

Add after text-to-video is complete and reviewed:

- `first_frame`: one image playable;
- `last_frame`: one image playable;
- `first_last`: two image playables with distinct roles;
- `reference`: allowed combinations of reference image, video, and audio
  playables where the selected adapter/model explicitly supports them.

The public API accepts playable ids and roles, never server paths and never
arbitrary remote URLs. Resolve each id from SQLite, then resolve its URI through
the same contained-root rules used elsewhere.

For direct H3, preflight every reference against these currently documented
limits:

- image: documented format, no more than 30 MB, dimensions 256–5760, aspect
  ratio 0.4–2.5;
- reference video: MP4/MOV, H.264/H.265, no more than 50 MB, 2–15 seconds,
  23.976–60 FPS, documented dimensions/aspect, at most three clips and at most
  15 seconds combined;
- reference audio: WAV/MP3, no more than 15 MB, 2–15 seconds, at most three
  clips and at most 15 seconds combined;
- reference images: at most nine;
- all mixed reference files: at most twelve;
- complete request body: at most 64 MB.

Prefer base64 data URLs only when the encoded request stays comfortably below
the 64 MB limit. Base64 expansion must be measured, not estimated from the raw
file limit. Do not expose Bumparr's media server publicly just to give a provider a
URL. If a supported input cannot fit safely, reject it with a useful preflight
message; a future explicit upload mechanism can solve that separately.

First/last-frame mode and reference mode are mutually exclusive for direct H3.
For OpenRouter, use `frame_images` and `input_references` only when the live
model descriptor and adapter both advertise the exact capability. OpenRouter's
generic request schema accepting a field does not prove every model/provider
honors it. Never silently send or ignore an unsupported reference.

### Image request contract

Add OpenRouter image generation after reviewed video output is stable:

```json
{
  "model": "operator-image-alias",
  "output": "image",
  "mode": "text",
  "prompt": "An original still-image creative brief…",
  "title": "Optional operator title",
  "kind": "generated_scenic",
  "count": 1,
  "aspect_ratio": "16:9",
  "creative": {"roles": ["inside"], "energy": "quiet"}
}
```

Only manifest-allowed models and discovered parameters are selectable. Initial
count is one even if a provider supports batches. Decode the returned base64,
reject vector output until a separate SVG sanitization design exists, decode
the raster with Pillow's bomb protections, normalize to a safe RGB PNG/JPEG,
checksum it, and register a disabled `type=image` candidate. Image references
come from contained playables and receive the same rights/privacy confirmation.

### Invented text-card request contract

The core may later produce only the existing explicitly invented kinds (`psa`,
`corrections`, `achievements`, `coming_up`, `tiny_games`). It does not generate
trivia, facts, numbers, dates, weather, or other claims whose truth requires a
grounded source.

The existing per-kind prompt builders, channel voice block, JSON extraction,
`card_validation`, duplicate checks, and content filter remain in the pipeline.
One provider job may yield several `generation_outputs`, each linked to its own
disabled card row. Human approval enables the card; the existing offline card
renderer then creates its playable MP4. Do not let a model-generated background
or card skip either review stage.

## Creative brief policy

Every model must amplify Bumparr's original channel identity, not become a
shortcut to imitation.

The operator-facing form should call the input a “creative brief,” not a magic
prompt. Place this guidance beside it:

- describe subject, setting, action, camera, rhythm, palette, and sound;
- describe the desired emotional or broadcast role;
- use the channel profile's own vocabulary;
- do not name Adult Swim, an artist, director, studio, show, celebrity, or
  living creator as a style target;
- avoid requested logos and on-image text; Bumparr owns channel identity and
  typography outside the model;
- do not include private data or secrets;
- use only reference media the operator owns or is allowed to submit to an AI
  service.

Do not add automated prompt rewriting by an LLM. A deterministic brief builder
may add bounded technical instructions and selected channel-profile attributes,
and the UI must show the exact final prompt before submission.

## Safe result acquisition

Treat every provider URL, redirect, and base64 result as untrusted input even
though it came from a configured provider.

The downloader must:

1. Require HTTPS.
2. Resolve and reject loopback, link-local, multicast, private, metadata, and
   other special-use destinations.
3. Prevent DNS rebinding by using a connection whose actual peer is one of the
   validated public addresses (or an equivalent hardened helper); revalidate
   every redirect target and cap redirect count.
4. Send no provider bearer credential to a different origin; for an
   authenticated provider content endpoint, strip it before cross-origin
   redirects.
5. Stream into a unique `.part` file under the private contained
   `GENERATION_STAGING_DIR`, outside every static media mount.
6. Enforce `GENERATION_DOWNLOAD_MAX_MB` on actual decoded/streamed bytes, even when `Content-Length` is
   absent or false.
7. `fsync`, close, and atomically rename only after validation succeeds.
8. Delete partials on every terminal failure.
9. Never persist or return a signed result URL.

For base64 outputs, reject impossible length before allocation, decode with a
strict alphabet into a bounded staging file, and enforce the decoded-byte cap.
Never put provider media bodies in SQLite.

Use short UUID-based filenames so quarantine and temporary suffixes cannot
exceed filesystem component limits.

A fully downloaded artifact that fails normalization is not a partial. Keep it
private only while it is referenced by a processing-failed output so the
operator can retry local processing without another paid request. Derive its
short path from local job/output ids; on startup, remove old `.part` files and
unreferenced staging artifacts, but never delete a file referenced by active or
processing-failed work.

## Media validation and normalization

Put shared untrusted-result handling in `bumparr/generation/media.py`. Do not
refactor all existing production code merely to share a few lines.

Validation requires:

- a recognized media container;
- at least one decodable video stream;
- finite positive duration reasonably close to the provider result;
- dimensions and frame rate within bounded sane limits;
- no dangerous path or protocol references;
- complete decode or an FFmpeg validation pass, not extension-only trust.

Normalize outside the playback path to Bumparr's interoperable library format:

- MP4 container;
- H.264 video, yuv420p;
- 1920×1080 at 30 FPS using aspect-preserving fit/pad behavior;
- AAC, 48 kHz, stereo;
- duration measured from the final output;
- fast-start metadata;
- the same subprocess timeout and kill-process-group guarantees used by other
  FFmpeg paths.

Native synchronized sound is part of the generated work. Do not add a random
music bed. If the result has usable audio, normalize it to the project's
loudness policy and mark `creative.audio="designed"`. If it has no audio,
insert a valid silent AAC track and mark `creative.audio="silence"`. Never mark
generated audio as licensed catalog music and never fabricate music credits.

Write normalized candidates beneath `GENERATION_OUTPUT_DIR` with a
collision-resistant name derived from the local output id. Compute SHA-256 after normalization.
The raw provider download is temporary and removed after a successful
normalization; retaining raw material can be a future opt-in feature.

## Playable registration and provenance

When processing succeeds, insert one disabled playable per output with:

- `id`: `gen:<output-uuid>`;
- `type`: `video`, `image`, or `card` according to the validated modality;
- `kind`: validated operator kind, with modality-specific safe default;
- `source`: `generated:<provider>`;
- `uri`: path relative to `ASSET_ROOT`;
- `uri`: NULL for a generated text card until the ordinary renderer runs;
- `duration`: probed normalized duration for media or existing card default;
- `title`: operator title or bounded derived title;
- `weight`: `0` while pending review; store the proposed ordinary declared
  weight in generation metadata and apply it only on approval. The first media
  release fixes proposed weight at `1.0`; do not accept arbitrary weight in the
  create API. G8 uses each existing card generator's declared kind weight, still
  never a browser-supplied value;
- `enabled`: `0`;
- `health`: `ok`;
- `tags`: include `ai-generated,pending-review` plus provider/model tokens until review metadata is
  resolved without relying on tags for enforcement.

Use `payload.creative` through `creative.with_presentation`. Video defaults to
family `authored`, image to `scenic`, and text cards to their inferred family.
Use validated roles and energy, resolved audio, accurate `text_heavy`, and
`brand_mode=none` for generated pixels that do not actually contain a local
brand treatment. Text cards retain their normal local renderer brand policy.

Add a namespaced `payload.generation` snapshot:

```json
{
  "ai_generated": true,
  "provider": "minimax",
  "model_alias": "h3-direct",
  "provider_model": "MiniMax-H3",
  "provider_model_canonical": null,
  "output_id": "genout:…:0",
  "mode": "text",
  "generation_id": "gen:…",
  "provider_job_id": "…",
  "operator_brief": "…",
  "submitted_prompt": "…",
  "requested": {"duration": 8, "resolution": "768P", "ratio": "16:9"},
  "actual": {"duration": 8.01, "width": 1920, "height": 1080, "fps": 30},
  "references": [],
  "usage": {"output_seconds": 8},
  "cost": {"reserved_microusd": 1040000, "actual_microusd": null},
  "capability_snapshot_hash": "…",
  "generated_at": 0,
  "sha256": "…",
  "review": {"status": "pending", "reviewed_at": null}
}
```

Never use the payload's review field alone as the eligibility gate. The
primary enforced gate is `enabled=0` until the transactional approval
operation, with `weight=0` as defense in depth against an older/general enable
path. Approval atomically restores the recorded proposed weight. A rejected or
pending output therefore remains score-zero even if some unrelated code flips
`enabled`.

Do not call `db.upsert_playable` unchanged for candidate registration: today it
always inserts `enabled=1`. Either extend it with an explicit, safely defaulted
enabled argument and tests for every caller, or use one dedicated transactional
candidate insert that hard-codes `enabled=0, weight=0`.

## Review behavior

Approval must:

1. require processing status `ready` and review status `pending`;
2. confirm the playable exists, remains disabled, points to a contained regular
   file, and still matches its recorded SHA-256 for media; for a card, validate
   its structured payload again;
3. update payload review status and time;
4. remove the pending tag if tag rewriting remains useful;
5. set `playables.enabled=1` and output review status `approved` in one transaction;
6. let generated cards follow ordinary rendering and generated media follow the
   normal station conform loop asynchronously.

Rejection must:

- require processing status `ready` and review status `pending`;
- keep the playable disabled;
- record a bounded optional reason;
- set output and payload review status to `rejected`;
- keep the normalized file until explicit deletion so rejection is reversible
  through a later approval if the product chooses to support that transition.

Deletion must use the existing contained, symlink-safe deletion path. Extend it
to mark the associated output `deleted` without erasing job provenance. A
failed file deletion must not delete the database row first.

Regeneration is a new job copied from an old job's editable brief and settings.
It never overwrites media or provenance and always incurs a new visible budget
reservation.

### Existing pool-management integration

Generated candidates must not be accidentally promoted by generic maintenance:

- `POST /api/pool/enable` returns 409 with an actionable pointer to the
  generation review endpoint for a pending/rejected generated output;
- `/api/pool/revive` excludes generated outputs whose review state is not
  approved, even when their files probe successfully;
- generic kind enable/disable behavior may disable an approved output but may
  not approve one;
- deletion updates `generation_outputs.review_status='deleted'` only after the
  existing safe filesystem/database deletion succeeds;
- a missing file parks an approved generated playable as it does other media;
  revive may restore it only because its generation output is already approved;
- list/detail APIs expose “awaiting generation review” separately from ordinary
  operator parking.

Startup seeding and `produce.py` must also treat `GENERATION_OUTPUT_DIR` as
Bumparr-managed output, not quarry/source material. Require it to be a proper
contained descendant of `ASSET_ROOT` (not the root itself), resolve its exact
relative subtree without following an escaping symlink, and skip paths within
that subtree in both `seed.py` discovery and `produce.py` scans. Do not exclude
only its first path component: a custom path such as
`ASSET_ROOT/ambient/generated` must not hide ordinary `ambient` source media.
This prevents a normalized file that landed immediately before a DB failure
from being rediscovered as an enabled anonymous video on restart. Raw/staging
files live outside the served asset tree and are never scanned. Add regression
tests for both the seed and quarry paths, including a nested custom contained
output directory and sibling media that must remain discoverable.

## Background worker and recovery

Add `jobs.generation_loop()` to the FastAPI lifespan tasks. Disabling generation
stops new submissions; it must not abandon already accepted paid work. When
disabled, the loop continues polling/processing active durable jobs if their
recorded adapter and credential remain available. With no active jobs it sleeps
quietly. Removing a model alias likewise blocks new work but does not strand an
existing job whose provider/model/capability snapshot is already recorded.

Worker cycle:

1. Recover stale local states.
2. Rebook any queued reservations that crossed UTC midnight, then claim work
   while below `GENERATION_MAX_ACTIVE` and all daily caps.
3. Dispatch claimed work through its named adapter.
4. Poll asynchronous submitted/running tasks no faster than adapter cadence.
5. Acquire and validate successful outputs.
6. Normalize/validate and register disabled candidates.
7. Sleep interruptibly.

Recovery rules:

- `submitted`/`running` rows with provider job ids are queried through the
  recorded adapter after restart;
- a missing credential pauses recovery with an actionable safe error and no
  resubmission; restoring the credential resumes the same provider job;
- `downloading`/`processing` rows restart from a clean bounded staging file,
  using the provider job id, a durably staged synchronous result, or a stored
  secret-free response descriptor;
- stale `submitting` without a provider job id becomes `submission_unknown` and is not
  automatically resubmitted;
- queued work remains queued;
- completed/failed/cancelled jobs are terminal for the execution worker;
- processing-ready outputs are never regenerated by the worker merely because
  review remains pending; approved/rejected/deleted review states are likewise
  never regenerated;
- missing normalized files for processing-ready pending-review or approved
  outputs are surfaced as
  an error and the playable is parked, never silently regenerated at cost;
- transient query failures persist bounded attempt count and `next_attempt_at`
  and back off across restarts; they do not turn a provider job into a duplicate
  submission.

Use a single loop and the SQLite table, not one immortal asyncio task per row.
This keeps restart behavior explicit and makes bounded concurrency simple.
Run blocking provider I/O and FFmpeg work through `asyncio.to_thread` (or the
project's equivalent bounded executor path) so the FastAPI event loop, status
reads, and shutdown cancellation remain responsive.

## HTTP API

Add these endpoints in a new `generation/routes.py` router and mount it from
`app.py`:

| Method/path | Purpose |
|---|---|
| `GET /api/generation` | Configuration-safe summary, budgets, counts, and worker state. |
| `GET /api/generation/models` | Safe enabled aliases and cached effective capabilities. |
| `POST /api/generation/preflight` | Validate without a provider call and return the exact submitted prompt, capability snapshot hash, and cost estimate. |
| `GET /api/generation/jobs` | Paginated jobs with provider/model/output/status/time filters. |
| `POST /api/generation/jobs` | Validate, reserve, and enqueue one generation. |
| `GET /api/generation/jobs/{id}` | Full safe detail including outputs and provenance. |
| `POST /api/generation/jobs/{id}/cancel` | Stop queued work or request local cancellation. |
| `POST /api/generation/jobs/{id}/regenerate` | Create a new queued job from editable settings. |
| `POST /api/generation/jobs/{id}/reconcile` | Deliberately resolve `submission_unknown` by attaching a verified provider job id or marking it not accepted. |
| `GET /api/generation/outputs` | Paginated review queue filtered by modality/review status. |
| `POST /api/generation/outputs/{id}/approve` | Transactionally approve one candidate. |
| `POST /api/generation/outputs/{id}/reject` | Record rejection and keep it disabled. |
| `POST /api/generation/outputs/{id}/retry-processing` | Retry a safe local download/normalization step without creating a provider job. |
| `DELETE /api/generation/outputs/{id}` | Safely delete one candidate while preserving its job audit record. |

Return 202 for accepted local enqueue, 409 for invalid state transitions or an
exhausted configured budget, 422 for
request validation, and 503 when generation or a model is disabled/unconfigured. Keep response
shapes stable and document them in `docs/API.md`.

Creation must accept one generation only. Batch generation encourages accidental
spend and complicates review. An operator who wants several variations submits
them deliberately as separate visible jobs.

The create form calls preflight first and displays its exact normalized result.
Creation repeats the same validation and rejects if capability or budget state
changed; it must not trust a browser-supplied estimate or prompt. Reconciliation
accepts only `submission_unknown`: an attached provider job id is validated by
querying the recorded adapter before transition, while “not accepted” requires
an explicit operator confirmation after checking the provider dashboard and
then releases the provisional reservation. It never directly resubmits.

List/detail responses must not include API keys, authorization headers, signed
download URLs, base64 references, local absolute paths, or raw provider bodies.
All list limits, offsets, filters, ids, prompts, titles, and rejection reasons
have explicit FastAPI bounds and enums; unknown filters never broaden a query.
Request models reject unknown fields. Generation write endpoints enforce a
small overall JSON-body ceiling (128 KiB is sufficient because clients submit
only text, options, and playable ids); reference bytes are resolved server-side
and never uploaded in the public request.

## Operator frontend

Integrate with the information architecture in `FRONTEND_PLAN.md`. Add a
`#/generation` view, or a clearly separated Generation section under
Operations until that navigation plan lands. Do not hide paid generation in the
generic natural-language ask bar.

### Create panel

- configured/enabled indicator;
- provider and model alias selector with the real provider/model shown;
- explicit “uses a paid external API” notice and current provider links;
- creative brief and exact submitted-prompt preview;
- server preflight summary; submission repeats validation and may reject a
  capability or budget change instead of trusting stale browser state;
- duration/resolution controls populated from effective capabilities;
- mode selection once multimodal work lands;
- contained library picker for reference inputs;
- kind, role, and energy fields using project allow-lists;
- remaining daily job, video-second, and estimated-USD budgets;
- one explicit submit action with a confirmation summarizing model, duration,
  resolution, and references.

### Job queue

Show local id, title, mode, requested duration/resolution, created time, status,
and a plain-language next step. Poll while any visible job is nonterminal; stop
polling terminal-only pages. A page reload must reconstruct everything from the
server.

Distinctly render job execution:

- waiting locally;
- submitted/queued at the named provider;
- generating;
- downloading;
- validating/normalizing;
- failed/cancelled;
- unknown submission outcome.

Within a completed job, distinctly render each output's processing state and
review state. “Awaiting review” means processing `ready` plus review `pending`;
processing `failed` must instead offer its safe local retry when possible. Do
not collapse output review into provider execution status.

Never label a working or unknown job successful.

### Review panel

- native video controls with audio;
- title, brief, exact submitted prompt, model, mode, requested and actual specs;
- reference thumbnails/links to their Bumparr records;
- generation time, usage units, checksum, and AI-generated badge;
- creative role/energy/audio metadata;
- Approve, Reject, Regenerate, and deliberate Delete actions;
- explanation that approval enables ordinary rotation and that station
  availability follows the next conform sweep.

All provider and prompt strings are inserted with `textContent`; no generated
string enters `innerHTML`. Controls must be keyboard-accessible and never
hover-only.

## Security, privacy, rights, and spend

### Network exposure

Bumparr currently has no authentication. A paid generation endpoint increases
the consequence of exposing it. The feature must therefore be off by default,
require explicit `GENERATION_ENABLED=1`, repeat the trusted-network warning in the UI,
and document that reverse-proxy authentication is required before internet
exposure. Designing project-wide auth is separate work; a generation-only fake
login would not secure the other destructive endpoints.

### Secret handling

- read the API key from the environment only;
- never accept a key in an HTTP request;
- never interpolate it into an exception or command;
- redact request headers in debug logging;
- add tests which place a sentinel key in failures and assert it never appears
  in logs, responses, or stored rows.

### Reference privacy and rights

Before submission, tell the operator that prompt and reference contents leave
their server and name every routing layer that may process them (for example,
OpenRouter plus a downstream model provider). Require an explicit checkbox for
multimodal references confirming the operator has rights and consents to send
them. Store the acknowledgement time and reference hashes, not a fabricated
license conclusion.

Do not accept URLs pointing at people or media outside the registry. Do not add
face cloning, celebrity presets, or voice cloning affordances.

### Spend control

- disabled by default;
- one job per creation request;
- daily job/video-second/estimated-USD caps enforced transactionally before submission;
- concurrent provider cap default one;
- show budget consumption and remaining seconds;
- count accepted provider tasks even if they fail or are cancelled;
- never auto-regenerate failures;
- use OpenRouter's discovered pricing snapshot where available and require a
  conservative operator-supplied ceiling where it is not;
- link to current pricing and recommend a dedicated provider key plus the
  strongest provider-enforced limit available for that account tier.

## Failure taxonomy

Expose stable codes and actionable messages:

| Code | Operator meaning | Retry policy |
|---|---|---|
| `disabled` | Generation or the chosen model is not enabled. | Configure; no automatic retry. |
| `missing_key` | API key is absent. | Configure; no automatic retry. |
| `budget_exhausted` | Local daily cap reached. | Wait or deliberately change config. |
| `invalid_request` | Local preflight failed. | Edit request. |
| `capabilities_stale` | No safe current model contract is available. | Restore discovery or select a direct model. |
| `unsupported_capability` | Model cannot honor an option/reference. | Change request/model. |
| `auth_failed` | Provider rejected the credential. | Fix the selected provider key. |
| `insufficient_balance` | Provider account cannot fund request. | Fix account balance. |
| `provider_moderation` | Provider rejected content. | Edit brief; do not bypass safeguards. |
| `privacy_policy_conflict` | Account/request privacy enforcement cannot serve this modality (for example OpenRouter ZDR enforcement on video). | Change the route or deliberate account policy; never loosen silently. |
| `rate_limited` | Provider asked Bumparr to slow down. | Automatic bounded query retry; create remains visible. |
| `provider_unavailable` | Remote 5xx/transport failure. | Do not ambiguously retry create; retry safe queries. |
| `provider_expired` | Accepted provider job exceeded its retrieval/execution lifetime. | Never resubmit automatically; explicit regenerate only. |
| `submission_unknown` | Crash may have occurred after paid acceptance. | Operator reconciliation only. |
| `download_rejected` | Result URL/size/network safety failed. | Re-query same task, never resubmit. |
| `invalid_media` | Download did not decode or meet bounds. | Keep failed evidence; explicit regenerate only. |
| `normalize_failed` | FFmpeg could not produce canonical media. | Retry local normalization without new provider spend. |
| `missing_output` | Reviewed/approved file vanished. | Park playable; restore or delete. |

Provider messages are untrusted and must be escaped, bounded, and translated
where possible.

## Observability

Add safe structured log events for local generation id and transition, never
an API key or full signed URL. Include provider job id after it exists, but
do not make raw prompts part of routine logs.

`GET /api/generation` and `/api/status` should report:

- enabled/configured;
- enabled model aliases by provider/output and unavailable-alias reasons;
- UTC daily caps, reservations, actual reported cost, and remaining capacity;
- counts by state;
- oldest active job age;
- last successful completion time;
- last bounded non-sensitive error code;
- age/status of the OpenRouter capability cache;
- worker running state.

Healthz remains a liveness probe and must not call any provider.

## Implementation phases

Each phase must leave the default no-generation installation working and
tested. Do not parallelize phases whose exit criteria establish the next
phase's safety boundary.

### Phase G0 — contract and documentation

Deliver:

- this reviewed plan;
- links from documentation indexes;
- hosted-API and explicit-adapter decisions;
- MiniMax/OpenRouter terms, pricing, routing, retention, and operator-responsibility language;
- no runtime behavior claims.

Exit criteria:

- documentation distinguishes the legacy optional text LLM, the new durable
  generation system, hosted H3, OpenRouter routing, and local H3 weights;
- no document implies any new integration is already shipped;
- official endpoint/model/spec/privacy claims have direct primary citations.

### Phase G1 — generation core, configuration, and schema

Files:

- `bumparr/config.py`
- `bumparr/db.py`
- new `bumparr/generation/__init__.py`
- new `bumparr/generation/models.py`
- new `bumparr/generation/service.py`
- new `bumparr/generation/providers/base.py`
- new `bumparr/config_files/generation_models.yaml`
- `.env.example`
- `docs/CONFIG.md`
- `docs/SCHEMA.md`
- new `tests/test_generation.py`

Deliver:

- safe opt-in configuration;
- additive `generation_jobs`/`generation_outputs` schema and indexes;
- separate job execution and output review state machines;
- strict model manifest and explicit adapter registry;
- normalized capability/request/cost/result objects;
- model-alias resolution and capability intersection;
- generic budget reservation/reconciliation;
- configuration-safe status shape.

Tests:

- clean and migrated databases;
- every valid/invalid state transition;
- manifest and capability-intersection boundaries;
- disabled/missing-key/job/video-second/USD budget behavior;
- provisional reservation release, ambiguous retention, and UTC-midnight rebooking;
- integer monetary accounting and estimate-versus-actual reconciliation;
- key redaction;
- no real network.

### Phase G2 — direct MiniMax H3 adapter and durable worker

Files:

- new `bumparr/generation/providers/minimax.py`
- new `bumparr/generation/worker.py`
- `bumparr/jobs.py`
- `bumparr/app.py` lifespan wiring
- `tests/test_generation.py`
- new `tests/test_generation_minimax.py`
- `tests/test_jobs.py`

Deliver:

- exact H3 create/query parsing against an injected fake transport;
- durable claim/submit/poll lifecycle;
- transactional job/video-second/cost reservation;
- restart recovery and `submission_unknown` handling;
- bounded backoff and concurrency;
- failure-code mapping.

Tests:

- MiniMax queued/running/succeeded/failed/cancelled sequences;
- restart at every local state;
- crash ambiguity does not resubmit;
- two worker claims cannot double-submit;
- 400/401/402/422/429/5xx mappings;
- cancellation semantics;
- worker cancellation during app shutdown.

### Phase G3 — safe media acquisition, normalization, and registration

Files:

- new `bumparr/generation/media.py`
- `bumparr/generation/providers/minimax.py`
- `bumparr/ffmpeg_pipe.py` only if an existing safe primitive is missing
- `bumparr/db.py`
- `tests/test_generation.py`
- `tests/test_generation_minimax.py`

Deliver:

- fail-closed result downloader;
- private staging outside `/media`, with startup cleanup of stale unreferenced
  partials;
- media probe/decode validation;
- canonical MP4 normalization and audio treatment;
- checksum and atomic output landing;
- disabled video playable and output-row registration with processing `ready`,
  review `pending`, and full provenance;
- local-only normalization retry.

Tests:

- private/special IP and unsafe redirect rejection;
- streamed byte cap with false/missing content length;
- partial cleanup and short filenames;
- malformed JSON/download/media;
- FFmpeg timeout kills the process group;
- audio and silent outputs produce explicit correct metadata;
- processing-ready, review-pending candidate is absent from
  random/fill/M3U/station;
- registration is idempotent after a simulated DB failure.

### Phase G4 — generic review API/UI and first releasable H3 slice

Files:

- new `bumparr/generation/routes.py`
- `bumparr/app.py`
- `bumparr/web/index.html`
- `bumparr/web/app.js`
- `bumparr/web/style.css`
- `bumparr/web/app.test.js`
- `docs/API.md`

Deliver:

- preflight, create/list/detail/cancel/reconcile/approve/reject/regenerate/delete,
  and safe local processing-retry endpoints;
- generation form, durable queue, and audiovisual review panel;
- transactional approval and ordinary conformance pickup;
- safe status and provenance display;
- clear paid API and unauthenticated-network warnings.

Tests:

- endpoint validation/status codes/pagination;
- unknown-field and overall request-body rejection;
- preflight performs no provider call and creation revalidates stale results;
- unknown-submission reconciliation validates attached provider ids, releases a
  confirmed unaccepted reservation, and never resubmits directly;
- concurrent or repeated approve/reject calls are idempotent or 409;
- checksum mismatch blocks approval;
- approval enables exactly one row;
- rejection never enables;
- hostile provider/prompt strings cannot create HTML;
- frontend polling stops only at a terminal state;
- refresh reconstructs job state from the API.

Phase G4 is the first releasable slice: direct H3 text-to-video is durable,
safe, review-gated, observable, and schedulable through a provider-neutral core.
Do not market multi-provider support yet.

### Phase G5 — OpenRouter video and real multi-model support

Files:

- new `bumparr/generation/providers/openrouter.py`
- `bumparr/generation/models.py`
- generation worker/routes/frontend
- new `tests/test_generation_openrouter.py`
- documentation and example manifest

Deliver:

- cached `/api/v1/videos/models` discovery and strict response bounds;
- OpenRouter video submit/poll/content retrieval;
- exact status/error/usage/cost mapping;
- manifest allow-list filtered by discovered capability;
- only documented video provider options, with no borrowed chat/image routing
  fields and explicit routed-provider uncertainty;
- accurate non-ZDR video disclosure;
- OpenRouter H3 plus at least one non-MiniMax video-model fixture proving the
  adapter is not H3-shaped;
- provider/model/canonical/routed-provider/capability provenance.

Tests:

- discovery cache fresh/stale/unavailable behavior;
- unsupported duration/resolution/reference rejected before submission;
- OpenRouter pending/in-progress/completed/failed sequences;
- OpenRouter cancelled/expired terminal responses;
- authenticated canonical content download and credential stripping on redirect;
- cost reservation vs reported actual cost;
- model removal/change does not mutate historical job snapshots;
- H3 and a second model use the same core without conditional scheduler code.

Phase G5 is the first releasable multi-provider/multi-model video system.

### Phase G6 — frame and reference video generation

Files:

- MiniMax and OpenRouter adapters
- API request schemas/routes
- frontend contained-asset picker
- media preflight helpers
- tests and documentation

Deliver in this order:

1. first-frame image;
2. last-frame image;
3. first-plus-last frame;
4. reference images;
5. direct-H3 reference video and audio.

Every step must ship its full local preflight and rights/privacy notice. Do not
enable a mode merely because the provider accepts a JSON shape.

Tests cover exact documented count, byte, dimension, aspect, codec, FPS, and
duration boundaries; base64 expansion and total request size; role exclusivity;
contained asset resolution; and no arbitrary URL/path acceptance.

### Phase G7 — OpenRouter generated images

Files:

- OpenRouter adapter and model discovery
- generation media/service/routes/frontend
- tests and documentation

Deliver:

- `/api/v1/images/models` discovery and manifest filtering;
- one-output text-to-image first, then optional contained image reference;
- decoded-byte and raster safety limits;
- safe normalized still registration as disabled `type=image`;
- visual review and independent output approval;
- no SVG acceptance until a separate sanitization implementation exists.

Exit criteria:

- one core job may safely own multiple output rows even though the UI submits
  count one initially;
- an approved image participates in ordinary image/station handling;
- no image response bytes or base64 are persisted in SQLite.

### Phase G8 — converge invented text-card generation

Files:

- new `bumparr/generation/providers/openai_compatible.py`
- OpenRouter adapter chat support
- `bumparr/generators/cards.py`
- `bumparr/ingest.py`
- generation routes/frontend
- card and generation tests

Deliver:

- `LLM_API_KEY` support without breaking unauthenticated local endpoints;
- OpenRouter chat with model allow-list, structured outputs when supported,
  data-collection denial, and optional ZDR policy;
- durable provider jobs and per-card output/review records;
- preserved current CLI and API entry points as compatibility façades;
- explicit invented-kind-only boundary;
- approval followed by ordinary offline card rendering;
- deprecation guidance only after feature parity is demonstrated.

Tests:

- all existing card generation/validation tests remain green;
- OpenRouter and local OpenAI-compatible fakes yield identical validated card
  candidates;
- grounded kinds cannot route through a model;
- one rejected card does not reject or enable sibling outputs;
- old `LLM_BASE`/`LLM_MODEL` configuration and commands remain accepted;
  model-created candidates now require review, while model-free output remains
  unchanged.

### Phase G9 — operational polish and release evidence

Files:

- `README.md`
- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/CONFIG.md`
- `docs/API.md`
- `docs/SCHEMA.md`
- `docs/RELEASE_REVIEW.md`
- `CHANGELOG.md`

Deliver:

- setup, terms, pricing, privacy, and troubleshooting guidance;
- backup/restore explanation for jobs and generated media;
- generated-content source/provenance description by provider/model/modality;
- release-review prompts for audiovisual artifacts, unwanted text/logos,
  likeness, audio defects, originality, and sequence fit;
- end-to-end tests with recorded fake MiniMax and OpenRouter transcripts;
- manual evidence from operator-controlled paid tests, kept out of CI and
  containing no credential or signed URL.

## Test strategy

### Unit tests

- pure request validation and mapping;
- state transitions;
- budget accounting;
- response parsing and redaction;
- reference preflight;
- payload/provenance construction.

### Integration tests

Run the FastAPI app against a local fake client/transport. Test complete
create-to-processing-ready/review-pending and approve-to-eligible flows without
internet or payment.
Fixtures should be tiny generated media owned by the repository, not MiniMax
or other provider outputs whose redistribution rights are unclear.

### Failure injection

Inject failure immediately before and after every durable boundary:

- local claim commit;
- provider create call;
- provider-job-id commit;
- query success;
- download rename;
- normalization rename;
- playable insert;
- output processing-ready/review-pending commit;
- approval transaction.

Assert restart recovery never duplicates provider submission and never enables
partial media.

### Existing regression suite

At minimum run:

```bash
python -m compileall -q bumparr tests
pytest -q
node --check bumparr/web/app.js
node --test bumparr/web/app.test.js
```

Run the repository's Docker build/CI-equivalent checks before declaring the
feature complete. No test requires `MINIMAX_API_KEY`, `OPENROUTER_API_KEY`, or
any network access.

## Manual acceptance review

Using operator-owned API accounts and explicit budgets:

1. Confirm disabled/unconfigured behavior makes no request.
2. Through MiniMax direct, submit one 4-second and one 15-second 16:9 H3 text generation.
3. Restart Bumparr while one task is running; confirm it resumes polling the
   same provider job id.
4. Confirm the downloaded raw result is removed after canonical output lands.
5. Confirm both candidates are disabled and absent from every output path.
6. Preview with sound and inspect exact prompt/provenance/usage.
7. Reject one and approve the other.
8. Confirm the approved item appears through ordinary selection and conforms on
   the next background sweep, not during a playlist request.
9. Delete it and confirm the file is safely removed while the generation audit
   record remains marked deleted.
10. Exhaust the daily cap and confirm no further provider submission occurs.
11. Through OpenRouter, submit H3 and one non-MiniMax model using only options
    discovered for each; confirm provider/model/cost provenance.
12. Confirm OpenRouter video is accurately labeled non-ZDR.
13. Repeat with one first-frame input after Phase G6.
14. After G7/G8, repeat the review gate for one image and two sibling cards.

Record observed API response variations in tests before weakening a parser.
Never paste credentials, signed URLs, or private reference media into review
artifacts.

## Definition of complete

The first-class multi-provider video release (G0–G5) is complete only when all
of the following are true:

- generation is off by default and only manifest-allowed models are visible;
- direct MiniMax H3 and OpenRouter video both work through the same durable core;
- OpenRouter proves a second non-MiniMax video model without core/scheduler forks;
- paid jobs and provider job ids survive restart;
- ambiguous submission cannot duplicate spend automatically;
- local budget and concurrency controls are enforced transactionally;
- results are downloaded with network/size/path protections;
- media is decoded, normalized, checksummed, and registered disabled;
- every processing-ready candidate requires explicit modality-appropriate
  review and approval;
- approval enters the existing selection/conform/station paths without a
  special bypass;
- generation and playable records expose accurate, redacted provenance;
- operator UI covers creation, state, review, rejection, and regeneration;
- prompt/reference privacy, originality, and rights boundaries are visible;
- multimodal reference modes meet provider preflight limits when claimed as
  supported;
- all tests use fakes and the entire existing suite remains green;
- OpenRouter discovery/cost/privacy snapshots are accurate and historical;
- runtime and documentation make no claim that local inference is required or bundled.

The full generative-content roadmap is complete when G6–G9 additionally prove
capability-gated references, generated images, and invented text cards without
weakening grounding, review, rights, privacy, or legacy compatibility.

## Implementation file checklist

Expected new files:

- `bumparr/generation/__init__.py`
- `bumparr/generation/models.py`
- `bumparr/generation/service.py`
- `bumparr/generation/worker.py`
- `bumparr/generation/media.py`
- `bumparr/generation/routes.py`
- `bumparr/generation/providers/base.py`
- `bumparr/generation/providers/minimax.py`
- `bumparr/generation/providers/openrouter.py`
- `bumparr/generation/providers/openai_compatible.py`
- `bumparr/config_files/generation_models.yaml`
- `tests/test_generation.py`
- `tests/test_generation_minimax.py`
- `tests/test_generation_openrouter.py`

Expected modified files:

- `.env.example`
- `bumparr/config.py`
- `bumparr/db.py`
- `bumparr/jobs.py`
- `bumparr/app.py`
- `bumparr/seed.py`
- `bumparr/produce.py`
- `bumparr/generators/cards.py` and `bumparr/ingest.py` in Phase G8
- `bumparr/web/index.html`
- `bumparr/web/app.js`
- `bumparr/web/style.css`
- `bumparr/web/app.test.js`
- `docs/API.md`
- `docs/ARCHITECTURE.md`
- `docs/CONFIG.md`
- `docs/SCHEMA.md`
- `docs/RELEASE_REVIEW.md`
- `docs/README.md`
- `README.md`
- `CHANGELOG.md`

Files that should not need provider/model-specific paths:

- `rotation.py`
- `selection.py`
- `sequence.py`
- `station/playout.py`
- `station/routes.py`

If those modules acquire `if provider == ...` or `if model == ...` behavior, stop and check
whether the registry/creative contract is being bypassed.

## Official references

The implementation agent must re-check these pages immediately before coding,
because API schemas, pricing, and terms can change:

- [MiniMax video-generation guide](https://platform.minimax.io/docs/guides/video-generation)
- [Create H3 video-generation task](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
- [Query H3 task](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)
- [MiniMax H3 model card and local-release distinction](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- [MiniMax H3 community license for the separately released weights](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE)
- [MiniMax pay-as-you-go pricing](https://platform.minimax.io/docs/guides/pricing-paygo)
- [MiniMax terms of service](https://www.minimax.io/terms-of-service)
- [OpenRouter video-generation guide](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [OpenRouter video-model API reference](https://openrouter.ai/docs/api/api-reference/video-generation/list-all-video-generation-models)
- [OpenRouter image-generation guide](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [OpenRouter model discovery](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter API-key creation and spending-limit fields](https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)
- [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection)
- [OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter live model/pricing catalog](https://openrouter.ai/models)
- [OpenRouter terms of service](https://openrouter.ai/terms)

If live documentation differs from this plan, update the plan and tests first;
do not silently code around the discrepancy.
