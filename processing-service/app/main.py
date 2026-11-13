"""FastAPI application factory for the Briefly AI processing service.

This service performs content processing on behalf of the Node.js backend
(extraction, transcription and Gemini calls in later milestones). It is an
internal service: it binds to localhost by default and all /internal routes
require a shared secret.
"""

import logging

from fastapi import FastAPI, Request

from app.api import api_router
from app.core.config import get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import configure_logging
from app.services import usage


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    if settings.ai_mock_mode:
        logging.getLogger(__name__).warning(
            "AI_MOCK_MODE is on: generation and embeddings return deterministic test data; no request reaches Gemini."
        )

    app = FastAPI(
        title="Briefly AI Processing Service",
        version=settings.version,
        docs_url="/docs" if settings.show_docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.show_docs else None,
    )

    register_exception_handlers(app)

    @app.middleware("http")
    async def count_gemini_requests(request: Request, call_next):
        # Every Gemini request made while serving this call is reported to the backend's quota manager.
        cell = usage.start()
        response = await call_next(request)
        response.headers["X-Gemini-Requests"] = str(cell[0])
        return response

    app.include_router(api_router)

    logging.getLogger("app").info(
        "Processing service initialized (environment=%s, docs=%s)", settings.environment, settings.show_docs
    )
    return app


app = create_app()
