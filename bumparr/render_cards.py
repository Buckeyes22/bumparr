"""Render text cards to real video files.

Bumparr's entire contract is that something ELSE plays its output — ErsatzTV,
Dispatcharr, Tunarr, a media server, a plain player. Cards used to exist only as
JSON payloads that one specific browser player knew how to draw, which meant the
most distinctive thing Bumparr produces was invisible to every consumer. This
module closes that gap.

The layout deliberately mirrors the CSS in the reference player so a rendered
card looks like the card it came from: same vmin-derived sizes, same centred
flex-column stack, same letter-spacing, same timed reveals. The reveal is a real
opacity fade, done as an ffmpeg alpha fade over a transparent layer, because a
card whose answer simply cuts in reads as a glitch.

Render is offline and idempotent: a card with a fresh file on disk is skipped.
Nothing here runs in the playback path.
"""
import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import closing
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from bumparr import config, creative, db, ffmpeg_pipe, music

# ---------------------------------------------------------------- geometry --
# The reference player sizes everything in `vmin`. At 1920x1080 one vmin is
# 10.8px. Keeping the vmin numbers visible (rather than pre-multiplied pixels)
# is what lets this file be diffed against the stylesheet.
W, H = 1920, 1080
VMIN = min(W, H) / 100.0

PAD = 8.0 * VMIN            # .card padding
GAP = 3.0 * VMIN            # .card gap

# Title-safe region at 1920×1080 (10% inset). All templates keep glyphs here.
SAFE_LEFT = int(0.10 * W)
SAFE_TOP = int(0.10 * H)
SAFE_RIGHT = W - SAFE_LEFT
SAFE_BOTTOM = H - SAFE_TOP
SAFE_W = SAFE_RIGHT - SAFE_LEFT
SAFE_H = SAFE_BOTTOM - SAFE_TOP

FG = (232, 232, 232)        # --fg
DIM = (138, 138, 138)       # --dim
WHITE = (255, 255, 255)

# Font sizes / tracking, straight from the stylesheet.
SZ_EYEBROW, TRACK_EYEBROW = 2.2 * VMIN, 0.5      # letter-spacing: .5em
SZ_BIG = 8.0 * VMIN
SZ_BIG_NUMBER, TRACK_BIG_NUMBER = 12.0 * VMIN, 0.04
SZ_LINES, LH_LINES = 4.0 * VMIN, 1.5
SZ_REVEAL = 5.0 * VMIN
SZ_BRAND, TRACK_BRAND = 6.5 * VMIN, 0.06
BRAND_MARGIN_TOP = 2.0 * VMIN

FADE_REVEAL = 0.6           # .reveal transition
FADE_BRAND = 1.0            # .brand-reveal transition
_BG_MAX = 64 * 1024 * 1024

# Category labels, mirroring CARD_LABELS in the reference player.
CARD_LABELS = {
    "trivia": "TRIVIA", "psa": "", "number": "", "corrections": "CORRECTION",
    "fun_facts": "FUN FACT", "connections": "CONNECTION", "three_clues": "WHO OR WHAT?",
    "guess_year": "GUESS THE YEAR", "on_this_day": "ON THIS DAY",
    "achievements": "ACHIEVEMENT", "coming_up": "COMING UP EVENTUALLY",
    "tiny_games": "",
}

# Kinds this module renders as text cards.
TEXT_KINDS = set(CARD_LABELS) | {"psa", "number"}

# Kinds rendered frame-by-frame because their look is animated rather than a
# static layout with a timed fade.
ANIMATED_KINDS = {"station_id", "dead_air", "local_time", "weather"}

# Kinds whose CONTENT goes out of date, and how long a rendered file stays
# truthful. These are not "unrenderable" — they are perishable, exactly like the
# live-window cams the pool already re-captures on a schedule. A file older than
# its TTL is re-rendered rather than served, which is what lets a clock card
# exist as a file at all.
VOLATILE_TTL = {
    "local_time": int(config.env("TTL_LOCAL_TIME", "60")),
    "weather": int(config.env("TTL_WEATHER", "1800")),
}

SMPTE = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"]

OUT_SUBDIR = "cards"        # under ASSET_ROOT — rendered media, safe to scan
# Working cache, deliberately a SIBLING of the output rather than inside it:
# consumers point a library scanner at the media directories, and a scanner
# cannot tell a cached source JPEG from a bumper it should air.
_BG_CACHE = ".cache/card-backgrounds"


# ------------------------------------------------------------------- fonts --
def _font_dirs():
    """Search path for font files, most specific first.

    Bumparr ships its own OFL fonts so it never depends on the player's asset
    tree; the player's font directory is still searched when the two are
    deployed together, so a shared brand font resolves from either side.
    """
    dirs = [Path(__file__).resolve().parent / "fonts"]
    try:
        dirs.append(Path(config.FRONTEND_DIR) / "fonts")
    except Exception:
        pass
    dirs += [Path("/usr/share/fonts/truetype/dejavu")]
    return [d for d in dirs if d.is_dir()]


def _resolve_font_file(name, fallbacks):
    """Find a Pillow-loadable font file for `name`.

    Web fonts are the wrinkle: the player's default is a .woff2, which browsers
    read and Pillow cannot. Rather than fail, resolve a .ttf/.otf sharing the
    same stem, then fall back through the supplied list.
    """
    cands = []
    if name:
        cands.append(name)
        stem = Path(name).stem
        cands += [stem + ".ttf", stem + ".otf"]
    cands += list(fallbacks)
    for cand in cands:
        p = Path(cand)
        if p.is_absolute() and p.is_file() and p.suffix.lower() in (".ttf", ".otf"):
            return str(p)
        for d in _font_dirs():
            f = d / cand
            if f.is_file() and f.suffix.lower() in (".ttf", ".otf"):
                return str(f)
    return None


def _load(path, size):
    """Pillow font at `size`, degrading to the built-in default rather than
    failing a whole render because one face is missing or unreadable."""
    if path:
        try:
            return ImageFont.truetype(path, round(size))
        except Exception:
            pass
    return ImageFont.load_default()


_MISSING = "\ue000"      # private-use, unmapped in our fonts -> renders .notdef


def _has_glyph(font, ch):
    """True when `font` really has `ch`, rather than substituting tofu.

    Pillow reports a bitmap for a missing glyph too (the .notdef box has a
    bounding box), so presence has to be decided by comparing the raster
    against a codepoint the font definitely lacks.
    """
    try:
        a = font.getmask(ch, mode="L")
        b = font.getmask(_MISSING, mode="L")
        return (a.size, bytes(a)) != (b.size, bytes(b))
    except Exception:
        return False


