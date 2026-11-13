"""Typed, validated configuration loaded from environment variables / .env."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=SERVICE_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "briefly-processing-service"
    version: str = "0.2.0"
    environment: Literal["development", "test", "production"] = "development"
    host: str = "127.0.0.1"
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # Required. The service refuses to start without a strong shared secret.
    internal_service_secret: SecretStr = Field(min_length=32)

    docs_enabled: bool = True

    # ---- Gemini -----------------------------------------------------------
    # Never logged or returned. Summarization reports AI_NOT_CONFIGURED without it.
    gemini_api_key: SecretStr | None = None
    gemini_model: str = Field(default="gemini-3.5-flash-lite", min_length=1)  # free tier; see README
    gemini_timeout_seconds: float = Field(default=90, gt=0, le=600)
    gemini_temperature: float = Field(default=0.2, ge=0, le=2)
    gemini_max_output_tokens: int = Field(default=16384, ge=512, le=65536)
    # Deterministic offline responses for automated and end-to-end tests (app/services/mock_ai.py).
    # No Gemini client is created and no request reaches Google. Refused in production.
    ai_mock_mode: bool = False

    # ---- Article fetching & extraction -----------------------------------
    article_fetch_timeout_seconds: float = Field(default=15, gt=0, le=120)
    article_max_bytes: int = Field(default=5 * 1024 * 1024, ge=64 * 1024, le=50 * 1024 * 1024)
    article_max_redirects: int = Field(default=5, ge=0, le=10)
    article_min_words: int = Field(default=120, ge=1)
    # Characters of article text sent to Gemini (longer articles are truncated at a paragraph break).
    article_max_summary_chars: int = Field(default=60000, ge=2000, le=500000)
    # Characters of article text returned for storage.
    article_max_stored_chars: int = Field(default=300000, ge=10000)
    article_user_agent: str = "BrieflyAI/0.2 (+article summarizer)"

    # ---- YouTube ------------------------------------------------------------
    # Optional. With a key, metadata comes from the official YouTube Data API v3
    # (duration, publish date, caption tracks, age restriction). Without one, the
    # public oEmbed endpoint provides title/channel/thumbnail only.
    youtube_api_key: SecretStr | None = None

    # ---- Transcription --------------------------------------------------------
    # Provider registry key (see app/processors/transcription.py). Only "gemini" ships today.
    transcription_provider: Literal["gemini"] = "gemini"
    # Defaults to GEMINI_MODEL when empty.
    transcription_model: str | None = None
    transcription_max_output_tokens: int = Field(default=32768, ge=1024, le=65536)
    # Transcript characters sent to the video summarizer.
    video_max_summary_chars: int = Field(default=250000, ge=5000, le=2_000_000)

    # ---- Media (uploaded videos) ----------------------------------------------
    # Path to an ffmpeg binary. When empty, the binary bundled with imageio-ffmpeg is used.
    ffmpeg_path: str | None = None
    ffmpeg_timeout_seconds: float = Field(default=300, gt=0, le=3600)
    # Comma-separated hostnames that signed storage download URLs may point to
    # (e.g. "<account>.r2.cloudflarestorage.com"). When empty, any public host that passes the SSRF
    # checks is accepted in development; in production an empty list refuses all downloads.
    storage_download_hosts: str = ""

    # ---- Documents (PDF / DOCX / TXT) ------------------------------------------
    document_max_bytes: int = Field(default=50 * 1024 * 1024, ge=1024, le=1024 * 1024 * 1024)
    document_max_pages: int = Field(default=1000, ge=1, le=10000)
    # Extracted characters kept per document (~500k tokens); the rest is reported as truncated.
    document_max_chars: int = Field(default=2_000_000, ge=10_000, le=20_000_000)
    # DOCX/TXT have no fixed pages; their text is grouped into parts of about this size.
    document_part_chars: int = Field(default=4000, ge=500, le=50_000)
    # Longer paragraphs are split at sentence boundaries.
    document_max_block_chars: int = Field(default=4000, ge=500, le=50_000)
    # Zip-bomb guard for DOCX (total uncompressed size of all parts).
    docx_max_uncompressed_bytes: int = Field(default=200 * 1024 * 1024, ge=1024 * 1024)
    # When the combined chunk notes exceed this, they are merged hierarchically first.
    document_combine_max_chars: int = Field(default=150_000, ge=5000, le=2_000_000)

    # ---- Embeddings / RAG / study tools ------------------------------------------
    # Provider registry key (see app/services/embeddings.py). Only "gemini" ships today.
    embedding_provider: Literal["gemini"] = "gemini"
    embedding_model: str = Field(default="gemini-embedding-001", min_length=1)
    # Must match EMBEDDING_DIMENSIONS in backend/.env and the Atlas vector index definition.
    embedding_dimensions: int = Field(default=768, ge=64, le=3072)
    embedding_batch_size: int = Field(default=100, ge=1, le=250)
    # Upper bound on retrieved context sent with one question.
    rag_max_context_chars: int = Field(default=16000, ge=2000, le=200_000)
    # Upper bound on source material sent to a study-tool generation.
    study_max_input_chars: int = Field(default=80000, ge=5000, le=1_000_000)

    # ---- OCR -------------------------------------------------------------------
    # Provider registry key (see app/documents/ocr.py). Only "gemini" ships today.
    ocr_provider: Literal["gemini"] = "gemini"
    ocr_model: str | None = None  # defaults to GEMINI_MODEL
    ocr_dpi: int = Field(default=150, ge=72, le=300)
    ocr_max_pages_per_request: int = Field(default=5, ge=1, le=20)

    @property
    def gemini_configured(self) -> bool:
        return self.gemini_api_key is not None and bool(self.gemini_api_key.get_secret_value().strip())

    @property
    def youtube_api_configured(self) -> bool:
        return self.youtube_api_key is not None and bool(self.youtube_api_key.get_secret_value().strip())

    @property
    def effective_transcription_model(self) -> str:
        return (self.transcription_model or "").strip() or self.gemini_model

    @property
    def effective_ocr_model(self) -> str:
        return (self.ocr_model or "").strip() or self.gemini_model

    @property
    def storage_download_host_list(self) -> list[str]:
        return [h.strip().lower() for h in self.storage_download_hosts.split(",") if h.strip()]

    @field_validator("internal_service_secret")
    @classmethod
    def reject_placeholder(cls, value: SecretStr) -> SecretStr:
        if value.get_secret_value().lower().startswith("change-me"):
            raise ValueError("INTERNAL_SERVICE_SECRET still contains the .env.example placeholder")
        return value

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, value: object) -> object:
        return value.upper() if isinstance(value, str) else value

    @model_validator(mode="after")
    def reject_mock_in_production(self) -> "Settings":
        if self.ai_mock_mode and self.environment == "production":
            raise ValueError("AI_MOCK_MODE cannot be enabled when ENVIRONMENT=production")
        return self

    @property
    def show_docs(self) -> bool:
        return self.docs_enabled and self.environment != "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
