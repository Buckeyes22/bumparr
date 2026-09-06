# Generation implementation status (G0–G5)

**Status:** G0–G5 local implementation and the seventeen review findings have
been remediated; current evidence is in [GENERATION_REMEDIATION.md](GENERATION_REMEDIATION.md).
Generation is **off by default**. No document here claims that MiniMax or OpenRouter audiovisual
acceptance has been proven with paid calls. Tests use injected fake
transports and tiny local ffmpeg fixtures only.

**Research re-checked:** 2026-09-05 against live MiniMax H3 V2 create/query
OpenAPI and the OpenRouter video-generation guide.

This file maps [GENERATION_PLAN.md](GENERATION_PLAN.md) phases G0–G5 to code,
tests, and remaining operator-controlled evidence. Phases G6 (frame/reference),
G7 (images), and G8 (invented text-card migration) stay unavailable.

## Distinctions (do not collapse these)

| Surface | What it is | How it is enabled | What it is not |
|---|---|---|---|
| Legacy optional text LLM | `LLM_BASE` / `LLM_MODEL` OpenAI-compatible chat used only to diversify invented **text cards** | Nonempty `LLM_BASE` | Not durable paid video. Not MiniMax H3. Not OpenRouter `/api/v1/videos`. |
| Durable generation core | SQLite `generation_jobs` / `generation_outputs`, one worker loop, review gate | Exact `GENERATION_ENABLED=1` plus a valid model alias and that provider’s key | Credentials alone never spend. Playback/status/preview/simulation never call a provider. |
| Hosted MiniMax H3 | Direct adapter to `https://api.minimax.io` model `MiniMax-H3` | Manifest alias `provider: minimax` | Not MiniMax-H3-Max in this slice. Not local H3-Base weights. |
| OpenRouter video routing | Direct adapter to `https://openrouter.ai` `/api/v1/videos` + `/api/v1/videos/models` | Manifest alias `provider: openrouter` | Not chat completions. Not ZDR. Not a silent fallback for direct MiniMax. |
| Local H3 weights | MiniMax publishes H3-Base weights and a community license separately | **Not implemented. Not downloaded. Not served.** | Calling the hosted API does not require local GPUs or weights. |

Live terms and pricing are operator responsibilities. This project links to
current provider pages instead of embedding a use-permission claim:

- MiniMax terms: https://www.minimax.io/terms-of-service
- MiniMax pay-as-you-go: https://platform.minimax.io/docs/guides/pricing-paygo
- MiniMax H3 local-release distinction: https://huggingface.co/MiniMaxAI/MiniMax-H3
- OpenRouter privacy / ZDR: https://openrouter.ai/docs/guides/features/zdr
- OpenRouter video guide: https://openrouter.ai/docs/guides/overview/multimodal/video-generation

## Live-doc re-check (2026-09-05)

Verified against primary pages immediately before coding. Material deltas
versus the plan text:

1. **MiniMax-H3-Max is now on the create OpenAPI.** `MiniMax-H3` remains
   768P/2K, 4–15s, text / first-last / reference. `MiniMax-H3-Max` is 480P/768P
   (no 2K), 5–15s, text and first/last only — no reference. **G0–G5 implements
   MiniMax-H3 text-to-video only.** H3-Max and all reference/frame modes stay
   G6+ / later allow-list admission. The adapter will not submit `MiniMax-H3-Max`
   until that contract is an implemented, tested mode.
2. **MiniMax origins/endpoints match the plan:** `POST /v2/video_generation`
   returns `task_id`; `GET /v2/query/video_generation/{task_id}` statuses
   `queued|running|succeeded|failed|cancelled`; success download is
   `task.content.url`. Query window is the preceding seven days →
   `provider_expired`, never resubmit. Prompt max 7000 characters. Text-to-video
   requires `ratio` and forbids `adaptive`. Bearer auth. Errors 400/401/402/422/429/500.
3. **OpenRouter video contract matches the plan:** `GET /api/v1/videos/models`,
   `POST /api/v1/videos`, `GET /api/v1/videos/{job_id}`,
   `GET /api/v1/videos/{job_id}/content?index=0`. Poll statuses
   `pending|in_progress|completed|failed`. Webhook-only terminal states
   `cancelled` and `expired` are mapped if polling returns them. Video is
   **not ZDR-eligible**; do not send `zdr=true` or label it ZDR. Do not send
   chat/image pin/no-fallback fields to video.
4. **Do not trust `polling_url` or `unsigned_urls`.** Reconstruct poll and
   content paths from the validated job id. The content endpoint needs the
   OpenRouter credential; strip it before any cross-origin redirect.
5. **OpenRouter catalog includes non-MiniMax models** (examples in live docs:
   `google/veo-3.1`, `alibaba/wan-2.7`). G5 proves a second model through
   **representative protocol fixtures**, not a live paid catalog fetch. Never
   assume Hailuo/H3 capabilities for those slugs.
6. **Repo CI is `python -m unittest discover -s tests`, not pytest.**

The plan’s endpoint names, MiniMax-H3 text-to-video mechanics, and OpenRouter
async video workflow remain current. Unverified adapter behavior (H3-Max,
frame/reference, images, chat) is left unavailable.