def _symbol_font(ch, size):
    """A font that can actually draw `ch`, or None.

    Weather cards carry an emoji chosen by the generator, and text fonts do not
    cover them. DejaVu supplies the classic monochrome weather symbols, which is
    the right trade here: a colour emoji font is a large dependency with fragile
    Pillow support, whereas a missing symbol degrades to simply not drawing it.
    """
    for cand in ("DejaVuSans.ttf", "DejaVuSerif-Bold.ttf"):
        path = _resolve_font_file(cand, [])
        if not path:
            continue
        f = _load(path, size)
        if _has_glyph(f, ch):
            return f
    return None


def fonts():
    """(card_font_path, brand_font_path) resolved once per run."""
    card = _resolve_font_file(config.CARD_FONT,
                              ["card-nunito.ttf", "card-quicksand.ttf", "DejaVuSans.ttf"])
    brand = _resolve_font_file(config.BRAND_FONT,
                               ["DejaVuSansMono-Bold.ttf", "DejaVuSans-Bold.ttf",
                                "card-nunito.ttf"])
    return card, brand


# -------------------------------------------------------------- text layout --
def _text_w(draw, s, font, track_em=0.0):
    """Width of `s`, including CSS-style letter-spacing.

    Pillow has no letter-spacing, so tracked text is drawn glyph by glyph and
    must be measured the same way or it will not centre.
    """
    if not s:
        return 0
    base = draw.textlength(s, font=font)
    if track_em:
        base += track_em * font.size * len(s)
    return base


def _draw_centred(draw, y, s, font, fill, track_em=0.0):
    """Draw `s` horizontally centred at baseline-top `y`. Returns its width."""
    if not s:
        return 0
    w = _text_w(draw, s, font, track_em)
    return _draw_at(draw, (W - w) / 2.0, y, s, font, fill, track_em)


def _draw_at(draw, x, y, s, font, fill, track_em=0.0):
    """Draw `s` at left `x`, baseline-top `y`. Returns its width."""
    if not s:
        return 0
    w = _text_w(draw, s, font, track_em)
    if not track_em:
        draw.text((x, y), s, font=font, fill=fill)
        return w
    cursor = x
    for ch in s:
        draw.text((cursor, y), ch, font=font, fill=fill)
        cursor += draw.textlength(ch, font=font) + track_em * font.size
    return w


def _wrap(draw, text, font, max_w, track_em=0.0):
    """Word-wrap to `max_w`, honouring existing newlines (CSS pre-wrap)."""
    out = []
    for para in str(text).split("\n"):
        words, line = para.split(), ""
        if not words:
            out.append("")
            continue
        for word in words:
            trial = (line + " " + word).strip()
            if _text_w(draw, trial, font, track_em) <= max_w or not line:
                line = trial
            else:
                out.append(line)
                line = word
        if line:
            out.append(line)
    return out


class Block:
    """One laid-out run of text: the unit the vertical packing works on."""

    def __init__(self, lines, font, size, fill, track=0.0, lh=1.25, layer="base",
                 align="center"):
        """Pre-measure a run of lines so layout (and its height) is known
        before drawing; `layer` marks which transparency layer it lands on."""
        self.lines, self.font, self.size = lines, font, size
        self.fill, self.track, self.lh = fill, track, lh
        self.layer = layer            # base | reveal | brand
        self.align = align            # center | left | right
        self.line_h = size * lh
        self.height = self.line_h * len(lines)


def _content_blocks(draw, kind, payload, title, card_font, max_w, size_lines=None,
                    align="center"):
    """Eyebrow + body + optional reveal, without the brand mark."""
    blocks = []
    line_size = size_lines if size_lines is not None else SZ_LINES
    label = CARD_LABELS.get(kind, "")
    if label:
        f = _load(card_font, SZ_EYEBROW)
        blocks.append(Block([label.upper()], f, SZ_EYEBROW, DIM,
                            track=TRACK_EYEBROW, lh=1.2, align=align))

    reveal_text, reveal_after = None, 0.0
    if kind == "number":
        f = _load(card_font, SZ_BIG_NUMBER)
        big = str(payload.get("number") or title or "")
        blocks.append(Block(_wrap(draw, big, f, max_w, TRACK_BIG_NUMBER), f,
                            SZ_BIG_NUMBER, FG, track=TRACK_BIG_NUMBER, lh=1.15,
                            align=align))
        if payload.get("meaning"):
            reveal_text = str(payload["meaning"])
            reveal_after = float(payload.get("reveal_after") or 5)
    elif isinstance(payload.get("lines"), list):
        f = _load(card_font, line_size)
        text = "\n".join(str(x) for x in payload["lines"])
        blocks.append(Block(_wrap(draw, text, f, max_w), f, line_size, FG,
                            lh=LH_LINES, align=align))
        if payload.get("answer"):
            reveal_text = str(payload["answer"])
            reveal_after = float(payload.get("reveal_after") or 8)
    else:
        f = _load(card_font, SZ_BIG)
        big = str(payload.get("text") or title or "")
        blocks.append(Block(_wrap(draw, big, f, max_w), f, SZ_BIG, FG, lh=1.15,
                            align=align))

    if reveal_text:
        f = _load(card_font, SZ_REVEAL)
        blocks.append(Block(_wrap(draw, reveal_text, f, max_w), f, SZ_REVEAL,
                            WHITE, lh=1.25, layer="reveal", align=align))
    return blocks, reveal_after


def _brand_timing(brand_mode, reveal_after, duration, render_seed):
    if brand_mode == "none":
        return duration + 1.0
    if brand_mode == "static":
        return 0.0
    frac = (int(render_seed) % 100) / 100.0
    if reveal_after:
        return reveal_after + 1.5 + frac * 2.0
    return min(duration * (0.25 + 0.20 * frac), max(0.5, duration - 1.5))


def _line_box(draw, y, line, font, track, align, column_left, column_right):
    width = _text_w(draw, line, font, track)
    if align == "left":
        x = column_left
    elif align == "right":
        x = column_right - width
    else:
        x = column_left + (column_right - column_left - width) / 2.0
    x = min(max(x, SAFE_LEFT), max(SAFE_LEFT, SAFE_RIGHT - width))
    return x, width


def _pack_boxes(draw, blocks, y0, column_left, column_right, gap=GAP, brand_extra=0.0):
    boxes = []
    y = y0
    for i, block in enumerate(blocks):
        if block.layer == "brand":
            y += brand_extra
        for line in block.lines:
            x, width = _line_box(draw, y, line, block.font, block.track,
                                 block.align, column_left, column_right)
            boxes.append({
                "text": line, "x": x, "y": y, "w": width, "h": block.line_h,
                "layer": block.layer, "font": block.font, "fill": block.fill,
                "track": block.track,
            })
            y += block.line_h
        y += gap
    return boxes


