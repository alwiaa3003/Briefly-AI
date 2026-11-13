"""Internal endpoints. Every route here requires the X-Internal-Token header."""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.core.security import require_internal_token
from app.schemas.common import SuccessResponse
from app.schemas.internal import TestRequest, TestResult

router = APIRouter(
    prefix="/internal",
    tags=["internal"],
    dependencies=[Depends(require_internal_token)],
)


@router.post("/test", response_model=SuccessResponse[TestResult])
def internal_test(
    payload: TestRequest,
    settings: Annotated[Settings, Depends(get_settings)],
) -> SuccessResponse[TestResult]:
    """Round-trip used to verify Node.js -> Python communication and the job pipeline."""
    return SuccessResponse(
        data=TestResult(
            echo=payload.message,
            message_length=len(payload.message),
            job_id=payload.job_id,
            processed_by=settings.app_name,
            received_at=datetime.now(UTC),
        )
    )
