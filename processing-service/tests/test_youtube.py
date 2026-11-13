import json

import httpx
import pytest
from pydantic import SecretStr

from app.core.config import get_settings
from app.core.exceptions import ServiceError
from app.extractors import youtube
from app.extractors.youtube import fetch_video_metadata, parse_iso8601_duration, parse_youtube_url

ID = "dQw4w9WgXcQ"


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={ID}",
        f"https://youtube.com/watch?v={ID}&t=42s&list=PL123",
        f"http://m.youtube.com/watch?feature=share&v={ID}",
        f"https://music.youtube.com/watch?v={ID}",
        f"https://youtu.be/{ID}",
        f"https://youtu.be/{ID}?si=abc&t=10",
        f"https://www.youtube.com/shorts/{ID}",
        f"https://www.youtube.com/embed/{ID}?start=5",
        f"https://www.youtube.com/live/{ID}",
        f"https://www.youtube-nocookie.com/embed/{ID}",
        f"  https://www.youtube.com/watch?v={ID}  ",
    ],
)
def test_parses_supported_youtube_url_formats(url):
    assert parse_youtube_url(url) == ID


@pytest.mark.parametrize(
    "url",
    [
        "",
        "not a url",
        "https://www.youtube.com/",
        "https://www.youtube.com/watch",
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/watch?v=has spaces!",
        "https://www.youtube.com/@somechannel",
        "https://www.youtube.com/playlist?list=PL123",
        f"https://vimeo.com/{ID}",
        f"https://youtube.com.evil.example/watch?v={ID}",
        f"https://evil.example/youtube.com/watch?v={ID}",
        f"ftp://youtube.com/watch?v={ID}",
        f"javascript://youtube.com/watch?v={ID}",
        f"https://user:pass@www.youtube.com/watch?v={ID}",
    ],
)
def test_rejects_invalid_or_non_youtube_urls(url):
    with pytest.raises(ServiceError) as info:
        parse_youtube_url(url)
    assert info.value.code == "INVALID_YOUTUBE_URL"


@pytest.mark.parametrize(
    "value, expected",
    [("PT1H2M3S", 3723), ("PT45S", 45), ("PT10M", 600), ("P1DT1S", 86401), ("PT0S", None), ("", None), ("bogus", None)],
)
def test_parse_iso8601_duration(value, expected):
    assert parse_iso8601_duration(value) == expected


# ------------------------------------------------------------------ metadata


def video_item(**overrides):
    item = {
        "snippet": {
            "title": "How Urban Trees Cool Cities",
            "channelTitle": "Science Channel",
            "channelId": "UC123",
            "publishedAt": "2025-03-01T10:00:00Z",
            "liveBroadcastContent": "none",
            "thumbnails": {
                "high": {"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"},
                "maxres": {"url": "https://i.ytimg.com/vi/x/maxresdefault.jpg"},
            },
        },
        "contentDetails": {"duration": "PT12M30S", "caption": "true", "contentRating": {}},
        "status": {"privacyStatus": "public", "uploadStatus": "processed"},
    }
    for key, value in overrides.items():
        item[key] = {**item[key], **value}
    return item


def use_transport(monkeypatch, handler):
    monkeypatch.setattr(youtube, "transport", httpx.MockTransport(handler))


@pytest.fixture()
def api_settings():
    return get_settings().model_copy(update={"youtube_api_key": SecretStr("yt-test-key")})


def data_api_handler(items, captions=None, seen=None):
    def handler(request: httpx.Request):
        if seen is not None:
            seen.append(request)
        if request.url.path.endswith("/videos"):
            return httpx.Response(200, json={"items": items})
        if request.url.path.endswith("/captions"):
            return httpx.Response(200, json={"items": captions or []})
        return httpx.Response(404)

    return handler