def _stack_height(blocks, gap=GAP, brand_extra=0.0):
    if not blocks:
        return 0.0
    total = sum(b.height for b in blocks) + gap * max(0, len(blocks) - 1)
    if any(b.layer == "brand" for b in blocks):
        total += brand_extra
    return total


def _place(draw, kind, payload, title, card_font, brand_font, brand,
           template, brand_mode, render_seed, duration):
    """Return (boxes, reveal_after, brand_at) inside the title-safe region."""
    template = template or "minimal_center"
    brand_mode = brand_mode or "reveal"
    include_brand = brand_mode != "none" and bool(brand)
    brand_layer = "brand"

    if template == "signal" or kind in ("technical_difficulties", "dead_air"):
        return _place_signal(draw, kind, payload, title, card_font, brand_font,
                             brand, brand_mode, duration)

    if template == "minimal_corner":
        max_w = SAFE_W * 0.42
        blocks, reveal_after = _content_blocks(
            draw, kind, payload, title, card_font, max_w,
            size_lines=SZ_LINES * 0.75, align="left")
        corner = int(render_seed) % 4
        align = "left" if corner in (0, 2) else "right"
        for block in blocks:
            block.align = align
        if include_brand:
            bf = _load(brand_font, SZ_BRAND * 0.45)
            blocks.append(Block([brand], bf, SZ_BRAND * 0.45, (255, 255, 255),
                                track=TRACK_BRAND, lh=1.15, layer=brand_layer,
                                align=align))
        total = _stack_height(blocks, gap=GAP * 0.6)
        y0 = SAFE_BOTTOM - total if corner in (0, 1) else SAFE_TOP
        y0 = min(max(y0, SAFE_TOP), max(SAFE_TOP, SAFE_BOTTOM - total))
        if align == "left":
            left, right = SAFE_LEFT, SAFE_LEFT + max_w
        else:
            left, right = SAFE_RIGHT - max_w, SAFE_RIGHT
        boxes = _pack_boxes(draw, blocks, y0, left, right, gap=GAP * 0.6)
        return boxes, reveal_after, _brand_timing(brand_mode, reveal_after, duration, render_seed)

    if template == "image_caption":
        max_w = SAFE_W * 0.88
        blocks, reveal_after = _content_blocks(
            draw, kind, payload, title, card_font, max_w,
            size_lines=SZ_LINES * 0.7, align="left")
        if include_brand:
            bf = _load(brand_font, SZ_BRAND * 0.4)
            blocks.append(Block([brand], bf, SZ_BRAND * 0.4, (255, 255, 255),
                                track=TRACK_BRAND, lh=1.15, layer=brand_layer,
                                align="left"))
        total = _stack_height(blocks, gap=GAP * 0.5)
        y0 = min(max(SAFE_BOTTOM - total, SAFE_TOP), SAFE_BOTTOM - total)
        boxes = _pack_boxes(draw, blocks, y0, SAFE_LEFT, SAFE_LEFT + max_w,
                            gap=GAP * 0.5)
        return boxes, reveal_after, _brand_timing(brand_mode, reveal_after, duration, render_seed)

    if template == "information_board":
        max_w = SAFE_W * 0.72
        blocks, reveal_after = _content_blocks(
            draw, kind, payload, title, card_font, max_w, align="left")
        if include_brand:
            bf = _load(brand_font, SZ_BRAND * 0.45)
            blocks.append(Block([brand], bf, SZ_BRAND * 0.45, (255, 255, 255),
                                track=TRACK_BRAND, lh=1.15, layer=brand_layer,
                                align="left"))
        total = _stack_height(blocks)
        y0 = SAFE_TOP + max(0.0, (SAFE_H - total) / 2.0)
        boxes = _pack_boxes(draw, blocks, y0, SAFE_LEFT, SAFE_LEFT + max_w)
        return boxes, reveal_after, _brand_timing(brand_mode, reveal_after, duration, render_seed)

    # minimal_center (and unknown names that already fell back)
    max_w = min(W - 2 * PAD, SAFE_W)
    blocks, reveal_after = _content_blocks(
        draw, kind, payload, title, card_font, max_w)
    if include_brand:
        bf = _load(brand_font, SZ_BRAND)
        blocks.append(Block([brand], bf, SZ_BRAND, (255, 255, 255),
                            track=TRACK_BRAND, lh=1.15, layer=brand_layer))
    total = _stack_height(blocks, brand_extra=BRAND_MARGIN_TOP)
    y0 = SAFE_TOP + max(0.0, (SAFE_H - total) / 2.0)
    boxes = _pack_boxes(draw, blocks, y0, SAFE_LEFT, SAFE_RIGHT,
                        brand_extra=BRAND_MARGIN_TOP)
    return boxes, reveal_after, _brand_timing(brand_mode, reveal_after, duration, render_seed)


def _place_signal(draw, kind, payload, title, card_font, brand_font, brand,
                  brand_mode, duration):
    """Failure / dead-air caption inside the lower safe band."""
    text = str(payload.get("text") or title or
               ("PLEASE STAND BY" if payload.get("variant") != "nosignal" else "NO SIGNAL"))
    text = text.replace("{BRAND}", brand)
    f = _load(card_font, 5.0 * VMIN)
    lines = _wrap(draw, text, f, SAFE_W * 0.9, 0.35)
    pad = 1.4 * VMIN
    band_h = f.size * 1.2 * max(1, len(lines)) + pad * 2
    band_top = min(max(H * 0.92 - band_h, SAFE_TOP), SAFE_BOTTOM - band_h)
    boxes = []
    y = band_top + pad
    for line in lines:
        width = _text_w(draw, line, f, 0.35)
        x = SAFE_LEFT + (SAFE_W - width) / 2.0
        boxes.append({
            "text": line, "x": x, "y": y, "w": width, "h": f.size * 1.2,
            "layer": "base", "font": f, "fill": (255, 255, 255), "track": 0.35,
        })
        y += f.size * 1.2
    brand_at = duration + 1.0
    if brand_mode != "none" and brand and kind == "dead_air":
        bf = _load(brand_font, 2.4 * VMIN)
        width = _text_w(draw, brand, bf, 0.3)
        boxes.append({
            "text": brand, "x": SAFE_RIGHT - width, "y": SAFE_BOTTOM - bf.size,
            "w": width, "h": bf.size * 1.2, "layer": "brand", "font": bf,
            "fill": (255, 255, 255), "track": 0.3,
        })
        brand_at = 0.0 if brand_mode == "static" else max(1.0, duration - 2.0)
    return boxes, 0.0, brand_at


