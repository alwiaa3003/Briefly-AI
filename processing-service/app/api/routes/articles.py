"""Internal article endpoints, called only by the Node.js worker."""

from typing import Annotated

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings, get_settings
from app.core.security import require_internal_token
from app.extractors.article import extract_article
from app.extractors.fetcher import fetch_article_page
from app.processors.article_summarizer import summarize_article
from app.schemas.articles import ExtractRequest, ExtractResult, SummarizeRequest, SummarizeResult
from app.schemas.common import SuccessResponse
from app.services.gemini import LazyGeminiGenerator, StructuredGenerator

router = APIRouter(
    prefix="/internal/articles",
    tags=["articles"],
    dependencies=[Depends(require_internal_token)],
)


def get_generator(settings: Annotated[Settings, Depends(get_settings)]) -> StructuredGenerator:
    return LazyGeminiGenerator(settings)


@router.post("/extract", response_model=SuccessResponse[ExtractResult])
async def extract(
    payload: ExtractRequest, settings: Annotated[Settings, Depends(get_settings)]
) -> SuccessResponse[ExtractResult]:
    page = await fetch_article_page(payload.url, settings)
    # Parsing is CPU-bound; keep it off the event loop.
    article = await run_in_threadpool(extract_article, page.body, page.final_url, settings)
    return SuccessResponse(
        data=ExtractResult(
            requested_url=page.requested_url,
            final_url=page.final_url,
            canonical_url=article.canonical_url or page.final_url,
            title=article.title,
            author=article.author,
            published_at=article.published_at,
            site_name=article.site_name,
            description=article.description,
            language=article.language,
            content=article.content,
            word_count=article.word_count,
            content_truncated=article.content_truncated,
        )
    )


@router.post("/summarize", response_model=SuccessResponse[SummarizeResult])
async def summarize(
    payload: SummarizeRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    generator: Annotated[StructuredGenerator, Depends(get_generator)],
) -> SuccessResponse[SummarizeResult]:
    return SuccessResponse(data=await summarize_article(payload, settings, generator))
