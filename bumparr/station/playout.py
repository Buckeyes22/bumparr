"""A channel as a virtual clock.

There is no encoder loop and no thread. Each channel keeps a timeline of
(start time, conformed item) that is extended whenever someone asks for the
playlist, anchored to the wall clock, so serving the channel is arithmetic
over a list plus a static file per segment. The choice of what comes next
goes through the same scored_candidates helper as /api/bumpers/random, then
sequence.choose_next for adjacency (repeat the previous item only when it is
the last positive-score option).

This is also the first thing in Bumparr that reports plays. When an entry's
start time passes, it is written to play_history and the row's last_played
and play_count move, which is what finally gives the recency, affinity and
fatigue factors something to work with. Nothing here touches `weight`.

If nobody asks for a playlist for longer than the window, the timeline is
stale and restarts from now: extending it through hours nobody watched would
report plays that never aired.
"""
import math
import random
import threading
import time
from dataclasses import dataclass

from bumparr import channel_profile, config, creative, db, selection, sequence
from bumparr.station import conform

SLATE_ID = "slate"


@dataclass
class Entry:
    start: float
    item_id: str
    key: str
    segments: list
    duration: float
    title: str
    kind: str
    family: str = ""
    text_heavy: bool = False
    energy: str = ""
    audio: str = ""
    template: str = None
    music_id: str = None

    @property
    def end(self):
        return self.start + self.duration