## Phase coverage

| Phase | Scope | Implementation | Evidence | Remaining |
|---|---|---|---|---|
| G0 | Contract, distinctions, citations | This file; index links; plan research note | Docs only | Paid/live audiovisual acceptance is operator-controlled |
| G1 | Opt-in config, schema, state machine, manifest, budgets, redaction | `bumparr/config.py`, `bumparr/db.py`, `bumparr/generation/` | `tests/test_generation.py` | — |
| G2 | MiniMax H3 adapter + worker | `providers/minimax.py`, `worker.py`, `jobs.py` | `tests/test_generation_minimax.py` | No paid MiniMax call in CI |
| G3 | Download, normalize, disabled registration, bypasses | `media.py`, seed/produce/pool guards | generation + seed/produce tests | ffmpeg present in this environment; Compose smoke optional |
| G4 | HTTP API + `#/generation` UI | `routes.py`, `bumparr/web/*` | TestClient + Node tests | Browser matrix is operator-side |
| G5 | OpenRouter video + non-MiniMax fixture | `providers/openrouter.py` | `tests/test_generation_openrouter.py` | Live discovery/catalog not fetched with credentials |

## Changed files (G0–G5)

See the generation package under `bumparr/generation/`, additive schema in
`bumparr/db.py`, config keys, `.env.example`, pool/seed/produce guards, dashboard
`#/generation`, and the tests listed above. Selection, rotation, sequence, and
station playout have no provider/model branches.

## Initial implementation verification (superseded by remediation evidence)

The following records the teammate's initial pass, not final acceptance. The
subsequent audit found gaps despite these tests passing. Current tests, failure
injections, browser checks, and deployment checks are recorded in
[GENERATION_REMEDIATION.md](GENERATION_REMEDIATION.md).

| Check | Result |
|---|---|
| `python -m compileall -q bumparr tests` | OK |
| `ruff check bumparr tests` | All checks passed |
| `python -m bumparr.generation.models --check` | ok (0 aliases, shipped-default) |
| `python -W error::ResourceWarning -m unittest discover -s tests` | **Ran 605 tests in 37.672s: OK** |
| `node --check bumparr/web/app.js` | OK |
| `node --test bumparr/web/app.test.js` | **24 pass, 0 fail** |
| `git diff --check` | OK |
| `docker compose config` | OK |

Focused logs (scratch): `generation-failure.log` (download/normalize/register
injection on `worker.tick`: one create POST, no enabled playable),
`generation-launch.log` (`TestClient(bumparr.app:app)` preflight twice:
`submitted_prompt` + estimate, zero transport calls; disabled create is 503).

Also covered: UTC-day rebook before enqueue so a leftover yesterday
reservation cannot stack today's cap; `claim_queued` rebooks even when
`max_active` is full; `revive()` skips pending generated files;
`produce.run()` does not quarry `GENERATION_OUTPUT_DIR`.

No test called MiniMax or OpenRouter. ffmpeg is present in this environment
and was used to mint tiny local clips and run the happy-path normalize.

## Review findings (this verification round)

| Finding | Resolution |
|---|---|
| UTC-day cap stacked leftover yesterday reservations | Now rebook and enqueue atomically under `BEGIN IMMEDIATE`; a rejected enqueue rolls both back. Claims independently rebook under the same writer lock. |
| Missing download/normalize/register failure injection on `worker.tick` | Three tests fail those boundaries; assert a single create POST and no enabled generated playable. |
| Launch tests used a copy FastAPI app | `TestClient` now drives `bumparr.app:app` (no lifespan); preflight run twice with prompt+estimate and zero provider calls. |
| revive/produce never exercised on generated output | `revive()` and `produce.run()` tests leave unreviewed generated media unplayable. |

## Unresolved / blocked external evidence

- No `MINIMAX_API_KEY` / `OPENROUTER_API_KEY` paid call is authorized in this
  work. Mocked tests are not real-provider acceptance.
- Live OpenRouter `/api/v1/videos/models` catalog is not snapshotted from a
  credentialed account; G5 uses in-repo protocol fixtures.
- Local Docker build, Compose forwarding validation, and network-disabled
  non-root smoke evidence are in the remediation report; no production deploy.

## Operator-controlled paid validation (not CI)

1. Set `GENERATION_ENABLED=1`, a dedicated MiniMax key, and an allow-listed
   `h3-direct` alias. Confirm `/api/generation` shows configured models and
   that `GENERATION_ENABLED=0` with the same key creates nothing.
2. Preflight one 4s and one 15s 16:9 H3 text job. Confirm the exact submitted
   prompt and estimate. Create. Restart during `running`. Confirm the same
   `task_id` is polled.
3. Confirm the candidate is `enabled=0` `weight=0`, absent from random/fill/M3U/
   station, then approve one and reject one. Approval restores proposed weight
   `1.0`. Conform happens on the next sweep, not in the playlist request.
4. Exhaust the daily cap. Confirm no further create call.
5. Repeat through OpenRouter with an H3 alias and one non-MiniMax alias using
   only discovered options. Confirm non-ZDR disclosure and distinct routing
   (no silent move to MiniMax direct).
6. Never paste keys, signed URLs, or private reference media into review notes.
