"""Google Gemini client (official ``google-genai`` SDK).

The API key is read from settings and used only to construct the SDK client.
It is never logged, returned or included in error messages. SDK and network
failures are mapped to ServiceErrors with user-safe messages and a
``retryable`` flag.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Protocol

import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.services import usage as request_usage

logger = logging.getLogger("app.gemini")

GEMINI_API_VERSION = "v1beta"

BLOCKED_FINISH_REASONS = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"}

# The SDK may raise transport errors from httpx or from its httpx2 dependency;
# the two libraries' exception classes are unrelated, so both are listed.
_TIMEOUT_ERRORS: tuple[type[BaseException], ...] = (httpx.TimeoutException, TimeoutError)
_TRANSPORT_ERRORS: tuple[type[BaseException], ...] = (httpx.HTTPError,)
try:  # pragma: no cover - depends on the installed SDK version
    import httpx2

    _TIMEOUT_ERRORS += (httpx2.TimeoutException,)
    _TRANSPORT_ERRORS += (httpx2.HTTPError,)
except ImportError:  # pragma: no cover
    pass


@dataclass(frozen=True)
class GenerationResult:
    text: str | None
    finish_reason: str | None
    input_tokens: int | None
    output_tokens: int | None


class StructuredGenerator(Protocol):
    model: str

    async def generate_structured(
        self,
        *,
        system_instruction: str,
        prompt: str,
        response_schema: type[BaseModel],
        media: list[types.Part] | None = None,
        media_resolution: str | None = None,
        model: str | None = None,
        max_output_tokens: int | None = None,
        error_context: str | None = None,
    ) -> GenerationResult: ...


def _ai_error(status: int, code: str, message: str, retryable: bool, meta: dict | None = None) -> ServiceError:
    return ServiceError(status, code, message, retryable=retryable, meta=meta)


def _mentions_api_key(error: Exception) -> bool:
    text = f"{getattr(error, 'message', '')} {getattr(error, 'status', '')}".lower()
    return "api key" in text or "api_key" in text


_DELAY = re.compile(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*s\s*$")
_RETRY_IN = re.compile(r"retry in ([0-9]+(?:\.[0-9]+)?)\s*s", re.IGNORECASE)


def parse_quota_error(error: Exception) -> dict:
    """Extracts the quota scope and the provider's retry delay from a Gemini 429.

    Gemini returns google.rpc details: ``QuotaFailure.violations[].quotaId`` (for
    example ``GenerateRequestsPerDayPerProjectPerModel-FreeTier``) and
    ``RetryInfo.retryDelay`` (for example ``"28853s"``). Nothing is guessed: a
    missing value stays ``None`` and the scope is ``"unknown"``.
    """
    body = getattr(error, "details", None)
    payload = body.get("error", body) if isinstance(body, dict) else {}
    details = payload.get("details") if isinstance(payload, dict) else None
    quota_ids: list[str] = []
    quota_value: str | None = None
    retry_after: float | None = None
    for item in details if isinstance(details, list) else []:
        if not isinstance(item, dict):
            continue
        for violation in item.get("violations") or []:
            if isinstance(violation, dict) and isinstance(violation.get("quotaId"), str):
                quota_ids.append(violation["quotaId"])
                if quota_value is None and violation.get("quotaValue") is not None:
                    quota_value = str(violation["quotaValue"])
        delay = item.get("retryDelay")
        if isinstance(delay, str) and (match := _DELAY.match(delay)):
            retry_after = float(match.group(1))
    if retry_after is None:
        message = str(getattr(error, "message", "") or "")
        if match := _RETRY_IN.search(message):
            retry_after = float(match.group(1))
    joined = " ".join(quota_ids).lower()
    if "perday" in joined:
        scope = "daily"
    elif "perminute" in joined:
        scope = "minute"
    else:
        scope = "unknown"
    return {
        "scope": scope,
        "retry_after_seconds": round(retry_after, 1) if retry_after is not None else None,
        "quota_id": quota_ids[0] if quota_ids else None,
        "quota_value": quota_value,
    }


def map_api_error(error: Exception, context: str | None = None, model: str | None = None) -> ServiceError:
    """Translates SDK/network exceptions into safe, classified ServiceErrors.

    Messages are feature-neutral (the backend words them for summaries, chat,
    study tools, ...). Quota errors carry ``meta`` with the quota scope and the
    provider's retry delay, so the backend can schedule a delayed retry instead
    of retrying immediately.
    """
    if isinstance(error, genai_errors.APIError):
        code = getattr(error, "code", None)
        if code == 429:
            quota = parse_quota_error(error)
            meta = {**quota, "model": model}
            if quota["scope"] == "daily":
                return _ai_error(
                    429, "AI_QUOTA_EXHAUSTED", "The AI service's daily quota for this model is used up.", True, meta
                )
            return _ai_error(429, "AI_RATE_LIMITED", "The AI service is rate-limited right now.", True, meta)
        # Gemini rejects private, unlisted, age-restricted or removed YouTube videos with 400/403.
        if context == "youtube" and code in (400, 403) and not _mentions_api_key(error):
            return _ai_error(
                422,
                "VIDEO_UNSUPPORTED",
                "This video can't be processed. Only public YouTube videos are supported; "
                "private, unlisted, age-restricted and removed videos are not.",
                False,
            )
        if code == 404:
            return _ai_error(
                502,
                "AI_MODEL_UNAVAILABLE",
                "The AI model configured on the server is not available for its API key.",
                False,
                {"model": model},
            )
        if code in (401, 403) or (code == 400 and _mentions_api_key(error)):
            return _ai_error(502, "AI_CONFIGURATION_ERROR", "AI features are not available right now.", False)
        if code == 400:
            return _ai_error(422, "AI_REQUEST_REJECTED", "The AI service could not process this content.", False)
        if isinstance(error, genai_errors.ServerError) or (isinstance(code, int) and code >= 500):
            return _ai_error(503, "AI_UNAVAILABLE", "The AI service is temporarily unavailable.", True)
        return _ai_error(502, "AI_UNAVAILABLE", "The AI service returned an error.", True)
    if isinstance(error, _TIMEOUT_ERRORS):
        return _ai_error(504, "AI_TIMEOUT", "The AI service took too long to respond.", True)
    if isinstance(error, _TRANSPORT_ERRORS):
        return _ai_error(503, "AI_UNAVAILABLE", "The AI service could not be reached.", True)
    return _ai_error(502, "AI_UNAVAILABLE", "The AI service returned an unexpected error.", True)


class GoogleGeminiClient:
    def __init__(self, settings: Settings) -> None:
        if not settings.gemini_configured:
            raise ServiceError(
                503, "AI_NOT_CONFIGURED", "AI features are not configured on the server.", retryable=False
            )
        self.model = settings.gemini_model
        self._temperature = settings.gemini_temperature
        self._max_output_tokens = settings.gemini_max_output_tokens
        self._client = genai.Client(
            api_key=settings.gemini_api_key.get_secret_value(),  # type: ignore[union-attr]
            # Pinned: structured (JSON-schema) output is only available on v1beta; some key types default to v1.
            http_options=types.HttpOptions(
                api_version=GEMINI_API_VERSION,
                timeout=int(settings.gemini_timeout_seconds * 1000),
                # No hidden SDK retries: Briefly's quota manager decides when to retry and counts every request.
                retry_options=types.HttpRetryOptions(attempts=1),
            ),
        )

    async def generate_structured(
        self,
        *,
        system_instruction: str,
        prompt: str,
        response_schema: type[BaseModel],
        media: list[types.Part] | None = None,
        media_resolution: str | None = None,
        model: str | None = None,
        max_output_tokens: int | None = None,
        error_context: str | None = None,
    ) -> GenerationResult:
        """Structured JSON generation.

        ``media`` parts (audio bytes, a YouTube URL with offsets, ...) are sent
        before the text prompt. ``error_context="youtube"`` maps request
        rejections to video-specific errors.
        """
        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            response_mime_type="application/json",
            response_schema=response_schema,
            temperature=self._temperature,
            max_output_tokens=max_output_tokens or self._max_output_tokens,
            media_resolution=media_resolution,
        )
        contents: str | list = [*media, types.Part.from_text(text=prompt)] if media else prompt
        model_name = model or self.model
        request_usage.record(1)
        try:
            response = await self._client.aio.models.generate_content(
                model=model_name, contents=contents, config=config
            )
        except Exception as error:  # noqa: BLE001 - every failure is classified below
            mapped = map_api_error(error, context=error_context, model=model_name)
            logger.warning(
                "Gemini request failed (code=%s, model=%s, type=%s, scope=%s)",
                mapped.code,
                model_name,
                type(error).__name__,
                (mapped.meta or {}).get("scope"),
            )
            raise mapped from error

        if response.prompt_feedback is not None and response.prompt_feedback.block_reason:
            raise _ai_error(422, "AI_BLOCKED", "The AI service declined to summarize this content.", False)

        candidate = response.candidates[0] if response.candidates else None
        finish_reason = None
        if candidate is not None and candidate.finish_reason is not None:
            finish_reason = getattr(candidate.finish_reason, "value", str(candidate.finish_reason))
        if finish_reason in BLOCKED_FINISH_REASONS:
            raise _ai_error(422, "AI_BLOCKED", "The AI service declined to summarize this content.", False)

        usage = response.usage_metadata
        return GenerationResult(
            text=response.text,
            finish_reason=finish_reason,
            input_tokens=getattr(usage, "prompt_token_count", None) if usage else None,
            output_tokens=getattr(usage, "candidates_token_count", None) if usage else None,
        )


class LazyGeminiGenerator:
    """Creates the Gemini client on first use.

    Used as the route dependency so that request validation, SSRF checks and
    media errors are always reported before a missing API key would be.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def model(self) -> str:
        if self._settings.ai_mock_mode:
            from app.services.mock_ai import MOCK_MODEL_PREFIX

            return MOCK_MODEL_PREFIX + self._settings.gemini_model
        return self._settings.gemini_model

    async def generate_structured(self, **kwargs) -> GenerationResult:
        return await get_gemini_client(self._settings).generate_structured(**kwargs)


_client_cache: dict[tuple[str, str, float], GoogleGeminiClient] = {}


def get_gemini_client(settings: Settings) -> GoogleGeminiClient:
    """Returns a cached client per (key fingerprint, model, timeout); the offline mock in AI_MOCK_MODE."""
    if settings.ai_mock_mode:
        from app.services.mock_ai import MockGeminiClient

        return MockGeminiClient(settings)  # type: ignore[return-value]
    if not settings.gemini_configured:
        raise ServiceError(503, "AI_NOT_CONFIGURED", "AI features are not configured on the server.", retryable=False)
    import hashlib

    fingerprint = hashlib.sha256(settings.gemini_api_key.get_secret_value().encode()).hexdigest()  # type: ignore[union-attr]
    key = (fingerprint, settings.gemini_model, settings.gemini_timeout_seconds)
    if key not in _client_cache:
        _client_cache.clear()
        _client_cache[key] = GoogleGeminiClient(settings)
    return _client_cache[key]