def measure_layout(kind, payload, title, template="minimal_center",
                   brand_mode="reveal", brand="TV", duration=None, render_seed=0):
    """Safe-area boxes at 1920×1080. No encode, no files."""
    duration = float(duration if duration is not None else config.CARD_DEFAULT_DURATION)
    card_font, brand_font = fonts()
    dummy = Image.new("RGB", (W, H), (0, 0, 0))
    draw = ImageDraw.Draw(dummy)
    boxes, reveal_after, brand_at = _place(
        draw, kind, payload, title, card_font, brand_font, brand,
        template, brand_mode, render_seed, duration)
    public = [{k: box[k] for k in ("text", "x", "y", "w", "h", "layer")} for box in boxes]
    return {"boxes": public, "reveal_after": reveal_after, "brand_at": brand_at,
            "duration": duration}


# ------------------------------------------------------------- backgrounds --
def _bg_image(url):
    """Fetch and cache a card background. Returns a cover-cropped RGB image."""
    if not url:
        return None
    from bumparr import stream_proxy
    origin = stream_proxy._origin(url)
    if origin is None:
        return None
    cache = Path(config.ASSET_ROOT) / _BG_CACHE
    cache.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()
    local = cache / (key + ".img")
    partial = local.with_name(".%s.%s.part" % (key, uuid.uuid4().hex))
    try:
        if not local.is_file() or local.stat().st_size == 0:
            # Background sources may redirect to a separate public CDN. The
            # shared fetcher still rejects credentials, non-HTTP schemes and
            # every private/special address on each redirect.
            with closing(stream_proxy._fetch(url, None)) as r, partial.open("xb") as fh:
                try:
                    declared = int(r.headers.get("Content-Length") or 0)
                except (AttributeError, TypeError, ValueError):
                    declared = 0
                if declared > _BG_MAX:
                    raise ValueError("background image exceeds size cap")
                total = 0
                while True:
                    chunk = r.read(min(262144, _BG_MAX + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > _BG_MAX:
                        raise ValueError("background image exceeds size cap")
                    fh.write(chunk)
            # Decode before promotion so a corrupt response never poisons cache.
            with Image.open(partial) as check:
                check.verify()
            os.replace(partial, local)
        with Image.open(local) as source:
            img = source.convert("RGB")
    except Exception as e:
        print("  bg fetch failed (%s): %s" % (url[:60], e))
        try:
            local.unlink()
        except OSError:
            pass
        try:
            partial.unlink()
        except OSError:
            pass
        return None
    # CSS background-size: cover; background-position: center.
    scale = max(W / img.width, H / img.height)
    img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                     Image.LANCZOS)
    left, top = (img.width - W) // 2, (img.height - H) // 2
    return img.crop((left, top, left + W, top + H))


def prune_bg_cache(max_age_days=30, max_bytes=2 * 1024 ** 3):
    """Evict background-cache files older than `max_age_days`, then oldest-first
    until the cache fits `max_bytes`. Returns the number of files removed."""
    cache = Path(config.ASSET_ROOT) / _BG_CACHE
    if not cache.is_dir():
        return 0
    entries = []
    for f in cache.iterdir():
        if not f.is_file():
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        entries.append([st.st_mtime, st.st_size, f])
    removed = 0
    cutoff = time.time() - max_age_days * 86400
    for e in entries:
        if e[0] < cutoff:
            try:
                e[2].unlink()
                removed += 1
                e[1] = 0
            except OSError:
                pass
    live = sorted((e for e in entries if e[1] > 0 and e[2].exists()))
    total = sum(e[1] for e in live)
    for _, size, f in live:
        if total <= max_bytes:
            break
        try:
            f.unlink()
            removed += 1
            total -= size
        except OSError:
            pass
    return removed


def _scrim(img):
    """The player's linear-gradient(rgba(0,0,0,.5), rgba(0,0,0,.7)) overlay."""
    grad = Image.new("L", (1, H))
    for y in range(H):
        a = 0.5 + (0.7 - 0.5) * (y / max(1, H - 1))
        grad.putpixel((0, y), int(a * 255))
    grad = grad.resize((W, H))
    return Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), img, grad)


# ------------------------------------------------------------- composition --
def _compose(kind, payload, title, duration, card_font, brand_font, brand,
             template="minimal_center", brand_mode="reveal", render_seed=0):
    """Render the three layers of a text card.

    Split by layer rather than by time: the base never changes, and the reveal
    and brand are separate transparent images ffmpeg fades in. That reproduces
    the CSS opacity transition instead of approximating it with a hard cut.
    """
    base = Image.new("RGB", (W, H), (0, 0, 0))
    bg = _bg_image(payload.get("bg"))
    if bg is not None:
        base = _scrim(bg)
    elif template == "image_caption":
        base = Image.new("RGB", (W, H), (8, 8, 12))

    measure = ImageDraw.Draw(base)
    boxes, reveal_after, brand_at = _place(
        measure, kind, payload, title, card_font, brand_font, brand,
        template, brand_mode, render_seed, duration)

    reveal_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    brand_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    drawers = {
        "base": ImageDraw.Draw(base),
        "reveal": ImageDraw.Draw(reveal_layer),
        "brand": ImageDraw.Draw(brand_layer),
    }
    for box in boxes:
        layer = box["layer"]
        draw = drawers.get(layer, drawers["base"])
        fill = box["fill"] if layer == "base" else tuple(box["fill"][:3]) + (
            235 if layer == "brand" else 255,)
        _draw_at(draw, box["x"], box["y"], box["text"], box["font"], fill, box["track"])

    return base, reveal_layer, brand_layer, reveal_after, brand_at


def _stamp_credit(img, text, font_path):
    """Draw required attribution inside the title-safe lower-left corner."""
    if not text:
        return img
    font = _load(font_path, 1.6 * VMIN)
    layer = img.convert("RGBA") if img.mode != "RGBA" else img.copy()
    draw = ImageDraw.Draw(layer)
    x, y = SAFE_LEFT, SAFE_BOTTOM - font.size - int(0.4 * VMIN)
    fill = (220, 220, 220, 200)
    _draw_at(draw, x, y, text, font, fill, 0.0)
    return layer.convert(img.mode) if img.mode != "RGBA" else layer


def _column(draw, items, gap, y_center=True, bg_top=0, bg_bottom=H):
    """Lay out a centred vertical stack of (text, font, fill, tracking, margin_top).

    The visual bumpers are all flex columns in the stylesheet, so they share one
    layout routine; only their contents and colours differ.
    """
    heights, total = [], 0.0
    for i, (text, font, fill, track, mt) in enumerate(items):
        h = font.size * 1.2
        heights.append(h)
        total += h + mt + (gap if i else 0)
    y = bg_top + ((bg_bottom - bg_top) - total) / 2.0 if y_center else bg_top
    out = []
    for i, ((text, font, fill, track, mt), h) in enumerate(zip(items, heights)):
        if i:
            y += gap
        y += mt
        out.append((y, text, font, fill, track))
        y += h
    return out


