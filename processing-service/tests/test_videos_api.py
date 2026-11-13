import pytest

from app.api.routes import videos as video_routes
from app.core.exceptions import ServiceError
from app.extractors.youtube import CaptionInfo, VideoMetadata
from app.media import ffmpeg
from tests.fakes import FakeGenerator
from tests.video_fixtures import SEGMENTS, VALID_VIDEO_SUMMARY

ID = "dQw4w9WgXcQ"
SIGNED_URL = "https://acct.r2.cloudflarestorage.com/briefly/videos/abc.mp4?X-Amz-Signature=sig"


@pytest.fixture()
def use_generator(client):
    def install(*responses):
        fake = FakeGenerator(responses=list(responses))
        client.app.dependency_overrides[video_routes.get_generator] = lambda: fake
        return fake

    yield install
    client.app.dependency_overrides.clear()


@pytest.fixture()
def storage_hosts(monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "storage_download_hosts", "acct.r2.cloudflarestorage.com")


@pytest.mark.parametrize(
    "path",
    ["/internal/youtube/metadata", "/internal/youtube/transcribe", "/internal/videos/probe",
     "/internal/videos/transcribe", "/internal/videos/summarize"],
)
def test_video_endpoints_require_internal_token(client, path):
    response = client.post(path, json={})
    assert response.status_code == 401


