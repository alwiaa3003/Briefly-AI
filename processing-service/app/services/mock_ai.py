"""Deterministic offline AI (AI_MOCK_MODE=true) for automated and end-to-end tests.

No Gemini client is created and nothing is sent to Google: the generator builds a
schema-valid JSON response from the requested ``response_schema`` and the prompt,
and the embedder derives vectors from the text itself. The same input always
produces the same output, so tests can assert on it.

Neither class records Gemini requests (``app.services.usage``), so the backend's
budget counters see 0 requests for mocked calls.

This is a test double, not a fallback: it is only used when AI_MOCK_MODE is set,
and Settings refuses it in production.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import types as pytypes
from typing import Union, get_args, get_origin

from pydantic import BaseModel

from app.core.config import Settings
from app.services.gemini import GenerationResult

MOCK_MODEL_PREFIX = "mock:"

# Fields whose values must be one of a fixed set (the processors validate them).
_FIXED = {"support": "supported", "language": "en", "kind": "paragraph", "speaker": "", "section": ""}
# Reference lists stay empty: grounding would discard invented references anyway.
_EMPTY_LISTS = {"refs", "citations", "pages", "external_knowledge"}
_LONG_TEXT = {"overview", "content", "summary", "explanation", "answer", "back", "text", "statement", "description"}
_QUESTION_TYPES = ("multiple_choice", "true_false", "short_answer")


class _Context:
    """What the mock reads from the prompt to shape its answer."""

    def __init__(self, prompt: str) -> None:
        self.seed = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:8]
        exact = re.search(r"Create (?:exactly|up to) (\d+) (questions|flashcards)", prompt)
        self.counts = {exact.group(2): int(exact.group(1))} if exact else {}
        allowed = re.search(r"Allowed types: ([a-z_, ]+)", prompt)
        found = [t.strip() for t in allowed.group(1).split(",")] if allowed else []
        self.question_types = [t for t in found if t in _QUESTION_TYPES] or ["multiple_choice"]

    def list_length(self, name: str) -> int:
        if name == "questions":
            return max(1, min(self.counts.get("questions", 3), 30))
        if name == "cards":
            return max(1, min(self.counts.get("flashcards", 4), 30))
        if name == "follow_up_questions":
            return 2
        if name == "options":
            return 4
        return 4


def _unwrap_optional(annotation):
    origin = get_origin(annotation)
    if origin in (Union, pytypes.UnionType):
        args = [a for a in get_args(annotation) if a is not type(None)]
        return args[0] if args else str
    return annotation


def _text(name: str, index: int, ctx: _Context) -> str:
    label = name.replace("_", " ")
    if name in _LONG_TEXT:
        return (
            f"Mock {label} {index + 1} ({ctx.seed}). This deterministic text stands in for a Gemini response "
            "so automated tests can run without calling the real API."
        )
    return f"Mock {label} {index + 1}"


def _value(name: str, annotation, index: int, ctx: _Context, parent: str):
    annotation = _unwrap_optional(annotation)
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return _build(annotation, ctx, index)
    if get_origin(annotation) is list:
        if name in _EMPTY_LISTS:
            return []
        (item_type,) = get_args(annotation) or (str,)
        return [_value(name, item_type, i, ctx, parent) for i in range(ctx.list_length(name))]
    if annotation is bool:
        return True
    if annotation is int:
        return 1 if name == "level" else 0
    if annotation is float:
        if name == "end_seconds":
            return float(index * 10 + 9)
        if name == "seconds":
            return float(index * 10 + 5)
        return float(index * 10)  # start_seconds and other offsets
    # Strings.
    if name == "type" and parent == "GeminiQuestion":
        return ctx.question_types[index % len(ctx.question_types)]
    if name in _FIXED:
        return _FIXED[name]
    if name == "options":
        return f"Option {chr(65 + index)}"
    return _text(name, index, ctx)


def _build(model: type[BaseModel], ctx: _Context, index: int = 0) -> dict:
    return {
        name: _value(name, field.annotation, index, ctx, model.__name__)
        for name, field in model.model_fields.items()
    }


def mock_response(response_schema: type[BaseModel], prompt: str) -> dict:
    """The JSON object the mock returns for one structured request (exposed for tests)."""
    return _build(response_schema, _Context(prompt))


class MockGeminiClient:
    """Stands in for GoogleGeminiClient. Same interface; never touches the network."""

    def __init__(self, settings: Settings) -> None:
        self.model = MOCK_MODEL_PREFIX + settings.gemini_model

    async def generate_structured(
        self,
        *,
        system_instruction: str,
        prompt: str,
        response_schema: type[BaseModel],
        media=None,
        media_resolution: str | None = None,
        model: str | None = None,
        max_output_tokens: int | None = None,
        error_context: str | None = None,
    ) -> GenerationResult:
        text = json.dumps(mock_response(response_schema, prompt), ensure_ascii=False)
        return GenerationResult(
            text=text,
            finish_reason="STOP",
            input_tokens=max(1, len(system_instruction + prompt) // 4),
            output_tokens=max(1, len(text) // 4),
        )


class MockEmbeddingProvider:
    """Hashed bag-of-words vectors: deterministic, unit length, and texts sharing words are similar."""

    name = "mock"

    def __init__(self, settings: Settings) -> None:
        self.model = MOCK_MODEL_PREFIX + settings.embedding_model
        self.dimensions = settings.embedding_dimensions

    def _vector(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for word in re.findall(r"\w+", text.lower()) or ["empty"]:
            digest = hashlib.sha256(word.encode("utf-8")).digest()
            slot = int.from_bytes(digest[:4], "big") % self.dimensions
            vector[slot] += 1.0 if digest[4] % 2 else -1.0
        norm = math.sqrt(sum(v * v for v in vector))
        if not norm:  # every word cancelled out: still return a valid unit vector
            vector[0], norm = 1.0, 1.0
        return [v / norm for v in vector]

    async def embed(self, texts: list[str], task) -> list[list[float]]:
        return [self._vector(text) for text in texts]
