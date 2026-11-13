"""Internal video endpoints (YouTube + uploaded videos), called only by the Node.js worker.

The worker orchestrates long videos window by window:
  metadata / probe  ->  transcribe [0, n), [n, 2n), ...  ->  summarize
Each call is independent and stateless, so a failed window is retried alone.
"""

import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings, get_settings
from app.core.exceptions import ServiceError
from app.core.security import require_internal_token
from app.extractors.youtube import fetch_video_metadata
from app.media import ffmpeg
from app.processors.transcription import get_transcription_provider
from app.processors.video_summarizer import summarize_video
from app.schemas.common import SuccessResponse
from app.schemas.videos import (
    CaptionsResult,
    ProbeRequest,
    ProbeResult,
    TranscribeResult,
    UploadTranscribeRequest,
    VideoSummarizeRequest,
    VideoSummarizeResult,
    YouTubeMetadataRequest,
    YouTubeMetadataResult,
    YouTubeTranscribeRequest,
)
from app.services.gemini import LazyGeminiGenerator, StructuredGenerator

router = APIRouter(prefix="/internal", tags=["videos"], dependencies=[Depends(require_internal_token)])

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_generator(settings: SettingsDep) -> StructuredGenerator:
    return LazyGeminiGenerator(settings)


GeneratorDep = Annotated[StructuredGenerator, Depends(get_generator)]


# ------------------------------- YouTube ---------------------------------


@router.post("/youtube/metadata", response_model=SuccessResponse[YouTubeMetadataResult])
async def youtube_metadata(payload: YouTubeMetadataRequest, settings: SettingsDep):
    meta = await fetch_video_metadata(payload.video_id, settings, payload.max_duration_seconds)
    return SuccessResponse(
        data=YouTubeMetadataResult(
            video_id=meta.video_id,
            watch_url=meta.watch_url,
            title=meta.title,
            channel_title=meta.channel_title,
            channel_url=meta.channel_url,
            thumbnail_url=meta.thumbnail_url,
            duration_seconds=meta.duration_seconds,
            published_at=meta.published_at,
            privacy_status=meta.privacy_status,
            metadata_source=meta.metadata_source,
            captions=CaptionsResult(**meta.captions.__dict__),
        )
    )


@router.post("/youtube/transcribe", response_model=SuccessResponse[TranscribeResult])
async def youtube_transcribe(payload: YouTubeTranscribeRequest, settings: SettingsDep, generator: GeneratorDep):
    provider = get_transcription_provider(settings, generator)
    window = await provider.transcribe_youtube(
        payload.video_id, clip_start=payload.start_seconds, clip_end=payload.end_seconds
    )
    return SuccessResponse(
        data=TranscribeResult(
            segments=window.segments,
            language=window.language,
            provider=provider.name,
            model=provider.model,
            clip_start=payload.start_seconds,
            clip_end=payload.end_seconds,
            usage=window.usage,
        )
    )


# ---------------------------- Uploaded videos ----------------------------


@router.post("/videos/probe", response_model=SuccessResponse[ProbeResult])
async def video_probe(payload: ProbeRequest, settings: SettingsDep):
    url = ffmpeg.validate_download_url(payload.download_url, settings)
    info = await run_in_threadpool(ffmpeg.probe, url, payload.container, settings)
    if payload.max_duration_seconds and info.duration_seconds > payload.max_duration_seconds:
        raise ServiceError(
            422,
            "VIDEO_TOO_LONG",
            f"This video is longer than the {payload.max_duration_seconds // 60}-minute limit.",
            retryable=False,
        )
    if not info.has_audio:
        raise ServiceError(422, "MEDIA_NO_AUDIO", "This video has no audio track to transcribe.", retryable=False)
    return SuccessResponse(
        data=ProbeResult(duration_seconds=info.duration_seconds, has_audio=info.has_audio, has_video=info.has_video)
    )


@router.post("/videos/transcribe", response_model=SuccessResponse[TranscribeResult])
async def video_transcribe(payload: UploadTranscribeRequest, settings: SettingsDep, generator: GeneratorDep):
    url = ffmpeg.validate_download_url(payload.download_url, settings)
    provider = get_transcription_provider(settings, generator)
    duration = payload.end_seconds - payload.start_seconds

    # Temporary audio lives only for this request and is always removed.
    with tempfile.TemporaryDirectory(prefix="briefly-audio-") as workdir:
        audio_path = Path(workdir) / "window.mp3"
        await run_in_threadpool(
            ffmpeg.extract_audio, url, payload.container, payload.start_seconds, duration, audio_path, settings
        )
        audio = audio_path.read_bytes()

    window = await provider.transcribe_audio(audio, clip_start=payload.start_seconds, clip_end=payload.end_seconds)
    return SuccessResponse(
        data=TranscribeResult(
            segments=window.segments,
            language=window.language,
            provider=provider.name,
            model=provider.model,
            clip_start=payload.start_seconds,
            clip_end=payload.end_seconds,
            usage=window.usage,
        )
    )


# ------------------------------- Summary ---------------------------------


@router.post("/videos/summarize", response_model=SuccessResponse[VideoSummarizeResult])
async def video_summarize(payload: VideoSummarizeRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await summarize_video(payload, settings, generator))
