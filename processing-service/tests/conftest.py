import os

# Test configuration must be in place before the app (and its cached settings) is imported.
TEST_SECRET = "test-internal-secret-0123456789-abcdefghijklmnop"
os.environ["ENVIRONMENT"] = "test"
os.environ["INTERNAL_SERVICE_SECRET"] = TEST_SECRET
os.environ["LOG_LEVEL"] = "WARNING"

# Real Gemini calls are opt-in: RUN_LIVE_GEMINI=1 runs only the tests marked `live_gemini`
# (tests/test_live_gemini.py), with the key from processing-service/.env.
LIVE_GEMINI = os.environ.get("RUN_LIVE_GEMINI") == "1"
if not LIVE_GEMINI:
    # Environment variables take precedence over .env: routine tests never even load the real key,
    # and a mock-mode flag in a local .env cannot leak into them.
    os.environ["GEMINI_API_KEY"] = "test-gemini-key-not-a-real-key"
    os.environ["AI_MOCK_MODE"] = "false"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from google import genai  # noqa: E402

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()

from app.main import create_app  # noqa: E402

# Every attempt to reach Gemini from a routine test (see BlockedGeminiClient).
BLOCKED_GEMINI_CALLS: list[str] = []


class RealGeminiCallBlocked(RuntimeError):
    """Raised when a routine test tries to send a request to Gemini."""


class _BlockedModels:
    async def generate_content(self, *args, **kwargs):
        BLOCKED_GEMINI_CALLS.append("generate_content")
        raise RealGeminiCallBlocked("Routine tests must not call Gemini (generate_content). Use a fake or AI_MOCK_MODE.")

    async def embed_content(self, *args, **kwargs):
        BLOCKED_GEMINI_CALLS.append("embed_content")
        raise RealGeminiCallBlocked("Routine tests must not call Gemini (embed_content). Use a fake or AI_MOCK_MODE.")


class BlockedGeminiClient:
    """Replaces google.genai.Client in routine tests: it can be constructed, but never sends a request."""

    def __init__(self, *args, **kwargs):
        self.aio = type("Aio", (), {"models": _BlockedModels()})()
        self.models = self.aio.models


@pytest.fixture(autouse=True, scope="session")
def _block_real_gemini():
    if LIVE_GEMINI:
        yield
        return
    original = genai.Client
    genai.Client = BlockedGeminiClient  # gemini.py and embeddings.py both resolve genai.Client at call time
    try:
        yield
    finally:
        genai.Client = original


def pytest_configure(config):
    config.addinivalue_line("markers", "live_gemini: calls the real Gemini API (opt-in with RUN_LIVE_GEMINI=1)")


def pytest_collection_modifyitems(config, items):
    if LIVE_GEMINI:
        # Opt-in runs execute only the live tests, so nothing else can spend quota by accident.
        skip = pytest.mark.skip(reason="RUN_LIVE_GEMINI=1 runs only tests marked live_gemini")
        for item in items:
            if "live_gemini" not in item.keywords:
                item.add_marker(skip)
        return
    skip_live = pytest.mark.skip(reason="real Gemini test: set RUN_LIVE_GEMINI=1 to run it")
    for item in items:
        if "live_gemini" in item.keywords:
            item.add_marker(skip_live)


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    if LIVE_GEMINI:
        terminalreporter.write_line("Real Gemini API: ENABLED for tests marked live_gemini (RUN_LIVE_GEMINI=1).")
        return
    terminalreporter.write_line(
        f"Real Gemini API calls attempted by routine tests: {len(BLOCKED_GEMINI_CALLS)} (all blocked; real key not loaded)"
    )


def pytest_sessionfinish(session, exitstatus):
    # A blocked call may be swallowed by error mapping inside the code under test; fail the run anyway.
    if not LIVE_GEMINI and BLOCKED_GEMINI_CALLS:
        session.exitstatus = 1


@pytest.fixture()
def client() -> TestClient:
    get_settings.cache_clear()
    return TestClient(create_app(), raise_server_exceptions=False)


@pytest.fixture()
def auth_headers() -> dict[str, str]:
    return {"X-Internal-Token": TEST_SECRET}
