"""AI_MOCK_MODE: deterministic offline generation and embeddings for automated and end-to-end tests.

These tests prove that every processor accepts the mock's output, that the mock is
deterministic, that it never creates a Gemini client or counts a Gemini request,
and that it cannot be enabled in production.
"""

import pytest
from google import genai
from pydantic import ValidationError

from app.core.config import Settings, get_settings
from app.core.exceptions import ServiceError
from app.documents.ocr import GeminiOcrProvider
from app.processors.article_summarizer import summarize_article
from app.processors.document_summarizer import summarize_chunk, summarize_document
from app.processors.transcription import GeminiTranscriptionProvider
from app.processors.video_summarizer import summarize_video
from app.schemas.articles import GeminiArticleSummary
from app.schemas.documents import ChunkSummarizeRequest, DocumentSummarizeRequest
from app.services import embeddings as emb
from app.services import gemini
from app.services.mock_ai import MockEmbeddingProvider, MockGeminiClient, mock_response
from tests import conftest
from tests.test_ai import chunk, study_body
from tests.test_document_summarizer import PDF_PARTS
from tests.test_summarizer import REQUEST as ARTICLE_REQUEST
from tests.test_video_summarizer import REQUEST as VIDEO_REQUEST

SECRET = conftest.TEST_SECRET


def mock_settings(**extra) -> Settings:
    return Settings(internal_service_secret=SECRET, environment="test", ai_mock_mode=True, **extra)  # type: ignore[call-arg]


@pytest.fixture()
def no_client_allowed(monkeypatch):
    """Fails the test if anything constructs a Gemini client (the guard client would allow construction)."""

    def forbidden(*args, **kwargs):
        raise AssertionError("mock mode must not create a Gemini client")

    monkeypatch.setattr(genai, "Client", forbidden)


