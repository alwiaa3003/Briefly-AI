"""YouTube URL parsing and metadata.

Metadata sources, both officially provided by YouTube:
- YouTube Data API v3 (``videos.list`` + ``captions.list``) when YOUTUBE_API_KEY is
  set: title, channel, thumbnail, duration, publish date, privacy, age
  restriction, live status and the kinds of caption tracks (manual vs
  auto-generated).
- The public oEmbed endpoint otherwise: title, channel and thumbnail only.

Transcripts are NOT taken from YouTube captions (the Data API only lets a
video's owner download them, and scraping the player's caption endpoints is
not permitted). They are produced by Gemini's supported YouTube video input;
see app/processors/transcription.py.

Requests only ever go to fixed Google hosts, so no user-controlled URL is fetched.
The API key is sent in a header (never in the URL) so it cannot appear in logs.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlsplit

import httpx

from app.core.config import Settings
from app.core.exceptions import ServiceError

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}
SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
PATH_PREFIXES = ("embed", "shorts", "live", "v", "e")

DATA_API_URL = "https://www.googleapis.com/youtube/v3"
OEMBED_URL = "https://www.youtube.com/oembed"
REQUEST_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

# Replaced in tests.
transport: httpx.AsyncBaseTransport | None = None


def _error(status: int, code: str, message: str, retryable: bool) -> ServiceError:
    return ServiceError(status, code, message, retryable=retryable)


def parse_youtube_url(url: str) -> str:
    """Returns the 11-character video id, or raises INVALID_YOUTUBE_URL."""
    invalid = _error(422, "INVALID_YOUTUBE_URL", "Enter a valid YouTube video link.", False)
    if not isinstance(url, str) or len(url) > 2048:
        raise invalid
    try:
        parts = urlsplit(url.strip())
    except ValueError as exc:
        raise invalid from exc
    if parts.scheme not in ("http", "https") or parts.username or parts.password:
        raise invalid
    host = (parts.hostname or "").lower()
    segments = [s for s in parts.path.split("/") if s]

    candidate: str | None = None
    if host in SHORT_HOSTS:
        candidate = segments[0] if segments else None
    elif host in YOUTUBE_HOSTS:
        if segments[:1] == ["watch"]:
            candidate = (parse_qs(parts.query).get("v") or [None])[0]
        elif len(segments) >= 2 and segments[0] in PATH_PREFIXES:
            candidate = segments[1]
    if not candidate or not VIDEO_ID.match(candidate):
        raise invalid
    return candidate


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def parse_iso8601_duration(value: str | None) -> int | None:
    """'PT1H2M3S' -> 3723. Returns None for missing/zero/unparseable values."""
    if not value:
        return None
    match = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", value)
    if not match:
        return None
    days, hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())
    total = days * 86400 + hours * 3600 + minutes * 60 + seconds
    return total or None


@dataclass
class CaptionInfo:
    # None = unknown (no API key or captions.list unavailable)
    available: bool | None = None
    manual_languages: list[str] = field(default_factory=list)
    auto_languages: list[str] = field(default_factory=list)


@dataclass
class VideoMetadata:
    video_id: str
    watch_url: str
    title: str | None
    channel_title: str | None
    channel_url: str | None
    thumbnail_url: str | None
    duration_seconds: int | None
    published_at: str | None
    privacy_status: str | None
    metadata_source: str
    captions: CaptionInfo


def _best_thumbnail(thumbnails: dict) -> str | None:
    for size in ("maxres", "standard", "high", "medium", "default"):
        url = (thumbnails.get(size) or {}).get("url")
        if isinstance(url, str) and url.startswith("https://"):
            return url
    return None


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, timeout=REQUEST_TIMEOUT, trust_env=False, follow_redirects=False)


async def _fetch_data_api(video_id: str, settings: Settings) -> VideoMetadata | None:
    """Returns None when the Data API can't be used right now (quota, outage) so oEmbed can be tried."""
    headers = {"X-Goog-Api-Key": settings.youtube_api_key.get_secret_value()}  # type: ignore[union-attr]
    params = {"part": "snippet,contentDetails,status", "id": video_id}
    async with _client() as client:
        try:
            response = await client.get(f"{DATA_API_URL}/videos", params=params, headers=headers)
        except httpx.HTTPError:
            return None
        if response.status_code in (403, 429) or response.status_code >= 500:
            return None
        if response.status_code != 200:
            raise _error(502, "YOUTUBE_METADATA_FAILED", "Video details could not be retrieved.", True)

        items = response.json().get("items") or []
        if not items:
            # The API hides private and deleted videos alike.
            raise _error(422, "VIDEO_NOT_FOUND", "This video doesn't exist, was removed, or is private.", False)
        item = items[0]
        snippet, details, status = item.get("snippet", {}), item.get("contentDetails", {}), item.get("status", {})

        if status.get("uploadStatus") not in (None, "processed", "uploaded"):
            raise _error(422, "VIDEO_UNAVAILABLE", "This video is not available.", False)
        privacy = status.get("privacyStatus")
        if privacy == "private":
            raise _error(422, "VIDEO_PRIVATE", "This video is private.", False)
        if privacy == "unlisted":
            raise _error(
                422, "VIDEO_UNSUPPORTED", "Unlisted videos can't be processed. Only public videos are supported.", False
            )
        if snippet.get("liveBroadcastContent") in ("live", "upcoming"):
            raise _error(
                422, "VIDEO_LIVE", "Live streams and upcoming premieres can't be summarized until they've ended.", False
            )
        if (details.get("contentRating") or {}).get("ytRating") == "ytAgeRestricted":
            raise _error(422, "VIDEO_AGE_RESTRICTED", "Age-restricted videos can't be processed.", False)

        captions = CaptionInfo(available=details.get("caption") == "true" if "caption" in details else None)
        try:
            cap = await client.get(
                f"{DATA_API_URL}/captions", params={"part": "snippet", "videoId": video_id}, headers=headers
            )
            if cap.status_code == 200:
                for track in cap.json().get("items") or []:
                    track_snippet = track.get("snippet", {})
                    language = str(track_snippet.get("language") or "")[:20]
                    if track_snippet.get("trackKind") == "asr":
                        captions.auto_languages.append(language)
                    else:
                        captions.manual_languages.append(language)
                captions.available = bool(captions.auto_languages or captions.manual_languages)
        except (httpx.HTTPError, ValueError):
            pass

        channel_id = snippet.get("channelId")
        return VideoMetadata(
            video_id=video_id,
            watch_url=watch_url(video_id),
            title=snippet.get("title"),
            channel_title=snippet.get("channelTitle"),
            channel_url=f"https://www.youtube.com/channel/{channel_id}" if channel_id else None,
            thumbnail_url=_best_thumbnail(snippet.get("thumbnails") or {}),
            duration_seconds=parse_iso8601_duration(details.get("duration")),
            published_at=snippet.get("publishedAt"),
            privacy_status=privacy,
            metadata_source="youtube_data_api",
            captions=captions,
        )


