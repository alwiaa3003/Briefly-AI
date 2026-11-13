"""Schemas for document extraction, OCR and summarization."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.documents.model import Block, DocumentFormat, Part
from app.schemas.articles import TokenUsage

# --------------------------------------------------------------------------
# Requests
# --------------------------------------------------------------------------


class DocumentExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    download_url: str = Field(min_length=1, max_length=8192)
    format: DocumentFormat
    max_pages: int | None = Field(default=None, ge=1, le=10000)


class DocumentOcrRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    download_url: str = Field(min_length=1, max_length=8192)
    pages: list[int] = Field(min_length=1, max_length=20)

    @field_validator("pages")
    @classmethod
    def _positive_unique(cls, value: list[int]) -> list[int]:
        if any(p < 1 for p in value):
            raise ValueError("page numbers start at 1")
        return sorted(set(value))


class OcrPageResult(BaseModel):
    page: int
    blocks: list[Block]


class DocumentOcrResult(BaseModel):
    pages: list[OcrPageResult]
    provider: str
    model: str


# --------------------------------------------------------------------------
# References (validated against the input: never invented)
# --------------------------------------------------------------------------


class Ref(BaseModel):
    pages: list[int] = Field(default_factory=list, max_length=12)
    section: str | None = Field(default=None, max_length=300)


class RefText(Ref):
    text: str = Field(min_length=3, max_length=800)


class RefFact(Ref):
    statement: str = Field(min_length=3, max_length=800)


class RefDefinition(Ref):
    term: str = Field(min_length=1, max_length=150)
    explanation: str = Field(min_length=3, max_length=800)


class RefSection(Ref):
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=10, max_length=3000)


class ChunkNotes(BaseModel):
    sections: list[RefSection] = Field(default_factory=list, max_length=20)
    key_points: list[RefText] = Field(default_factory=list, max_length=20)
    facts: list[RefFact] = Field(default_factory=list, max_length=25)
    definitions: list[RefDefinition] = Field(default_factory=list, max_length=20)
    arguments: list[RefText] = Field(default_factory=list, max_length=12)


class DetailedSection(BaseModel):
    heading: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=20, max_length=8000)


class DocumentSummary(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    overview: str = Field(min_length=40, max_length=2500)
    sections: list[DetailedSection] = Field(min_length=1, max_length=12)
    section_breakdown: list[RefSection] = Field(min_length=1, max_length=40)
    key_takeaways: list[RefText] = Field(min_length=3, max_length=10)
    concepts: list[RefDefinition] = Field(default_factory=list, max_length=15)
    facts: list[RefFact] = Field(default_factory=list, max_length=20)
    main_arguments: list[RefText] = Field(min_length=1, max_length=10)


# Gemini response schemas (no validation constraints; strict models above validate).
class GeminiRef(BaseModel):
    pages: list[int]
    section: str


class GeminiRefText(GeminiRef):
    text: str


class GeminiRefFact(GeminiRef):
    statement: str


class GeminiRefDefinition(GeminiRef):
    term: str
    explanation: str


class GeminiRefSection(GeminiRef):
    title: str
    summary: str


class GeminiChunkNotes(BaseModel):
    sections: list[GeminiRefSection]
    key_points: list[GeminiRefText]
    facts: list[GeminiRefFact]
    definitions: list[GeminiRefDefinition]
    arguments: list[GeminiRefText]


class GeminiDetailedSection(BaseModel):
    heading: str
    content: str


class GeminiDocumentSummary(BaseModel):
    title: str
    overview: str
    sections: list[GeminiDetailedSection]
    section_breakdown: list[GeminiRefSection]
    key_takeaways: list[GeminiRefText]
    concepts: list[GeminiRefDefinition]
    facts: list[GeminiRefFact]
    main_arguments: list[GeminiRefText]


# --------------------------------------------------------------------------
# Summarize requests / results
# --------------------------------------------------------------------------


class ChunkSummarizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    format: DocumentFormat
    chunk_index: int = Field(ge=0)
    chunk_count: int = Field(ge=1)
    parts: list[Part] = Field(min_length=1, max_length=5000)


class ChunkSummarizeResult(BaseModel):
    notes: ChunkNotes
    model: str
    references_discarded: int
    usage: TokenUsage


class DocumentSummarizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    format: DocumentFormat
    page_count: int | None = Field(default=None, ge=0)
    mode: Literal["direct", "combine"]
    parts: list[Part] | None = Field(default=None, max_length=5000)
    notes: list[ChunkNotes] | None = Field(default=None, max_length=1000)
    # Pages / section headings that exist in the processed text. References must come from these.
    allowed_pages: list[int] = Field(default_factory=list, max_length=10000)
    allowed_sections: list[str] = Field(default_factory=list, max_length=20000)
    truncated: bool = False


class DocumentSummarizeResult(BaseModel):
    summary: DocumentSummary
    model: str
    prompt_version: str
    mode: Literal["direct", "combine"]
    input_characters: int
    references_discarded: int
    merge_rounds: int
    usage: TokenUsage