@pytest.fixture()
def mock_client(monkeypatch, no_client_allowed):
    """The HTTP app with AI_MOCK_MODE=true and no dependency overrides: the production wiring, mocked at the source."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    monkeypatch.setenv("AI_MOCK_MODE", "true")
    get_settings.cache_clear()
    yield TestClient(create_app(), raise_server_exceptions=False)
    get_settings.cache_clear()


# ------------------------------------------------------------------ processors accept mock output


@pytest.mark.anyio
async def test_article_summary(no_client_allowed):
    result = await summarize_article(ARTICLE_REQUEST, get_settings(), MockGeminiClient(mock_settings()))
    assert result.summary.title and len(result.summary.key_takeaways) >= 3


@pytest.mark.anyio
async def test_video_summary(no_client_allowed):
    result = await summarize_video(VIDEO_REQUEST, get_settings(), MockGeminiClient(mock_settings()))
    assert result.summary.chapters and result.summary.overview


@pytest.mark.anyio
async def test_transcription_window(no_client_allowed):
    provider = GeminiTranscriptionProvider(MockGeminiClient(mock_settings()), get_settings())
    window = await provider.transcribe_audio(b"audio", clip_start=0, clip_end=60)
    assert window.segments and all(0 <= s.start <= 60 for s in window.segments)


@pytest.mark.anyio
async def test_document_direct_chunk_and_combine(no_client_allowed):
    mock = MockGeminiClient(mock_settings())
    direct = await summarize_document(DocumentSummarizeRequest(format="pdf", mode="direct", parts=PDF_PARTS), get_settings(), mock)
    assert len(direct.summary.key_takeaways) >= 3

    notes = await summarize_chunk(
        ChunkSummarizeRequest(title="Report", format="pdf", chunk_index=0, chunk_count=2, parts=PDF_PARTS), get_settings(), mock
    )
    combined = await summarize_document(
        DocumentSummarizeRequest(format="pdf", mode="combine", notes=[notes.notes, notes.notes], allowed_pages=[1, 2, 4]),
        get_settings(),
        mock,
    )
    assert combined.summary.overview


@pytest.mark.anyio
async def test_ocr_page(no_client_allowed):
    blocks = await GeminiOcrProvider(MockGeminiClient(mock_settings()), get_settings()).recognize(b"\x89PNG fake", 1)
    assert blocks


def test_study_tools_and_answers_through_the_real_routes(mock_client, auth_headers):
    headers = auth_headers
    answer = mock_client.post("/internal/ai/answer", json={"question": "Why?", "chunks": [chunk(1)], "scope": "library"}, headers=headers)
    assert answer.status_code == 200, answer.text
    assert answer.headers["X-Gemini-Requests"] == "0"
    assert answer.json()["data"]["model"].startswith("mock:")

    assert mock_client.post("/internal/ai/study/notes", json=study_body(), headers=headers).status_code == 200
    for types in (["multiple_choice"], ["true_false", "short_answer"]):
        quiz = mock_client.post("/internal/ai/study/quiz", json=study_body(count=5, difficulty="easy", types=types), headers=headers)
        assert quiz.status_code == 200, quiz.text
        assert {q["type"] for q in quiz.json()["data"]["quiz"]["questions"]} <= set(types)
    cards = mock_client.post("/internal/ai/study/flashcards", json=study_body(count=6), headers=headers)
    assert cards.status_code == 200 and len(cards.json()["data"]["flashcards"]["cards"]) == 6
    restyled = mock_client.post("/internal/ai/summaries/restyle", json=study_body(style="concise"), headers=headers)
    assert restyled.status_code == 200, restyled.text


def test_embeddings_route_and_config(mock_client, auth_headers):
    body = {"texts": ["urban trees cool cities", "urban trees cool cities", "quarterly revenue"], "task": "document"}
    response = mock_client.post("/internal/ai/embeddings", json=body, headers=auth_headers)
    assert response.status_code == 200, response.text
    assert response.headers["X-Gemini-Requests"] == "0"
    vectors = response.json()["data"]["vectors"]
    assert vectors[0] == vectors[1] and vectors[0] != vectors[2]
    assert len(vectors[0]) == get_settings().embedding_dimensions

    config = mock_client.get("/internal/ai/config", headers=auth_headers).json()["data"]
    assert config["mock_mode"] is True and config["configured"] is True


# ------------------------------------------------------------------ determinism and safety


def test_responses_are_deterministic():
    assert mock_response(GeminiArticleSummary, "prompt A") == mock_response(GeminiArticleSummary, "prompt A")
    assert mock_response(GeminiArticleSummary, "prompt A") != mock_response(GeminiArticleSummary, "prompt B")


@pytest.mark.anyio
async def test_embeddings_are_unit_length_and_similar_for_shared_words():
    provider = MockEmbeddingProvider(mock_settings())
    a, b, c = await provider.embed(["heat islands in cities", "cities and heat islands", "quarterly revenue report"], "document")
    dot = lambda x, y: sum(i * j for i, j in zip(x, y, strict=True))  # noqa: E731
    assert abs(dot(a, a) - 1) < 1e-9
    assert dot(a, b) > dot(a, c)


def test_factories_return_the_mock_without_creating_a_client(no_client_allowed):
    settings = mock_settings()
    assert isinstance(gemini.get_gemini_client(settings), MockGeminiClient)
    assert isinstance(emb.get_embedding_provider(settings), MockEmbeddingProvider)


def test_mock_mode_is_refused_in_production():
    with pytest.raises(ValidationError, match="AI_MOCK_MODE"):
        Settings(internal_service_secret=SECRET, environment="production", ai_mock_mode=True)  # type: ignore[call-arg]


# ------------------------------------------------------------------ the routine-test guard itself


@pytest.mark.anyio
async def test_routine_tests_cannot_reach_gemini():
    """The conftest guard: a real client can be built, but any request is blocked and counted."""
    if conftest.LIVE_GEMINI:
        pytest.skip("guard is off in opt-in live runs")
    settings = get_settings()
    assert settings.gemini_api_key.get_secret_value() == "test-gemini-key-not-a-real-key"  # real key never loaded
    before = len(conftest.BLOCKED_GEMINI_CALLS)
    client = gemini.GoogleGeminiClient(settings)
    with pytest.raises((ServiceError, conftest.RealGeminiCallBlocked)):
        await client.generate_structured(system_instruction="x", prompt="y", response_schema=GeminiArticleSummary)
    with pytest.raises((ServiceError, conftest.RealGeminiCallBlocked)):
        await emb.GeminiEmbeddingProvider(settings).embed(["hello"], "query")
    assert conftest.BLOCKED_GEMINI_CALLS[before:] == ["generate_content", "embed_content"]
    # These two were deliberate; remove them so the session-level "zero real calls" check stays meaningful.
    del conftest.BLOCKED_GEMINI_CALLS[before:]