def _gradient(c_top, c_bottom, angle_bias=0.35):
    """Approximate the CSS linear-gradient backgrounds of the visual cards."""
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        f = y / max(1, H - 1)
        row = tuple(int(c_top[k] + (c_bottom[k] - c_top[k]) * f) for k in range(3))
        for x in range(0, W, 8):
            g = min(1.0, f + angle_bias * (x / W - 0.5) * 0.4)
            col = tuple(int(c_top[k] + (c_bottom[k] - c_top[k]) * g) for k in range(3))
            for xi in range(x, min(x + 8, W)):
                px[xi, y] = col
        del row
    return img


def _zone():
    """The configured timezone, or None to use the host's.

    A container's host timezone is UTC unless someone set it, and a clock card
    rendered in the wrong zone is wrong in the one way this card cannot survive,
    so the zone is configuration rather than an inherited accident.
    """
    if not config.TIMEZONE:
        return None
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(config.TIMEZONE)
    except Exception as e:
        print("  timezone %r unusable (%s); falling back to host time"
              % (config.TIMEZONE, e))
        return None


def _now_parts(epoch, tz):
    """Wall-clock datetime for `epoch` in the configured zone (host zone if none).

    Kept as a tiny indirection so the clock card's time is computed once, the
    same way, in every frame of its render.
    """
    from datetime import datetime
    return datetime.fromtimestamp(epoch, tz) if tz else datetime.fromtimestamp(epoch)


def _frames_station_id(payload, brand, card_font, brand_font, duration, brand_mode="none"):
    """Reproduce the three station-ID animations from the stylesheet.

    style 1 fades the logo up, style 2 scales it in from 0.6 while its tracking
    closes from .5em, style 3 sits on a lighter ground and breathes a glow.
    """
    style = int(payload.get("style") or 1)
    tag = str(payload.get("tag") or "")
    bg = (16, 16, 20) if style == 3 else (0, 0, 0)
    logo_f = _load(brand_font, 13.0 * VMIN)
    tag_f = _load(card_font, 2.6 * VMIN)

    def frame(t):
        """One frame of this station ID at time t: ground, logo, and tag,
        animated per the chosen style's keyframes."""
        img = Image.new("RGB", (W, H), bg)
        d = ImageDraw.Draw(img)
        # progress through each style's keyframes
        osc = 0.0
        if style == 1:
            prog = min(1.0, t / 1.2)
            alpha, scale, track = prog, 1.0, 0.05
        elif style == 2:
            prog = min(1.0, t / 1.4)
            e = 1 - pow(1 - prog, 3)                    # ease-out, ~cubic-bezier(.2,.8,.2,1)
            alpha, scale, track = e, 0.6 + 0.4 * e, 0.5 - 0.45 * e
        else:
            # sid-glow: 2.4s ease-in-out alternate == a 4.8s round trip
            osc = 0.5 + 0.5 * math.sin(2 * math.pi * (t / 4.8) - math.pi / 2)
            alpha, scale, track = 1.0, 1.0, 0.05
        size = max(8, int(13.0 * VMIN * (scale if style == 2 else 1.0)))
        f = _load(brand_font, size) if size != logo_f.size else logo_f

        items = [(brand, f, None, track, 0)]
        if tag:
            items.append((tag.upper(), tag_f, None, 0.5, 0))
        placed = _column(d, items, 2.0 * VMIN)

        for i, (y, text, font, _fill, tr) in enumerate(placed):
            if i == 0:
                if style == 3:
                    # sid-glow's text-shadow: draw the mark a few times at
                    # increasing blur, with the halo brightening on the CSS cycle
                    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                    gd = ImageDraw.Draw(glow)
                    a = int(40 + 150 * osc)
                    _draw_centred(gd, y, text, font, (255, 255, 255, a), tr)
                    glow = glow.filter(ImageFilter.GaussianBlur(14))
                    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
                    d = ImageDraw.Draw(img)
                layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                _draw_centred(ImageDraw.Draw(layer), y, text, font,
                              (255, 255, 255, int(255 * alpha)), tr)
                img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
                d = ImageDraw.Draw(img)
            else:
                _draw_centred(d, y, text, font, DIM, tr)
        return img

    return frame


def _frames_dead_air(payload, brand, card_font, brand_font, duration, brand_mode="none"):
    """Black, then the brand mark eases in near the end — the stylesheet's
    dead-logo fade at (duration - 2)s over 1.2s."""
    f = _load(brand_font, 2.4 * VMIN)
    show_at = 0.0 if brand_mode == "static" else max(1.0, duration - 2.0)
    hide = brand_mode == "none"

    def frame(t):
        """One frame of the dead-air card: black, with the corner brand
        easing in during the final two seconds."""
        img = Image.new("RGB", (W, H), (0, 0, 0))
        if hide:
            return img
        a = 1.0 if brand_mode == "static" else min(1.0, max(0.0, (t - show_at) / 1.2))
        if a > 0:
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            x = W - 5.0 * VMIN
            y = H - 5.0 * VMIN - f.size
            _draw_tracked_right(d, x, y, brand, f, (255, 255, 255, int(191 * a)), 0.3)
            img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")
        return img

    return frame


def _frames_local_time(payload, brand, card_font, brand_font, duration, brand_mode="none"):
    """The clock card. Rendered from the wall clock at render time, which is why
    this kind carries a short TTL and is re-rendered rather than cached."""
    city = str(payload.get("city") or "").upper()
    f_city = _load(card_font, 3.0 * VMIN)
    f_clock = _load(card_font, 20.0 * VMIN)
    f_date = _load(card_font, 3.2 * VMIN)
    f_bug = _load(brand_font, 2.2 * VMIN)
    base_epoch = time.time()
    tz = _zone()

    def frame(t):
        """One frame of the clock card, advancing the wall clock with t.

        The whole clip walks real time frame by frame, which is what makes the
        rendered file truthful for its short TTL instead of a frozen clock.
        """
        now = _now_parts(base_epoch + t, tz)
        img = Image.new("RGB", (W, H), (4, 6, 10))
        d = ImageDraw.Draw(img)
        items = [
            (city, f_city, DIM, 0.6, 0),
            (now.strftime("%I:%M %p").lstrip("0"), f_clock, FG, 0.02, 0),
            (now.strftime("%A, %B ") + str(now.day), f_date, (187, 187, 187), 0.0, 0),
        ]
        if brand_mode != "none":
            items.append((brand, f_bug, (255, 255, 255), 0.3, 3.0 * VMIN))
        for y, text, font, fill, tr in _column(d, items, 1.5 * VMIN):
            _draw_centred(d, y, text, font, fill, tr)
        return img

    return frame


