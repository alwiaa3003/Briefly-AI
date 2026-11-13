"""DOCX extraction with python-docx.

Safety before parsing:
- The file must be a ZIP with [Content_Types].xml and word/document.xml.
- Macro-enabled documents (.docm content types, vbaProject parts) are rejected;
  macros are never executed in any case.
- Zip-bomb guard: total uncompressed size, entry count and compression ratio are checked.
- python-docx parses XML with entity resolution disabled (no XXE).

Body order is preserved (paragraphs and tables interleaved). Headings come
from heading/title styles, list items from list styles or numbering
properties, and tables are rendered as pipe-separated rows.
"""

from __future__ import annotations

import zipfile
from datetime import datetime
from pathlib import Path

import docx
from docx.table import Table
from docx.text.paragraph import Paragraph

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.documents.model import Block, DocumentMetadata, ExtractionResult
from app.documents.text_utils import count_words, group_into_parts, make_blocks, total_chars

MAX_ENTRIES = 10_000
MAX_RATIO = 200


def _error(code: str, message: str) -> ServiceError:
    return ServiceError(422, code, message, retryable=False)


def _check_package(path: Path, settings: Settings) -> None:
    if not zipfile.is_zipfile(path):
        raise _error("DOCUMENT_INVALID", "The file is not a valid Word (.docx) document.")
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            names = {e.filename for e in entries}
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                raise _error("DOCUMENT_INVALID", "The file is not a valid Word (.docx) document.")
            if len(entries) > MAX_ENTRIES:
                raise _error("DOCUMENT_INVALID", "The Word document has an unexpected structure.")
            total = sum(e.file_size for e in entries)
            if total > settings.docx_max_uncompressed_bytes:
                raise _error("DOCUMENT_TOO_LARGE", "The Word document expands to more data than allowed.")
            for entry in entries:
                if (
                    entry.compress_size
                    and entry.file_size / entry.compress_size > MAX_RATIO
                    and entry.file_size > 10_000_000
                ):
                    raise _error("DOCUMENT_INVALID", "The Word document has an unexpected structure.")
            content_types = archive.read("[Content_Types].xml").decode("utf-8", errors="replace")
            if "macroEnabled" in content_types or any(n.lower().endswith("vbaproject.bin") for n in names):
                raise _error(
                    "DOCUMENT_MACROS",
                    "Macro-enabled Word documents are not supported. Save it as a regular .docx and upload it again.",
                )
            if "wordprocessingml.template" in content_types:
                raise _error("DOCUMENT_UNSUPPORTED", "Word templates are not supported. Save it as a regular .docx.")
    except zipfile.BadZipFile as exc:
        raise _error("DOCUMENT_INVALID", "The Word document is damaged.") from exc


def _heading_level(style_name: str) -> int | None:
    name = style_name.lower()
    if name == "title":
        return 1
    if name.startswith("heading"):
        digits = "".join(ch for ch in name if ch.isdigit())
        return min(int(digits), 6) if digits else 1
    return None


def _is_list(paragraph: Paragraph, style_name: str) -> bool:
    if "list" in style_name.lower():
        return True
    p_pr = paragraph._p.pPr  # noqa: SLF001 - python-docx exposes numbering only via the XML element
    return p_pr is not None and p_pr.numPr is not None


def _table_text(table: Table) -> str:
    rows = []
    for row in table.rows:
        cells: list[str] = []
        for cell in row.cells:
            text = " ".join(cell.text.split())
            if not cells or cells[-1] != text:  # merged cells repeat their text
                cells.append(text)
        if any(cells):
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def _iso(value: object) -> str | None:
    return value.date().isoformat() if isinstance(value, datetime) else None


def extract_docx(path: Path, settings: Settings) -> ExtractionResult:
    _check_package(path, settings)
    try:
        document = docx.Document(str(path))
    except Exception as exc:  # noqa: BLE001 - malformed packages raise KeyError, ValueError, lxml errors...
        raise _error("DOCUMENT_INVALID", "The Word document is damaged or could not be read.") from exc

    max_block = settings.document_max_block_chars
    blocks: list[Block] = []
    list_buffer: list[str] = []

    def flush_list() -> None:
        if list_buffer:
            blocks.extend(make_blocks("list", "\n".join(f"- {item}" for item in list_buffer), max_block))
            list_buffer.clear()

    chars = 0
    truncated = False
    for item in document.iter_inner_content():
        if chars > settings.document_max_chars:
            truncated = True
            break
        if isinstance(item, Paragraph):
            text = item.text.strip()
            if not text:
                continue
            style = item.style.name if item.style is not None and item.style.name else ""
            level = _heading_level(style)
            if level:
                flush_list()
                blocks.extend(make_blocks("heading", text, max_block, level))
            elif _is_list(item, style):
                list_buffer.append(" ".join(text.split()))
            else:
                flush_list()
                blocks.extend(make_blocks("paragraph", text, max_block))
            chars += len(text)
        elif isinstance(item, Table):
            flush_list()
            text = _table_text(item)
            if text:
                blocks.extend(make_blocks("table", text, max_block))
                chars += len(text)
    flush_list()

    if not blocks:
        raise _error("DOCUMENT_NO_TEXT", "The Word document contains no text.")

    props = document.core_properties
    metadata = DocumentMetadata(
        title=(props.title or "").strip()[:300] or None,
        author=(props.author or "").strip()[:300] or None,
        subject=(props.subject or "").strip()[:300] or None,
        keywords=(props.keywords or "").strip()[:300] or None,
        created=_iso(props.created),
        modified=_iso(props.modified),
    )
    parts = group_into_parts(blocks, settings.document_part_chars)
    return ExtractionResult(
        format="docx",
        metadata=metadata,
        page_count=None,
        pages_processed=None,
        char_count=total_chars(parts),
        word_count=sum(count_words(b.text) for b in blocks),
        parts=parts,
        ocr_pages=[],
        truncated=truncated,
        warnings=["The document was too long; only its first part was processed."] if truncated else [],
    )
