from pathlib import Path

import pytest

from app.core.config import get_settings
from app.core.exceptions import ServiceError
from app.extractors.article import extract_article, truncate_for_summary

FIXTURE = (Path(__file__).parent / "fixtures" / "article.html").read_bytes()
URL = "https://gazette.example.com/science/urban-trees-cool-cities?utm_source=x"


@pytest.fixture()
def settings():
    return get_settings().model_copy(update={"article_min_words": 120})


def test_extracts_metadata(settings):
    article = extract_article(FIXTURE, URL, settings)

    assert article.title == "How Urban Trees Cool Cities"
    assert article.author == "Priya Raman"
    assert article.published_at == "2025-06-14"
    assert article.site_name == "The Example Gazette"
    assert article.description.startswith("Street trees lower summer temperatures")
    assert article.canonical_url == "https://gazette.example.com/science/urban-trees-cool-cities"
    assert article.language == "en-gb"


def test_extracts_main_content_and_keeps_structure(settings):
    article = extract_article(FIXTURE, URL, settings)

    assert "evapotranspiration" in article.content
    assert "## Unequal shade" in article.content  # headings preserved
    assert "\n\n" in article.content  # paragraphs preserved
    assert article.word_count > 200
    assert article.content_truncated is False


def test_removes_boilerplate_scripts_and_ads(settings):
    content = extract_article(FIXTURE, URL, settings).content

    for unwanted in [
        "ADVERTISEMENT",
        "Sign in",
        "Related stories",
        "Football transfer",
        "Subscribe to our newsletter",
        "window.tracker",
        "HIJACKED",
        "display: block",
    ]:
        assert unwanted not in content


def test_short_or_paywalled_pages_are_rejected(settings):
    paywall = b"""<html><head><title>Members only</title></head><body><nav>Home</nav>
    <article><p>Subscribe to continue reading this article.</p></article></body></html>"""

    with pytest.raises(ServiceError) as info:
        extract_article(paywall, "https://news.example.com/x", settings)
    assert info.value.code == "ARTICLE_CONTENT_UNAVAILABLE"
    assert info.value.retryable is False


def test_empty_page_is_rejected(settings):
    with pytest.raises(ServiceError) as info:
        extract_article(b"   ", "https://news.example.com/x", settings)
    assert info.value.code == "ARTICLE_EMPTY"


def test_javascript_only_pages_are_rejected(settings):
    spa = b"""<html><body><div id="root"></div><script>render(); document.write('lots of words '.repeat(500))</script></body></html>"""

    with pytest.raises(ServiceError) as info:
        extract_article(spa, "https://app.example.com/", settings)
    assert info.value.code == "ARTICLE_CONTENT_UNAVAILABLE"


def test_unusual_layouts_without_article_tags_are_handled(settings):
    paragraphs = "".join(
        f"<div class='txt'>Paragraph {i}: the committee reviewed the transit budget and debated the cost of new bus lanes in detail.</div>"
        for i in range(20)
    )
    page = f"<html><head><title>Council debate</title></head><body><div id='wrap'>{paragraphs}</div></body></html>".encode()

    article = extract_article(page, "https://local.example.com/council", settings)
    assert "transit budget" in article.content


def test_unsafe_canonical_urls_are_ignored(settings):
    page = FIXTURE.replace(
        b"https://gazette.example.com/science/urban-trees-cool-cities", b"http://169.254.169.254/latest"
    )
    article = extract_article(page, URL, settings)
    assert article.canonical_url == URL


def test_stored_content_is_capped(settings):
    capped = settings.model_copy(update={"article_max_stored_chars": 10000})
    long_page = ("<html><body><article>" + "<p>" + ("Sentence about the economy. " * 60) + "</p>") * 20
    article = extract_article((long_page + "</article></body></html>").encode(), "https://news.example.com/x", capped)
    assert len(article.content) <= 10000
    assert article.content_truncated is True


def test_truncate_for_summary_cuts_at_paragraph_boundary():
    text = "\n\n".join(["Paragraph " + "x" * 100] * 50)
    cut, truncated = truncate_for_summary(text, 1000)
    assert truncated is True
    assert len(cut) <= 1000
    assert cut.endswith("x")

    same, flag = truncate_for_summary("short", 1000)
    assert (same, flag) == ("short", False)
