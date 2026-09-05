# Card rendering

How a card goes from JSON payload to a playable MP4, and what each piece is
for. The module is `bumparr/render_cards.py`; this is the map of it.

## Why rendering exists at all

Bumparr's contract is that *something else* plays its output — ErsatzTV,
Dispatcharr, Tunarr, a media server, a plain player. A card that exists only
as a JSON payload is invisible to all of them, which would make the most
distinctive thing Bumparr produces unusable. Rendering closes that gap.

Until a card is rendered its `uri` is NULL: it stays out of `/playlist.m3u`
and `media_url` returns nothing for it. Bumparr never advertises something a
consumer cannot play.

## The pipeline

```text
playables row (type=card)
  └─ render_all:  select unrendered (volatile kinds always re-checked)
       └─ render_one per card
            ├─ layout:  template-aware _place / _compose — title-safe
            │           1920×1080 region; reveal + brand pre-reserved
            │           (no mid-play jump). Brand mode reveal/static/none.
            ├─ draw:    PIL — base layer (bg image + scrim + text),
            │           transparent reveal layer, transparent brand layer
            └─ encode:  ffmpeg → 1080p30 H.264 + AAC (silent track if no
                        music), alpha fades for the timed reveals,
                        yuv420p + faststart for transcoders/set-top players
  └─ registry:  set uri, health='ok', stamp payload.brand/branded
```

Output goes to `ASSET_ROOT/cards/<id>.mp4` (`OUT_SUBDIR`), a working cache of
fetched background images sits in a *sibling* `.cache/` dir so library scanners
can't mistake it for a bumper.

## What each kind renders as

| Kind | Path | Notes |
|---|---|---|
| Prose kinds (psa, corrections, achievements, coming_up, trivia, fun_facts, tiny_games, on_this_day, number) | static layout + timed alpha fades | the answer/meaning (`reveal_after`) fades in at its scheduled time; the brand mark fades in after. A hard cut for the reveal would read as a glitch. |
| `station_id` | frame-by-frame | reproduces the three stylesheet animations (fade-up, scale-in with closing tracking, breathing glow). |
| `dead_air` | frame-by-frame | black, with the corner brand easing in over the final two seconds. |
| `local_time` | frame-by-frame, **volatile** | the wall clock advances frame by frame; the file is re-rendered on its TTL so it stays truthful. |
| `weather` | frame-by-frame, **volatile** | static conditions fetched at render time; TTL re-render, same as the clock. |
| `technical_difficulties` (bars / nosignal) | composed ground + caption | SMPTE bars on the top 78%, caption on a translucent band. |
| `technical_difficulties` (static) | ffmpeg-generated grain + caption | per-pixel noise is the one thing PIL does badly; ffmpeg's noise filter gives real grain for free. |

## Volatile kinds (perishable cards)

`local_time` and `weather` render files whose *content goes out of date* —
the only kind of card where "already rendered" is a lie after a while. The
treatment is the same as the live-window cams: a TTL
(`TTL_LOCAL_TIME`, `TTL_WEATHER`) and the volatile-refresh loop
(`VOLATILE_INTERVAL`) re-render only the files that have aged out. `is_stale`
is the per-file check; `refresh_volatile` is the cheap scheduled pass.

This is also why these two kinds are the only ones allowed into
`render_all`'s candidate set after they have a `uri`.

## Templates

A finite set, not a plugin framework. Kind/family compatibility is defined in
`bumparr.creative`. Strict creation/preview rejects an incompatible explicit
template; runtime rendering falls back to the documented default.

| Template | Use |
|---|---|
| `minimal_center` | Current centred column. Default for ordinary text cards (`presentation.default_template`). |
| `minimal_corner` | Sparse safe-corner/edge text. |
| `image_caption` | Background (or dark ground) plus a restrained safe-area caption. |
| `information_board` | Weather, clock, fact, and number presentation. Weather/clock keep their existing builders. |
| `signal` | Failure / dead-air presentation (existing technical-difficulties and dead-air builders). |
| `ident` | Existing station-ident builders. Ident family only. |

New items persist `payload.creative.template`, `render_seed`, and `brand_mode`.
Legacy items derive `render_seed` from a stable id hash (not process `hash()`)
and persist those fields only during an explicit render or refresh — never
inspection or selection. Existing files stay until you re-render (`--force`).

Brand modes: `reveal` (timed fade, delay varied by `render_seed`), `static`
(visible from the first frame), `none` (no brand layer). Idents and failure
cards default to `none`; periodic idents carry continuity instead of a forced
reveal on every new card. Profile default for ordinary cards is `reveal`.

## Layout fidelity

The renderer deliberately mirrors the reference player's CSS: sizes are kept
as the stylesheet's `vmin` numbers (1 vmin = 10.8px at 1080p) so the file can
be diffed against the stylesheet; the reveal and brand elements occupy layout
space from frame one (opacity 0 in the browser, transparent layers here) so
content above them never shifts when they appear. Every template keeps glyphs
inside the 10% title-safe region at 1920×1080.

Fonts come from `CARD_FONT` / `BRAND_FONT` with bundled OFL fallbacks
(see [fonts/README.md](../bumparr/fonts/README.md)); `.woff2` names resolve to a same-stem
`.ttf`/`.otf` because Pillow can't read web fonts.

## Running it

```bash
# from the API (the usual path)
curl -X POST 'http://localhost:8780/api/render/cards'              # everything pending
curl -X POST 'http://localhost:8780/api/render/cards?limit=25'     # in batches

# from the CLI (same module, with progress)
docker compose exec bumparr python -m bumparr.render_cards
docker compose exec bumparr python -m bumparr.render_cards --force
```

Offline and idempotent: a card with a fresh file on disk is skipped (unless
`--force`), so it is safe to run on a schedule after every generation pass —
which is what `tools/overnight.sh` does in phase 2.
