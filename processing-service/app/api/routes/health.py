from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.schemas.common import HealthData, SuccessResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=SuccessResponse[HealthData])
def health(settings: Annotated[Settings, Depends(get_settings)]) -> SuccessResponse[HealthData]:
    """Public liveness check. Reveals nothing beyond service name and version."""
    return SuccessResponse(data=HealthData(status="ok", service=settings.app_name, version=settings.version))
