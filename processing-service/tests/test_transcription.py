import pytest
from google.genai import errors as genai_errors

from app.core.config import get_settings
from app.core.exceptions import ServiceError
from app.processors.transcription import (
    GeminiTranscriptionProvider,
    get_transcription_provider,
    normalize_segments,
)
from app.schemas.videos import GeminiTranscript
from app.services.gemini import map_api_error
from tests.fakes import FakeGenerator


def seg(start, end, text="Hello there.", speaker=""):
    return {"start_seconds": start, "end_seconds": end, "speaker": speaker, "text": text}


class TestNormalizeSegments:
    def test_relative_times_are_offset_onto_the_video_timeline(self):
        result = normalize_segments([seg(0, 5), seg(5, 12, "Next.")], clip_start=600, clip_end=1200)
        assert [(s.start, s.end) for s in result] == [(600, 605), (605, 612)]

    def test_absolute_times_from_clipped_youtube_input_are_not_double_offset(self):
        result = normalize_segments([seg(601, 606), seg(606, 615, "Next.")], clip_start=600, clip_end=1200)
        assert [s.start for s in result] == [601, 606]

    def test_segments_outside_the_window_are_dropped_not_shifted(self):
        result = normalize_segments(
            [seg(1, 4, "In window."), seg(700, 705, "Hallucinated far past the clip end.")], clip_start=0, clip_end=600
        )
        assert [s.text for s in result] == ["In window."]

    def test_sorts_fills_missing_ends_and_clamps_to_clip(self):
        raw = [seg(20, None, "Second."), seg(3, -1, "First."), seg(595, 640, "Runs past the end.")]
        result = normalize_segments(raw, clip_start=0, clip_end=600)
        assert [s.text for s in result] == ["First.", "Second.", "Runs past the end."]
        assert result[0].end == 20  # missing/invalid end -> next start
        assert result[2].end == 600  # clamped to the window

    def test_drops_invalid_values_and_empty_text(self):
        raw = [seg("abc", 4), seg(float("nan"), 4), seg(-5, 1), seg(2, 4, "   "), seg(5, 8, "Kept.")]
        assert [s.text for s in normalize_segments(raw, clip_start=0, clip_end=60)] == ["Kept."]

    def test_speakers_are_kept_and_blank_speakers_become_none(self):
        result = normalize_segments([seg(0, 4, "A", "Speaker 1"), seg(4, 8, "B", "")], clip_start=0, clip_end=60)
        assert [s.speaker for s in result] == ["Speaker 1", None]

    def test_removes_repeated_segments(self):
        result = normalize_segments([seg(0, 4, "Same."), seg(0.4, 4, "Same.")], clip_start=0, clip_end=60)
        assert len(result) == 1

    def test_unknown_clip_end(self):
        result = normalize_segments([seg(0, 4), seg(3000, 3004, "Late.")], clip_start=0, clip_end=None)
        assert len(result) == 2


def transcript(*segments, language="en"):
    return {"language": language, "segments": list(segments)}


@pytest.mark.anyio
async def test_audio_transcription_sends_inline_audio_and_offsets_times():
    fake = FakeGenerator(responses=[transcript(seg(0, 4, "Hi."), seg(4, 9, "Bye."))])
    provider = GeminiTranscriptionProvider(fake, get_settings())

    window = await provider.transcribe_audio(b"ID3fake-mp3", clip_start=600, clip_end=1200)

    assert [s.start for s in window.segments] == [600, 604]
    assert window.language == "en"
    call = fake.calls[0]
    assert call["schema"] is GeminiTranscript
    part = call["media"][0]
    assert part.inline_data.mime_type == "audio/mp3"
    assert part.inline_data.data == b"ID3fake-mp3"
    assert call["model"] == get_settings().effective_transcription_model


@pytest.mark.anyio
async def test_youtube_transcription_uses_clipped_video_input_at_low_resolution():
    fake = FakeGenerator(responses=[transcript(seg(0, 5, "Intro."))])
    provider = GeminiTranscriptionProvider(fake, get_settings())

    window = await provider.transcribe_youtube("dQw4w9WgXcQ", clip_start=600, clip_end=1200)

    part = fake.calls[0]["media"][0]
    assert part.file_data.file_uri == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert part.video_metadata.start_offset == "600s"
    assert part.video_metadata.end_offset == "1200s"
    assert fake.calls[0]["media_resolution"] == "MEDIA_RESOLUTION_LOW"
    assert fake.calls[0]["error_context"] == "youtube"
    assert window.segments[0].start == 600


@pytest.mark.anyio
async def test_silence_returns_no_segments_rather_than_inventing_text():
    fake = FakeGenerator(responses=[transcript(language="")])
    window = await GeminiTranscriptionProvider(fake, get_settings()).transcribe_audio(b"x", clip_start=0, clip_end=60)
    assert window.segments == []


@pytest.mark.anyio
async def test_invalid_output_is_retried_in_call_then_reported_as_final():
    fake = FakeGenerator(responses=["not json", "{\"segments\": \"nope\"}"])
    with pytest.raises(ServiceError) as info:
        await GeminiTranscriptionProvider(fake, get_settings()).transcribe_audio(b"x", clip_start=0, clip_end=60)
    assert info.value.code == "TRANSCRIPTION_INVALID_RESPONSE"
    assert info.value.retryable is False
    assert len(fake.calls) == 2


@pytest.mark.anyio
async def test_provider_errors_propagate():
    error = ServiceError(503, "AI_RATE_LIMITED", "busy", retryable=True)
    with pytest.raises(ServiceError) as info:
        await GeminiTranscriptionProvider(FakeGenerator(responses=[error]), get_settings()).transcribe_audio(
            b"x", clip_start=0, clip_end=60
        )
    assert info.value is error


def test_youtube_rejections_map_to_video_unsupported():
    mapped = map_api_error(genai_errors.ClientError(403, {"error": {"message": "Video is private"}}), context="youtube")
    assert mapped.code == "VIDEO_UNSUPPORTED"
    assert mapped.retryable is False


def test_invalid_api_key_is_a_configuration_error_even_for_youtube():
    error = genai_errors.ClientError(400, {"error": {"message": "API key not valid. Please pass a valid API key."}})
    assert map_api_error(error, context="youtube").code == "AI_CONFIGURATION_ERROR"
    assert map_api_error(error).code == "AI_CONFIGURATION_ERROR"


def test_provider_registry_and_model_override():
    settings = get_settings().model_copy(update={"transcription_model": "gemini-special"})
    provider = get_transcription_provider(settings, FakeGenerator())
    assert provider.name == "gemini"
    assert provider.model == "gemini-special"
    assert get_transcription_provider(get_settings(), FakeGenerator()).model == get_settings().gemini_model
