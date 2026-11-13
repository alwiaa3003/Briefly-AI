"""Schemas for article extraction and summarization."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, field_validator

# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------


class ExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    url: str = Field(min_length=1, max_length=2048)


class ExtractResult(BaseModel):
    requested_url: str
    final_url: str
    canonical_url: str
    title: str | None
    author: str | None
    published_at: str | None
    site_name: str | None
    description: str | None
    language: str | None
    content: str
    word_count: int
    content_truncated: bool


# --------------------------------------------------------------------------
# Summarization
# --------------------------------------------------------------------------


class SummarizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    url: str = Field(min_length=1, max_length=2048)
    title: str | None = Field(default=None, max_length=300)
    author: str | None = Field(default=None, max_length=300)
    published_at: str | None = Field(default=None, max_length=40)
    site_name: str | None = Field(default=None, max_length=200)
    content: str = Field(min_length=1, max_length=600_000)


# Schema sent to Gemini for structured output. Kept free of validation
# constraints so it converts cleanly to the API's schema format; the strict
# rules live in ArticleSummary below.
class GeminiSection(BaseModel):
    heading: str
    content: str


class GeminiConcept(BaseModel):
    term: str
    explanation: str


class GeminiArticleSummary(BaseModel):
    title: str
    overview: str
    sections: list[GeminiSection]
    key_takeaways: list[str]
    concepts: list[GeminiConcept]
    main_arguments: list[str]


def _clean(value: str) -> str:
    """Collapses whitespace inside paragraphs while keeping blank-line paragraph breaks."""
    paragraphs = [" ".join(part.split()) for part in value.replace("\r", "").split("\n\n")]
    return "\n\n".join(p for p in paragraphs if p)


def _clean_if_str(value: object) -> object:
    return _clean(value) if isinstance(value, str) else value


class SummarySection(BaseModel):
    heading: str = Field(min_length=1, max_length=150)
    content: str = Field(min_length=20, max_length=6000)

    @field_validator("heading", "content", mode="before")
    @classmethod
    def _normalize(cls, value: object) -> object:
        return _clean_if_str(value)


class SummaryConcept(BaseModel):
    term: str = Field(min_length=1, max_length=120)
    explanation: str = Field(min_length=5, max_length=600)

    @field_validator("term", "explanation", mode="before")
    @classmethod
    def _normalize(cls, value: object) -> object:
        return _clean_if_str(value)


class ArticleSummary(BaseModel):
    """Validated summary. Gemini output that fails these rules is rejected."""

    title: str = Field(min_length=1, max_length=300)
    overview: str = Field(min_length=40, max_length=1500)
    sections: list[SummarySection] = Field(min_length=1, max_length=10)
    key_takeaways: list[str] = Field(min_length=3, max_length=8)
    concepts: list[SummaryConcept] = Field(default_factory=list, max_length=12)
    main_arguments: list[str] = Field(min_length=1, max_length=8)

    @field_validator("title", "overview", mode="before")
    @classmethod
    def _normalize_text(cls, value: object) -> object:
        return _clean_if_str(value)

    @field_validator("key_takeaways", "main_arguments", mode="before")
    @classmethod
    def _normalize_points(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        seen: set[str] = set()
        points: list[str] = []
        for item in value:
            if not isinstance(item, str):
                return value  # let type validation report it
            text = _clean(item)
            key = text.lower()
            if text and key not in seen:
                seen.add(key)
                points.append(text)
        return points[:8]

    @field_validator("key_takeaways", "main_arguments")
    @classmethod
    def _bounded_points(cls, value: list[str]) -> list[str]:
        for item in value:
            if not 5 <= len(item) <= 600:
                raise ValueError("each point must be between 5 and 600 characters")
        return value


class TokenUsage(BaseModel):
    input_tokens: int | None = None
    output_tokens: int | None = None


class SummarizeResult(BaseModel):
    summary: ArticleSummary
    model: str
    prompt_version: str
    input_truncated: bool
    input_characters: int
    usage: TokenUsage