def _frames_weather(payload, brand, card_font, brand_font, duration, brand_mode="none"):
    """Current conditions, laid out like the stylesheet's weather card. Carries a
    TTL for the same reason the clock does."""
    emoji = str(payload.get("emoji") or "")
    f_emoji = _load(card_font, 14.0 * VMIN)
    if emoji and not _has_glyph(f_emoji, emoji[0]):
        alt = _symbol_font(emoji[0], 14.0 * VMIN)
        # No font can draw it: show nothing rather than a tofu box. The card
        # still reads completely from city, temperature and conditions.
        f_emoji, emoji = (alt, emoji) if alt else (f_emoji, "")
    f_city = _load(card_font, 3.0 * VMIN)
    f_temp = _load(card_font, 16.0 * VMIN)
    f_cond = _load(card_font, 4.0 * VMIN)
    f_meta = _load(card_font, 2.4 * VMIN)
    f_bug = _load(brand_font, 2.2 * VMIN)
    meta = "   ·   ".join(x for x in [
        ("wind " + payload["wind"]) if payload.get("wind") else "",
        ("humidity " + payload["humidity"]) if payload.get("humidity") else ""] if x)
    bg = _gradient((10, 20, 32), (4, 8, 14))

    items_spec = [
        (emoji, f_emoji, FG, 0.0, 0),
        (str(payload.get("city") or "").upper(), f_city, DIM, 0.5, 1.0 * VMIN),
        (str(payload.get("temp") or ""), f_temp, FG, 0.0, 0),
        (str(payload.get("conditions") or ""), f_cond, (205, 214, 224), 0.0, 0),
        (meta, f_meta, DIM, 0.1, 1.0 * VMIN),
    ]
    if brand_mode != "none":
        items_spec.append((brand, f_bug, (255, 255, 255), 0.3, 3.0 * VMIN))
    items_spec = [it for it in items_spec if it[0]]

    def frame(t):
        """One frame of the weather card. Static for the whole clip — the data
        was fetched at render time and the card carries a TTL, so it is
        re-rendered (not re-animated) when it goes stale."""
        img = bg.copy()
        d = ImageDraw.Draw(img)
        for y, text, font, fill, tr in _column(d, items_spec, 1.0 * VMIN):
            _draw_centred(d, y, text, font, fill, tr)
        return img

    return frame


def _draw_tracked_right(draw, right_x, y, s, font, fill, track_em=0.0):
    """Right-aligned tracked text (the dead-air / corner brand marks)."""
    w = _text_w(draw, s, font, track_em)
    x = right_x - w
    for ch in s:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + track_em * font.size


def _td_caption(payload, brand, card_font):
    """The standby caption as a TRANSPARENT overlay.

    Kept separate from the ground so the same caption can sit on drawn bars or
    on ffmpeg-generated static without either path baking in the other's
    background. The band keeps the stylesheet's rgba(0,0,0,.55) rather than
    becoming an opaque black box.
    """
    variant = payload.get("variant", "bars")
    text = str(payload.get("text") or
               ("PLEASE STAND BY" if variant == "bars" else "NO SIGNAL"))
    text = text.replace("{BRAND}", brand)
    f = _load(card_font, 5.0 * VMIN)
    pad = 1.4 * VMIN
    band_h = f.size * 1.2 + pad * 2
    band_top = H * 0.92 - band_h

    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rectangle([0, band_top, W, band_top + band_h], fill=(0, 0, 0, 140))
    _draw_centred(d, band_top + pad, text, f, (255, 255, 255, 255), 0.35)
    return layer


def _compose_technical_difficulties(payload, brand, card_font, brand_font):
    """SMPTE bars / no-signal ground plus the standby caption.

    Matches the stylesheet: bars occupy the top 78% (`inset: 0 0 22% 0`), the
    caption sits at 8% from the bottom on a translucent black band, and the
    no-signal ground is the CSS blue rather than black.
    """
    variant = payload.get("variant", "bars")
    ground = (16, 16, 176) if variant == "nosignal" else (0, 0, 0)
    img = Image.new("RGB", (W, H), ground)
    d = ImageDraw.Draw(img)
    if variant == "bars":
        bar_h = H * 0.78
        bw = W / len(SMPTE)
        for i, col in enumerate(SMPTE):
            d.rectangle([i * bw, 0, (i + 1) * bw, bar_h], fill=col)
    cap = _td_caption(payload, brand, card_font)
    return Image.alpha_composite(img.convert("RGBA"), cap).convert("RGB")


# ----------------------------------------------------------------- encoding --
def _music_bed(payload, row=None):
    """Resolve a card's music bed to a contained file path, or None (silence).

    New rows use creative.music_id from the manifest. Legacy payload.music is
    honoured only when ALLOW_UNMANIFESTED_MUSIC=1. Escaping symlinks, missing
    files, and disabled beds become silence.
    """
    bed = music.resolve_playable(payload, row)
    if bed is None:
        return None
    return bed.resolved_path


