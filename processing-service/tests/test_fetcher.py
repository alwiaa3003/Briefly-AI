import httpx
import pytest

from app.core.config import get_settings
from app.core.exceptions import ServiceError
from app.extractors import url_safety
from app.extractors.fetcher import fetch_article_page
from app.extractors.url_safety import UnsafeUrlError

PUBLIC_DNS = {
    "news.example.com": ["93.184.216.34"],
    "cdn.example.net": ["93.184.216.35"],
    "evil.example.com": ["10.0.0.9"],
}


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    async def resolve(host, _port):
        if host not in PUBLIC_DNS:
            import socket

            raise socket.gaierror("unknown host")
        return PUBLIC_DNS[host]

    monkeypatch.setattr(url_safety, "resolver", resolve)


def transport(handler):
    return httpx.MockTransport(handler)


async def fetch(url, handler):
    return await fetch_article_page(url, get_settings(), transport=transport(handler))


HTML = b"<html><body><article><p>Hello world</p></article></body></html>"


@pytest.mark.anyio
async def test_connects_to_validated_ip_with_original_host_and_sni():
    seen = {}

    def handler(request: httpx.Request):
        seen["url"] = str(request.url)
        seen["host"] = request.headers["host"]
        seen["sni"] = request.extensions.get("sni_hostname")
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=HTML)

    page = await fetch("https://news.example.com/story?x=1#frag", handler)

    assert seen["url"] == "https://93.184.216.34/story?x=1"  # pinned IP, fragment dropped
    assert seen["host"] == "news.example.com"
    assert seen["sni"] == "news.example.com"
    assert page.final_url == "https://news.example.com/story?x=1#frag"
    assert page.body == HTML


@pytest.mark.anyio
async def test_follows_safe_redirects_and_revalidates_each_hop():
    calls = []

    def handler(request: httpx.Request):
        calls.append(request.headers["host"])
        if request.headers["host"] == "news.example.com":
            return httpx.Response(301, headers={"location": "https://cdn.example.net/final"})
        return httpx.Response(200, headers={"content-type": "text/html"}, content=HTML)

    page = await fetch("http://news.example.com/old", handler)

    assert calls == ["news.example.com", "cdn.example.net"]
    assert page.final_url == "https://cdn.example.net/final"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "location",
    [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:80/",
        "https://evil.example.com/",  # resolves to a private IP
        "file:///etc/passwd",
    ],
)
async def test_blocks_redirects_to_unsafe_destinations(location):
    requested = []

    def handler(request: httpx.Request):
        requested.append(request.headers["host"])
        return httpx.Response(302, headers={"location": location})

    with pytest.raises(ServiceError) as info:
        await fetch("https://news.example.com/", handler)

    assert info.value.code in ("UNSAFE_URL", "INVALID_URL")
    assert requested == ["news.example.com"]  # the unsafe target was never contacted


@pytest.mark.anyio
async def test_too_many_redirects():
    def handler(request: httpx.Request):
        return httpx.Response(302, headers={"location": "https://news.example.com/loop"})

    with pytest.raises(ServiceError) as info:
        await fetch("https://news.example.com/", handler)
    assert info.value.code == "ARTICLE_TOO_MANY_REDIRECTS"


@pytest.mark.anyio
async def test_rejects_unsafe_initial_url_without_any_request():
    def handler(request):  # pragma: no cover - must not be called
        raise AssertionError("request should not be sent")

    with pytest.raises(UnsafeUrlError):
        await fetch("http://192.168.0.1/", handler)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "status, code, retryable",
    [
        (401, "ARTICLE_ACCESS_DENIED", False),
        (402, "ARTICLE_ACCESS_DENIED", False),
        (403, "ARTICLE_ACCESS_DENIED", False),
        (404, "ARTICLE_NOT_FOUND", False),
        (410, "ARTICLE_NOT_FOUND", False),
        (429, "ARTICLE_RATE_LIMITED", True),
        (500, "ARTICLE_SITE_ERROR", True),
        (503, "ARTICLE_SITE_ERROR", True),
        (418, "ARTICLE_FETCH_FAILED", False),
    ],
)
async def test_maps_http_errors(status, code, retryable):
    with pytest.raises(ServiceError) as info:
        await fetch("https://news.example.com/", lambda r: httpx.Response(status))
    assert info.value.code == code
    assert info.value.retryable is retryable


@pytest.mark.anyio
async def test_rejects_non_html_content():
    def handler(request):
        return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.7")

    with pytest.raises(ServiceError) as info:
        await fetch("https://news.example.com/paper.pdf", handler)
    assert info.value.code == "ARTICLE_UNSUPPORTED_CONTENT"
    assert "PDF" in info.value.message


@pytest.mark.anyio
async def test_enforces_size_limit_while_streaming(monkeypatch):
    settings = get_settings().model_copy(update={"article_max_bytes": 64 * 1024})

    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"x" * (64 * 1024 + 1))

    with pytest.raises(ServiceError) as info:
        await fetch_article_page("https://news.example.com/", settings, transport=transport(handler))
    assert info.value.code == "ARTICLE_TOO_LARGE"


@pytest.mark.anyio
async def test_rejects_declared_oversized_content_length():
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/html", "content-length": str(500 * 1024 * 1024)})

    with pytest.raises(ServiceError) as info:
        await fetch("https://news.example.com/", handler)
    assert info.value.code == "ARTICLE_TOO_LARGE"


@pytest.mark.anyio
async def test_timeouts_are_retryable():
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ServiceError) as info:
        await fetch("https://news.example.com/", handler)
    assert info.value.code == "ARTICLE_TIMEOUT"
    assert info.value.retryable is True


@pytest.mark.anyio
async def test_connection_errors_are_retryable():
    def handler(request):
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(ServiceError) as info:
        await fetch("https://news.example.com/", handler)
    assert info.value.code == "ARTICLE_UNREACHABLE"
    assert info.value.retryable is True
