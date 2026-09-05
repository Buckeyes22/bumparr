# Bumparr

![CI](https://github.com/mikemcg94/bumparr/actions/workflows/ci.yml/badge.svg?branch=main) ![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)

**A bumper generator for the \*arr stack.** Point it at your sources and it builds
and maintains a self-refreshing pool of TV bumpers / interstitials — station IDs,
"please stand by" cards, trivia, live "window" cams, public-domain clips, ambient
loops.

Bumparr is a self-hosted engine for making and serving short television
interstitials. It is not a long-form programme scheduler: it does not schedule
episodes or films. Lead with the **bumper library** and **break composer**; the
live station is a bumper showcase plus branded failover.

| Mode | What it does |
|---|---|
| Bumper library | Create, ingest, inspect, enable, disable, render, and serve individual items. `/playlist.m3u` is an unsequenced pool listing for a downstream scheduler (ErsatzTV, Tunarr, or similar). |
| Break composer | `GET /api/bumpers/fill` returns an ordered bumper set that fits a duration and optional placement. It is not a programme schedule. |
| Live station | `/station/live` is a continuous bumper showcase; `/station/standby` is branded failover. The station schedules only its own bumper pool. |

## Run it

```bash
cp .env.example .env      # optional; all settings have safe defaults
docker compose up -d
# dashboard: http://localhost:8780
```

Runs as its own service on port `8780`, next to the rest of your stack. By
default, Docker-managed `bumparr-assets` and `bumparr-data` volumes persist the
library and database and work on a clean checkout. To use host directories,
set `ASSETS` and `DATA` in `.env`; the container runs as UID/GID `10001`, so
those bind mounts must be writable by that identity (for example,
`sudo chown -R 10001:10001 /path/to/assets /path/to/data`).

> [!NOTE]
> The live cams that ship enabled are open, direct-HLS feeds — no key, no
> scraping, genuinely real-time. Bumparr can *also* capture YouTube-backed
> cams, but ships none enabled: whether to scrape YouTube is your call to make
> for your own install, not this project's to make for you. See
> `bumparr/config_files/live_cams.yaml` for a commented template.

## What it produces

Bumpers are "playables" of several types, all served from one pool:

- **video** — public-domain clips (Internet Archive), NASA/ambient loops, vintage
  station IDs, cartoons, your own media
- **stream** — live "window" cams (open DOT traffic cams play truly live;
  YouTube-backed cams are opt-in, captured as fresh looping snippets)
- **card** — generated text cards: trivia & fun-facts (**grounded in real sources**,
  not model hallucination), surreal PSAs, "we'll be right back", unexplained
  numbers, on-this-day, and more
- **image** — timed image cards

Everything is configurable — sources, cams, fonts, brand, and the local model
endpoint — via `.env` and `config_files/`. No code changes to adopt.

**A local model is optional.** Grounded cards (trivia, fun-facts, numbers) come
from real sources, and the procedural kinds plus every other kind ship with a
small built-in starter set, so a fresh install with no model still has content in
every kind. Point Bumparr at any OpenAI-compatible endpoint to generate far more,
in your own voice — the model diversifies the pool, it is not required to run.

## Render cards to video first

Video, stream and image bumpers are files (or live URLs) the moment they land.
**Text cards are not** — they start life as structured content, so they have to be
rendered before anything outside Bumparr can play them:

```bash
curl -X POST 'http://localhost:8780/api/render/cards?limit=N' # optional batch limit
docker compose exec bumparr python -m bumparr.render_cards   # same thing, with progress
```

This lays each card out and encodes a 1080p30 H.264 MP4 with a silent AAC track,
timed answer/brand reveals included. It is offline and idempotent — already-rendered
cards are skipped, so it is safe to run on a schedule after generating new ones.
Until a card is rendered it stays out of `/playlist.m3u` and its `media_url` is
`null`, which is deliberate: Bumparr never advertises something a consumer cannot play.

Time-sensitive `weather` and `local_time` cards are rendered too, then refreshed
automatically on their configured TTLs so file-based consumers do not air stale data.

## Consume it

The primary product is the bumper library and the break composer. The live
station is a showcase of that same pool, plus branded failover.

| Endpoint | Use |
|---|---|
| `GET /api/bumpers/fill?seconds=N` | Ordered bumper set that fits a duration and optional placement (not a programme schedule) |
| `GET /api/bumpers/random?count=N&max_duration=S&types=video,card` | N bumpers from the library, ranked by the scoring model |
| `GET /playlist.m3u` | Unsequenced M3U of every playable bumper (video, stream, rendered cards) for a downstream scheduler |
| `GET /media/<path>` | The actual media files |
| `GET /station/live/index.m3u8` | Bumper showcase HLS |
| `GET /station/standby/index.m3u8` | Branded failover HLS |
| `GET /station/channel.m3u` + `/station/guide.xml` | Both station channels plus XMLTV (Dispatcharr, or any HLS player) |

Plus `GET /api/status`, `GET /api/bumpers`, `POST /api/render/cards`, and
`POST /api/generate/<kind>` / `POST /api/sources/<action>` to drive it from the
dashboard or scripts.

> [!CAUTION]
> Bumparr ships with no auth — the dashboard and every POST/DELETE endpoint are
> open to whoever can reach the port, so keep it off the open internet.

Every URL Bumparr hands out is absolute, because the thing that fetches a playlist
is rarely the thing that plays its entries. Behind a reverse proxy, set
`PUBLIC_URL` to the address consumers actually reach; otherwise Bumparr
derives it from the incoming request.

`/fill` solves a duration as a subset-sum rather than a greedy pass, then
applies break sequence grammar (placement, family, text run, exit ident).
That is the contract a channel generator actually needs for bumper
placement, and nothing else in the \*arr ecosystem offers it.

The live station is the bumper pool run as HLS: pre-conformed segments and a
playlist, no encoder in the playback path. It showcases bumpers; it does not
schedule episodes or films.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/PRODUCT_VISION.md](docs/PRODUCT_VISION.md) | what Bumparr is trying to make and the experience it should deliver |
| [docs/CREATIVE_REFERENCE.md](docs/CREATIVE_REFERENCE.md) | the Adult Swim bumper reference and what to preserve without copying |
| [docs/ALIGNMENT_PLAN.md](docs/ALIGNMENT_PLAN.md) | self-contained execution specification for closing the product and creative gaps |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | wiring Bumparr into ErsatzTV, Tunarr, Dispatcharr |
| [docs/CARDS.md](docs/CARDS.md) | making the cards yours: shapes per kind, model prompts, new kinds |
| [docs/API.md](docs/API.md) | the full endpoint reference, incl. the dashboard |
| [docs/CONFIG.md](docs/CONFIG.md) | every environment variable and its default |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how the pipeline fits together, and the invariants to keep |
| [docs/ROTATION.md](docs/ROTATION.md) | the scoring model and how to tune variety |
| [docs/STATION.md](docs/STATION.md) | running the pool as a live channel: conform, the two channels, dayparts, the guide, standby failover |
| [docs/SCHEMA.md](docs/SCHEMA.md) | the database: every column, the card lifecycle, id conventions |
| [docs/CLI.md](docs/CLI.md) | every `python -m` module, flags, and the overnight batch |
| [docs/RENDERING.md](docs/RENDERING.md) | the card-rendering pipeline, volatile cards, TTLs |

## The pool maintains itself

- Live-window cams re-capture on a schedule so they stay current.
- A self-healing fetch queue retries public-domain downloads that failed (e.g. a
  temporarily-down archive node).
- Generated card content is grounded where it must be true and free-wheeling only
  where invention is the point.

## Sources & licensing

Bumparr ships pointed at genuinely public-domain / open sources. Anything you add
via config is your responsibility. Bundled fonts live in `bumparr/fonts/` and are
OFL (commercial-OK); a personal-use font is your own config, never redistributed.
Point `CARD_FONT` / `BRAND_FONT` at any `.ttf`/`.otf` to restyle
rendered cards.

## License

**GNU AGPL-3.0** — see [LICENSE](LICENSE). Contributions welcome.

Copyleft, matching the rest of the \*arr stack (Sonarr/Radarr/Prowlarr are GPL-3.0,
Dispatcharr is AGPL-3.0). You're free to use, modify, and self-host Bumparr,
including commercially — but any modified version you distribute *or run as a
network service* must make its complete source available under the same license.
That keeps every fork open and prevents closed-source resale.

Copyright (c) 2026 the Bumparr authors.
