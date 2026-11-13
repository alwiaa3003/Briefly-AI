"""Shared response envelope matching the Node.js API."""

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class SuccessResponse(BaseModel, Generic[T]):
    success: Literal[True] = True
    data: T


class HealthData(BaseModel):
    status: Literal["ok"]
    service: str
    version: str
