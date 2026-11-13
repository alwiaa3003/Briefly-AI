"""PDF extraction.

- pypdfium2 opens the file first: page count, metadata, and encryption /
  corruption detection.
- pdfminer.six performs layout analysis page by page (``caching=False``,
  iterator API), so memory stays bounded for large files. ``boxes_flow``
  orders text boxes in reading order, which handles most multi-column layouts.
- Headings are detected from relative font size (and short bold lines).
  Running headers/footers repeated on many pages and bare page numbers are
  removed.
- Pages with (almost) no text but with images are flagged ``needs_ocr``; their
  text is produced later by the OCR step (app/documents/ocr.py).
- Nothing in the PDF is executed: no JavaScript, forms or embedded files are evaluated.
"""

from __future__ import annotations

import logging
import re
import statistics
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import pypdfium2 as pdfium
from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTChar, LTFigure, LTImage, LTTextContainer

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.documents.model import Block, DocumentMetadata, ExtractionResult, Part
from app.documents.text_utils import clean_block_text, count_words, make_blocks, update_heading_path

logger = logging.getLogger("app.documents.pdf")

OCR_TEXT_THRESHOLD = 25  # characters of real text below which an image page is treated as scanned
_PAGE_NUMBER = re.compile(r"^(page\s*)?\d{1,4}(\s*(/|of)\s*\d{1,4})?$", re.IGNORECASE)
_BULLET = re.compile(r"^\s*([•●▪◦‣\-–*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+")
LAYOUT = LAParams(line_margin=0.5, char_margin=2.0, word_margin=0.1, boxes_flow=0.5)


def _error(code: str, message: str) -> ServiceError:
    return ServiceError(422, code, message, retryable=False)


@dataclass
class _Box:
    text: str
    size: float
    bold: bool
    chars: int


@dataclass
class _RawPage:
    number: int
    boxes: list[_Box] = field(default_factory=list)
    has_image: bool = False


