"""Quota-aware Gemini error mapping and request accounting (no real API calls)."""

import pytest
from google.genai import errors as genai_errors

from app.api.routes import ai as ai_routes
from app.core.exceptions import ServiceError
from app.services import usage
from app.services.gemini import map_api_error, parse_quota_error
from tests.fakes import FakeGenerator


def quota_error(quota_id=None, delay=None, message="Resource has been exhausted", value="20"):
    details = []
    if quota_id:
        details.append(
            {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                "violations": [
                    {"quotaMetric": "generate_content_free_tier_requests", "quotaId": quota_id, "quotaValue": value}
                ],
            }
        )
    if delay:
        details.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay})
    return genai_errors.ClientError(
        429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": message, "details": details}}
    )


def test_daily_quota_is_distinguished_from_rate_limits():
    mapped = map_api_error(quota_error("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "28853s"), model="m1")
    assert mapped.code == "AI_QUOTA_EXHAUSTED"
    assert mapped.status_code == 429
    assert mapped.meta == {
        "scope": "daily",
        "retry_after_seconds": 28853.0,
        "quota_id": "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        "quota_value": "20",
        "model": "m1",
    }


def test_per_minute_limit_with_fractional_delay():
    mapped = map_api_error(quota_error("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "41.7s"))
    assert mapped.code == "AI_RATE_LIMITED"
    assert mapped.retryable is True
    assert mapped.meta["scope"] == "minute" and mapped.meta["retry_after_seconds"] == 41.7


def test_retry_delay_parsed_from_message_when_details_are_missing():
    info = parse_quota_error(quota_error(message="Quota exceeded. Please retry in 12.5s."))
    assert info == {"scope": "unknown", "retry_after_seconds": 12.5, "quota_id": None, "quota_value": None}
    assert map_api_error(quota_error(message="x")).meta["retry_after_seconds"] is None


@pytest.mark.parametrize("delay", ["soon", "", None, "12m"])
def test_unparseable_delays_are_not_guessed(delay):
    assert parse_quota_error(quota_error("X-PerMinute", delay))["retry_after_seconds"] is None


def test_quota_messages_are_feature_neutral_and_safe():
    for error in (quota_error("PerDay"), quota_error("PerMinute")):
        message = map_api_error(error).message
        assert "summary" not in message.lower()
        assert "api key" not in message.lower()


def test_unknown_model_is_a_clear_non_retryable_error():
    mapped = map_api_error(genai_errors.ClientError(404, {"error": {"message": "models/x is not found"}}), model="x")
    assert mapped.code == "AI_MODEL_UNAVAILABLE" and mapped.retryable is False and mapped.meta == {"model": "x"}


def test_invalid_key_is_never_retryable():
    error = genai_errors.ClientError(400, {"error": {"message": "API key not valid. Please pass a valid API key."}})
    assert map_api_error(error).code == "AI_CONFIGURATION_ERROR"
    assert map_api_error(error).retryable is False


def test_malformed_request_is_never_retryable():
    mapped = map_api_error(
        genai_errors.ClientError(400, {"error": {"message": "Request contains an invalid argument."}})
    )
    assert mapped.code == "AI_REQUEST_REJECTED" and mapped.retryable is False


def test_quota_meta_is_returned_in_the_error_envelope(client, auth_headers):
    fake = FakeGenerator(
        responses=[
            ServiceError(
                429,
                "AI_QUOTA_EXHAUSTED",
                "used up",
                retryable=True,
                meta={"scope": "daily", "retry_after_seconds": 60.0, "model": "m"},
            )
        ]
    )
    client.app.dependency_overrides[ai_routes.get_generator] = lambda: fake
    try:
        body = {"question": "q?", "scope": "library", "chunks": []}
        response = client.post("/internal/ai/answer", json=body, headers=auth_headers)
    finally:
        client.app.dependency_overrides.clear()
    assert response.status_code == 429
    assert response.json()["error"]["meta"] == {"scope": "daily", "retry_after_seconds": 60.0, "model": "m"}


def test_request_count_header_counts_real_gemini_calls(client, auth_headers):
    class CountingFake(FakeGenerator):
        async def generate_structured(self, **kwargs):
            usage.record(1)
            return await super().generate_structured(**kwargs)

    fake = CountingFake(
        responses=["not json", {"answer": "A", "support": "supported", "citations": ["c1"], "follow_up_questions": []}]
    )
    client.app.dependency_overrides[ai_routes.get_generator] = lambda: fake
    try:
        chunk = {"id": "c1", "text": "Trees cool cities.", "source_id": "s", "source_kind": "article"}
        response = client.post(
            "/internal/ai/answer", json={"question": "q?", "scope": "library", "chunks": [chunk]}, headers=auth_headers
        )
    finally:
        client.app.dependency_overrides.clear()
    assert response.status_code == 200
    # One invalid output plus one retry: two real requests.
    assert response.headers["X-Gemini-Requests"] == "2"


def test_request_count_header_on_errors_and_non_ai_routes(client, auth_headers):
    assert client.get("/health").headers["X-Gemini-Requests"] == "0"
    response = client.post("/internal/ai/embeddings", json={"texts": [], "task": "query"}, headers=auth_headers)
    assert response.status_code == 422 and response.headers["X-Gemini-Requests"] == "0"


def test_config_endpoint_reports_models_without_secrets(client, auth_headers):
    response = client.get("/internal/ai/config", headers=auth_headers)
    data = response.json()["data"]
    assert data["api_version"] == "v1beta"
    assert data["generation_model"] and data["embedding_model"] == "gemini-embedding-001"
    assert data["transcription_model"] == data["generation_model"]
    assert "key" not in str(data).lower()
    assert client.get("/internal/ai/config").status_code == 401


@pytest.mark.anyio
async def test_real_client_counts_requests_and_maps_quota_errors(monkeypatch):
    """Exercises GoogleGeminiClient / GeminiEmbeddingProvider themselves (SDK stubbed, no network)."""
    from types import SimpleNamespace

    from pydantic import BaseModel, SecretStr

    from app.core.config import get_settings
    from app.services.embeddings import GeminiEmbeddingProvider
    from app.services.gemini import GoogleGeminiClient

    class Out(BaseModel):
        title: str

    settings = get_settings().model_copy(
        update={"gemini_api_key": SecretStr("test-key-not-real"), "embedding_dimensions": 64}
    )
    gen = GoogleGeminiClient(settings)
    ok = SimpleNamespace(
        prompt_feedback=None,
        candidates=[SimpleNamespace(finish_reason=None)],
        text='{"title": "T"}',
        usage_metadata=SimpleNamespace(prompt_token_count=11, candidates_token_count=3),
    )
    calls = []

    async def generate_content(**kwargs):
        calls.append(kwargs["model"])
        if len(calls) == 2:
            raise quota_error("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "100s")
        return ok

    gen._client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)))
    cell = usage.start()
    result = await gen.generate_structured(system_instruction="s", prompt="p", response_schema=Out)
    assert (result.text, result.input_tokens, result.output_tokens) == ('{"title": "T"}', 11, 3)
    with pytest.raises(ServiceError) as info:
        await gen.generate_structured(system_instruction="s", prompt="p", response_schema=Out, model="other-model")
    assert info.value.code == "AI_QUOTA_EXHAUSTED" and info.value.meta["model"] == "other-model"
    assert cell[0] == 2

    provider = GeminiEmbeddingProvider(settings.model_copy(update={"embedding_batch_size": 2}))

    async def embed_content(model, contents, config):
        return SimpleNamespace(embeddings=[SimpleNamespace(values=[1.0] * 64) for _ in contents])

    provider._client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(embed_content=embed_content)))
    await provider.embed(["a", "b", "c"], "document")
    assert cell[0] == 4  # two embedding batches
