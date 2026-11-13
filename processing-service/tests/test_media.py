"""ffmpeg integration tests against small, real, locally generated videos."""

import pytest

from app.core.config import get_settings
from app.core.exceptions import ServiceError
from app.media import ffmpeg
from tests.video_fixtures import make_video


@pytest.fixture()
def settings():
    return get_settings()


@pytest.mark.parametrize("container", ["mp4", "mov", "webm", "mkv"])
def test_probe_reads_duration_and_streams(tmp_path, settings, container):
    path = make_video(tmp_path, container, seconds=4)
    info = ffmpeg.probe(path, container, settings, allow_local=True)
    assert 3.5 <= info.duration_seconds <= 4.5
    assert info.has_audio is True
    assert info.has_video is True


def test_probe_detects_missing_audio(tmp_path, settings):
    path = make_video(tmp_path, "mp4", seconds=2, audio=False)
    assert ffmpeg.probe(path, "mp4", settings, allow_local=True).has_audio is False


def test_extract_audio_window(tmp_path, settings):
    path = make_video(tmp_path, "mp4", seconds=6)
    out = tmp_path / "window.mp3"
    ffmpeg.extract_audio(path, "mp4", 2, 3, out, settings, allow_local=True)

    assert out.read_bytes()[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")
    info = ffmpeg.probe(path, "mp4", settings, allow_local=True)
    assert info.duration_seconds > 5  # source untouched


def test_extract_audio_from_video_without_audio_fails_cleanly(tmp_path, settings):
    path = make_video(tmp_path, "mp4", seconds=2, audio=False)
    with pytest.raises(ServiceError) as info:
        ffmpeg.extract_audio(path, "mp4", 0, 2, tmp_path / "x.mp3", settings, allow_local=True)
    assert info.value.code == "MEDIA_NO_AUDIO"
    assert info.value.retryable is False


def test_garbage_file_is_rejected_as_invalid(tmp_path, settings):
    bad = tmp_path / "fake.mp4"
    bad.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"not really a video" * 50)
    with pytest.raises(ServiceError) as info:
        ffmpeg.probe(bad, "mp4", settings, allow_local=True)
    assert info.value.code == "MEDIA_INVALID"


def test_forced_demuxer_rejects_mismatched_content(tmp_path, settings):
    """A WebM file declared as MP4 is read with the MP4 demuxer only, never auto-detected."""
    webm = make_video(tmp_path, "webm", seconds=2)
    with pytest.raises(ServiceError):
        ffmpeg.probe(webm, "mp4", settings, allow_local=True)


def test_playlist_style_inputs_cannot_reach_local_files(tmp_path, settings):
    """An HLS playlist disguised as an upload must not be able to read other files."""
    secret = tmp_path / "secret.txt"
    secret.write_text("TOP SECRET")
    playlist = tmp_path / "evil.mp4"
    playlist.write_text(f"#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\n{secret.as_uri()}\n#EXT-X-ENDLIST\n")
    with pytest.raises(ServiceError) as info:
        ffmpeg.probe(playlist, "mp4", settings, allow_local=True)
    assert info.value.code == "MEDIA_INVALID"


def test_local_paths_are_refused_unless_explicitly_allowed(tmp_path, settings):
    path = make_video(tmp_path, "mp4", seconds=2)
    with pytest.raises(ServiceError) as info:
        ffmpeg.probe(path, "mp4", settings)
    assert info.value.code == "UNSAFE_URL"
    with pytest.raises(ServiceError):
        ffmpeg.probe("file:///etc/passwd", "mp4", settings)


def test_unsupported_container(settings, tmp_path):
    with pytest.raises(ServiceError) as info:
        ffmpeg.probe(tmp_path / "x.avi", "avi", settings, allow_local=True)
    assert info.value.code == "MEDIA_UNSUPPORTED"


def test_ffmpeg_timeouts_are_retryable(tmp_path, monkeypatch):
    import subprocess

    def slow(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="ffmpeg", timeout=1)

    monkeypatch.setattr(ffmpeg.subprocess, "run", slow)
    with pytest.raises(ServiceError) as info:
        ffmpeg.probe(tmp_path / "x.mp4", "mp4", get_settings(), allow_local=True)
    assert info.value.code == "MEDIA_TIMEOUT"
    assert info.value.retryable is True


@pytest.mark.parametrize(
    "url",
    [
        "http://storage.example.com/obj?sig=1",  # not https
        "https://127.0.0.1/obj",
        "https://169.254.169.254/latest/meta-data",
        "https://localhost/obj",
        "file:///etc/passwd",
        "https://user:pw@storage.example.com/obj",
    ],
)
def test_download_url_validation_blocks_ssrf(settings, url):
    with pytest.raises(ServiceError) as info:
        ffmpeg.validate_download_url(url, settings)
    assert info.value.code == "UNSAFE_URL"


def test_download_url_must_match_configured_storage_hosts():
    settings = get_settings().model_copy(update={"storage_download_hosts": "acct.r2.cloudflarestorage.com"})
    assert ffmpeg.validate_download_url("https://acct.r2.cloudflarestorage.com/bucket/videos/x?sig=1", settings)
    with pytest.raises(ServiceError):
        ffmpeg.validate_download_url("https://other.example.com/x", settings)


def test_production_requires_configured_storage_hosts():
    """An empty STORAGE_DOWNLOAD_HOSTS must not allow arbitrary hosts in production."""
    url = "https://acct.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=x"
    prod = get_settings().model_copy(update={"environment": "production", "storage_download_hosts": ""})
    with pytest.raises(ServiceError) as info:
        ffmpeg.validate_download_url(url, prod)
    assert info.value.code == "STORAGE_NOT_CONFIGURED"
    configured = prod.model_copy(update={"storage_download_hosts": "acct.r2.cloudflarestorage.com"})
    assert ffmpeg.validate_download_url(url, configured) == url