def _encode(dest, base, reveal, brand_img, duration, reveal_at, brand_at, music):
    """Encode the layers to H.264 with alpha fades for the reveals.

    yuv420p + even dimensions + faststart, because the consumers here are
    transcoders and set-top players, not just browsers.
    """
    tmp = Path(tempfile.mkdtemp(prefix="bumparr-card-"))
    try:
        pb, pr, pg = tmp / "base.png", tmp / "reveal.png", tmp / "brand.png"
        base.save(pb)
        reveal.save(pr)
        brand_img.save(pg)

        # ffmpeg requires every input before any output option, so the audio
        # input is declared here rather than alongside the audio codec flags.
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-loop", "1", "-t", "%.3f" % duration, "-i", str(pb),
               "-loop", "1", "-t", "%.3f" % duration, "-i", str(pr),
               "-loop", "1", "-t", "%.3f" % duration, "-i", str(pg)]
        if music:
            cmd += ["-i", music]
        else:
            # A silent track, not "no track". Several players and transcoders
            # mishandle a video-only bumper spliced into a stream that has audio.
            cmd += ["-f", "lavfi", "-t", "%.3f" % duration,
                    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        ai = 3

        brand_fade = 0.05 if brand_at <= 0 else FADE_BRAND
        chains = [
            "[1:v]format=rgba,fade=in:st=%.2f:d=%.2f:alpha=1[rv]" % (reveal_at, FADE_REVEAL),
            "[2:v]format=rgba,fade=in:st=%.2f:d=%.2f:alpha=1[bd]" % (brand_at, brand_fade),
            "[0:v][rv]overlay=format=auto[t1]",
            "[t1][bd]overlay=format=auto[t2]",
            # A short fade at each end so a card does not slam in or out when a
            # channel generator butts it against programming.
            "[t2]fade=in:st=0:d=0.4,fade=out:st=%.2f:d=0.5,format=yuv420p[v]"
            % max(0.0, duration - 0.5),
        ]
        cmd += ["-filter_complex", ";".join(chains), "-map", "[v]", "-map", "%d:a" % ai]
        if music:
            cmd += ["-shortest", "-c:a", "aac", "-b:a", "128k",
                    "-ar", "48000", "-ac", "2"]
        else:
            cmd += ["-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2"]
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-pix_fmt", "yuv420p", "-r", "30",
                "-movflags", "+faststart", str(dest)]

        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or "")[-600:])
        except Exception:
            try:
                Path(dest).unlink()
            except OSError:
                pass
            raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _encode_frames(dest, frame_fn, duration, music=None, fps=30):
    """Encode an animated card by piping raw frames straight into ffmpeg.

    Frames go over a pipe rather than to disk: a 10s 1080p card is ~300 frames,
    which is gigabytes as PNGs and nothing at all as a stream.
    """
    n = max(1, round(duration * fps))
    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H),
           "-r", str(fps), "-i", "-"]
    if music:
        cmd += ["-i", music]
    else:
        cmd += ["-f", "lavfi", "-t", "%.3f" % duration,
                "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    cmd += ["-map", "0:v", "-map", "1:a", "-shortest",
            "-vf", "fade=in:st=0:d=0.4,fade=out:st=%.2f:d=0.5,format=yuv420p"
            % max(0.0, duration - 0.5),
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", str(fps),
            "-c:a", "aac", "-b:a", "128k" if music else "96k",
            "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart", str(dest)]

    def frames():
        for i in range(n):
            img = frame_fn(i / float(fps))
            if img.mode != "RGB":
                img = img.convert("RGB")
            yield img.tobytes()

    ffmpeg_pipe.encode_frames(cmd, frames(), dest, timeout=600, tail=600)


def _encode_noise(dest, caption_img, duration, music=None, fps=30):
    """Analogue static, generated by ffmpeg rather than drawn.

    Per-pixel noise is the one thing Pillow is genuinely bad at here; ffmpeg's
    noise generator gives real grain at effectively no cost, with the standby
    caption composited over it.
    """
    tmp = Path(tempfile.mkdtemp(prefix="bumparr-noise-"))
    try:
        cap = tmp / "cap.png"
        caption_img.save(cap)
        cmd = ["ffmpeg", "-y", "-loglevel", "error",
               "-f", "lavfi", "-t", "%.3f" % duration,
               "-i", "color=c=gray:s=%dx%d:r=%d" % (W, H, fps),
               "-loop", "1", "-t", "%.3f" % duration, "-i", str(cap)]
        if music:
            cmd += ["-i", music]
        else:
            cmd += ["-f", "lavfi", "-t", "%.3f" % duration,
                    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        chains = [
            "[0:v]noise=alls=96:allf=t+u,format=rgba[n]",
            "[n][1:v]overlay=format=auto,"
            "fade=in:st=0:d=0.4,fade=out:st=%.2f:d=0.5,format=yuv420p[v]"
            % max(0.0, duration - 0.5),
        ]
        cmd += ["-filter_complex", ";".join(chains), "-map", "[v]", "-map", "2:a",
                "-shortest", "-c:v", "libx264", "-preset", "medium", "-crf", "22",
                "-pix_fmt", "yuv420p", "-r", str(fps),
                "-c:a", "aac", "-b:a", "128k" if music else "96k",
                "-ar", "48000", "-ac", "2",
                "-movflags", "+faststart", str(dest)]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or "")[-600:])
        except Exception:
            try:
                Path(dest).unlink()
            except OSError:
                pass
            raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


ANIMATED_BUILDERS = {
    "station_id": _frames_station_id,
    "dead_air": _frames_dead_air,
    "local_time": _frames_local_time,
    "weather": _frames_weather,
}


# ------------------------------------------------------------------ driver --
def is_stale(kind, dest):
    """True when a volatile card's file has outlived the truth it captured."""
    ttl = VOLATILE_TTL.get(kind)
    if not ttl or not dest.is_file():
        return False
    return (time.time() - dest.stat().st_mtime) > ttl


_SKIP_MUSIC = object()


def stamp_presentation(row, rel_uri=None, bed=_SKIP_MUSIC):
    """Payload with template/render_seed/brand_mode merged. Does not write SQLite.

    Used by explicit render/refresh so legacy rows persist a derived seed only
    when a file is actually (re)written — never during inspection or selection.
    Music credits are snapshotted only when `bed` is supplied (a real render),
    not on cache hits, so historical evidence is not rewritten by inspection.
    """
    try:
        payload = json.loads(row["payload"] or "{}")
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    assigned = creative.assign_presentation(row)
    payload = creative.merge_creative(payload, assigned)
    if bed is not _SKIP_MUSIC:
        payload = music.apply_playable_audio(payload, bed, preserve_non_music=True)
    payload["brand"] = config.BRAND
    payload["branded"] = True
    return payload


