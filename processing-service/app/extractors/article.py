"""Main-content and metadata extraction for article pages (trafilatura).

trafilatura parses the HTML with lxml and never executes scripts. It removes
navigation, ads, comments and other boilerplate, and keeps paragraphs,
headings, lists and tables. Extraction runs in precision mode first, then
falls back to recall mode for sites with unusual layouts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import trafilatura
from trafilatura.utils import load_html

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.extractors.url_safety import InvalidUrlError, UnsafeUrlError, check_url

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_EXCESS_BLANK_LINES = re.compile(r"\n{3,}")
_WORD = re.compile(r"\w+", re.UNICODE)

EXTRACT_OPTIONS = dict(
    output_format="markdown",
    include_formatting=True,
    include_comments=False,
    include_links=False,
    include_images=False,
    include_tables=True,
    deduplicate=True,
)


@dataclass(frozen=True)
class ExtractedArticle:
    title: str | None
    author: str | None
    published_at: str | None
    site_name: str | None
    description: str | None
    language: str | None
    canonical_url: str | None
    content: str
    word_count: int
    content_truncated: bool


def clean_text(value: str | None, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    cleaned = _CONTROL_CHARS.sub("", value).replace("\r\n", "\n").replace("\r", "\n").strip()
    cleaned = _EXCESS_BLANK_LINES.sub("\n\n", cleaned)
    if max_length is not None:
        cleaned = cleaned[:max_length].strip()
    return cleaned or None


def count_words(text: str) -> int:
    return len(_WORD.findall(text))


def _safe_canonical(candidate: str | None, fallback: str) -> str:
    """Only keep a canonical URL that is itself a safe http(s) URL."""
    if candidate:
        try:
            return check_url(candidate).url
        except (InvalidUrlError, UnsafeUrlError):
            pass
    return fallback


def _detect_language(body: bytes) -> str | None:
    root = load_html(body)
    if root is None:
        return None
    lang = root.get("lang") or root.get("{http://www.w3.org/XML/1998/namespace}lang")
    if lang and re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*", lang.strip()):
        return lang.strip().lower()
    return None


def _truncate_at_paragraph(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    cut = text.rfind("\n\n", 0, max_chars)
    if cut < max_chars * 0.5:
        cut = max_chars
    return text[:cut].rstrip(), True


def extract_article(body: bytes, final_url: str, settings: Settings) -> ExtractedArticle:
    if not body or not body.strip():
        raise ServiceError(422, "ARTICLE_EMPTY", "The page is empty.", retryable=False)

    content = trafilatura.extract(body, url=final_url, favor_precision=True, **EXTRACT_OPTIONS)
    content = clean_text(content)
    if not content or count_words(content) < settings.article_min_words:
        recall = clean_text(trafilatura.extract(body, url=final_url, favor_recall=True, **EXTRACT_OPTIONS))
        if recall and (not content or count_words(recall) > count_words(content)):
            content = recall

    if not content or count_words(content) < settings.article_min_words:
        raise ServiceError(
            422,
            "ARTICLE_CONTENT_UNAVAILABLE",
            "We couldn't find enough readable article text on this page. "
            "It may be behind a paywall, require JavaScript, or not be an article.",
            retryable=False,
        )

    content, truncated = _truncate_at_paragraph(content, settings.article_max_stored_chars)

    tree = load_html(body)
    metadata = trafilatura.extract_metadata(tree, default_url=final_url) if tree is not None else None

    return ExtractedArticle(
        title=clean_text(metadata.title, 300) if metadata else None,
        author=clean_text(metadata.author, 300) if metadata else None,
        published_at=clean_text(metadata.date, 40) if metadata else None,
        site_name=clean_text(metadata.sitename, 200) if metadata else None,
        description=clean_text(metadata.description, 1000) if metadata else None,
        language=_detect_language(body),
        canonical_url=_safe_canonical(metadata.url if metadata else None, final_url),
        content=content,
        word_count=count_words(content),
        content_truncated=truncated,
    )


def truncate_for_summary(content: str, max_chars: int) -> tuple[str, bool]:
    return _truncate_at_paragraph(content, max_chars)
