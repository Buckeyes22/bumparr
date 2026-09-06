# Generation review remediation

Date: 2026-09-05. Scope: the seventeen findings from the G0–G5 generation
implementation audit, including the teammate's incomplete remediation.

The historical statement below that no commit or push was performed describes
that audit scope. Current combined-branch publication and integration evidence
belongs in [PR_SUMMARY.md](PR_SUMMARY.md).

This report supersedes the initial completion claim in
[GENERATION_IMPLEMENTATION_STATUS.md](GENERATION_IMPLEMENTATION_STATUS.md).
Generation remains opt-in. These are local implementation and regression
results, not proof of paid MiniMax/OpenRouter audiovisual acceptance.

## Findings and permanent corrections

The numbered rows match the original audit. All seventeen are locally
remediated. Regression tests are in
[`tests/test_generation_remediation.py`](../tests/test_generation_remediation.py),
the existing generation suites, and
[`bumparr/web/app.test.js`](../bumparr/web/app.test.js).

| # | Finding | Correction and evidence |
|---|---|---|
| 1 | Non-atomic budget reservations | `db.conn(immediate=True)` actually executes `BEGIN IMMEDIATE` before reads; setting SQLite's isolation level alone was insufficient. Midnight rebooking, budget check and enqueue share a transaction. Six simultaneous enqueue attempts against a one-job cap admit exactly one. |
| 2 | Queued work bypasses current restrictions | Claims stop on over-budget usage. The pre-submit gate checks enabled state, historical provider/model versus current alias, capability hash, credential, current caps, and persisted claim state. Tests remove/reprice aliases, lower caps after claim, and report an actual-cost overrun on a failed accepted job. No new provider create is sent. Accepted work uses its historical provider even after alias removal or repointing. |
| 3 | Resolution-specific pricing ignored | OpenRouter snapshots preserve reviewed per-second/resolution SKUs. Estimates use the requested resolution. Unknown dimensions, malformed values and oversized SKU sets fail closed. The documented 1080p example estimates 8 × $0.75 = $6 and is rejected against a $5 cap. |
| 4 | Authorization forwarded on JSON redirects | The provider JSON opener refuses redirects (including same-origin redirects); final-origin checks retain HTTPS. Tests cover redirect refusal and GET-vs-create transport-failure behavior. |
| 5 | DNS rebinding gap | Downloads resolve and validate public addresses, connect to a selected numeric address, check the actual peer before TLS/request transmission, and preserve original-host TLS verification/SNI. Every redirect is validated anew. Tests reject a substituted private peer and unsafe redirect, verify the pinned connection/SNI, and verify cross-origin authorization stripping and connection cleanup. |
| 6 | Secrets and signed URLs in errors | Central redaction includes live configured keys, header patterns and entire provider URLs (signatures can occur in arbitrary paths/queries). Exception strings, persisted errors and public errors are sanitized. Synthetic credentials and nonstandard signed URLs are absent from both SQLite and responses. |
| 7 | File quarantine survives database rollback | Output deletion holds a writer transaction, rejects active outputs, stages the exact owned files, and restores staged entries if staging or the database transaction fails. Injected DB deletion failure leaves both the original playable and original file intact. Failed-output deletion also removes private bytes and cannot subsequently be retried. |
| 8 | Non-durable local processing | Outputs receive stable IDs before retrieval. Downloads use output-derived private names; processing failure retains referenced raw bytes and a failed output. Normalized files and checksummed landed descriptors survive registration failure. Registration updates the existing pending output to ready in the disabled-playable transaction. Retries reuse the same output/provider job, and raw bytes are removed only after commit. Tests cover normalization failure/retry without a key, failure after encoding, and DB failure after landing without reencoding. Cleanup removes only old unreferenced staging artifacts. |
| 9 | Paid create not bound to preflight | Preflight returns a server-derived consistency fingerprint of normalized inputs, capabilities/pricing, UTC day and budget usage/caps. HTTP create/regenerate require a matching fingerprint under the reservation lock. The UI invalidates edited/failed previews, includes the exact preview in confirmation, and prevents duplicate clicks. Tests reject missing, edited, stale and replayed previews. |
| 10 | Recoverable accepted jobs abandoned | Missing/rejected credentials pause accepted jobs; transient GET/download errors use persisted bounded backoff. Due-time filtering prevents tight retries. Successful repeated-state polls clear backoff and record usage. Tests remove/restore credentials, disable generation/remove aliases during recovery, and inject URL errors/read timeouts without duplicate creation. |
| 11 | Request-driven discovery | Status/models/preflight read only unexpired cache entries. The worker alone refreshes discovery when needed and reuses the one-hour cache. Tests prove zero outbound calls/cache writes on cold-cache reads and exactly one refresh across two background checks. |
| 12 | Regenerate rejects stored creative metadata | Regeneration projects stored creative metadata into the accepted roles/energy input shape. Service and HTTP tests create a distinct linked child through a matching preflight. |
| 13 | Stale cancel/reconcile responses | Responses are loaded after transaction commit. Tests assert immediate cancelled/failed state and released provisional reservations. |
| 14 | Incomplete operator workflow | Queue offers cancel, attach provider ID, confirm non-acceptance and explicitly preflighted paid regeneration. Review offers approve/reject, safe processing retry and deletion with state checks. Queue and review have independent pagination and review-state filtering, so older outputs remain reachable. HTTP failures are visible. Capability controls preserve selections and update by model. Unchanged polling preserves video elements/focus rather than rebuilding cards every five seconds. |
| 15 | Header-only body ceiling | A generation-scoped ASGI boundary counts actual streamed bytes before FastAPI/JSON parsing. All write routes reject >128 KiB, even without Content-Length. Tests exercise every write route with an oversized streamed body. |
| 16 | Truthy malformed enable flag | Manifest parsing requires a real boolean and safely rejects malformed decimal ceilings. Tests verify quoted `"false"` and invalid prices are rejected. |
| 17 | Compose drops generation configuration | Compose explicitly forwards all generation settings and both provider keys while defaulting generation off. A regression test checks every configured variable; a real Compose expansion verifies opt-in/model/fake-key forwarding without printing key values. Container-path manifest/mount instructions are in CONFIG.md and .env.example. |

