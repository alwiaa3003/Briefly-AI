'use strict';

/**
 * HTTP client for the internal Python processing service.
 *
 * Every request carries the shared secret in the X-Internal-Token header.
 * Errors are normalized into ProcessingServiceError with a `retryable` flag so
 * background jobs know whether retrying could help (network failures, 5xx,
 * 429) or not (4xx such as authentication or validation failures).
 */

const config = require('../config/env');
const aiGate = require('./ai/aiGate');

class ProcessingServiceError extends Error {
  constructor(message, { code, status = null, retryable, meta = null, geminiRequests = null }) {
    super(message);
    this.name = 'ProcessingServiceError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    // Quota context from the processing service (Gemini 429s): scope and the provider's retry delay.
    this.quotaScope = meta?.scope || null;
    this.retryAfterSeconds = Number.isFinite(meta?.retry_after_seconds) ? meta.retry_after_seconds : null;
    this.model = meta?.model || null;
    // Gemini requests the processing service actually made for this call (X-Gemini-Requests).
    this.geminiRequests = geminiRequests;
  }
}

const USER_FACING_CODE =
  /^(ARTICLE_[A-Z_]+|AI_[A-Z_]+|VIDEO_[A-Z_]+|MEDIA_[A-Z_]+|TRANSCRIPTION_[A-Z_]+|YOUTUBE_[A-Z_]+|DOCUMENT_[A-Z_]+|OCR_[A-Z_]+|EMBEDDING_[A-Z_]+|UNSAFE_URL|INVALID_URL|INVALID_YOUTUBE_URL)$/;

