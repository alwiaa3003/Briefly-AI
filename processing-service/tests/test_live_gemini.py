"""Real Gemini verification (opt-in). Skipped unless RUN_LIVE_GEMINI=1.

    cd processing-service
    RUN_LIVE_GEMINI=1 ../.venv/Scripts/python -m pytest tests/test_live_gemini.py

Uses GEMINI_API_KEY from processing-service/.env and the configured free-tier models.
Cost when enabled: exactly 1 generation request and 1 embedding request. These calls
go straight to Google, so they count against the Gemini free-tier quota but not
against Briefly's own budget counters (which only the backend's AI gate maintains).
"""

import json

import pytest
from pydantic import BaseModel

from app.core.config import get_settings
from app.services.embeddings import GeminiEmbeddingProvider
from app.services.gemini import GoogleGeminiClient

pytestmark = pytest.mark.live_gemini


class Ping(BaseModel):
    word: str


@pytest.mark.anyio
async def test_real_generation_request():
    settings = get_settings()
    assert settings.gemini_configured, "GEMINI_API_KEY is not set in processing-service/.env"
    assert not settings.ai_mock_mode, "AI_MOCK_MODE must be off for a live run"
    result = await GoogleGeminiClient(settings).generate_structured(
        system_instruction="Answer with JSON only.",
        prompt='Return {"word": "ok"}.',
        response_schema=Ping,
        max_output_tokens=64,
    )
    assert json.loads(result.text)["word"]


@pytest.mark.anyio
async def test_real_embedding_request():
    settings = get_settings()
    vectors = await GeminiEmbeddingProvider(settings).embed(["Briefly live check"], "query")
    assert len(vectors) == 1 and len(vectors[0]) == settings.embedding_dimensions