The OpenRouter SKU fixture follows its
[official video-generation documentation](https://openrouter.ai/docs/guides/overview/multimodal/video-generation).
It is an illustrative contract fixture, not a guarantee of current account
pricing or model availability.

## Verification

- Full Python suite: **639 tests passed**, with ResourceWarning promoted to error.
- Focused generation suites: **87 tests** (included in the full suite).
- JavaScript: **33 tests passed**; syntax check passed.
- Ruff, Python compileall and `git diff --check`: passed.
- A final full-suite run exposed a pre-existing station test flake: its fake
  encoder matched `bad` anywhere in the command, including random cache hashes.
  The test now fails only the intended `bad.mp4` source; no station production
  code was changed for this issue.
- Docker image build: passed. Network-disabled smoke: UID 10001, writable
  `/assets` and `/data`, DB initialization, model-free baseline/number cards,
  application import, generation disabled.
- Compose configuration validation and synthetic generation/key forwarding:
  passed. No deployment or production volume changes.

Reproduce:

```sh
python -W error::ResourceWarning -m unittest discover -s tests
python -W error::ResourceWarning -m unittest discover -s tests -p 'test_generation*.py'
ruff check bumparr tests
python -m compileall -q bumparr tests
node --check bumparr/web/app.js
node --test bumparr/web/app.test.js
git diff --check
docker compose config --quiet
```

### Browser evidence

The real dashboard was served on an ephemeral loopback port with temporary
database/assets, lifespan disabled, fake provider responses and outbound
provider transport forbidden. The fixture normalized a tiny local video.

Observed in Chrome:

- create initially disabled; successful preflight displays the exact prompt and
  cost and enables creation; editing resolution disables it again;
- cancelling a queued job updates the row to cancelled and releases its budget;
- approving a candidate removes it from pending review, and the approved filter
  displays `ready · approved` without approval controls;
- reconciliation/regeneration controls and independent pagination are visible;
- generation hides Overview correctly;
- narrow layouts at 390 and 320 CSS viewport widths have no horizontal document
  overflow after fixing the header; the 320-wide screenshot was visually checked.

Browser testing also exposed unnecessary polling DOM replacement; a regression
test now protects stable review/video elements. Native confirmation paths and
duplicate-click behavior were tested in JavaScript, with API validation tested
through the real FastAPI app; they are not claimed as a complete browser matrix.

## Remaining external evidence and operating limits

- No paid API requests, real credentials, production deploy, commit or push were
  performed. Real provider acceptance, audiovisual quality, account pricing,
  upstream retention and cross-restart live-provider retrieval remain operator
  validation tasks, not successful local test claims.
- The shipped configuration uses one generation worker loop. Do not run multiple
  independent processing workers against the same media tree; this change does
  not introduce a distributed execution/lease system.
- G6–G8 remain deferred. No reference/image generation, local H3 hosting, or
  migration of the legacy text-card LLM path was added.
- The dashboard remains a trusted-network application without authentication;
  proxy authentication is required before internet exposure. Local estimates
  are safeguards, not provider billing guarantees.
