# Pull request summary

## Suggested title

**Add creative channel engine, operator console, and review-gated video generation**

## What this PR does

This PR brings Bumparr from a bumper pool with a basic dashboard toward a
coherent, operator-owned television interstitial system. It combines the
station/runtime hardening work with the creative alignment work, the
dependency-free operator console, and the opt-in generative-video workflow.

Bumparr remains an original, self-hosted project inspired by the *function* of
Adult Swim's interstitial grammar: a channel can have a voice, pacing, quiet,
surprise, and memory between programmes. It does not copy Adult Swim marks,
copy, footage, music, or branding. The product is still three things:

- a bumper library for creating, ingesting, rendering, inspecting, enabling,
  disabling, and serving short playables;
- a break composer that returns an ordered set fitting a requested duration and
  placement; and
- a live bumper showcase plus branded standby/failover HLS channel.

It is not a long-form programme scheduler. `/playlist.m3u` remains an
unsequenced pool for a downstream scheduler; `/api/bumpers/fill` composes a
bounded break; `/station/live` and `/station/standby` schedule only Bumparr's
own bumper material.

## Creative and channel system

- Operator-owned voice and channel profiles define tone, boundaries, preferred
  subjects, prohibited habits, presentation families, roles, energy, audio,
  dayparts, and sequence preferences.
- A single creative resolver gives new and legacy rows stable family, role,
  template, audio, brand, and provenance semantics without a schema migration.
- Finite card templates and explicit `reveal`, `static`, and `none` brand modes
  keep variation intentional rather than turning every card into the same
  branded layout.
- Break composition and station adjacency share strict selection eligibility:
  computed score must be positive, hard roles and profile gates are respected,
  and soft adjacency rules report their relaxations.
- Music is manifest-owned, energy/family compatible, credited, loudness-shaped,
  and allowed to resolve to deliberate silence. Native, music, designed, and
  silence treatments stay distinct.
- Channel-memory cards use station play history and local operator messages,
  with freshness and evidence metadata. They say what the channel has aired,
  never that an individual viewer watched it.
- Simulation and review artifacts expose mix diagnostics, provenance, repeats,
  role/gate violations, duration error, and relaxations. These metrics are
  diagnostic unless explicitly listed as objective gates.

See [PRODUCT_VISION.md](PRODUCT_VISION.md), [CREATIVE_REFERENCE.md](CREATIVE_REFERENCE.md),
[ALIGNMENT_PLAN.md](ALIGNMENT_PLAN.md), [CONFIG.md](CONFIG.md), and [RELEASE_REVIEW.md](RELEASE_REVIEW.md).

## Station and media correctness

- Live and standby are separate HLS channels with channel M3U and XMLTV guide
  output for Dispatcharr and ordinary HLS players.
- Eligible items are conformed once in a background cache; serving a playlist
  never launches an encoder. Profile-aware cache keys and a branded empty-pool
  slate preserve continuity across refreshes.
- Playout shares scored eligibility with random/fill, records history only when
  requested timeline entries pass, and discards abandoned timelines after
  reconnect staleness. Dayparts, standby restrictions, absolute URLs, explicit
  MPEG-TS types, and status purity are covered by the station contract.
- Source/output separation, contained filesystem resolution, atomic downloads,
  media quarantine, bounded fetches, redirect/DNS checks, stream-proxy
  allowlists, and non-root execution address media and SSRF hazards.
- Cards remain invisible to consumers until rendered to playable MP4.

## Operator console

The dashboard remains a same-origin, dependency-free operator console with
six hash-driven views: Overview, Library, Composer, Station, Operations, and
Generation. Its surfaces expose truthful loading, empty,
offline, stale, failed, parked, and unprotected-network states.

The console supports the operator's loop: inspect health, search and preview the
pool, review an ordered break, inspect station/failover status, conform the
station, run maintenance jobs, and review generated candidates. Controls are
keyboard-visible, previews bounded, polling lifecycle-aware, and generated
candidates disabled until explicit approval.

## Opt-in generation (G0–G5)

