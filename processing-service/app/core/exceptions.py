"""Centralized exception handling.

Every error response uses the same envelope as the Node.js API:

    {"success": false, "error": {"code": "...", "message": "...", "details": [...]}}

Unexpected exceptions are logged server-side and reported to the caller only as
a generic message.
"""

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("app.errors")


class ServiceError(Exception):
    """An expected, client-facing error with a stable code.

    ``message`` must be safe to show to end users: never include exception
    text, URLs of internal systems, or secrets. ``retryable`` tells the caller
    (the BullMQ worker) whether repeating the request could succeed.
    """

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: Any = None,
        retryable: bool | None = None,
        meta: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.retryable = retryable
        # Machine-readable context for the caller (e.g. quota scope and provider retry delay).
        self.meta = meta


class UnauthorizedError(ServiceError):
    def __init__(self, message: str = "A valid internal service token is required.") -> None:
        super().__init__(401, "UNAUTHORIZED", message, retryable=False)


def error_response(
    status_code: int,
    code: str,
    message: str,
    details: Any = None,
    retryable: bool | None = None,
    meta: dict[str, Any] | None = None,
) -> JSONResponse:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    if retryable is not None:
        error["retryable"] = retryable
    if meta:
        error["meta"] = meta
    return JSONResponse(status_code=status_code, content={"success": False, "error": error})


_HTTP_CODES = {
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ServiceError)
    async def handle_service_error(_request: Request, exc: ServiceError) -> JSONResponse:
        return error_response(exc.status_code, exc.code, exc.message, exc.details, exc.retryable, exc.meta)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {
                "field": ".".join(str(part) for part in err["loc"] if part != "body") or "body",
                "message": err["msg"],
            }
            for err in exc.errors()
        ]
        return error_response(422, "VALIDATION_ERROR", "Request validation failed.", details)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(exc.status_code, "HTTP_ERROR")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return error_response(exc.status_code, code, message)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return error_response(500, "INTERNAL_ERROR", "An unexpected error occurred.")