function geminiRequestsHeader(response) {
  const value = Number.parseInt(response.headers?.get?.('x-gemini-requests') ?? '', 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Performs a call and returns { data, requests } (requests = Gemini requests made by the processing service). */
async function requestRaw(path, { method = 'GET', body, timeoutMs = config.processingService.timeoutMs } = {}) {
  const url = `${config.processingService.url}${path}`;
  const headers = { Accept: 'application/json', 'X-Internal-Token': config.processingService.secret };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new ProcessingServiceError(
      timedOut ? 'The processing service timed out.' : 'The processing service is unreachable.',
      { code: timedOut ? 'PROCESSING_SERVICE_TIMEOUT' : 'PROCESSING_SERVICE_UNREACHABLE', retryable: true }
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const geminiRequests = geminiRequestsHeader(response);

  if (!response.ok) {
    const remote = (payload && payload.error) || {};
    // The processing service states explicitly whether a retry can help; fall back to the status code.
    const retryable =
      typeof remote.retryable === 'boolean' ? remote.retryable : response.status >= 500 || response.status === 429;

    // Content-processing errors carry messages written for end users (e.g. "The page could not be
    // found"). Anything else (auth, validation, internal errors) gets a generic message.
    if (typeof remote.code === 'string' && USER_FACING_CODE.test(remote.code) && typeof remote.message === 'string') {
      throw new ProcessingServiceError(remote.message.slice(0, 300), {
        code: remote.code,
        status: response.status,
        retryable,
        meta: remote.meta,
        geminiRequests,
      });
    }
    throw new ProcessingServiceError('The processing service could not complete the request.', {
      code: remote.code ? `PROCESSING_${remote.code}` : 'PROCESSING_SERVICE_ERROR',
      status: response.status,
      retryable,
      geminiRequests,
    });
  }

  if (!payload || payload.success !== true) {
    throw new ProcessingServiceError('The processing service returned an unexpected response.', {
      code: 'PROCESSING_SERVICE_BAD_RESPONSE',
      status: response.status,
      retryable: false,
      geminiRequests,
    });
  }

  return { data: payload.data, requests: geminiRequests };
}

async function request(path, options) {
  return (await requestRaw(path, options)).data;
}

/**
 * A call that uses Gemini: goes through the quota-aware request manager
 * (budgets, provider rate-limit state, concurrency, usage accounting).
 */
function aiRequest(kind, operation, path, options) {
  return aiGate.withAiCall({ kind, operation }, () => requestRaw(path, options));
}
const GEN = aiGate.KINDS.GENERATION;
const EMB = aiGate.KINDS.EMBEDDING;

aiGate.setModelLoader(() => request('/internal/ai/config', { timeoutMs: 3000 }));

/** GET /health — public liveness endpoint of the processing service. */
function checkHealth({ timeoutMs = 3000 } = {}) {
  return request('/health', { timeoutMs });
}

/** POST /internal/test — authenticated round-trip used by the test job. */
function runInternalTest({ message, jobId }) {
  return request('/internal/test', { method: 'POST', body: { message, job_id: jobId } });
}

/** POST /internal/articles/extract — safe fetch + main-content extraction. */
function extractArticle({ url }) {
  return request('/internal/articles/extract', {
    method: 'POST',
    body: { url },
    timeoutMs: config.processingService.extractTimeoutMs,
  });
}

/** POST /internal/articles/summarize — Gemini summary of already-extracted text. */
function summarizeArticle({ url, title, author, publishedAt, siteName, content }) {
  return aiRequest(GEN, 'summarize', '/internal/articles/summarize', {
    method: 'POST',
    body: {
      url,
      title: title || null,
      author: author || null,
      published_at: publishedAt || null,
      site_name: siteName || null,
      content,
    },
    timeoutMs: config.processingService.summarizeTimeoutMs,
  });
}

/* ------------------------------ Videos ------------------------------ */

const prepareTimeout = () => config.processingService.videoPrepareTimeoutMs;
const transcribeTimeout = () => config.processingService.transcribeTimeoutMs;

/** POST /internal/youtube/metadata — official Data API (or oEmbed) metadata + availability checks. */
function getYouTubeMetadata({ videoId, maxDurationSeconds }) {
  return request('/internal/youtube/metadata', {
    method: 'POST',
    body: { video_id: videoId, max_duration_seconds: maxDurationSeconds ?? null },
    timeoutMs: prepareTimeout(),
  });
}

/** POST /internal/youtube/transcribe — one transcription window of a public YouTube video. */
function transcribeYouTube({ videoId, startSeconds, endSeconds }) {
  return aiRequest(GEN, 'transcribe', '/internal/youtube/transcribe', {
    method: 'POST',
    body: { video_id: videoId, start_seconds: startSeconds, end_seconds: endSeconds ?? null },
    timeoutMs: transcribeTimeout(),
  });
}

/** POST /internal/videos/probe — duration / audio check of an uploaded file via a signed URL. */
function probeVideo({ downloadUrl, container, maxDurationSeconds }) {
  return request('/internal/videos/probe', {
    method: 'POST',
    body: { download_url: downloadUrl, container, max_duration_seconds: maxDurationSeconds ?? null },
    timeoutMs: prepareTimeout(),
  });
}

/** POST /internal/videos/transcribe — audio extraction + transcription of one window of an upload. */
function transcribeUploadedVideo({ downloadUrl, container, startSeconds, endSeconds }) {
  return aiRequest(GEN, 'transcribe', '/internal/videos/transcribe', {
    method: 'POST',
    body: { download_url: downloadUrl, container, start_seconds: startSeconds, end_seconds: endSeconds },
    timeoutMs: transcribeTimeout(),
  });
}

/** POST /internal/videos/summarize — summary, chapters and key moments grounded in the transcript. */
function summarizeVideo({ sourceKind, title, channel, durationSeconds, language, segments }) {
  return aiRequest(GEN, 'summarize', '/internal/videos/summarize', {
    method: 'POST',
    body: {
      source_kind: sourceKind,
      title: title || null,
      channel: channel || null,
      duration_seconds: durationSeconds ?? null,
      language: language || null,
      segments: segments.map(({ start, end, text, speaker }) => ({ start, end, text, speaker: speaker || null })),
    },
    timeoutMs: config.processingService.summarizeTimeoutMs,
  });
}

/* ----------------------------- Documents ----------------------------- */

/** POST /internal/documents/extract — download + PDF/DOCX/TXT extraction into parts. */
function extractDocument({ downloadUrl, format, maxPages }) {
  return request('/internal/documents/extract', {
    method: 'POST',
    body: { download_url: downloadUrl, format, max_pages: maxPages ?? null },
    timeoutMs: config.processingService.documentExtractTimeoutMs,
  });
}

/** POST /internal/documents/ocr — OCR for a small batch of scanned PDF pages. */
function ocrDocumentPages({ downloadUrl, pages }) {
  return aiRequest(GEN, 'ocr', '/internal/documents/ocr', {
    method: 'POST',
    body: { download_url: downloadUrl, pages },
    timeoutMs: config.processingService.ocrTimeoutMs,
  });
}

const toPythonPart = (part) => ({
  index: part.index,
  page: part.page ?? null,
  heading_path: part.headingPath || [],
  blocks: (part.blocks || []).map((b) => ({ kind: b.kind, text: b.text, level: b.level ?? null })),
  needs_ocr: false,
  char_count: part.charCount || 0,
});

/** POST /internal/documents/summarize-chunk — map step: notes for one chunk of a long document. */
function summarizeDocumentChunk({ title, format, chunkIndex, chunkCount, parts }) {
  return aiRequest(GEN, 'summarize', '/internal/documents/summarize-chunk', {
    method: 'POST',
    body: { title: title || null, format, chunk_index: chunkIndex, chunk_count: chunkCount, parts: parts.map(toPythonPart) },
    timeoutMs: config.processingService.summarizeTimeoutMs,
  });
}

/** POST /internal/documents/summarize — direct summary, or reduce step over chunk notes. */
function summarizeDocument({ title, format, pageCount, mode, parts, notes, allowedPages, allowedSections, truncated }) {
  return aiRequest(GEN, 'summarize', '/internal/documents/summarize', {
    method: 'POST',
    body: {
      title: title || null,
      format,
      page_count: pageCount ?? null,
      mode,
      parts: parts ? parts.map(toPythonPart) : null,
      notes: notes || null,
      allowed_pages: allowedPages || [],
      allowed_sections: allowedSections || [],
      truncated: Boolean(truncated),
    },
    timeoutMs: config.processingService.documentSummarizeTimeoutMs,
  });
}

/* ------------------- Embeddings, Ask AI and study tools ------------------- */

/** POST /internal/ai/embeddings — vectors for chunks ("document") or a search query ("query"). */
function embedTexts({ texts, task }) {
  return aiRequest(EMB, 'embed', '/internal/ai/embeddings', {
    method: 'POST',
    body: { texts, task },
    timeoutMs: config.processingService.embedTimeoutMs,
  });
}

/** Chunks are sent with short ids ("c1", "c2", ...) that the model must cite. */
const toContextChunk = (chunk) => ({
  id: chunk.id,
  text: chunk.text,
  label: chunk.label || null,
  source_id: String(chunk.sourceId),
  source_title: chunk.sourceTitle ? String(chunk.sourceTitle).slice(0, 300) : null,
  source_kind: chunk.sourceKind,
});

/** POST /internal/ai/answer — grounded answer from retrieved chunks with validated citations. */
function answerQuestion({ question, history, chunks, scope, scopeTitle }) {
  return aiRequest(GEN, 'answer', '/internal/ai/answer', {
    method: 'POST',
    body: {
      question,
      history: history.map(({ role, content }) => ({ role, content })),
      chunks: chunks.map(toContextChunk),
      scope,
      scope_title: scopeTitle ? String(scopeTitle).slice(0, 300) : null,
    },
    timeoutMs: config.processingService.answerTimeoutMs,
  });
}

const STUDY_PATHS = Object.freeze({
  notes: '/internal/ai/study/notes',
  quiz: '/internal/ai/study/quiz',
  flashcards: '/internal/ai/study/flashcards',
  style: '/internal/ai/summaries/restyle',
});

/** Study notes / quiz / flashcards / summary style from a bounded selection of chunks. */
function generateStudy(tool, { title, sourceKind, summaryOverview, chunks, options = {} }) {
  return aiRequest(GEN, tool, STUDY_PATHS[tool], {
    method: 'POST',
    body: {
      title: title ? String(title).slice(0, 300) : null,
      source_kind: sourceKind,
      summary_overview: summaryOverview ? String(summaryOverview).slice(0, 4000) : null,
      chunks: chunks.map(toContextChunk),
      ...options,
    },
    timeoutMs: config.processingService.studyTimeoutMs,
  });
}

/** GET /internal/ai/config — configured models (no secrets). */
function getAiConfig() {
  return request('/internal/ai/config', { timeoutMs: 3000 });
}

module.exports = {
  getAiConfig,
  embedTexts,
  answerQuestion,
  generateStudy,
  extractDocument,
  ocrDocumentPages,
  summarizeDocumentChunk,
  summarizeDocument,
  checkHealth,
  runInternalTest,
  extractArticle,
  summarizeArticle,
  getYouTubeMetadata,
  transcribeYouTube,
  probeVideo,
  transcribeUploadedVideo,
  summarizeVideo,
  ProcessingServiceError,
};
