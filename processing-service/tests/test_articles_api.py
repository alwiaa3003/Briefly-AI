from pathlib import Path

import httpx
import pytest

from app.api.routes import articles as articles_routes
from app.core.exceptions import ServiceError
from app.extractors import fetcher
from tests.fakes import FakeGenerator

FIXTURE = (Path(__file__).parent / "fixtures" / "article.html").read_bytes()


@pytest.fixture()
def fake_fetch(monkeypatch):
    """Serves the fixture page without network access."""

    async def fetch_article_page(url, settings, transport=None):
        if "missing" in url:
            raise ServiceError(422, "ARTICLE_NOT_FOUND", "The page could not be found.", retryable=False)
        return fetcher.FetchedPage(
            requested_url=url, final_url=url, status_code=200, content_type="text/html", body=FIXTURE
        )

    monkeypatch.setattr(articles_routes, "fetch_article_page", fetch_article_page)


@pytest.fixture()
def generator(client):
    fake = FakeGenerator()
    client.app.dependency_overrides[articles_routes.get_generator] = lambda: fake
    yield fake
    client.app.dependency_overrides.clear()


SUMMARIZE_BODY = {
    "url": "https://gazette.example.com/trees",
    "title": "How Urban Trees Cool Cities",
    "content": "Trees " * 300,
}


@pytest.mark.parametrize("path", ["/internal/articles/extract", "/internal/articles/summarize"])
def test_article_endpoints_require_internal_token(client, path):
    response = client.post(path, json={"url": "https://example.com"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_extract_returns_article(client, auth_headers, fake_fetch):
    response = client.post(
        "/internal/articles/extract", json={"url": "https://gazette.example.com/trees"}, headers=auth_headers
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["title"] == "How Urban Trees Cool Cities"
    assert data["author"] == "Priya Raman"
    assert data["canonical_url"] == "https://gazette.example.com/science/urban-trees-cool-cities"
    assert data["word_count"] > 200
    assert "ADVERTISEMENT" not in data["content"]


def test_extract_reports_classified_errors(client, auth_headers, fake_fetch):
    response = client.post(
        "/internal/articles/extract", json={"url": "https://x.example.com/missing"}, headers=auth_headers
    )

    assert response.status_code == 422
    assert response.json()["error"] == {
        "code": "ARTICLE_NOT_FOUND",
        "message": "The page could not be found.",
        "retryable": False,
    }


def test_extract_rejects_unsafe_urls_end_to_end(client, auth_headers):
    response = client.post("/internal/articles/extract", json={"url": "http://169.254.169.254/"}, headers=auth_headers)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "UNSAFE_URL"
    assert response.json()["error"]["retryable"] is False


def test_extract_validates_body(client, auth_headers):
    response = client.post("/internal/articles/extract", json={"url": ""}, headers=auth_headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_summarize_returns_structured_summary(client, auth_headers, generator):
    response = client.post("/internal/articles/summarize", json=SUMMARIZE_BODY, headers=auth_headers)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["summary"]["title"] == "How Urban Trees Cool Cities"
    assert 5 <= len(data["summary"]["key_takeaways"]) <= 8
    assert data["model"] == "fake-gemini"
    assert data["usage"] == {"input_tokens": 1200, "output_tokens": 400}


def test_summarize_without_api_key_is_a_non_retryable_error(client, auth_headers, monkeypatch):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "gemini_api_key", None)
    response = client.post("/internal/articles/summarize", json=SUMMARIZE_BODY, headers=auth_headers)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_NOT_CONFIGURED"
    assert response.json()["error"]["retryable"] is False


def test_summarize_rate_limit_is_retryable(client, auth_headers):
    fake = FakeGenerator(responses=[ServiceError(503, "AI_RATE_LIMITED", "busy", retryable=True)])
    client.app.dependency_overrides[articles_routes.get_generator] = lambda: fake
    try:
        response = client.post("/internal/articles/summarize", json=SUMMARIZE_BODY, headers=auth_headers)
    finally:
        client.app.dependency_overrides.clear()

    assert response.status_code == 503
    assert response.json()["error"]["retryable"] is True


def test_unexpected_errors_are_generic(client, auth_headers):
    fake = FakeGenerator(responses=[RuntimeError("internal secret detail")])
    client.app.dependency_overrides[articles_routes.get_generator] = lambda: fake
    try:
        response = client.post("/internal/articles/summarize", json=SUMMARIZE_BODY, headers=auth_headers)
    finally:
        client.app.dependency_overrides.clear()

    assert response.status_code == 500
    assert "secret" not in response.text


def test_httpx_is_used_for_real_fetches():
    # Guard: the fetcher must ignore proxy environment variables (they would bypass IP pinning).
    import inspect

    assert "trust_env=False" in inspect.getsource(fetcher)
    assert httpx.__version__
