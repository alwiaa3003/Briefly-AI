"""Plain-text extraction with encoding detection.

Encoding: BOM (UTF-8, UTF-16 LE/BE, UTF-32 LE/BE) -> strict UTF-8 ->
charset-normalizer's best guess. Files that decode to mostly control
characters (i.e. binaries renamed to .txt) are rejected.

Structure: blank lines separate paragraphs (line breaks inside a paragraph
are kept). Markdown "#" headings, setext underlines and bullet/numbered lists
are recognised.
"""

from __future__ import annotations

import codecs
import re
from pathlib import Path

from charset_normalizer import from_bytes

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.documents.model import Block, DocumentMetadata, ExtractionResult
from app.documents.text_utils import count_words, group_into_parts, make_blocks, total_chars

_BOMS = [
    (codecs.BOM_UTF32_LE, "utf-32-le"),
    (codecs.BOM_UTF32_BE, "utf-32-be"),
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF16_LE, "utf-16-le"),
    (codecs.BOM_UTF16_BE, "utf-16-be"),
]
_ATX_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$")
_SETEXT = re.compile(r"^(=+|-+)\s*$")
_LIST_LINE = re.compile(r"^\s*([-*+•]|\d{1,3}[.)])\s+\S")
_CONTROL = re.compile(r"[\x00-\x08\x0e-\x1f\x7f]")


def _error(code: str, message: str) -> ServiceError:
    return ServiceError(422, code, message, retryable=False)


def decode_text(data: bytes) -> tuple[str, str]:
    for bom, encoding in _BOMS:
        if data.startswith(bom):
            return data[len(bom) :].decode(encoding.replace("-sig", ""), errors="replace"), encoding.replace("-sig", "")
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass
    if b"\x00" in data[:4096]:
        raise _error("DOCUMENT_INVALID", "This file is not a plain-text document.")
    best = from_bytes(data[:2_000_000]).best()
    if best is None:
        raise _error("DOCUMENT_INVALID", "The text encoding of this file could not be detected.")
    return data.decode(best.encoding, errors="replace"), best.encoding


def _parse_blocks(text: str, max_block: int) -> list[Block]:
    blocks: list[Block] = []
    for paragraph in re.split(r"\n\s*\n", text):
        lines = [line.rstrip() for line in paragraph.split("\n") if line.strip()]
        if not lines:
            continue
        atx = _ATX_HEADING.match(lines[0].strip())
        if atx and len(lines) == 1:
            blocks.extend(make_blocks("heading", atx.group(2), max_block, len(atx.group(1))))
            continue
        if len(lines) == 2 and _SETEXT.match(lines[1].strip()) and len(lines[0]) <= 200:
            blocks.extend(make_blocks("heading", lines[0], max_block, 1 if lines[1].strip()[0] == "=" else 2))
            continue
        if atx:  # heading followed by text in the same paragraph
            blocks.extend(make_blocks("heading", atx.group(2), max_block, len(atx.group(1))))
            lines = lines[1:]
        if sum(bool(_LIST_LINE.match(line)) for line in lines) >= max(1, (len(lines) + 1) // 2):
            blocks.extend(make_blocks("list", "\n".join(lines), max_block))
        else:
            blocks.extend(make_blocks("paragraph", "\n".join(lines), max_block))
    return blocks


def extract_txt(path: Path, settings: Settings) -> ExtractionResult:
    data = path.read_bytes()
    if not data.strip():
        raise _error("DOCUMENT_EMPTY", "The text file is empty.")
    text, encoding = decode_text(data)
    if "\x00" in text or len(_CONTROL.findall(text[:100_000])) > max(10, len(text[:100_000]) * 0.01):
        raise _error("DOCUMENT_INVALID", "This file is not a plain-text document.")

    truncated = len(text) > settings.document_max_chars
    text = text[: settings.document_max_chars]
    blocks = _parse_blocks(text.replace("\r\n", "\n").replace("\r", "\n"), settings.document_max_block_chars)
    if not blocks:
        raise _error("DOCUMENT_EMPTY", "The text file is empty.")

    parts = group_into_parts(blocks, settings.document_part_chars)
    first_heading = next((b.text for b in blocks if b.kind == "heading"), None)
    return ExtractionResult(
        format="txt",
        metadata=DocumentMetadata(title=first_heading, encoding=encoding),
        page_count=None,
        pages_processed=None,
        char_count=total_chars(parts),
        word_count=sum(count_words(b.text) for b in blocks),
        parts=parts,
        ocr_pages=[],
        truncated=truncated,
        warnings=["The file was too long; only its first part was processed."] if truncated else [],
    )