class Channel:
    def __init__(self, name, kinds=None, now=None, rng=None):
        self.name = name
        self.kinds = set(kinds) if kinds else None
        self.rng = rng or random.Random()
        self.timeline = []
        self.seq_base = 0        # segments that have rolled off the front
        self.disc_base = 0       # entries that have rolled off (one discontinuity each)
        self.reported = 0        # entries from the front already written to the DB
        self.epoch = time.time() if now is None else now
        self.last_playlist_request = None
        self.lock = threading.RLock()

    @property
    def lookahead(self):
        return config.STATION_WINDOW_SEGMENTS * config.STATION_SEGMENT_SECONDS

    def _pool(self, index):
        if not index:
            return []
        with db.conn() as c:
            rows = [dict(r) for r in c.execute(
                "SELECT id,type,kind,source,title,payload,tags,weight,"
                "last_played,play_count,duration FROM playables "
                "WHERE enabled=1 AND health='ok'").fetchall()]
        pool = []
        for r in rows:
            entry = index.get(r["id"])
            if not entry or (self.kinds is not None and r["kind"] not in self.kinds):
                continue
            r["_idx"] = entry
            pool.append(r)
        return pool

    def _pick(self, now, prev_id):
        # prev_id matches timeline[-1] at the call site; adjacency uses
        # the last five in-memory entries (family/energy/text/music).
        index = conform.load_index()
        pool = self._pool(index)
        season, daypart = selection.live_factors()
        positive, _ = selection.scored_candidates(
            pool, season_factors=season, daypart_factors=daypart, now=now)
        candidates = [sequence.Candidate(row, score, creative.resolve_creative(row))
                      for row, score in positive]
        pick, _relaxed = sequence.choose_next(
            candidates, channel_profile.current(), self.timeline[-5:],
            self.rng, mode="station")
        if pick is not None:
            row = pick.row
            if "_idx" not in row:
                row["_idx"] = index.get(row["id"])
            row["_creative"] = pick.creative
            return row
        slate = index.get(SLATE_ID)
        if not slate:
            return None
        return {"id": SLATE_ID, "kind": SLATE_ID, "title": config.BRAND, "_idx": slate,
                "_creative": {}}

    def _drop(self, n):
        for e in self.timeline[:n]:
            self.seq_base += len(e.segments)
            self.disc_base += 1
        del self.timeline[:n]
        self.reported = max(0, self.reported - n)

    def _report(self, now):
        started = [e for e in self.timeline[self.reported:] if e.start <= now]
        if not started:
            return
        with db.conn() as c:
            for e in started:
                if e.item_id == SLATE_ID:
                    continue
                c.execute("INSERT INTO play_history(channel_id, playable_id, played_at) VALUES (?,?,?)",
                          ("station:" + self.name, e.item_id, e.start))
                c.execute("UPDATE playables SET last_played=?, play_count=play_count+1 WHERE id=?",
                          (e.start, e.item_id))
            last = started[-1]
            c.execute("INSERT INTO playout(channel_id, current_id, started_at) VALUES (?,?,?) "
                      "ON CONFLICT(channel_id) DO UPDATE SET current_id=excluded.current_id, "
                      "started_at=excluded.started_at",
                      ("station:" + self.name, last.item_id, last.start))
            c.commit()
        self.reported += len(started)

    def advance(self, now):
        """Handle a playlist request: extend, report, and forget the distant past."""
        with self.lock:
            # The timeline extends into the future, so its end cannot tell us
            # whether anyone was actually watching. Drop it before reporting if
            # no playlist was requested for a full window.
            if (self.timeline and self.last_playlist_request is not None
                    and now > self.last_playlist_request + self.lookahead):
                self._drop(len(self.timeline))
            self.last_playlist_request = now
            end = self.timeline[-1].end if self.timeline else now
            prev = self.timeline[-1].item_id if self.timeline else None
            while end < now + self.lookahead:
                pick = self._pick(end, prev)
                if pick is None:
                    break
                i = pick["_idx"]
                cr = pick.get("_creative") or {}
                self.timeline.append(Entry(
                    end, pick["id"], i["key"], list(i["segments"]),
                    float(i["duration"]), pick.get("title") or "",
                    pick.get("kind") or "",
                    family=cr.get("family") or "",
                    text_heavy=bool(cr.get("text_heavy")),
                    energy=cr.get("energy") or "",
                    audio=cr.get("audio") or "",
                    template=cr.get("template"),
                    music_id=cr.get("music_id")))
                end, prev = self.timeline[-1].end, pick["id"]
            self._report(now)
            n = 0
            while n < len(self.timeline) and self.timeline[n].end < now - 2 * self.lookahead:
                n += 1
            self._drop(n)

    def _segments(self):
        """Flatten to (global_index, entry, seg_index, seg_start, seg_duration)."""
        out, g = [], self.seq_base
        for e in self.timeline:
            t = e.start
            for i, d in enumerate(e.segments):
                out.append((g, e, i, t, d))
                g += 1
                t += d
        return out

    def playlist(self, now, seg_url):
        """The sliding-window media playlist, or None when nothing can air."""
        self.advance(now)
        with self.lock:
            seg = config.STATION_SEGMENT_SECONDS
            window = [s for s in self._segments()
                      if s[3] + s[4] > now - seg and s[3] < now + self.lookahead]
            if not window:
                return None
            first = window[0]
            # Every entry carries one discontinuity tag before its first segment.
            # Tags that precede the window, including the current entry's own if
            # the window opens mid-entry, are accounted for in the sequence number.
            disc_seq = self.disc_base + self.timeline.index(first[1]) + (1 if first[2] > 0 else 0)
            lines = ["#EXTM3U", "#EXT-X-VERSION:3",
                     "#EXT-X-TARGETDURATION:%d" % math.ceil(max(s[4] for s in window)),
                     "#EXT-X-MEDIA-SEQUENCE:%d" % first[0],
                     "#EXT-X-DISCONTINUITY-SEQUENCE:%d" % disc_seq]
            for _, e, i, _, d in window:
                if i == 0:
                    lines.append("#EXT-X-DISCONTINUITY")
                lines.append("#EXTINF:%.3f," % d)
                lines.append(seg_url(e.key, i))
            return "\n".join(lines) + "\n"

    def snapshot(self, now):
        """Return current timeline state without extending or reporting it.

        Additive: `last_playlist_request` and `lookahead_seconds` ride along
        with `now`/`next` so a single call under the channel lock gives a
        diagnostic view (`/api/station`) everything it needs without a second
        lock acquisition or a separate method.
        """
        with self.lock:
            cur = next((e for e in self.timeline if e.start <= now < e.end), None)
            nxt = next((e for e in self.timeline if e.start > now), None)

            def shape(e):
                return e and {"id": e.item_id, "title": e.title, "kind": e.kind,
                              "started_at": e.start, "ends_at": e.end}
            return {"now": shape(cur), "next": shape(nxt),
                    "last_playlist_request": self.last_playlist_request,
                    "lookahead_seconds": self.lookahead}

    def active_keys(self):
        with self.lock:
            return {e.key for e in self.timeline}


CHANNELS = {}
_REGISTRY_LOCK = threading.Lock()


def kinds_for(name):
    return None if name == "live" else set(config.STANDBY_KINDS)


def get(name, now=None):
    """The named channel, created on first use; None for an unknown name."""
    if name not in ("live", "standby"):
        return None
    with _REGISTRY_LOCK:
        ch = CHANNELS.get(name)
        if ch is None:
            ch = CHANNELS[name] = Channel(name, kinds_for(name), now)
        return ch


def active_keys():
    """Every key some channel has on its timeline; the conform sweep spares these."""
    with _REGISTRY_LOCK:
        channels = list(CHANNELS.values())
    keys = set()
    for ch in channels:
        keys |= ch.active_keys()
    return keys


def reset():
    """Forget every channel (tests)."""
    with _REGISTRY_LOCK:
        CHANNELS.clear()
