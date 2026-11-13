"""Internal AI endpoints (embeddings, RAG answers, study tools), called only by the Node backend."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.core.security import require_internal_token
from app.processors.rag import answer_question
from app.processors.study import generate_flashcards, generate_notes, generate_quiz, restyle_summary
from app.schemas.ai import (
    AnswerRequest,
    AnswerResult,
    EmbedRequest,
    EmbedResult,
    FlashcardRequest,
    FlashcardsResult,
    NotesResult,
    QuizRequest,
    QuizResult,
    RestyleRequest,
    RestyleResult,
    StudyRequest,
)
from app.schemas.common import SuccessResponse
from app.services.embeddings import EmbeddingProvider, LazyEmbeddingProvider
from app.services.gemini import LazyGeminiGenerator, StructuredGenerator

router = APIRouter(prefix="/internal/ai", tags=["ai"], dependencies=[Depends(require_internal_token)])

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_generator(settings: SettingsDep) -> StructuredGenerator:
    return LazyGeminiGenerator(settings)


def get_embedder(settings: SettingsDep) -> EmbeddingProvider:
    return LazyEmbeddingProvider(settings)


GeneratorDep = Annotated[StructuredGenerator, Depends(get_generator)]
EmbedderDep = Annotated[EmbeddingProvider, Depends(get_embedder)]


@router.post("/embeddings", response_model=SuccessResponse[EmbedResult])
async def embeddings(payload: EmbedRequest, embedder: EmbedderDep):
    vectors = await embedder.embed(payload.texts, payload.task)
    return SuccessResponse(
        data=EmbedResult(vectors=vectors, model=embedder.model, dimensions=embedder.dimensions, provider=embedder.name)
    )


@router.post("/answer", response_model=SuccessResponse[AnswerResult])
async def answer(payload: AnswerRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await answer_question(payload, settings, generator))


@router.post("/study/notes", response_model=SuccessResponse[NotesResult])
async def notes(payload: StudyRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await generate_notes(payload, settings, generator))


@router.post("/study/quiz", response_model=SuccessResponse[QuizResult])
async def quiz(payload: QuizRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await generate_quiz(payload, settings, generator))


@router.post("/study/flashcards", response_model=SuccessResponse[FlashcardsResult])
async def flashcards(payload: FlashcardRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await generate_flashcards(payload, settings, generator))


@router.post("/summaries/restyle", response_model=SuccessResponse[RestyleResult])
async def restyle(payload: RestyleRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await restyle_summary(payload, settings, generator))


@router.get("/config")
async def ai_config(settings: SettingsDep):
    """Which models this service uses (no secrets). The backend keys its quota tracking by these names."""
    from app.services.gemini import GEMINI_API_VERSION

    return SuccessResponse(
        data={
            "configured": settings.gemini_configured or settings.ai_mock_mode,
            "mock_mode": settings.ai_mock_mode,
            "api_version": GEMINI_API_VERSION,
            "generation_model": settings.gemini_model,
            "transcription_model": settings.effective_transcription_model,
            "ocr_model": settings.effective_ocr_model,
            "embedding_model": settings.embedding_model,
            "embedding_dimensions": settings.embedding_dimensions,
        }
    )