def render_one(row, card_font, brand_font, brand, force=False):
    """Render a single card row. Returns (status, rel_uri).

    Every kind renders. The animated ones go frame by frame, analogue static is
    generated by ffmpeg, and the rest are a static layout with timed fades.
    Missing/disabled/unreadable music becomes explicit silence; no partial file
    is left behind.
    """
    kind = row["kind"]
    try:
        payload = json.loads(row["payload"] or "{}")
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    row_view = {**dict(row), "payload": payload}
    resolved = creative.resolve_creative(row_view)
    assigned = creative.assign_presentation(row_view)
    template = assigned["template"]
    brand_mode = assigned["brand_mode"]
    render_seed = assigned["render_seed"]

    duration = float(row["duration"] or config.CARD_DEFAULT_DURATION)
    rel = "%s/%s.mp4" % (OUT_SUBDIR, str(row["id"]).replace(":", "_").replace("/", "_"))
    dest = Path(config.ASSET_ROOT) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file() and dest.stat().st_size > 0 and not force and not is_stale(kind, dest):
        return "cached", rel

    bed = music.resolve_playable(payload, row_view)
    audio_path = None
    excerpt_dir = None
    credit = ""
    if bed is not None:
        excerpt_dir = tempfile.mkdtemp(prefix="bumparr-card-bed-")
        excerpt = Path(excerpt_dir) / "bed.m4a"
        try:
            music.normalize_excerpt(bed.resolved_path, excerpt, duration)
            audio_path = str(excerpt)
            credit = music.onscreen_attribution(music.snapshot_credits(bed))
        except Exception:
            bed = None
            audio_path = None
            shutil.rmtree(excerpt_dir, ignore_errors=True)
            excerpt_dir = None

    def _apply_credit(img):
        return _stamp_credit(img, credit, card_font) if credit else img

    def _wrap_frames(frame_fn):
        if not credit:
            return frame_fn
        def wrapped(t):
            return _apply_credit(frame_fn(t))
        return wrapped

    partial = dest.with_name(".%s.%s.part.mp4" % (dest.stem, uuid.uuid4().hex))

    def _encode_card(audio):
        if kind in ANIMATED_BUILDERS:
            frame_fn = _wrap_frames(ANIMATED_BUILDERS[kind](
                payload, brand, card_font, brand_font, duration, brand_mode))
            _encode_frames(partial, frame_fn, duration, audio)
        elif kind == "technical_difficulties" and payload.get("variant") == "static":
            cap = _apply_credit(_td_caption(payload, brand, card_font))
            _encode_noise(partial, cap, duration, audio)
        elif kind == "technical_difficulties":
            img = _apply_credit(
                _compose_technical_difficulties(payload, brand, card_font, brand_font))
            blank = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            _encode(partial, img, blank, blank, duration, duration + 1,
                    duration + 1, audio)
        else:
            base, rev, bmg, reveal_at, brand_at = _compose(
                kind, payload, row["title"], duration, card_font, brand_font, brand,
                template=template, brand_mode=brand_mode, render_seed=render_seed)
            if not reveal_at:
                reveal_at = duration + 1
            _encode(partial, _apply_credit(base), rev, bmg, duration, reveal_at,
                    brand_at, audio)

    try:
        try:
            _encode_card(audio_path)
        except Exception:
            if audio_path is None:
                raise
            try:
                partial.unlink()
            except OSError:
                pass
            bed = None
            audio_path = None
            credit = ""
            _encode_card(None)
        if not partial.is_file() or partial.stat().st_size == 0:
            raise RuntimeError("ffmpeg produced no output")
        os.replace(partial, dest)
    except Exception:
        try:
            partial.unlink()
        except OSError:
            pass
        raise
    finally:
        if excerpt_dir:
            shutil.rmtree(excerpt_dir, ignore_errors=True)
    if isinstance(row, dict):
        row["_applied_bed"] = bed
    return "rendered", rel


def render_all(limit=None, kinds=None, force=False, ids=None):
    """Render pending cards and point their registry rows at the files.

    Setting `uri` is the whole point: it is what promotes a card from
    browser-only payload to something `/playlist.m3u` and `media_url` can hand
    to any consumer.

    `ids`, if given, selects exactly those card rows by id and ignores
    `limit`/`kinds` and the render-pending/`enabled` filters entirely — the
    operator named the row, so it renders (subject only to render_one's own
    cache/`force` decision) no matter how large the rest of the pool is or how
    long it has already had a uri. This is what `--id` and
    `POST /api/render/cards?bumper_id=` use for a single-card render; the
    caller (the API route) is what validates `type='card'` before the job
    starts, so a row of another type simply is not selected here.
    """
    card_font, brand_font = fonts()
    brand = config.BRAND
    print("[render] card font: %s | brand font: %s" % (card_font, brand_font))

    args = []
    if ids:
        q = ("SELECT * FROM playables WHERE type='card' AND id IN (%s)"
             % ",".join("?" * len(ids)))
        args = list(ids)
    else:
        q = "SELECT * FROM playables WHERE type='card' AND enabled=1"
        if not force:
            # Volatile kinds stay in the candidate set even once they have a uri:
            # their file expires, and render_one decides per-file whether it is
            # still truthful. Everything else is skipped once rendered.
            vol = ",".join("'%s'" % k for k in VOLATILE_TTL)
            q += " AND (uri IS NULL OR uri='' OR kind IN (%s))" % vol
        if kinds:
            q += " AND kind IN (%s)" % ",".join("?" * len(kinds))
            args += list(kinds)
        q += " ORDER BY created_at DESC"
        if limit:
            q += " LIMIT %d" % int(limit)

    with db.conn() as c:
        rows = c.execute(q, args).fetchall()

    stats = {"rendered": 0, "cached": 0, "failed": 0}
    failures = []
    for row in rows:
        row = dict(row)
        try:
            status, info = render_one(row, card_font, brand_font, brand, force=force)
        except Exception as e:
            stats["failed"] += 1
            failures.append("%s: %s" % (row["id"], e))
            print("  FAIL %s (%s): %s" % (row["id"], row["kind"], str(e)[:200]))
            continue
        stats[status] += 1
        with db.conn() as c:
            # Stamp brand plus presentation; only happens on explicit render.
            bed = row.get("_applied_bed", _SKIP_MUSIC) if status == "rendered" else _SKIP_MUSIC
            pay = stamp_presentation(row, info, bed=bed)
            pay.pop("_applied_bed", None)
            c.execute("UPDATE playables SET uri=?, health='ok', payload=? WHERE id=?",
                      (info, json.dumps(pay), row["id"]))
            c.commit()
        if status == "rendered":
            print("  ok   %-24s %s" % (row["kind"], info))

    return {"stats": stats, "failures": failures[:20]}


def refresh_volatile():
    """Re-render only the perishable kinds whose files have expired.

    Cheap enough to run on a short timer: it touches a handful of cards and
    no-ops entirely when nothing has aged out.
    """
    return render_all(kinds=list(VOLATILE_TTL))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Render Bumparr text cards to MP4.")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--kind", action="append", dest="kinds")
    ap.add_argument("--force", action="store_true", help="re-render even if a file exists")
    ap.add_argument("--refresh-volatile", action="store_true",
                    help="only re-render perishable kinds (clock, weather) whose files expired")
    ap.add_argument("--id", action="append", dest="ids",
                    help="render only this card id (repeatable); ignores --limit/--kind")
    a = ap.parse_args()
    db.init_db()
    t0 = time.time()
    if a.ids:
        res = render_all(ids=a.ids, force=a.force)
    elif a.refresh_volatile:
        res = refresh_volatile()
    else:
        res = render_all(limit=a.limit, kinds=a.kinds, force=a.force)
    print("[render] %s in %.1fs" % (res["stats"], time.time() - t0))
    for f in res["failures"]:
        print("[render] FAILED %s" % f)