async def _fetch_oembed(video_id: str) -> VideoMetadata:
    async with _client() as client:
        try:
            response = await client.get(OEMBED_URL, params={"url": watch_url(video_id), "format": "json"})
        except httpx.TimeoutException as exc:
            raise _error(504, "YOUTUBE_UNAVAILABLE", "YouTube took too long to respond.", True) from exc
        except httpx.HTTPError as exc:
            raise _error(502, "YOUTUBE_UNAVAILABLE", "YouTube could not be reached.", True) from exc

    if response.status_code in (401, 403):
        raise _error(422, "VIDEO_PRIVATE", "This video is private or can't be accessed.", False)
    if response.status_code in (400, 404):
        raise _error(422, "VIDEO_NOT_FOUND", "This video doesn't exist or was removed.", False)
    if response.status_code != 200:
        raise _error(502, "YOUTUBE_UNAVAILABLE", "Video details could not be retrieved.", True)

    data = response.json()
    author_url = data.get("author_url")
    thumbnail = data.get("thumbnail_url")
    return VideoMetadata(
        video_id=video_id,
        watch_url=watch_url(video_id),
        title=data.get("title"),
        channel_title=data.get("author_name"),
        channel_url=author_url if isinstance(author_url, str) and author_url.startswith("https://") else None,
        thumbnail_url=thumbnail if isinstance(thumbnail, str) and thumbnail.startswith("https://") else None,
        duration_seconds=None,
        published_at=None,
        privacy_status=None,
        metadata_source="oembed",
        captions=CaptionInfo(),
    )


async def fetch_video_metadata(video_id: str, settings: Settings, max_duration_seconds: int | None) -> VideoMetadata:
    if not VIDEO_ID.match(video_id):
        raise _error(422, "INVALID_YOUTUBE_URL", "Enter a valid YouTube video link.", False)

    metadata = await _fetch_data_api(video_id, settings) if settings.youtube_api_configured else None
    if metadata is None:
        metadata = await _fetch_oembed(video_id)

    if max_duration_seconds and metadata.duration_seconds and metadata.duration_seconds > max_duration_seconds:
        raise _error(
            422,
            "VIDEO_TOO_LONG",
            f"This video is longer than the {max_duration_seconds // 60}-minute limit.",
            False,
        )
    return metadata
