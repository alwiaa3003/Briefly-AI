"""Text embeddings (configurable provider; "gemini" ships).

- Model and dimensionality come from EMBEDDING_MODEL / EMBEDDING_DIMENSIONS, so
  switching models never requires code changes (re-indexing is required
  because vectors from different models are not comparable).
- Separate task types for stored passages (RETRIEVAL_DOCUMENT) and search
  queries (RETRIEVAL_QUERY), as the model recommends.
- Vectors are L2-normalised so cosine similarity is well defined when a reduced
  output dimensionality is requested.
"""

from __future__ import annotations

import hashlib
import logging
import math
from typing import Literal, Protocol

from google import genai
from google.genai import types

from app.core.config import Settings
from app.core.exceptions import ServiceError
from app.services import usage as request_usage
from app.services.gemini import GEMINI_API_VERSION, map_api_error

logger = logging.getLogger("app.embeddings")

EmbeddingTask = Literal["document", "query"]
_TASK_TYPES = {"document": "RETRIEVAL_DOCUMENT", "query": "RETRIEVAL_QUERY"}


class EmbeddingProvider(Protocol):
    name: str
    model: str
    dimensions: int

    async def embed(self, texts: list[str], task: EmbeddingTask) -> list[list[float]]: ...


def normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    if not norm or not math.isfinite(norm):
        raise ServiceError(
            502, "EMBEDDING_INVALID_RESPONSE", "The embedding service returned an invalid vector.", retryable=True
        )
    return [v / norm for v in vector]


class GeminiEmbeddingProvider:
    name = "gemini"

    def __init__(self, settings: Settings) -> None:
        if not settings.gemini_configured:
            raise ServiceError(
                503, "AI_NOT_CONFIGURED", "AI features are not configured on the server.", retryable=False
            )
        self.model = settings.embedding_model
        self.dimensions = settings.embedding_dimensions
        self._batch = settings.embedding_batch_size
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

    async def embed(self, texts: list[str], task: EmbeddingTask) -> list[list[float]]:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), self._batch):
            batch = texts[start : start + self._batch]
            request_usage.record(1)
            try:
                response = await self._client.aio.models.embed_content(
                    model=self.model,
                    contents=batch,
                    config=types.EmbedContentConfig(task_type=_TASK_TYPES[task], output_dimensionality=self.dimensions),
                )
            except Exception as error:  # noqa: BLE001 - classified below
                mapped = map_api_error(error, model=self.model)
                logger.warning("Embedding request failed (code=%s, model=%s)", mapped.code, self.model)
                raise mapped from error
            embeddings = response.embeddings or []
            if len(embeddings) != len(batch):
                raise ServiceError(
                    502,
                    "EMBEDDING_INVALID_RESPONSE",
                    "The embedding service returned an unexpected result.",
                    retryable=True,
                )
            for embedding in embeddings:
                values = list(embedding.values or [])
                if len(values) != self.dimensions:
                    raise ServiceError(
                        502,
                        "EMBEDDING_INVALID_RESPONSE",
                        "The embedding service returned vectors of the wrong size.",
                        retryable=False,
                    )
                vectors.append(normalize(values))
        return vectors


_cache: dict[tuple[str, str, int], GeminiEmbeddingProvider] = {}


def get_embedding_provider(settings: Settings) -> EmbeddingProvider:
    if settings.ai_mock_mode:
        from app.services.mock_ai import MockEmbeddingProvider

        return MockEmbeddingProvider(settings)
    if settings.embedding_provider != "gemini":  # pragma: no cover - guarded by the Settings Literal
        raise ServiceError(503, "EMBEDDINGS_NOT_CONFIGURED", "Embeddings are not configured.", retryable=False)
    if not settings.gemini_configured:
        raise ServiceError(503, "AI_NOT_CONFIGURED", "AI features are not configured on the server.", retryable=False)
    fingerprint = hashlib.sha256(settings.gemini_api_key.get_secret_value().encode()).hexdigest()  # type: ignore[union-attr]
    key = (fingerprint, settings.embedding_model, settings.embedding_dimensions)
    if key not in _cache:
        _cache.clear()
        _cache[key] = GeminiEmbeddingProvider(settings)
    return _cache[key]


class LazyEmbeddingProvider:
    """Creates the provider on first use so request validation errors are reported first."""

    name = "gemini"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.model = ("mock:" if settings.ai_mock_mode else "") + settings.embedding_model
        self.dimensions = settings.embedding_dimensions

    async def embed(self, texts: list[str], task: EmbeddingTask) -> list[list[float]]:
        return await get_embedding_provider(self._settings).embed(texts, task)