@pytest.mark.anyio
async def test_data_api_metadata_and_caption_kinds(monkeypatch, api_settings):
    seen = []
    captions = [
        {"snippet": {"trackKind": "standard", "language": "en"}},
        {"snippet": {"trackKind": "asr", "language": "en"}},
        {"snippet": {"trackKind": "asr", "language": "de"}},
    ]
    use_transport(monkeypatch, data_api_handler([video_item()], captions, seen))

    meta = await fetch_video_metadata(ID, api_settings, max_duration_seconds=3600)

    assert meta.title == "How Urban Trees Cool Cities"
    assert meta.channel_title == "Science Channel"
    assert meta.channel_url == "https://www.youtube.com/channel/UC123"
    assert meta.thumbnail_url == "https://i.ytimg.com/vi/x/maxresdefault.jpg"
    assert meta.duration_seconds == 750
    assert meta.published_at == "2025-03-01T10:00:00Z"
    assert meta.metadata_source == "youtube_data_api"
    assert meta.captions.available is True
    assert meta.captions.manual_languages == ["en"]
    assert meta.captions.auto_languages == ["en", "de"]
    # The API key travels in a header, never in the URL (which could be logged).
    assert all("yt-test-key" not in str(r.url) for r in seen)
    assert seen[0].headers["x-goog-api-key"] == "yt-test-key"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "items, code",
    [
        ([], "VIDEO_NOT_FOUND"),
        ([video_item(status={"privacyStatus": "private"})], "VIDEO_PRIVATE"),
        ([video_item(status={"privacyStatus": "unlisted"})], "VIDEO_UNSUPPORTED"),
        ([video_item(snippet={"liveBroadcastContent": "live"})], "VIDEO_LIVE"),
        ([video_item(snippet={"liveBroadcastContent": "upcoming"})], "VIDEO_LIVE"),
        ([video_item(contentDetails={"contentRating": {"ytRating": "ytAgeRestricted"}})], "VIDEO_AGE_RESTRICTED"),
        ([video_item(status={"uploadStatus": "rejected"})], "VIDEO_UNAVAILABLE"),
        ([video_item(contentDetails={"duration": "PT3H1S"})], "VIDEO_TOO_LONG"),
    ],
)
async def test_unavailable_videos_are_rejected_without_retry(monkeypatch, api_settings, items, code):
    use_transport(monkeypatch, data_api_handler(items))
    with pytest.raises(ServiceError) as info:
        await fetch_video_metadata(ID, api_settings, max_duration_seconds=3 * 3600)
    assert info.value.code == code
    assert info.value.retryable is False


@pytest.mark.anyio
async def test_no_captions_is_reported_honestly(monkeypatch, api_settings):
    use_transport(monkeypatch, data_api_handler([video_item(contentDetails={"caption": "false"})], captions=[]))
    meta = await fetch_video_metadata(ID, api_settings, None)
    assert meta.captions.available is False


@pytest.mark.anyio
async def test_quota_errors_fall_back_to_oembed(monkeypatch, api_settings):
    def handler(request: httpx.Request):
        if request.url.host == "www.googleapis.com":
            return httpx.Response(403, json={"error": {"errors": [{"reason": "quotaExceeded"}]}})
        return httpx.Response(200, json={"title": "From oEmbed", "author_name": "Chan", "thumbnail_url": "https://i.ytimg.com/a.jpg"})

    use_transport(monkeypatch, handler)
    meta = await fetch_video_metadata(ID, api_settings, None)
    assert meta.metadata_source == "oembed"
    assert meta.title == "From oEmbed"


@pytest.mark.anyio
async def test_oembed_without_api_key(monkeypatch):
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "title": "A talk",
                "author_name": "Speaker",
                "author_url": "https://www.youtube.com/@speaker",
                "thumbnail_url": "https://i.ytimg.com/vi/x/hqdefault.jpg",
            },
        )

    use_transport(monkeypatch, handler)
    meta = await fetch_video_metadata(ID, get_settings(), None)

    assert seen[0].url.host == "www.youtube.com"
    assert json.loads(json.dumps(dict(seen[0].url.params)))["url"] == f"https://www.youtube.com/watch?v={ID}"
    assert meta.title == "A talk"
    assert meta.duration_seconds is None  # unknown, never guessed
    assert meta.captions.available is None  # unknown without the Data API


@pytest.mark.anyio
@pytest.mark.parametrize("status, code", [(401, "VIDEO_PRIVATE"), (403, "VIDEO_PRIVATE"), (404, "VIDEO_NOT_FOUND"), (400, "VIDEO_NOT_FOUND")])
async def test_oembed_errors(monkeypatch, status, code):
    use_transport(monkeypatch, lambda r: httpx.Response(status))
    with pytest.raises(ServiceError) as info:
        await fetch_video_metadata(ID, get_settings(), None)
    assert info.value.code == code


@pytest.mark.anyio
async def test_youtube_outage_is_retryable(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("down", request=request)

    use_transport(monkeypatch, handler)
    with pytest.raises(ServiceError) as info:
        await fetch_video_metadata(ID, get_settings(), None)
    assert info.value.code == "YOUTUBE_UNAVAILABLE"
    assert info.value.retryable is True


@pytest.mark.anyio
async def test_rejects_malformed_ids_without_network(monkeypatch):
    use_transport(monkeypatch, lambda r: pytest.fail("no request expected"))
    with pytest.raises(ServiceError):
        await fetch_video_metadata("../../etc", get_settings(), None)
