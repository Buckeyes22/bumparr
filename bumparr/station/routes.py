"""The station's HTTP surface: playlists, the channel list, the guide, status."""
import time

from fastapi import APIRouter, Request, Response
from fastapi.responses import PlainTextResponse

from bumparr import config, db, urls
from bumparr.station import conform, guide, playout

router = APIRouter()
M3U8 = "application/vnd.apple.mpegurl"


def _seg_url(request):
    base = urls.public_base(request)
    return lambda key, n: "%s/station/seg/%s/%03d.ts" % (base, key, n)


def _attr(s):
    return str(s or "").replace('"', "'").replace("\n", " ")


@router.get("/station/{channel}/index.m3u8")
def index_m3u8(channel: str, request: Request):
    """The live media playlist. `no-store` because it changes every few seconds."""
    ch = playout.get(channel)
    if ch is None:
        return PlainTextResponse("unknown channel\n", status_code=404)
    body = ch.playlist(time.time(), _seg_url(request))
    if body is None:
        return PlainTextResponse("nothing conformed yet; run a conform pass (POST /api/station/conform)\n",
                                 status_code=503, headers={"Cache-Control": "no-store"})
    return Response(body, media_type=M3U8, headers={"Cache-Control": "no-store"})


@router.get("/station/channel.m3u")
def channel_m3u(request: Request):
    """Both channels as an M3U source, tvg-ids matching guide.xml."""
    base, brand = urls.public_base(request), config.BRAND
    lines = ["#EXTM3U"]
    for name, label in (("live", brand), ("standby", brand + " standby")):
        lines.append('#EXTINF:-1 tvg-id="bumparr.%s" tvg-name="%s" group-title="Bumparr",%s'
                     % (name, _attr(label), _attr(label)))
        lines.append("%s/station/%s/index.m3u8" % (base, name))
    return PlainTextResponse("\n".join(lines) + "\n", media_type="audio/x-mpegurl")


@router.get("/station/guide.xml")
def guide_xml():
    return Response(guide.xmltv(), media_type="application/xml",
                    headers={"Cache-Control": "max-age=300"})


def _channel_diagnosis(snap, conformed):
    """`state`/`reason` for one channel's snapshot, purely from data already
    in hand: whether something is airing right now, and whether anything has
    been conformed at all (the playlist route would 503 with nothing
    conformed, so the operator UI needs to say so explicitly)."""
    now = snap.get("now")
    if now is not None:
        return ("active", "slate" if now["id"] == playout.SLATE_ID else "playing")
    if conformed > 0:
        return ("idle", "no_recent_client")
    return ("unavailable", "nothing_conformed")


@router.get("/api/station")
def station_status(request: Request):
    """Now/next per channel, conform progress, and the URLs to hand a consumer."""
    now, base = time.time(), urls.public_base(request)
    index = conform.load_index()
    with db.conn() as c:
        eligible = len(conform.eligible_rows(c))
    conformed = len([k for k in index if k != conform.SLATE_KEY])
    channels = {}
    for name in ("live", "standby"):
        snap = playout.get(name).snapshot(now)
        state, reason = _channel_diagnosis(snap, conformed)
        snap["state"], snap["reason"] = state, reason
        channels[name] = snap
    return {"ffmpeg": bool(conform.ffmpeg_path()), "conformed": conformed, "eligible": eligible,
            "pending": max(0, eligible - conformed),
            "last_conform": conform.last_sweep(),
            "urls": {"channel_m3u": base + "/station/channel.m3u",
                     "guide_xml": base + "/station/guide.xml",
                     "live": base + "/station/live/index.m3u8",
                     "standby": base + "/station/standby/index.m3u8"},
            "channels": channels}
