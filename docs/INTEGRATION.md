# Wiring Bumparr into your channel

## Contents

- [The three ways out](#the-three-ways-out)
- [Filling a gap](#filling-a-gap-the-part-nothing-else-does)
- [ErsatzTV](#ersatztv)
- [Tunarr](#tunarr)
- [Dispatcharr](#dispatcharr)
- [Anything else](#anything-else)
- [Keeping the pool fresh](#keeping-the-pool-fresh)
- [Notes](#notes)

Bumparr produces short interstitials. It is not a long-form programme
scheduler: it does not schedule episodes or films. Hand the **bumper library**
and **break composer** to ErsatzTV, Tunarr, or anything that places filler;
use the **live station** as a bumper showcase and **standby** as branded
failover.

Everything below assumes Bumparr is reachable at `http://bumparr:8780`. If it
sits behind a reverse proxy, set `PUBLIC_URL` to the address your *consumers*
reach, because the playlist hands out absolute URLs to a separate player process
that has no idea where the playlist came from.

```dotenv
PUBLIC_URL=https://bumpers.example.com
```

## The three ways out

| Endpoint | Gives you | Use it when |
|---|---|---|
| `GET /api/bumpers/fill?seconds=N` | An ordered bumper set that fits N seconds with optional placement | You have a break to compose (not a programme schedule) |
| `GET /api/bumpers/random` | Up to `count` bumpers (default 5), JSON | You want to pick some yourself |
| `GET /playlist.m3u` | Unsequenced M3U of every playable bumper, absolute URLs | Your downstream scheduler ingests a pool listing |

The fill endpoint is the interesting one, and the reason Bumparr exists as a
break composer. The live showcase and standby failover are a fourth path:
`/station/live/index.m3u8` and `/station/standby/index.m3u8`.

## Filling a gap (the part nothing else does)

Ask for a duration and Bumparr hands back an ordered bumper set that adds up
to it. This composes a break; it does not schedule the show on either side:

```bash
curl 'http://bumparr:8780/api/bumpers/fill?seconds=47'
```

```text
seconds=47&tolerance=1.5&max_items=8&types=video,card&placement=close
```

- `seconds` — the gap you need to fill (required)
- `tolerance` — acceptable over/under, default `1.5s`
- `max_items` — cap on how many pieces, default `8`
- `types` — restrict to `video`, `card`, `stream`, `image`
- `placement` — `any` (default), `open`, `inside`, or `close`. Invalid values are 4xx, not fallback to `any`.

It solves this as a small subset-sum with randomised restarts, not a greedy
pass. That matters: greedy grabs the biggest clip that fits and leaves a
stubborn remainder no single clip covers, which is exactly how filler systems
end up with dead air at the end of every break. Bumparr will combine a 22s
clip, an 18s card and a 7s ident to land on 47.

## ErsatzTV

ErsatzTV has first-class filler support, so point it at Bumparr's unsequenced
pool listing and let ErsatzTV place the bumpers.

1. **Add the library.** Bumparr writes finished bumpers to its output directory
   (`OUTPUT`, default `<assets>/bumpers`). Mount that path into ErsatzTV and add
   it as a local library — this is the simplest, most reliable route, because
   ErsatzTV indexes real files.
2. **Build a Filler Preset** (Playout → Filler Presets) pointing at that
   library. Set it to *Pad* or *Pre-roll / Post-roll* depending on where you
   want bumpers.
3. **Attach the filler** to the schedule items that need it.

If you would rather not share a filesystem, add `http://bumparr:8780/playlist.m3u`
as a playlist source instead — just make sure `PUBLIC_URL` is set so the URLs
resolve from ErsatzTV's container.

The live showcase can also be added as a stream source
(`/station/live/index.m3u8`) for a bumper-only channel alongside the
file-based filler. That channel still does not schedule episodes or films.

## Tunarr

Tunarr also does flex/filler natively.

1. Add Bumparr's output directory as a media source (same mount approach as
   above), or add the M3U.
2. In the channel's **Flex** settings, choose the bumper library as filler
   content.
3. Set flex to fill the gap rather than pad with a static image.

The live showcase can also be added as a stream source
(`/station/live/index.m3u8`) for a bumper-only channel alongside the
file-based filler. That channel still does not schedule episodes or films.

## Dispatcharr

Dispatcharr relays live streams; it does not schedule files, so a playlist
of bumper files is not useful to it. Bumparr therefore runs its bumper pool
as HLS: `live` is a showcase and `standby` is branded failover. Dispatcharr
consumes those like any provider. This is still not episode or film
scheduling.

1. **Add the channel.** Sources → M3U: `http://bumparr:8780/station/channel.m3u`.
   Two streams appear in the `Bumparr` group: the live showcase and standby failover.
2. **Add the guide.** Sources → EPG: `http://bumparr:8780/station/guide.xml`.
   The `tvg-id`s match, so the guide assigns itself.
3. **Use standby as failover.** On any channel whose provider drops, add
   `http://bumparr:8780/station/standby/index.m3u8` as the **last** stream.
   Dispatcharr rotates onto it when everything above it fails, and the
   viewer sees a branded "please stand by" loop instead of a dead stream.

`PUBLIC_URL` must be the address Dispatcharr's container can reach, because
segment URLs in the playlist are absolute.

The channel's character by hour comes from `config_files/dayparts.yaml`;
what standby may air comes from `STANDBY_KINDS`. Until the first conform
sweep finishes the playlist returns 503; the dashboard's Station panel shows
progress and has a "Conform now" button.

## Anything else

If your tool speaks neither M3U nor local files, drive it from the API:

```bash
# what's in the pool
curl http://bumparr:8780/api/status

# up to five bumpers as JSON (set ?count=N to choose)
curl http://bumparr:8780/api/bumpers/random

# fill a 30-second gap with video only
curl 'http://bumparr:8780/api/bumpers/fill?seconds=30&types=video'
```

## Keeping the pool fresh

Bumparr maintains itself, but the useful manual levers are:

```bash
# pull the shipped starter seeds (needs PEXELS_API_KEY / PIXABAY_API_KEY)
curl -X POST http://bumparr:8780/api/starter

# generate more cards of a kind
curl -X POST http://bumparr:8780/api/generate/psa

# render text cards to video files
curl -X POST http://bumparr:8780/api/render/cards

# remove file debris / revive items marked unhealthy
curl -X POST http://bumparr:8780/api/pool/tidy
curl -X POST http://bumparr:8780/api/pool/revive
```

Text cards are structured content until they are rendered. If your consumer
plays files (ErsatzTV, Tunarr), run `/api/render/cards` so they become real
MP4s; a consumer that reads the API can use them directly.

## Notes

> [!NOTE]
> **The cams that ship enabled are open direct-HLS feeds** — no key, no
> scraping, genuinely live. YouTube-backed snapshot cams are supported but ship
> disabled; enable them yourself in `bumparr/config_files/live_cams.yaml` if you
> want them (`yt-dlp` is already installed for it).

> [!TIP]
> **A local model is optional.** Grounded cards, procedural kinds, and a
> built-in starter set all work with no model configured. See the [README](../README.md).
