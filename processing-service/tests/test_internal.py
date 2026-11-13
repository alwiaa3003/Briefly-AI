from datetime import datetime

import pytest


def test_internal_test_returns_structured_response(client, auth_headers):
    response = client.post(
        "/internal/test", json={"message": "  Hello from Node  ", "job_id": "abc123"}, headers=auth_headers
    )

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    data = body["data"]
    assert data["echo"] == "Hello from Node"  # whitespace is stripped by the schema
    assert data["message_length"] == len("Hello from Node")
    assert data["job_id"] == "abc123"
    assert data["processed_by"] == "briefly-processing-service"
    assert datetime.fromisoformat(data["received_at"].replace("Z", "+00:00")).tzinfo is not None


def test_job_id_is_optional(client, auth_headers):
    response = client.post("/internal/test", json={"message": "ping"}, headers=auth_headers)

    assert response.status_code == 200
    assert response.json()["data"]["job_id"] is None


def test_missing_token_is_rejected(client):
    response = client.post("/internal/test", json={"message": "ping"})

    assert response.status_code == 401
    assert response.json() == {
        "success": False,
        "error": {"code": "UNAUTHORIZED", "message": "A valid internal service token is required.", "retryable": False},
    }


@pytest.mark.parametrize(
    "token",
    ["wrong-token", "test-internal-secret-0123456789-abcdefghijklmnoX", ""],
)
def test_wrong_token_is_rejected(client, token):
    response = client.post("/internal/test", json={"message": "ping"}, headers={"X-Internal-Token": token})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"


def test_unauthorized_request_is_rejected_before_body_validation(client):
    # An attacker without the secret must not learn anything about the schema.
    response = client.post("/internal/test", json={"unexpected": True})

    assert response.status_code == 401


@pytest.mark.parametrize(
    "payload, field",
    [
        ({}, "message"),
        ({"message": ""}, "message"),
        ({"message": "x" * 501}, "message"),
        ({"message": "ok", "job_id": "x" * 65}, "job_id"),
        ({"message": "ok", "extra": 1}, "extra"),
    ],
)
def test_invalid_payload_returns_validation_error(client, auth_headers, payload, field):
    response = client.post("/internal/test", json=payload, headers=auth_headers)

    assert response.status_code == 422
    body = response.json()
    assert body["success"] is False
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert field in [detail["field"] for detail in body["error"]["details"]]


def test_docs_are_disabled_in_production(monkeypatch):
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.main import create_app

    monkeypatch.setenv("ENVIRONMENT", "production")
    get_settings.cache_clear()
    try:
        production_client = TestClient(create_app())
        assert production_client.get("/docs").status_code == 404
        assert production_client.get("/openapi.json").status_code == 404
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()


def test_service_refuses_to_start_without_a_strong_secret(monkeypatch):
    from pydantic import ValidationError

    from app.core.config import Settings

    monkeypatch.setenv("INTERNAL_SERVICE_SECRET", "too-short")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)

    monkeypatch.setenv("INTERNAL_SERVICE_SECRET", "change-me-generate-a-long-random-string")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
