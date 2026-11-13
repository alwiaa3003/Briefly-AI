"""ffmpeg wrapper for probing uploaded videos and extracting audio windows.

Uploaded files are untrusted. Hardening:
- The demuxer is forced from the container detected (and signature-checked)
  at upload time, so ffmpeg never auto-detects formats such as HLS playlists
  or concat lists that could reference other files or URLs.
- ``-protocol_whitelist`` allows only https/tls/tcp for remote sources, so a
  crafted file cannot make ffmpeg open local files or other protocols.
- Download URLs must be https and point at an allowed storage host (or at
  least pass the SSRF checks used for articles).
- No shell is involved; arguments are passed as a list. Every run has a timeout.
- Only audio is decoded (-vn -sn -dn), downmixed to 16 kHz mono MP3.

ffmpeg reads remote files with HTTP range requests, so probing and
extracting a 10-minute window does not download the whole video.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.extractors.url_safety import InvalidUrlError, UnsafeUrlError, check_url

# Detected container -> ffmpeg demuxer name.
CONTAINER_DEMUXERS = {"mp4": "mov", "mov": "mov", "webm": "matroska", "mkv": "matroska"}
AUDIO_MIME_TYPE = "audio/mp3"

_DURATION = re.compile(r"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
_AUDIO_STREAM = re.compile(r"Stream #\d+:\d+[^\n]*?: Audio:")
_VIDEO_STREAM = re.compile(r"Stream #\d+:\d+[^\n]*?: Video:")


@dataclass(frozen=True)
class MediaInfo:
    duration_seconds: float
    has_audio: bool
    has_video: bool


def _error(status: int, code: str, message: str, retryable: bool) -> ServiceError:
    return ServiceError(status, code, message, retryable=retryable)


def ffmpeg_executable(settings: Settings) -> str:
    if settings.ffmpeg_path:
        return settings.ffmpeg_path
    try:
        import imageio_ffmpeg
    except ImportError as exc:  # pragma: no cover - dependency is pinned
        raise _error(503, "MEDIA_TOOLS_MISSING", "Video processing is not available on the server.", False) from exc
    return imageio_ffmpeg.get_ffmpeg_exe()


def validate_download_url(url: str, settings: Settings) -> str:
    """Signed storage URLs must be https and point at an allowed storage host."""
    try:
        checked = check_url(url)
    except (InvalidUrlError, UnsafeUrlError) as exc:
        raise _error(422, "UNSAFE_URL", "The media URL is not allowed.", False) from exc
    if checked.scheme != "https":
        raise _error(422, "UNSAFE_URL", "The media URL must use https.", False)
    allowed = settings.storage_download_host_list
    if not allowed and settings.environment == "production":
        # In production, downloads are only allowed from explicitly configured storage hosts.
        raise _error(503, "STORAGE_NOT_CONFIGURED", "File processing is not configured on the server.", False)
    if allowed and checked.hostname not in allowed:
        raise _error(422, "UNSAFE_URL", "The media URL does not point at the configured storage.", False)
    return url


def _input_args(source: str | Path, container: str, allow_local: bool) -> list[str]:
    demuxer = CONTAINER_DEMUXERS.get(container)
    if demuxer is None:
        raise _error(422, "MEDIA_UNSUPPORTED", "This video format is not supported.", False)
    is_remote = isinstance(source, str) and urlsplit(source).scheme == "https"
    if not is_remote and not allow_local:
        raise _error(422, "UNSAFE_URL", "The media URL must use https.", False)
    whitelist = "https,tls,tcp" if is_remote else "file"
    return ["-protocol_whitelist", whitelist, "-f", demuxer, "-i", str(source)]


def _run(args: list[str], settings: Settings) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(  # noqa: S603 - argument list, no shell
            args,
            capture_output=True,
            timeout=settings.ffmpeg_timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise _error(504, "MEDIA_TIMEOUT", "Processing the video took too long.", True) from exc
    except OSError as exc:
        raise _error(503, "MEDIA_TOOLS_MISSING", "Video processing is not available on the server.", False) from exc


def _classify_failure(stderr: str) -> ServiceError:
    lowered = stderr.lower()
    if any(marker in lowered for marker in ("server returned 403", "server returned 404", "server returned 401")):
        # Typically an expired signed URL; the worker requests a fresh one on retry.
        return _error(502, "MEDIA_DOWNLOAD_FAILED", "The uploaded video could not be read from storage.", True)
    if any(marker in lowered for marker in ("connection refused", "timed out", "i/o error", "server returned 5")):
        return _error(502, "MEDIA_DOWNLOAD_FAILED", "The uploaded video could not be read from storage.", True)
    return _error(422, "MEDIA_INVALID", "The video file is damaged or in an unsupported format.", False)


def probe(source: str | Path, container: str, settings: Settings, *, allow_local: bool = False) -> MediaInfo:
    args = [ffmpeg_executable(settings), "-hide_banner", "-nostdin", *_input_args(source, container, allow_local)]
    result = _run(args, settings)
    stderr = result.stderr.decode("utf-8", errors="replace")
    match = _DURATION.search(stderr)
    if not match:
        raise _classify_failure(stderr)
    hours, minutes, seconds = int(match.group(1)), int(match.group(2)), float(match.group(3))
    duration = hours * 3600 + minutes * 60 + seconds
    if duration <= 0:
        raise _error(422, "MEDIA_INVALID", "The video has no playable content.", False)
    return MediaInfo(
        duration_seconds=round(duration, 2),
        has_audio=bool(_AUDIO_STREAM.search(stderr)),
        has_video=bool(_VIDEO_STREAM.search(stderr)),
    )


def extract_audio(
    source: str | Path,
    container: str,
    start_seconds: float,
    duration_seconds: float,
    output_path: Path,
    settings: Settings,
    *,
    allow_local: bool = False,
) -> Path:
    """Writes a 16 kHz mono MP3 of [start, start + duration) to output_path."""
    args = [
        ffmpeg_executable(settings),
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-ss",
        f"{max(0.0, start_seconds):.3f}",
        "-t",
        f"{max(0.1, duration_seconds):.3f}",
        *_input_args(source, container, allow_local),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "32k",
        "-f",
        "mp3",
        "-y",
        str(output_path),
    ]
    result = _run(args, settings)
    if result.returncode != 0 or not output_path.exists() or output_path.stat().st_size == 0:
        stderr = result.stderr.decode("utf-8", errors="replace")
        if "matches no streams" in stderr.lower():
            raise _error(422, "MEDIA_NO_AUDIO", "This video has no audio track to transcribe.", False)
        raise _classify_failure(stderr)
    return output_path
