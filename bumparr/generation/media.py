"""Untrusted result download, validation, normalization, and path helpers."""
import hashlib
import http.client
import ipaddress
import os
import re
import socket
import ssl
import subprocess
import uuid
import time
import math
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request

from bumparr import config, music
from bumparr.generation import models as gen_models
from bumparr.generation.providers.base import ProviderError

MAX_REDIRECTS = 5
FFMPEG_TIMEOUT = 180


def download_untrusted(url, staging_dir, limits, *, auth_origin=None, auth_header=None,
                       opener=None):
    """Stream an https result into private staging. Never follows unsafe peers."""
    staging = Path(staging_dir)
    staging.mkdir(parents=True, exist_ok=True)
    cap = int(limits.get("max_bytes") or gen_models.runtime_settings()["download_max_bytes"])
    stem = limits.get("filename") or uuid.uuid4().hex[:16]
    if not re.fullmatch(r"[A-Za-z0-9-]{1,80}", stem):
        raise ProviderError("download_rejected", "invalid staging identity")
    name = stem + ".part"
    dest = staging / name
    if dest.is_symlink() or dest.with_suffix(".bin").is_symlink():
        raise ProviderError("download_rejected", "staging entry must not be a symlink")
    _unlink(dest)  # This output's interrupted partial, never another job's file.
    current = url
    sent_auth_origin = None
    try:
        for _redirect in range(MAX_REDIRECTS + 1):
            parsed = _require_https(current)
            peer_ip = _public_peer_ip(parsed.hostname, parsed.port or 443)
            headers = {"User-Agent": "bumparr-generation/1.0", "Accept": "*/*",
                       "Host": parsed.hostname}
            origin = "%s://%s" % (parsed.scheme, parsed.netloc)
            auth_netloc = urlparse(auth_origin).netloc if auth_origin else ""
            if auth_header and auth_origin and parsed.netloc.lower() == auth_netloc.lower():
                headers["Authorization"] = auth_header
                sent_auth_origin = origin
            elif auth_header and sent_auth_origin and origin != sent_auth_origin:
                headers.pop("Authorization", None)
            try:
                if opener is not None:
                    req = Request(current, headers=headers, method="GET")
                    resp = opener.open(req, timeout=60)
                else:
                    resp = _open_pinned(parsed, peer_ip, headers, timeout=60)
            except _Redirect as exc:
                current = urljoin(current, exc.location)
                continue
            try:
                if getattr(resp, "status", None) in (301, 302, 303, 307, 308):
                    location = (getattr(resp, "headers", {}) or {}).get("Location")
                    if not location:
                        raise ProviderError("download_rejected", "invalid redirect")
                    current = urljoin(current, location)
                    continue
                ctype = (getattr(resp, "headers", {}) or {}).get("Content-Type") or ""
                if not 200 <= getattr(resp, "status", 200) < 300:
                    raise ProviderError("download_rejected", "download did not succeed")
                if ctype.split(";")[0].strip().lower() in ("text/html", "application/json"):
                    raise ProviderError("download_rejected", "result was not media")
                declared = _content_length(resp)
                if declared and declared > cap:
                    raise ProviderError("download_rejected", "result exceeds the download cap")
                total = 0
                with dest.open("xb") as out:
                    while total <= cap:
                        chunk = resp.read(min(262144, cap + 1 - total))
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > cap:
                            raise ProviderError("download_rejected", "result exceeds the download cap")
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
                if total < 100:
                    raise ProviderError("invalid_media", "download too small")
                final = dest.with_suffix(".bin")
                dest.replace(final)
                return final
            finally:
                try:
                    resp.close()
                except Exception:
                    pass
        raise ProviderError("download_rejected", "excessive redirects")
    except Exception as exc:
        try:
            dest.unlink()
        except OSError:
            pass
        if isinstance(exc, (OSError, http.client.HTTPException)):
            raise ProviderError("provider_unavailable", "download transport interrupted", retryable=True) from exc
        raise


class _Redirect(Exception):
    def __init__(self, location):
        self.location = location


class _OwnedResponse:
    """HTTPResponse.close alone need not close its keep-alive connection."""
    def __init__(self, response, connection):
        self.response, self.connection = response, connection

    def __getattr__(self, name):
        return getattr(self.response, name)

    def close(self):
        try:
            self.response.close()
        finally:
            self.connection.close()


def _open_pinned(parsed, peer_ip, headers, timeout=60):
    """HTTPS GET to a previously validated public IP with SNI/Host of the URL."""
    path = parsed.path or "/"
    if parsed.query:
        path = path + "?" + parsed.query
    sock = socket.create_connection((str(peer_ip), parsed.port or 443), timeout=timeout)
    conn = None
    ssock = None
    try:
        if ipaddress.ip_address(sock.getpeername()[0]) != peer_ip:
            raise ProviderError("download_rejected", "connected peer differs from validated address")
        ctx = ssl.create_default_context()
        ssock = ctx.wrap_socket(sock, server_hostname=parsed.hostname)
        sock = None
        conn = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout)
        conn.sock = ssock
        send_headers = {k: v for k, v in headers.items() if k.lower() != "host"}
        conn.request("GET", path, headers=send_headers)
        resp = conn.getresponse()
        if resp.status in (301, 302, 303, 307, 308):
            location = resp.getheader("Location")
            resp.close()
            conn.close()
            if not location:
                raise ProviderError("download_rejected", "invalid redirect")
            raise _Redirect(location)
        if resp.status >= 400:
            resp.close()
            conn.close()
            raise ProviderError("download_rejected", "download HTTP %s" % resp.status)
        return _OwnedResponse(resp, conn)
    except Exception:
        if conn is not None:
            conn.close()
        elif ssock is not None:
            ssock.close()
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        raise


