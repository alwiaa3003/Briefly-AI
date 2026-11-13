"""Internal document endpoints, called only by the Node.js worker.

  extract   download (signed URL) -> PDF/DOCX/TXT extraction -> parts (+ pages that need OCR)
  ocr       render scanned PDF pages -> OCR provider -> blocks per page
  summarize-chunk / summarize   map / reduce summarization with grounded references

Every request downloads into its own temporary directory, which is removed on
success and on failure.
"""

import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from app.core.config import Settings, get_settings
from app.core.exceptions import ServiceError
from app.core.security import require_internal_token
from app.documents.docx_extract import extract_docx
from app.documents.download import download_to_file
from app.documents.model import ExtractionResult
from app.documents.ocr import get_ocr_provider, render_page_png
from app.documents.pdf import extract_pdf, inspect_pdf
from app.documents.txt_extract import extract_txt
from app.processors.document_summarizer import summarize_chunk, summarize_document
from app.schemas.common import SuccessResponse
from app.schemas.documents import (
    ChunkSummarizeRequest,
    ChunkSummarizeResult,
    DocumentExtractRequest,
    DocumentOcrRequest,
    DocumentOcrResult,
    DocumentSummarizeRequest,
    DocumentSummarizeResult,
    OcrPageResult,
)
from app.services.gemini import LazyGeminiGenerator, StructuredGenerator

router = APIRouter(prefix="/internal/documents", tags=["documents"], dependencies=[Depends(require_internal_token)])

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_generator(settings: SettingsDep) -> StructuredGenerator:
    return LazyGeminiGenerator(settings)


GeneratorDep = Annotated[StructuredGenerator, Depends(get_generator)]

EXTRACTORS = {
    "pdf": lambda path, settings, max_pages: extract_pdf(path, settings, max_pages),
    "docx": lambda path, settings, _max_pages: extract_docx(path, settings),
    "txt": lambda path, settings, _max_pages: extract_txt(path, settings),
}


@router.post("/extract", response_model=SuccessResponse[ExtractionResult])
async def extract(payload: DocumentExtractRequest, settings: SettingsDep):
    with tempfile.TemporaryDirectory(prefix="briefly-doc-") as workdir:
        path = Path(workdir) / f"document.{payload.format}"
        await download_to_file(payload.download_url, path, settings)
        result = await run_in_threadpool(EXTRACTORS[payload.format], path, settings, payload.max_pages)
    return SuccessResponse(data=result)


@router.post("/ocr", response_model=SuccessResponse[DocumentOcrResult])
async def ocr(payload: DocumentOcrRequest, settings: SettingsDep, generator: GeneratorDep):
    if len(payload.pages) > settings.ocr_max_pages_per_request:
        raise ServiceError(422, "VALIDATION_ERROR", "Too many pages in one OCR request.", retryable=False)
    provider = get_ocr_provider(settings, generator)
    results: list[OcrPageResult] = []
    with tempfile.TemporaryDirectory(prefix="briefly-ocr-") as workdir:
        path = Path(workdir) / "document.pdf"
        await download_to_file(payload.download_url, path, settings)
        page_count, _ = await run_in_threadpool(inspect_pdf, path)
        for page in payload.pages:
            if page > page_count:
                raise ServiceError(422, "DOCUMENT_INVALID", "The requested page does not exist.", retryable=False)
            image = await run_in_threadpool(render_page_png, path, page, settings.ocr_dpi)
            results.append(OcrPageResult(page=page, blocks=await provider.recognize(image, page)))
    return SuccessResponse(data=DocumentOcrResult(pages=results, provider=provider.name, model=provider.model))


@router.post("/summarize-chunk", response_model=SuccessResponse[ChunkSummarizeResult])
async def chunk(payload: ChunkSummarizeRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await summarize_chunk(payload, settings, generator))


@router.post("/summarize", response_model=SuccessResponse[DocumentSummarizeResult])
async def summarize(payload: DocumentSummarizeRequest, settings: SettingsDep, generator: GeneratorDep):
    return SuccessResponse(data=await summarize_document(payload, settings, generator))