Generation is off unless `GENERATION_ENABLED=1`; keys alone never spend. The
durable worker supports allow-listed hosted MiniMax H3 text-to-video and
OpenRouter video jobs, persisted state, budgets, preflight fingerprints,
review/approval, cancellation, retry/recovery, provenance, checksums, and
disabled-by-default output registration.

The remediation pass addresses atomic budget reservations, current-policy
submission gates, resolution-aware estimates, redirect/DNS-rebinding checks,
secret-safe errors, durable media processing, quarantine rollback, bounded
request bodies, provider discovery caching, stale-state handling, recovery
backoff, regeneration metadata, complete queue/review actions, and Compose
forwarding. It does not claim provider acceptance merely because fake transport
tests pass.

See [GENERATION_PLAN.md](GENERATION_PLAN.md),
[GENERATION_IMPLEMENTATION_STATUS.md](GENERATION_IMPLEMENTATION_STATUS.md),
and [GENERATION_REMEDIATION.md](GENERATION_REMEDIATION.md).

## Verification evidence

Combined local validation (2026-09-05):

- **729 Python tests pass**, with `ResourceWarning` promoted to errors.
- **326 Node tests pass**, retaining all 311 operator-console tests and all
  12 generation tests, plus three integration lifecycle regressions.
- Ruff, compileall, JavaScript syntax, and whitespace checks pass.
- The readable, dependency-free static bundle is **216,599 bytes**, below the
  unchanged 262,144-byte cap; there is no runtime build/minification step.
- Focused backend and frontend integration re-reviews are clean.
- Chromium drove the integrated six-view console against the real local API
  with a temporary database, synthetic credential, disabled worker/lifespan,
  and provider transport forbidden. Generation preflight displayed the exact
  submitted prompt and estimate; editing the brief disabled paid creation;
  Operations remained a separate functional view. This was not a paid call.
- Docker build and Compose configuration validation pass. The final image
  passes a network-disabled smoke as UID 10001 with fresh anonymous volumes:
  writable `/assets` and `/data`, DB initialization, model-free card generation,
  real HTTP health and six-view dashboard, generation off, gzip delivery, and
  rejection of an oversized generation request before JSON parsing. No
  production containers or volumes were changed.

Historical branch evidence, kept separate from these combined results:

- generation/remediation branch: 639 Python tests passed with
  `ResourceWarning` promoted to errors; 87 were focused generation tests;
  33 JavaScript tests passed; compile, Ruff, diff, Docker build, and Compose
  configuration checks passed;
- frontend branch: 311 frontend tests were reported across the operator-console
  work and its lifecycle follow-ups;
- browser evidence covered the generation workflow, narrow 320/390 CSS
  viewports, and key operator actions, but is not a complete browser matrix.

The historical captures are archived with their scope in
[evidence/frontend/README.md](evidence/frontend/README.md). Reproduce the
combined local checks with the repository CI commands:

```sh
python -W error::ResourceWarning -m unittest discover -s tests
ruff check bumparr tests
python -m compileall -q bumparr tests
node --check bumparr/web/app.js
node --test bumparr/web/app.test.js
git diff --check
docker compose config --quiet
```

## Operating defaults and explicit limits

- The service is unprotected by default and is intended for a trusted network;
  put authentication and a suitable proxy in front of it before internet
  exposure.
- No paid provider acceptance, real credential run, production deployment, or
  account-pricing guarantee is included. Local estimates and preflight gates
  are safeguards, not billing guarantees.
- The shipped generation path is hosted MiniMax H3/OpenRouter video only; it
  does not download local H3-Base weights, silently switch providers, or claim
  ZDR for video. G6–G8 remain deferred: frame/reference, image generation, and
  migration of the legacy invented-text-card path.
- Firefox has not been verified; the browser evidence is not a substitute for
  a full cross-browser/accessibility matrix.
- The Generation view does not imply G6–G8 frame images, local H3 hosting, or
  text migration; audiovisual output still requires human review with sound.
- The console and HTTP API remain a trusted-operator surface: no public
  submissions, viewer accounts, or authentication are added.
