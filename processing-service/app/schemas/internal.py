"""Schemas for internal (service-to-service) endpoints."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TestRequest(BaseModel):
    """Payload for the infrastructure round-trip test."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    message: str = Field(min_length=1, max_length=500)
    job_id: str | None = Field(default=None, max_length=64)


class TestResult(BaseModel):
    echo: str
    message_length: int
    job_id: str | None
    processed_by: str
    received_at: datetime
