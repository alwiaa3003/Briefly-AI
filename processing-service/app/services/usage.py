"""Counts the Gemini API requests made while serving one internal HTTP request.

The count is returned to the Node backend in the ``X-Gemini-Requests`` response
header (also on errors), so its quota manager can account for every request
that actually reached Google, including validation retries, transcription
windows and embedding batches.
"""

from __future__ import annotations

from contextvars import ContextVar

_counter: ContextVar[list[int] | None] = ContextVar("gemini_requests", default=None)


def start() -> list[int]:
    """Starts a fresh counter for the current request (a mutable cell shared with child tasks)."""
    cell = [0]
    _counter.set(cell)
    return cell


def record(count: int = 1) -> None:
    cell = _counter.get()
    if cell is not None:
        cell[0] += count
