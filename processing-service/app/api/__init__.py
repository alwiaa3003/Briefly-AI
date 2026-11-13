"""HTTP routers."""

from fastapi import APIRouter

from app.api.routes import ai, articles, documents, health, internal, videos

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(internal.router)
api_router.include_router(articles.router)
api_router.include_router(videos.router)
api_router.include_router(documents.router)
api_router.include_router(ai.router)
