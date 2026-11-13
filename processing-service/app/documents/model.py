"""Structured representation of an extracted document.

A document is a list of *parts*. For PDFs a part is one page (so page numbers
are exact). DOCX and TXT have no fixed pages, so their blocks are grouped into
parts of roughly DOCUMENT_PART_CHARS characters at block boundaries, with
``page = None``. References then point to sections (headings) instead of pages.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

BlockKind = Literal["heading", "paragraph", "list", "table"]
DocumentFormat = Literal["pdf", "docx", "txt"]


class Block(BaseModel):
    kind: BlockKind
    text: str = Field(min_length=1, max_length=60_000)
    level: int | None = Field(default=None, ge=1, le=6)  # headings only


class Part(BaseModel):
    index: int = Field(ge=0)
    page: int | None = Field(default=None, ge=1)
    heading_path: list[str] = Field(default_factory=list, max_length=6)
    blocks: list[Block] = Field(default_factory=list)
    needs_ocr: bool = False
    char_count: int = 0


class DocumentMetadata(BaseModel):
    title: str | None = None
    author: str | None = None
    subject: str | None = None
    keywords: str | None = None
    created: str | None = None
    modified: str | None = None
    encoding: str | None = None  # TXT only


class ExtractionResult(BaseModel):
    format: DocumentFormat
    metadata: DocumentMetadata
    page_count: int | None
    pages_processed: int | None
    char_count: int
    word_count: int
    parts: list[Part]
    ocr_pages: list[int]
    truncated: bool
    warnings: list[str] = Field(default_factory=list)
