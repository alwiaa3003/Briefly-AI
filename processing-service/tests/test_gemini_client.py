import httpx
import pytest
from google.genai import errors as genai_errors

from app.core.config import get_settings
from app.core.exceptions import ServiceError
from app.services.gemini import GoogleGeminiClient, get_gemini_client, map_api_error


@pytest.mark.parametrize(
    "error, code, retryable",
    [
        (genai_errors.ClientError(429, {"error": {"message": "quota"}}), "AI_RATE_LIMITED", True),
        (genai_errors.ClientError(401, {"error": {"message": "bad key"}}), "AI_CONFIGURATION_ERROR", False),
        (genai_errors.ClientError(403, {"error": {"message": "denied"}}), "AI_CONFIGURATION_ERROR", False),
        (genai_errors.ClientError(404, {"error": {"message": "no model"}}), "AI_MODEL_UNAVAILABLE", False),
        (genai_errors.ClientError(400, {"error": {"message": "too long"}}), "AI_REQUEST_REJECTED", False),
        (genai_errors.ServerError(500, {"error": {"message": "boom"}}), "AI_UNAVAILABLE", True),
        (genai_errors.ServerError(503, {"error": {"message": "overloaded"}}), "AI_UNAVAILABLE", True),
        (httpx.ReadTimeout("slow"), "AI_TIMEOUT", True),
        (TimeoutError(), "AI_TIMEOUT", True),
        (httpx.ConnectError("down"), "AI_UNAVAILABLE", True),
        (RuntimeError("unexpected"), "AI_UNAVAILABLE", True),
    ],
)
def test_maps_sdk_errors(error, code, retryable):
    mapped = map_api_error(error)
    assert mapped.code == code
    assert mapped.retryable is retryable


def test_maps_httpx2_transport_errors_used_by_the_sdk():
    httpx2 = pytest.importorskip("httpx2")
    assert map_api_error(httpx2.ReadTimeout("slow")).code == "AI_TIMEOUT"
    assert map_api_error(httpx2.ConnectError("down")).code == "AI_UNAVAILABLE"


def test_error_messages_never_leak_provider_details():
    mapped = map_api_error(genai_errors.ClientError(401, {"error": {"message": "API key AIza-secret-123 invalid"}}))
    assert "AIza" not in mapped.message
    assert "secret" not in mapped.message


def test_requires_api_key():
    settings = get_settings().model_copy(update={"gemini_api_key": None})
    with pytest.raises(ServiceError) as info:
        GoogleGeminiClient(settings)
    assert info.value.code == "AI_NOT_CONFIGURED"
    assert info.value.retryable is False

    with pytest.raises(ServiceError):
        get_gemini_client(settings)


def test_model_is_configurable():
    from pydantic import SecretStr

    settings = get_settings().model_copy(
        update={"gemini_api_key": SecretStr("test-key-not-real"), "gemini_model": "custom-model-x"}
    )
    client = get_gemini_client(settings)
    assert client.model == "custom-model-x"


def test_clients_pin_the_v1beta_api(monkeypatch):
    """Structured (JSON-schema) output only exists on v1beta; some API key types default the SDK to v1."""
    from pydantic import SecretStr

    from app.services import embeddings, gemini

    seen = []

    class FakeClient:
        def __init__(self, **kwargs):
            seen.append(kwargs["http_options"].api_version)
            # The SDK must never retry on its own (requests would be uncounted and could hammer quotas).
            assert kwargs["http_options"].retry_options.attempts == 1

    monkeypatch.setattr(gemini.genai, "Client", FakeClient)
    settings = get_settings().model_copy(update={"gemini_api_key": SecretStr("test-key-not-real")})
    gemini.GoogleGeminiClient(settings)
    embeddings.GeminiEmbeddingProvider(settings)
    assert seen == ["v1beta", "v1beta"]