def _clean_meta(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = clean_block_text(value)[:300]
    return cleaned or None


def _pdf_date(value: object) -> str | None:
    match = re.match(r"D:(\d{4})(\d{2})?(\d{2})?", value) if isinstance(value, str) else None
    if not match:
        return None
    year, month, day = match.group(1), match.group(2) or "01", match.group(3) or "01"
    return f"{year}-{month}-{day}"


def inspect_pdf(path: Path) -> tuple[int, DocumentMetadata]:
    if b"%PDF-" not in path.open("rb").read(1024):
        raise _error("DOCUMENT_INVALID", "The file is not a valid PDF.")
    try:
        document = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError as exc:
        message = str(exc).lower()
        if "password" in message:
            raise _error(
                "DOCUMENT_ENCRYPTED", "This PDF is password-protected. Remove the password and upload it again."
            ) from exc
        raise _error("DOCUMENT_INVALID", "The PDF is damaged or not a valid PDF file.") from exc
    try:
        page_count = len(document)
        raw = document.get_metadata_dict(skip_empty=True)
    finally:
        document.close()
    metadata = DocumentMetadata(
        title=_clean_meta(raw.get("Title")),
        author=_clean_meta(raw.get("Author")),
        subject=_clean_meta(raw.get("Subject")),
        keywords=_clean_meta(raw.get("Keywords")),
        created=_pdf_date(raw.get("CreationDate")),
        modified=_pdf_date(raw.get("ModDate")),
    )
    return page_count, metadata


def _line_style(line) -> tuple[float, bool, int]:
    sizes = []
    bold = 0
    for char in getattr(line, "_objs", []):
        if isinstance(char, LTChar) and char.get_text().strip():
            sizes.append(char.size)
            if "bold" in (char.fontname or "").lower():
                bold += 1
    size = statistics.median(sizes) if sizes else 0.0
    return size, bool(sizes) and bold >= len(sizes) * 0.6, len(sizes)


def _walk(element, page: _RawPage) -> None:
    if isinstance(element, LTTextContainer):
        # A text box often merges a heading with the paragraph below it. Split the box
        # into runs of consistently styled lines (same size, same boldness).
        run: list[str] = []
        run_style: tuple[float, bool] | None = None
        run_chars = 0

        def flush() -> None:
            if run and "".join(run).strip() and run_style is not None:
                page.boxes.append(_Box(text="".join(run), size=run_style[0], bold=run_style[1], chars=run_chars))

        for line in element:
            text = line.get_text() if hasattr(line, "get_text") else ""
            if not text.strip():
                continue
            size, bold, chars = _line_style(line)
            if run_style is not None and (abs(size - run_style[0]) > 0.5 or bold != run_style[1]):
                flush()
                run, run_chars = [], 0
            if not run:
                run_style = (size, bold)
            run.append(text)
            run_chars += chars
        flush()
        return
    if isinstance(element, LTImage):
        page.has_image = True
        return
    if isinstance(element, LTFigure):
        page.has_image = True
    for child in getattr(element, "_objs", []) or []:
        _walk(child, page)


def _read_layout(path: Path, max_pages: int) -> list[_RawPage]:
    pages: list[_RawPage] = []
    try:
        for number, layout in enumerate(
            extract_pages(str(path), laparams=LAYOUT, maxpages=max_pages, caching=False), start=1
        ):
            page = _RawPage(number=number)
            for element in layout:
                _walk(element, page)
            pages.append(page)
    except Exception as exc:  # noqa: BLE001 - pdfminer raises many unrelated exception types
        name = type(exc).__name__
        if "Password" in name or "Encryption" in name:
            raise _error(
                "DOCUMENT_ENCRYPTED", "This PDF is password-protected. Remove the password and upload it again."
            ) from exc
        if pages:
            logger.warning("PDF layout analysis stopped at page %s (%s)", len(pages) + 1, name)
            return pages
        raise _error("DOCUMENT_INVALID", "The PDF is damaged or could not be read.") from exc
    return pages


def _repeated_lines(pages: list[_RawPage]) -> set[str]:
    """Short boxes that repeat on many pages (running headers/footers)."""
    if len(pages) < 3:
        return set()
    counts: Counter[str] = Counter()
    for page in pages:
        seen = {clean_block_text(b.text).lower() for b in page.boxes if len(b.text.strip()) <= 120}
        counts.update(seen)
    threshold = max(3, int(len(pages) * 0.5))
    return {text for text, count in counts.items() if text and count >= threshold}


def _heading_levels(pages: list[_RawPage], body: float) -> dict[float, int]:
    sizes = sorted(
        {round(b.size, 1) for p in pages for b in p.boxes if b.size >= body * 1.18 and len(b.text.strip()) <= 200},
        reverse=True,
    )
    return {size: min(index + 1, 3) for index, size in enumerate(sizes[:3])} | {size: 3 for size in sizes[3:]}


def _classify(box: _Box, body: float, levels: dict[float, int], max_block: int) -> list[Block]:
    text = clean_block_text(box.text)
    if not text:
        return []
    single_line = "\n" not in text
    is_short = len(text) <= 200 and text.count("\n") <= 2
    looks_like_sentence = text.endswith((".", ",", ";", ":")) and len(text) > 60
    if is_short and not looks_like_sentence and box.size >= body * 1.18:
        return make_blocks("heading", " ".join(text.split()), max_block, levels.get(round(box.size, 1), 3))
    if single_line and box.bold and len(text) <= 100 and not text.endswith("."):
        return make_blocks("heading", text, max_block, 3)
    lines = [line for line in text.split("\n") if line.strip()]
    if lines and sum(bool(_BULLET.match(line)) for line in lines) >= max(1, len(lines) // 2):
        return make_blocks("list", text, max_block)
    # Join soft-wrapped lines inside a paragraph; keep paragraph breaks.
    paragraph = "\n\n".join(" ".join(chunk.split()) for chunk in text.split("\n\n"))
    return make_blocks("paragraph", paragraph, max_block)


def extract_pdf(path: Path, settings: Settings, max_pages: int | None = None) -> ExtractionResult:
    page_count, metadata = inspect_pdf(path)
    if page_count == 0:
        raise _error("DOCUMENT_EMPTY", "The PDF has no pages.")
    limit = min(page_count, max_pages or settings.document_max_pages, settings.document_max_pages)
    raw_pages = _read_layout(path, limit)

    all_sizes = [b.size for p in raw_pages for b in p.boxes for _ in range(max(1, min(b.chars, 2000))) if b.size]
    body = statistics.median(all_sizes) if all_sizes else 10.0
    levels = _heading_levels(raw_pages, body)
    repeated = _repeated_lines(raw_pages)

    parts: list[Part] = []
    ocr_pages: list[int] = []
    path_stack: list[str] = []
    chars = 0
    truncated = limit < page_count
    for raw in raw_pages:
        blocks: list[Block] = []
        for box in raw.boxes:
            normalized = clean_block_text(box.text)
            if not normalized or normalized.lower() in repeated or _PAGE_NUMBER.match(normalized):
                continue
            blocks.extend(_classify(box, body, levels, settings.document_max_block_chars))

        page_chars = sum(len(b.text) for b in blocks)
        needs_ocr = page_chars < OCR_TEXT_THRESHOLD and raw.has_image
        if needs_ocr:
            blocks = []
            page_chars = 0
            ocr_pages.append(raw.number)
        if chars + page_chars > settings.document_max_chars:
            truncated = True
            break
        chars += page_chars

        start_path = list(path_stack)
        for block in blocks:
            if block.kind == "heading":
                path_stack = update_heading_path(path_stack, block)
        parts.append(
            Part(
                index=len(parts),
                page=raw.number,
                heading_path=start_path,
                blocks=blocks,
                needs_ocr=needs_ocr,
                char_count=page_chars,
            )
        )

    if chars == 0 and not ocr_pages:
        raise _error("DOCUMENT_NO_TEXT", "No readable text was found in this PDF.")

    words = sum(count_words(b.text) for p in parts for b in p.blocks)
    warnings = []
    if truncated:
        warnings.append(f"Only the first {len(parts)} of {page_count} pages were processed.")
    return ExtractionResult(
        format="pdf",
        metadata=metadata,
        page_count=page_count,
        pages_processed=len(parts),
        char_count=chars,
        word_count=words,
        parts=parts,
        ocr_pages=ocr_pages,
        truncated=truncated,
        warnings=warnings,
    )