def _require_https(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ProviderError("download_rejected", "result URL must be https")
    if parsed.username or parsed.password:
        raise ProviderError("download_rejected", "result URL must not include credentials")
    return parsed


def _public_peer_ip(host, port):
    """Resolve and return one public address; reject mixed/private answers."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ProviderError("download_rejected", "result hostname did not resolve") from exc
    if not infos:
        raise ProviderError("download_rejected", "result hostname did not resolve")
    public = []
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if not address.is_global:
            raise ProviderError("download_rejected", "result address is not a public internet host")
        public.append(address)
    return public[0]


def _reject_private_peer(host, port):
    _public_peer_ip(host, port)


def _content_length(resp):
    try:
        headers = resp.headers
        value = headers.get("Content-Length") if headers is not None else None
        return int(value) if value else 0
    except (TypeError, ValueError, AttributeError):
        return 0


def probe_video(path):
    """Return {duration, width, height, fps, has_audio} or raise."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=60,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        raise ProviderError("invalid_media", "ffprobe failed") from exc
    if out.returncode != 0:
        raise ProviderError("invalid_media", "media did not decode")
    import json
    try:
        data = json.loads(out.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise ProviderError("invalid_media", "ffprobe JSON invalid") from exc
    streams = data.get("streams") if isinstance(data.get("streams"), list) else []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None:
        raise ProviderError("invalid_media", "no video stream")
    try:
        duration = float((data.get("format") or {}).get("duration") or video.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if not math.isfinite(duration) or duration <= 0 or duration > 120:
        raise ProviderError("invalid_media", "duration is not a finite bumper length")
    try:
        width = int(video.get("width") or 0)
        height = int(video.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0
    if width < 16 or height < 16 or width > 7680 or height > 4320:
        raise ProviderError("invalid_media", "frame size is outside bounds")
    return {
        "duration": duration,
        "width": width,
        "height": height,
        "has_audio": audio is not None,
    }


def normalize(src, dest, *, has_audio, timeout=FFMPEG_TIMEOUT):
    """Canonical 1920x1080 30fps H.264 + AAC. Designed audio or silence."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    lufs, peak = music.loudness_targets()
    vf = ("scale=1920:1080:force_original_aspect_ratio=decrease,"
          "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p")
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-i", str(src)]
    if not has_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    cmd += ["-vf", vf]
    if has_audio:
        cmd += ["-af", "loudnorm=I=%.1f:TP=%.1f:LRA=11,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
                % (lufs, peak), "-map", "0:v:0", "-map", "0:a:0?"]
    else:
        cmd += ["-shortest", "-map", "0:v:0", "-map", "1:a:0"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
            "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k",
            "-movflags", "+faststart", "-f", "mp4", str(part)]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, start_new_session=True)
    try:
        _, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        _kill_group(proc)
        _, err = proc.communicate()
        _unlink(part)
        raise ProviderError("normalize_failed", "ffmpeg timed out") from exc
    if proc.returncode != 0 or not part.is_file() or part.stat().st_size == 0:
        _unlink(part)
        raise ProviderError("normalize_failed", (err or b"").decode("utf-8", "ignore")[-400:] or "ffmpeg failed")
    with part.open("rb") as handle:
        os.fsync(handle.fileno())
    part.replace(dest)
    return dest


def _kill_group(proc):
    try:
        os.killpg(proc.pid, 15)
    except OSError:
        try:
            proc.kill()
        except OSError:
            pass
    else:
        try:
            proc.kill()
        except OSError:
            pass


def _unlink(path):
    try:
        Path(path).unlink()
    except OSError:
        pass


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cleanup_staging(staging_dir, keep=None):
    keep = {str(Path(p).resolve()) for p in (keep or []) if p}
    root = Path(staging_dir)
    if not root.is_dir():
        return
    for item in root.iterdir():
        try:
            resolved = item.resolve()
        except OSError:
            continue
        if str(resolved) in keep:
            continue
        # Only old, unreferenced generation artifacts. A successful job must
        # never clean another in-flight or retryable output's private bytes.
        if item.suffix in (".part", ".bin") and item.is_file() and item.stat().st_mtime < time.time() - 3600:
            _unlink(item)


def output_uri_for(filename):
    dest = gen_models.output_dir()
    if dest is None:
        raise ProviderError("disabled", "generation output directory is invalid")
    rel = Path(dest).resolve().relative_to(Path(config.ASSET_ROOT).resolve())
    return (rel / filename).as_posix()
