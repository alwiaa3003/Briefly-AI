"""Streams a stored document from a signed storage URL to a temporary file.

The URL must pass the same checks as video media URLs (https, allowed storage
host, SSRF rules). Redirects are not followed, proxies are ignored, and the
download is capped at DOCUMENT_MAX_BYTES, so memory stays constant.
"""

from __future__ import annotations

from pathlib import Path

import httpx

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.media.ffmpeg import validate_download_url

# Replaced in tests.
transport: httpx.AsyncBaseTransport | None = None


async def download_to_file(url: str, destination: Path, settings: Settings) -> int:
    validate_download_url(url, settings)
    size = 0
    try:
        async with httpx.AsyncClient(
            transport=transport, timeout=httpx.Timeout(120, connect=10), follow_redirects=False, trust_env=False
        ) as client:
            async with client.stream("GET", url) as response:
                if response.status_code in (401, 403, 404):
                    raise ServiceError(
                        502,
                        "DOCUMENT_DOWNLOAD_FAILED",
                        "The uploaded file could not be read from storage.",
                        retryable=True,
                    )
                if response.status_code != 200:
                    raise ServiceError(
                        502,
                        "DOCUMENT_DOWNLOAD_FAILED",
                        "The uploaded file could not be read from storage.",
                        retryable=True,
                    )
                with destination.open("wb") as handle:
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > settings.document_max_bytes:
                            raise ServiceError(
                                422, "DOCUMENT_TOO_LARGE", "The document is too large to process.", retryable=False
                            )
                        handle.write(chunk)
    except httpx.HTTPError as exc:
        raise ServiceError(
            502, "DOCUMENT_DOWNLOAD_FAILED", "The uploaded file could not be read from storage.", retryable=True
        ) from exc
    if size == 0:
        raise ServiceError(422, "DOCUMENT_EMPTY", "The document is empty.", retryable=False)
    return size
