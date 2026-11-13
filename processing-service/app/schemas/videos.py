"""Schemas for YouTube / uploaded-video processing."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.articles import ArticleSummary, GeminiConcept, GeminiSection, TokenUsage

Container = Literal["mp4", "mov", "webm", "mkv"]

# --------------------------------------------------------------------------
# Transcript segments
# --------------------------------------------------------------------------


class TranscriptSegment(BaseModel):
    """One timed piece of transcript. Times are seconds from the start of the video."""

    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str = Field(min_length=1, max_length=2000)
    speaker: str | None = Field(default=None, max_length=40)


class GeminiTranscriptSegment(BaseModel):
    start_seconds: float
    end_seconds: float
    speaker: str
    text: str


class GeminiTranscript(BaseModel):
    language: str
    segments: list[GeminiTranscriptSegment]


# --------------------------------------------------------------------------
# YouTube
# --------------------------------------------------------------------------


class YouTubeMetadataRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    max_duration_seconds: int | None = Field(default=None, ge=60)


class CaptionsResult(BaseModel):
    available: bool | None
    manual_languages: list[str]
    auto_languages: list[str]


class YouTubeMetadataResult(BaseModel):
    video_id: str
    watch_url: str
    title: str | None
    channel_title: str | None
    channel_url: str | None
    thumbnail_url: str | None
    duration_seconds: int | None
    published_at: str | None
    privacy_status: str | None
    metadata_source: Literal["youtube_data_api", "oembed"]
    captions: CaptionsResult


class YouTubeTranscribeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    video_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")
    start_seconds: float = Field(ge=0)
    # None = until the end of the video (used when the duration is unknown).
    end_seconds: float | None = Field(default=None, gt=0)

    @field_validator("end_seconds")
    @classmethod
    def _end_after_start(cls, value, info):
        start = info.data.get("start_seconds", 0)
        if value is not None and value <= start:
            raise ValueError("end_seconds must be greater than start_seconds")
        return value


# --------------------------------------------------------------------------
# Uploaded videos
# --------------------------------------------------------------------------


class ProbeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    download_url: str = Field(min_length=1, max_length=8192)
    container: Container
    max_duration_seconds: int | None = Field(default=None, ge=60)


class ProbeResult(BaseModel):
    duration_seconds: float
    has_audio: bool
    has_video: bool


class UploadTranscribeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    download_url: str = Field(min_length=1, max_length=8192)
    container: Container
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)

    @field_validator("end_seconds")
    @classmethod
    def _end_after_start(cls, value, info):
        if value <= info.data.get("start_seconds", 0):
            raise ValueError("end_seconds must be greater than start_seconds")
        return value


class TranscribeResult(BaseModel):
    segments: list[TranscriptSegment]
    language: str | None
    provider: str
    model: str
    clip_start: float
    clip_end: float | None
    usage: TokenUsage


# --------------------------------------------------------------------------
# Video summary
# --------------------------------------------------------------------------


class VideoSummarizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    source_kind: Literal["youtube", "video"]
    title: str | None = Field(default=None, max_length=300)
    channel: str | None = Field(default=None, max_length=200)
    duration_seconds: float | None = Field(default=None, ge=0)
    language: str | None = Field(default=None, max_length=35)
    segments: list[TranscriptSegment] = Field(min_length=1, max_length=20000)


class GeminiChapter(BaseModel):
    title: str
    start_seconds: float
    summary: str


class GeminiKeyMoment(BaseModel):
    seconds: float
    description: str


class GeminiVideoSummary(BaseModel):
    title: str
    overview: str
    sections: list[GeminiSection]
    key_takeaways: list[str]
    concepts: list[GeminiConcept]
    main_arguments: list[str]
    chapters: list[GeminiChapter]
    key_moments: list[GeminiKeyMoment]


class Chapter(BaseModel):
    title: str = Field(min_length=1, max_length=150)
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    summary: str = Field(min_length=1, max_length=1500)


class KeyMoment(BaseModel):
    seconds: float = Field(ge=0)
    description: str = Field(min_length=3, max_length=300)


class VideoSummary(ArticleSummary):
    chapters: list[Chapter] = Field(min_length=1, max_length=30)
    key_moments: list[KeyMoment] = Field(default_factory=list, max_length=15)


class VideoSummarizeResult(BaseModel):
    summary: VideoSummary
    model: str
    prompt_version: str
    input_truncated: bool
    input_characters: int
    transcript_covered_seconds: float | None
    timestamps_discarded: int
    usage: TokenUsage
