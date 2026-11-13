"""Safe HTTP fetching of article pages.

- Redirects are followed manually; every hop is re-validated (scheme, host,
  port, DNS) before it is requested.
- Connections go to the IP that passed validation. The original hostname is
  sent as the Host header and as TLS SNI, so certificates are still verified
  against the real hostname.
- Environment proxies are ignored (a proxy would bypass IP pinning).
- Bodies are streamed with a hard size cap; only HTML is accepted.
- Nothing on the page is executed: the HTML is only parsed.
"""

from __future__ import annotations

import asyncio
import ipaddress
from dataclasses import dataclass
from urllib.parse import urljoin, urlunsplit

import httpx

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.extractors import url_safety

HTML_CONTENT_TYPES = ("text/html", "application/xhtml+xml")
REDIRECT_STATUSES = {301, 302, 303, 307, 308}


@dataclass(frozen=True)
class FetchedPage:
    requested_url: str
    final_url: str
    status_code: int
    content_type: str
    body: bytes


def _error(status: int, code: str, message: str, retryable: bool) -> ServiceError:
    return ServiceError(status, code, message, retryable=retryable)


def _pinned_url(checked: url_safety.CheckedUrl, ip: url_safety.IPAddress) -> str:
    host = f"[{ip}]" if isinstance(ip, ipaddress.IPv6Address) else str(ip)
    default_port = url_safety.ALLOWED_SCHEMES[checked.scheme]
    netloc = host if checked.port == default_port else f"{host}:{checked.port}"
    path = checked.parts.path or "/"
    return urlunsplit((checked.scheme, netloc, path, checked.parts.query, ""))


def _host_header(checked: url_safety.CheckedUrl) -> str:
    default_port = url_safety.ALLOWED_SCHEMES[checked.scheme]
    return checked.hostname if checked.port == default_port else f"{checked.hostname}:{checked.port}"


def _raise_for_status(status: int) -> None:
    if status in (401, 402, 403, 451):
        raise _error(
            422,
            "ARTICLE_ACCESS_DENIED",
            "The website refused access to this page. It may require a login or subscription.",
            False,
        )
    if status in (404, 410):
        raise _error(422, "ARTICLE_NOT_FOUND", "The page could not be found. Check that the link is correct.", False)
    if status == 429:
        raise _error(503, "ARTICLE_RATE_LIMITED", "The website is limiting requests. Please try again later.", True)
    if status >= 500:
        raise _error(502, "ARTICLE_SITE_ERROR", "The website returned an error. Please try again later.", True)
    if status >= 400:
        raise _error(422, "ARTICLE_FETCH_FAILED", "The page could not be retrieved.", False)


async def _read_limited(response: httpx.Response, max_bytes: int) -> bytes:
    declared = response.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > max_bytes:
        raise _error(422, "ARTICLE_TOO_LARGE", "The page is too large to process.", False)
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        total += len(chunk)
        if total > max_bytes:
            raise _error(422, "ARTICLE_TOO_LARGE", "The page is too large to process.", False)
        chunks.append(chunk)
    return b"".join(chunks)


async def _fetch(url: str, settings: Settings, transport: httpx.AsyncBaseTransport | None) -> FetchedPage:
    timeout = httpx.Timeout(
        settings.article_fetch_timeout_seconds, connect=min(10.0, settings.article_fetch_timeout_seconds)
    )
    headers = {
        "User-Agent": settings.article_user_agent,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "Accept-Language": "en;q=0.9,*;q=0.5",
    }
    current = url
    async with httpx.AsyncClient(
        transport=transport, follow_redirects=False, timeout=timeout, trust_env=False, headers=headers
    ) as client:
        for _hop in range(settings.article_max_redirects + 1):
            checked = url_safety.check_url(current)
            ip = await url_safety.resolve_public_ip(checked)
            request_headers = {"Host": _host_header(checked)}
            extensions = {"sni_hostname": checked.hostname} if checked.scheme == "https" else {}

            try:
                async with client.stream(
                    "GET", _pinned_url(checked, ip), headers=request_headers, extensions=extensions
                ) as response:
                    if response.status_code in REDIRECT_STATUSES:
                        location = response.headers.get("location")
                        if not location:
                            raise _error(
                                422, "ARTICLE_FETCH_FAILED", "The page redirected without a destination.", False
                            )
                        current = urljoin(checked.url, location.strip())
                        continue

                    _raise_for_status(response.status_code)

                    content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                    if content_type and content_type not in HTML_CONTENT_TYPES:
                        if content_type == "application/pdf":
                            message = "This link points to a PDF. Document summarization is coming in a later release."
                        else:
                            message = "This link does not point to a web page that can be summarized."
                        raise _error(422, "ARTICLE_UNSUPPORTED_CONTENT", message, False)

                    body = await _read_limited(response, settings.article_max_bytes)
                    return FetchedPage(
                        requested_url=url,
                        final_url=checked.url,
                        status_code=response.status_code,
                        content_type=content_type or "text/html",
                        body=body,
                    )
            except httpx.TimeoutException as exc:
                raise _error(504, "ARTICLE_TIMEOUT", "The website took too long to respond.", True) from exc
            except httpx.TooManyRedirects as exc:  # pragma: no cover - redirects are manual
                raise _error(422, "ARTICLE_TOO_MANY_REDIRECTS", "The page redirected too many times.", False) from exc
            except httpx.HTTPError as exc:
                raise _error(
                    502, "ARTICLE_UNREACHABLE", "The website could not be reached. Please try again later.", True
                ) from exc

    raise _error(422, "ARTICLE_TOO_MANY_REDIRECTS", "The page redirected too many times.", False)


async def fetch_article_page(
    url: str, settings: Settings, transport: httpx.AsyncBaseTransport | None = None
) -> FetchedPage:
    """Fetches an article page with SSRF protection and an overall deadline."""
    deadline = settings.article_fetch_timeout_seconds * 2 + 5
    try:
        return await asyncio.wait_for(_fetch(url, settings, transport), deadline)
    except TimeoutError as exc:
        raise _error(504, "ARTICLE_TIMEOUT", "The website took too long to respond.", True) from exc