def test_youtube_metadata(client, auth_headers, monkeypatch):
    async def fake_fetch(video_id, settings, max_duration):
        assert (video_id, max_duration) == (ID, 7200)
        return VideoMetadata(
            video_id=ID, watch_url=f"https://www.youtube.com/watch?v={ID}", title="T", channel_title="C",
            channel_url=None, thumbnail_url=None, duration_seconds=600, published_at=None, privacy_status="public",
            metadata_source="youtube_data_api", captions=CaptionInfo(available=True, auto_languages=["en"]),
        )

    monkeypatch.setattr(video_routes, "fetch_video_metadata", fake_fetch)
    response = client.post(
        "/internal/youtube/metadata", json={"video_id": ID, "max_duration_seconds": 7200}, headers=auth_headers
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["duration_seconds"] == 600
    assert data["captions"] == {"available": True, "manual_languages": [], "auto_languages": ["en"]}


@pytest.mark.parametrize("video_id", ["short", "../../../etc/x", "dQw4w9WgXcQ&x=1"])
def test_youtube_endpoints_validate_video_ids(client, auth_headers, video_id):
    for path in ("/internal/youtube/metadata", "/internal/youtube/transcribe"):
        response = client.post(path, json={"video_id": video_id, "start_seconds": 0}, headers=auth_headers)
        assert response.status_code == 422


def test_youtube_transcribe_window(client, auth_headers, use_generator):
    use_generator({"language": "en", "segments": [{"start_seconds": 1, "end_seconds": 4, "speaker": "", "text": "Hi."}]})
    response = client.post(
        "/internal/youtube/transcribe", json={"video_id": ID, "start_seconds": 600, "end_seconds": 1200},
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["segments"] == [{"start": 601.0, "end": 604.0, "text": "Hi.", "speaker": None}]
    assert data["provider"] == "gemini"
    assert (data["clip_start"], data["clip_end"]) == (600, 1200)


def test_transcribe_rejects_inverted_windows(client, auth_headers):
    response = client.post(
        "/internal/youtube/transcribe", json={"video_id": ID, "start_seconds": 600, "end_seconds": 100},
        headers=auth_headers,
    )
    assert response.status_code == 422


def test_probe_enforces_duration_limit(client, auth_headers, monkeypatch, storage_hosts):
    monkeypatch.setattr(ffmpeg, "probe", lambda *a, **k: ffmpeg.MediaInfo(4000, True, True))
    response = client.post(
        "/internal/videos/probe",
        json={"download_url": SIGNED_URL, "container": "mp4", "max_duration_seconds": 3600},
        headers=auth_headers,
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VIDEO_TOO_LONG"
    assert response.json()["error"]["retryable"] is False


def test_probe_rejects_videos_without_audio(client, auth_headers, monkeypatch, storage_hosts):
    monkeypatch.setattr(ffmpeg, "probe", lambda *a, **k: ffmpeg.MediaInfo(60, False, True))
    response = client.post(
        "/internal/videos/probe", json={"download_url": SIGNED_URL, "container": "mp4"}, headers=auth_headers
    )
    assert response.json()["error"]["code"] == "MEDIA_NO_AUDIO"


def test_probe_success(client, auth_headers, monkeypatch, storage_hosts):
    monkeypatch.setattr(ffmpeg, "probe", lambda *a, **k: ffmpeg.MediaInfo(125.5, True, True))
    response = client.post(
        "/internal/videos/probe", json={"download_url": SIGNED_URL, "container": "webm"}, headers=auth_headers
    )
    assert response.json()["data"] == {"duration_seconds": 125.5, "has_audio": True, "has_video": True}


@pytest.mark.parametrize(
    "url", ["https://evil.example.com/x", "http://acct.r2.cloudflarestorage.com/x", "https://169.254.169.254/x"]
)
def test_media_endpoints_refuse_urls_outside_storage(client, auth_headers, storage_hosts, url):
    for path, body in (
        ("/internal/videos/probe", {"download_url": url, "container": "mp4"}),
        ("/internal/videos/transcribe", {"download_url": url, "container": "mp4", "start_seconds": 0, "end_seconds": 60}),
    ):
        response = client.post(path, json=body, headers=auth_headers)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "UNSAFE_URL"


def test_media_endpoints_reject_unknown_containers(client, auth_headers):
    response = client.post(
        "/internal/videos/probe", json={"download_url": SIGNED_URL, "container": "avi"}, headers=auth_headers
    )
    assert response.status_code == 422


def test_upload_transcription_extracts_audio_and_cleans_up(client, auth_headers, monkeypatch, storage_hosts, use_generator):
    fake = use_generator({"language": "en", "segments": [{"start_seconds": 2, "end_seconds": 6, "speaker": "Speaker 1", "text": "Hello."}]})
    seen = {}

    def fake_extract(url, container, start, duration, output_path, settings):
        seen.update(url=url, container=container, start=start, duration=duration, path=output_path)
        output_path.write_bytes(b"ID3audio")
        return output_path

    monkeypatch.setattr(ffmpeg, "extract_audio", fake_extract)
    response = client.post(
        "/internal/videos/transcribe",
        json={"download_url": SIGNED_URL, "container": "mov", "start_seconds": 600, "end_seconds": 1200},
        headers=auth_headers,
    )

    assert response.status_code == 200
    assert response.json()["data"]["segments"] == [{"start": 602.0, "end": 606.0, "text": "Hello.", "speaker": "Speaker 1"}]
    assert (seen["container"], seen["start"], seen["duration"]) == ("mov", 600, 600)
    assert fake.calls[0]["media"][0].inline_data.data == b"ID3audio"
    assert not seen["path"].exists()  # temporary audio removed


def test_upload_transcription_failure_still_cleans_up(client, auth_headers, monkeypatch, storage_hosts, use_generator):
    use_generator(ServiceError(503, "AI_UNAVAILABLE", "down", retryable=True))
    seen = {}

    def fake_extract(url, container, start, duration, output_path, settings):
        seen["path"] = output_path
        output_path.write_bytes(b"ID3audio")
        return output_path

    monkeypatch.setattr(ffmpeg, "extract_audio", fake_extract)
    response = client.post(
        "/internal/videos/transcribe",
        json={"download_url": SIGNED_URL, "container": "mp4", "start_seconds": 0, "end_seconds": 60},
        headers=auth_headers,
    )
    assert response.status_code == 503
    assert response.json()["error"]["retryable"] is True
    assert not seen["path"].exists()


def test_video_summarize(client, auth_headers, use_generator):
    use_generator(VALID_VIDEO_SUMMARY)
    response = client.post(
        "/internal/videos/summarize",
        json={
            "source_kind": "video",
            "title": "Trees",
            "duration_seconds": 180,
            "segments": [s.model_dump() for s in SEGMENTS],
        },
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert [c["start_seconds"] for c in data["summary"]["chapters"]] == [0.0, 12.5, 40.0, 150.0]
    assert data["summary"]["key_moments"][0] == {"seconds": 40.0, "description": "Canopy inequality is described"}


def test_video_summarize_requires_segments(client, auth_headers):
    response = client.post(
        "/internal/videos/summarize", json={"source_kind": "video", "segments": []}, headers=auth_headers
    )
    assert response.status_code == 422
