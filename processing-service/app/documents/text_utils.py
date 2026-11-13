"""Text cleaning and boundary-aware splitting shared by all extractors."""

from __future__ import annotations

import re

from app.documents.model import Block, Part

# Control characters except tab / newline; plus Unicode bidi overrides that can hide text.
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]")
_SPACES = re.compile(r"[ \t  -​]+")
_BLANK_LINES = re.compile(r"\n{3,}")
_SENTENCE_END = re.compile(r"(?<=[.!?…])[\"')\]]*\s+(?=[A-Z0-9\"'(\[])")
_WORD = re.compile(r"\w+", re.UNICODE)


def clean_block_text(text: str) -> str:
    """Removes control characters, collapses spaces, keeps line and paragraph breaks."""
    text = _CONTROL.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def count_words(text: str) -> int:
    return len(_WORD.findall(text))


def split_long_text(text: str, max_chars: int) -> list[str]:
    """Splits text at paragraph, then sentence, then word boundaries; never mid-word."""
    if len(text) <= max_chars:
        return [text]
    pieces: list[str] = []
    for paragraph in text.split("\n\n"):
        if len(paragraph) <= max_chars:
            pieces.append(paragraph)
            continue
        sentences = _SENTENCE_END.split(paragraph)
        current = ""
        for sentence in sentences:
            while len(sentence) > max_chars:  # a single enormous "sentence"
                cut = sentence.rfind(" ", 0, max_chars)
                cut = cut if cut > max_chars // 2 else max_chars
                if current:
                    pieces.append(current)
                    current = ""
                pieces.append(sentence[:cut].rstrip())
                sentence = sentence[cut:].lstrip()
            candidate = f"{current} {sentence}".strip() if current else sentence
            if len(candidate) > max_chars and current:
                pieces.append(current)
                current = sentence
            else:
                current = candidate
        if current:
            pieces.append(current)

    # Re-pack small pieces back together up to max_chars.
    packed: list[str] = []
    for piece in pieces:
        if packed and len(packed[-1]) + 2 + len(piece) <= max_chars:
            packed[-1] = f"{packed[-1]}\n\n{piece}"
        else:
            packed.append(piece)
    return packed


def make_blocks(kind: str, text: str, max_chars: int, level: int | None = None) -> list[Block]:
    cleaned = clean_block_text(text)
    if not cleaned:
        return []
    if kind == "heading":
        return [Block(kind="heading", text=cleaned[:300], level=level or 1)]
    return [Block(kind=kind, text=piece) for piece in split_long_text(cleaned, max_chars)]


def update_heading_path(path: list[str], block: Block) -> list[str]:
    level = min(block.level or 1, 6)
    return [*path[: level - 1], block.text][:6]


def group_into_parts(blocks: list[Block], part_chars: int) -> list[Part]:
    """DOCX/TXT: packs consecutive blocks into parts without splitting a block."""
    parts: list[Part] = []
    path: list[str] = []
    current: list[Block] = []
    current_chars = 0
    start_path: list[str] = []

    def flush() -> None:
        nonlocal current, current_chars
        if current:
            parts.append(Part(index=len(parts), heading_path=start_path, blocks=current, char_count=current_chars))
        current, current_chars = [], 0

    for block in blocks:
        # Start a new part at headings once the current part has some content.
        if current and (
            current_chars + len(block.text) > part_chars
            or (block.kind == "heading" and current_chars > part_chars // 3)
        ):
            flush()
        if not current:
            start_path = list(path)
        if block.kind == "heading":
            path = update_heading_path(path, block)
            if not current:
                start_path = list(path)
        current.append(block)
        current_chars += len(block.text)
    flush()
    return parts


def total_chars(parts: list[Part]) -> int:
    return sum(p.char_count for p in parts)
