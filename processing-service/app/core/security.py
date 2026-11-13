"""Internal service authentication.

Callers (the Express API and BullMQ workers) must send the shared secret in the
``X-Internal-Token`` header. The comparison is constant-time.
"""

import hmac
from typing import Annotated

from fastapi import Depends, Header

from app.core.config import Settings, get_settings
from app.core.exceptions import UnauthorizedError

INTERNAL_TOKEN_HEADER = "X-Internal-Token"


def require_internal_token(
    settings: Annotated[Settings, Depends(get_settings)],
    x_internal_token: Annotated[str | None, Header(alias=INTERNAL_TOKEN_HEADER)] = None,
) -> None:
    if not x_internal_token:
        raise UnauthorizedError()

    expected = settings.internal_service_secret.get_secret_value().encode("utf-8")
    if not hmac.compare_digest(x_internal_token.encode("utf-8"), expected):
        raise UnauthorizedError()
