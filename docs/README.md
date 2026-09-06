# Bumparr documentation

Bumparr is a self-hosted engine for short television interstitials. The product
contract is [PRODUCT_VISION.md](PRODUCT_VISION.md): three modes (bumper library,
break composer, live station as showcase/failover), and it is not a long-form
programme scheduler. Runtime alignment of that contract is specified in
[ALIGNMENT_PLAN.md](ALIGNMENT_PLAN.md) and is not claimed complete by the
Phase 0 docs/catalog slice.

| Doc | What it covers |
|---|---|
| [PRODUCT_VISION.md](PRODUCT_VISION.md) | What Bumparr is trying to make, its three product modes, creative principles, and non-goals. |
| [CREATIVE_REFERENCE.md](CREATIVE_REFERENCE.md) | The sourced Adult Swim bumper reference, portable design lessons, and originality/rights boundary. |
| [ALIGNMENT_PLAN.md](ALIGNMENT_PLAN.md) | Self-contained execution specification for closing the product and creative gaps. |
| [GENERATION_PLAN.md](GENERATION_PLAN.md) | First-class, review-gated generative content system: direct MiniMax H3, OpenRouter multi-model media, and later image/card convergence. Proposed spec; not a claim that the integration is already shipped. |
| [GENERATION_IMPLEMENTATION_STATUS.md](GENERATION_IMPLEMENTATION_STATUS.md) | G0–G5 coverage, live-doc re-check notes, tests actually run, and operator-controlled paid next steps. |
| [FRONTEND_PLAN.md](FRONTEND_PLAN.md) | Operator-console information architecture and frontend enhancement plan. |
| [INTEGRATION.md](INTEGRATION.md) | Wiring Bumparr into your channel: ErsatzTV, Tunarr, Dispatcharr, anything else. |
| [CARDS.md](CARDS.md) | Making the cards yours: the shapes per kind, the model prompts, adding a whole new kind. |
| [API.md](API.md) | The full HTTP API: status, the output contract (random/fill/m3u), management actions, stream proxy, dashboard. |
| [CONFIG.md](CONFIG.md) | Every environment variable, its default, and what it does. `.env.example` is the commonly-touched subset. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How acquisition → production → registry → selection → service fit together, the file map, and the invariants to preserve. |
| [ROTATION.md](ROTATION.md) | The scoring model (base × season × daypart × recency × affinity × fatigue) and practical tuning guidance. |
| [STATION.md](STATION.md) | Running the bumper pool as live and standby HLS channels. |
| [SCHEMA.md](SCHEMA.md) | The SQLite schema: column-by-column reference, id conventions, the card lifecycle, upsert rules. |
| [CLI.md](CLI.md) | Every `python -m bumparr.…` module and flag, plus `tools/overnight.sh`. |
| [RELEASE_REVIEW.md](RELEASE_REVIEW.md) | Human review checklist for the ten-minute plan and 15/30/60/90 packs. |
| [RENDERING.md](RENDERING.md) | How cards become MP4s: the pipeline, per-kind rendering, volatile cards and their TTLs. |

Read order for a first deploy: the main [README](../README.md), then
[INTEGRATION.md](INTEGRATION.md). Read order for contributors:
[PRODUCT_VISION.md](PRODUCT_VISION.md), [CREATIVE_REFERENCE.md](CREATIVE_REFERENCE.md),
and [ARCHITECTURE.md](ARCHITECTURE.md), then [ALIGNMENT_PLAN.md](ALIGNMENT_PLAN.md),
[GENERATION_PLAN.md](GENERATION_PLAN.md), [FRONTEND_PLAN.md](FRONTEND_PLAN.md),
[ROTATION.md](ROTATION.md), [STATION.md](STATION.md), and [SCHEMA.md](SCHEMA.md),
then the module docstrings (they carry the "why").
