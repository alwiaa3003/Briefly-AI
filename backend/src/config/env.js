'use strict';

/**
 * Centralized, validated configuration.
 *
 * Every environment variable the API or worker reads is parsed here exactly
 * once. Invalid or missing values fail fast at startup with a single
 * descriptive error instead of surfacing later as obscure runtime bugs.
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const errors = [];
const PLACEHOLDER_PATTERN = /^change[-_]?me/i;

function readString(name, { required = false, defaultValue, minLength, secret = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === '' ? defaultValue : raw.trim();

  if (required && (value === undefined || value === '')) {
    errors.push(`${name} is required.`);
    return value;
  }
  if (value && minLength && value.length < minLength) {
    errors.push(`${name} must be at least ${minLength} characters long.`);
  }
  if (value && secret && PLACEHOLDER_PATTERN.test(value)) {
    errors.push(`${name} still contains the placeholder value from .env.example. Generate a real secret.`);
  }
  return value;
}

function readInt(name, defaultValue, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}.`);
    return defaultValue;
  }
  return value;
}

function readBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  errors.push(`${name} must be a boolean (true/false).`);
  return defaultValue;
}

function readEnum(name, defaultValue, allowed) {
  const value = readString(name, { defaultValue });
  if (!allowed.includes(value)) {
    errors.push(`${name} must be one of: ${allowed.join(', ')}.`);
    return defaultValue;
  }
  return value;
}

function readNumber(name, defaultValue, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push(`${name} must be a number between ${min} and ${max}.`);
    return defaultValue;
  }
  return value;
}

function readTimeZone(name, defaultValue) {
  const value = readString(name, { defaultValue });
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return value;
  } catch {
    errors.push(`${name} must be an IANA time zone such as America/Los_Angeles.`);
    return defaultValue;
  }
}

function readList(name, defaultValue) {
  const value = readString(name, { defaultValue });
  return value
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const env = readString('NODE_ENV', { defaultValue: 'development' });
const isProduction = env === 'production';
const isTest = env === 'test';

const config = Object.freeze({
  env,
  isProduction,
  isTest,
  port: readInt('PORT', 5000, { min: 1, max: 65535 }),
  trustProxy: readInt('TRUST_PROXY', 0, { min: 0, max: 10 }),

  cors: Object.freeze({
    allowedOrigins: Object.freeze(readList('FRONTEND_ORIGIN', 'http://localhost:5173')),
  }),

  mongodb: Object.freeze({
    uri: readString('MONGODB_URI', { required: true }),
  }),

  redis: Object.freeze({
    url: readString('REDIS_URL', { defaultValue: 'redis://127.0.0.1:6379' }),
  }),

  queue: Object.freeze({
    prefix: readString('QUEUE_PREFIX', { defaultValue: 'briefly' }),
    workerConcurrency: readInt('WORKER_CONCURRENCY', 2, { min: 1, max: 50 }),
    maxAttempts: readInt('JOB_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
    backoffMs: readInt('JOB_BACKOFF_MS', 2000, { min: 100, max: 600000 }),
    // The worker only starts taking jobs once the shared Redis (AI budgets) is ready; it exits if that takes longer.
    redisReadyTimeoutMs: readInt('WORKER_REDIS_READY_TIMEOUT_MS', 60000, { min: 1000, max: 600000 }),
  }),

  auth: Object.freeze({
    accessTokenSecret: readString('JWT_ACCESS_SECRET', { required: true, minLength: 32, secret: true }),
    accessTokenExpiresIn: readString('JWT_ACCESS_EXPIRES_IN', { defaultValue: '15m' }),
    issuer: 'briefly-ai-api',
    audience: 'briefly-ai-web',
    refreshTokenTtlDays: readInt('REFRESH_TOKEN_TTL_DAYS', 7, { min: 1, max: 90 }),
    refreshCookieName: 'briefly_rt',
    cookieSecure: readBool('COOKIE_SECURE', isProduction),
    bcryptSaltRounds: readInt('BCRYPT_SALT_ROUNDS', 12, { min: 4, max: 15 }),
  }),

  rateLimit: Object.freeze({
    authWindowMs: 15 * 60 * 1000,
    authMax: readInt('AUTH_RATE_LIMIT_MAX', 20, { min: 1, max: 100000 }),
    jobWindowMs: 15 * 60 * 1000,
    jobMax: readInt('JOB_RATE_LIMIT_MAX', 30, { min: 1, max: 100000 }),
    // Article submissions per user per hour (each one costs a Gemini call).
    articleWindowMs: 60 * 60 * 1000,
    articleMax: readInt('ARTICLE_RATE_LIMIT_MAX', 20, { min: 1, max: 100000 }),
    // Video uploads per user per hour.
    uploadMax: readInt('UPLOAD_RATE_LIMIT_MAX', 10, { min: 1, max: 100000 }),
    // Ask AI questions, study-tool generations and smart searches per user per hour.
    chatMax: readInt('CHAT_RATE_LIMIT_MAX', 60, { min: 1, max: 100000 }),
    studyMax: readInt('STUDY_RATE_LIMIT_MAX', 30, { min: 1, max: 100000 }),
    searchMax: readInt('SEARCH_RATE_LIMIT_MAX', 120, { min: 1, max: 100000 }),
  }),

  processingService: Object.freeze({
    url: readString('PROCESSING_SERVICE_URL', { defaultValue: 'http://127.0.0.1:8000' }).replace(/\/+$/, ''),
    secret: readString('INTERNAL_SERVICE_SECRET', { required: true, minLength: 32, secret: true }),
    timeoutMs: readInt('PROCESSING_SERVICE_TIMEOUT_MS', 10000, { min: 500, max: 300000 }),
    // Fetching + extracting an article (the Python service caps a fetch at ~35s).
    extractTimeoutMs: readInt('PROCESSING_EXTRACT_TIMEOUT_MS', 45000, { min: 1000, max: 600000 }),
    // Gemini summarization (up to two generation attempts on the Python side).
    summarizeTimeoutMs: readInt('PROCESSING_SUMMARIZE_TIMEOUT_MS', 200000, { min: 1000, max: 900000 }),
    // Video metadata / probe calls.
    videoPrepareTimeoutMs: readInt('PROCESSING_VIDEO_PREPARE_TIMEOUT_MS', 120000, { min: 1000, max: 900000 }),
    // One transcription window (audio extraction + Gemini, two attempts).
    transcribeTimeoutMs: readInt('PROCESSING_TRANSCRIBE_TIMEOUT_MS', 420000, { min: 1000, max: 1800000 }),
    // Document extraction (large PDFs take minutes), OCR batches and (hierarchical) summarization.
    documentExtractTimeoutMs: readInt('PROCESSING_DOCUMENT_EXTRACT_TIMEOUT_MS', 600000, { min: 1000, max: 3600000 }),
    ocrTimeoutMs: readInt('PROCESSING_OCR_TIMEOUT_MS', 420000, { min: 1000, max: 1800000 }),
    documentSummarizeTimeoutMs: readInt('PROCESSING_DOCUMENT_SUMMARIZE_TIMEOUT_MS', 900000, { min: 1000, max: 3600000 }),
    // Embedding a batch of chunks / a search query.
    embedTimeoutMs: readInt('PROCESSING_EMBED_TIMEOUT_MS', 60000, { min: 1000, max: 600000 }),
    // Ask AI answers run while the user waits (two generation attempts at most).
    answerTimeoutMs: readInt('PROCESSING_ANSWER_TIMEOUT_MS', 90000, { min: 1000, max: 600000 }),
    // Study notes, quizzes, flashcards and summary styles (background jobs).
    studyTimeoutMs: readInt('PROCESSING_STUDY_TIMEOUT_MS', 300000, { min: 1000, max: 1800000 }),
  }),

  // S3-compatible object storage (Cloudflare R2, AWS S3, MinIO, ...) for uploaded videos.
  // Uploads are disabled (HTTP 503 with setup instructions) unless all of these are set.
  storage: Object.freeze({
    endpoint: readString('STORAGE_ENDPOINT'),
    region: readString('STORAGE_REGION', { defaultValue: 'auto' }),
    bucket: readString('STORAGE_BUCKET'),
    accessKeyId: readString('STORAGE_ACCESS_KEY_ID', { secret: true }),
    secretAccessKey: readString('STORAGE_SECRET_ACCESS_KEY', { secret: true }),
    forcePathStyle: readBool('STORAGE_FORCE_PATH_STYLE', false),
    signedUrlTtlSeconds: readInt('STORAGE_SIGNED_URL_TTL_SECONDS', 900, { min: 60, max: 43200 }),
  }),

  uploads: Object.freeze({
    maxBytes: readInt('UPLOAD_MAX_BYTES', 500 * 1024 * 1024, { min: 1024, max: 5 * 1024 * 1024 * 1024 }),
    maxDurationMinutes: readInt('VIDEO_MAX_DURATION_MINUTES', 180, { min: 1, max: 1440 }),
    // Uploaded video files are deleted after this many days; transcripts and summaries remain.
    retentionDays: readInt('UPLOAD_RETENTION_DAYS', 7, { min: 1, max: 3650 }),
    // Files of uploads that failed permanently are deleted after this many hours.
    failedRetentionHours: readInt('UPLOAD_FAILED_RETENTION_HOURS', 24, { min: 1, max: 720 }),
  }),

  documents: Object.freeze({
    maxBytes: readInt('DOCUMENT_MAX_BYTES', 50 * 1024 * 1024, { min: 1024, max: 1024 * 1024 * 1024 }),
    maxPages: readInt('DOCUMENT_MAX_PAGES', 1000, { min: 1, max: 10000 }),
    // Original files are deleted after this many days; extracted text and summaries remain.
    retentionDays: readInt('DOCUMENT_RETENTION_DAYS', 30, { min: 1, max: 3650 }),
    // Documents up to this many extracted characters are summarized in a single request (~37k tokens).
    singlePassChars: readInt('DOCUMENT_SINGLE_PASS_CHARS', 150000, { min: 5000, max: 2000000 }),
    // Longer documents are split into chunks of about this size (map step).
    chunkChars: readInt('DOCUMENT_CHUNK_CHARS', 60000, { min: 5000, max: 1000000 }),
    // Cost control: scanned pages beyond this are not OCR'd (the summary says so).
    maxOcrPages: readInt('DOCUMENT_MAX_OCR_PAGES', 50, { min: 0, max: 2000 }),
    ocrBatchPages: readInt('DOCUMENT_OCR_BATCH_PAGES', 5, { min: 1, max: 20 }),
  }),

  video: Object.freeze({
    // Long recordings are transcribed in windows of this length.
    transcriptionChunkSeconds: readInt('TRANSCRIPTION_CHUNK_SECONDS', 600, { min: 60, max: 3600 }),
    youtubeMaxDurationMinutes: readInt('YOUTUBE_MAX_DURATION_MINUTES', 180, { min: 1, max: 1440 }),
  }),

  // Retrieval-augmented generation (Ask AI, smart search, study tools). See docs/ARCHITECTURE.md.
  rag: Object.freeze({
    // atlas = MongoDB Atlas Vector Search; exact = in-process cosine scan (tests / non-Atlas MongoDB);
    // auto = Atlas when the vector index exists and is queryable, exact otherwise.
    vectorStore: readEnum('VECTOR_STORE', 'auto', ['auto', 'atlas', 'exact']),
    vectorIndexName: readString('VECTOR_INDEX_NAME', { defaultValue: 'content_chunks_vector' }),
    // Must equal EMBEDDING_DIMENSIONS of the processing service and the Atlas index definition.
    embeddingDimensions: readInt('EMBEDDING_DIMENSIONS', 768, { min: 64, max: 3072 }),
    autoIndex: readBool('RAG_AUTO_INDEX', true),
    chunkChars: readInt('RAG_CHUNK_CHARS', 1200, { min: 300, max: 6000 }),
    chunkOverlapChars: readInt('RAG_CHUNK_OVERLAP_CHARS', 150, { min: 0, max: 1000 }),
    maxChunksPerSource: readInt('RAG_MAX_CHUNKS_PER_SOURCE', 3000, { min: 10, max: 50000 }),
    embedBatchSize: readInt('RAG_EMBED_BATCH_SIZE', 64, { min: 1, max: 250 }),
    topK: readInt('RAG_TOP_K', 8, { min: 1, max: 30 }),
    numCandidates: readInt('RAG_NUM_CANDIDATES', 150, { min: 10, max: 2000 }),
    // Upper bound of chunks scanned by the exact (non-Atlas) vector store.
    exactScanLimit: readInt('RAG_EXACT_SCAN_LIMIT', 20000, { min: 100, max: 500000 }),
    chatHistoryMessages: readInt('CHAT_HISTORY_MESSAGES', 8, { min: 0, max: 20 }),
    chatMaxMessageChars: readInt('CHAT_MAX_MESSAGE_CHARS', 2000, { min: 100, max: 2000 }),
    // Characters of source content sent to one study-tool generation (representative sample).
    studyInputChars: readInt('STUDY_INPUT_CHARS', 60000, { min: 5000, max: 1000000 }),
    // Smart search: minimum semantic relevance (cosine similarity mapped to 0..1, the scale of Atlas
    // vectorSearchScore). Chunks below it are dropped, so unrelated sources are not returned.
    searchMinScore: readNumber('RAG_SEARCH_MIN_SCORE', 0.8, { min: 0, max: 1 }),
    // Ask AI retrieval threshold (0 = off): the answer model already reports "not found" for weak context.
    chatMinScore: readNumber('RAG_CHAT_MIN_SCORE', 0, { min: 0, max: 1 }),
  }),

  // Briefly's OWN protective limits for Gemini usage (not Google's quotas, which are set per project
  // by Google, can change, and are visible in Google AI Studio). Defaults are deliberately conservative
  // for a free-tier project; raise them only after checking your quotas in AI Studio.
  ai: Object.freeze({
    // Daily budgets reset at midnight in this time zone (Google resets daily quotas at midnight Pacific).
    budgetTimeZone: readTimeZone('AI_BUDGET_TIMEZONE', 'America/Los_Angeles'),
    appDailyGenerationLimit: readInt('AI_APP_DAILY_GENERATION_LIMIT', 15, { min: 1, max: 10000000 }),
    featureDailyGenerationLimits: Object.freeze({
      summary: readInt('AI_APP_DAILY_SUMMARY_LIMIT', 10, { min: 1, max: 10000000 }),
      chat: readInt('AI_APP_DAILY_CHAT_LIMIT', 8, { min: 1, max: 10000000 }),
      study: readInt('AI_APP_DAILY_STUDY_LIMIT', 6, { min: 1, max: 10000000 }),
    }),
    userDailyGenerationLimit: readInt('AI_USER_DAILY_GENERATION_LIMIT', 10, { min: 1, max: 10000000 }),
    appDailyEmbeddingLimit: readInt('AI_APP_DAILY_EMBEDDING_LIMIT', 500, { min: 1, max: 10000000 }),
    userDailyEmbeddingLimit: readInt('AI_USER_DAILY_EMBEDDING_LIMIT', 200, { min: 1, max: 10000000 }),
    // Requests per minute that Briefly allows itself (kept below the provider's per-minute limits).
    generationPerMinute: readInt('AI_GENERATION_RPM', 4, { min: 1, max: 100000 }),
    embeddingPerMinute: readInt('AI_EMBEDDING_RPM', 30, { min: 1, max: 100000 }),
    maxConcurrentGenerations: readInt('AI_MAX_CONCURRENT_GENERATIONS', 2, { min: 1, max: 100 }),
    maxConcurrentEmbeddings: readInt('AI_MAX_CONCURRENT_EMBEDDINGS', 2, { min: 1, max: 100 }),
    // Used only when Gemini does not say how long to wait.
    rateLimitFallbackSeconds: readInt('AI_RATE_LIMIT_FALLBACK_SECONDS', 60, { min: 5, max: 86400 }),
    quotaFallbackSeconds: readInt('AI_QUOTA_FALLBACK_SECONDS', 3600, { min: 60, max: 86400 }),
    // Background jobs waiting for quota are re-scheduled (delayed, without occupying a worker) at most
    // this many times / for this long; then they fail with a clear message and can be retried manually.
    maxDeferrals: readInt('AI_MAX_DEFERRALS', 30, { min: 1, max: 1000 }),
    maxDeferHours: readInt('AI_MAX_DEFER_HOURS', 48, { min: 1, max: 720 }),
    maxDelaySeconds: readInt('AI_MAX_DELAY_SECONDS', 6 * 3600, { min: 10, max: 86400 }),
    // Transient AI failures (overloaded model, timeouts): delayed retries starting at this delay.
    transientRetrySeconds: readInt('AI_TRANSIENT_RETRY_SECONDS', 20, { min: 1, max: 3600 }),
    // memory = per process (tests / single process); redis = shared by API and workers; auto = redis when connected.
    store: readEnum('AI_GATE_STORE', 'auto', ['auto', 'redis', 'memory']),
  }),

  http: Object.freeze({
    jsonBodyLimit: '100kb',
  }),
});

const storageValues = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].map((key) => config.storage[key]);
const storageSetCount = storageValues.filter(Boolean).length;
if (storageSetCount > 0 && storageSetCount < storageValues.length) {
  errors.push(
    'Object storage is partially configured. Set all of STORAGE_ENDPOINT, STORAGE_BUCKET, ' +
      'STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY, or none of them.'
  );
}
if (config.storage.endpoint && !/^https?:\/\//.test(config.storage.endpoint)) {
  errors.push('STORAGE_ENDPOINT must be an http(s) URL.');
}

if (isProduction && !config.auth.cookieSecure) {
  errors.push('COOKIE_SECURE must be true in production.');
}

if (errors.length > 0) {
  const message = `Invalid configuration:\n  - ${errors.join('\n  - ')}\nSee backend/.env.example.`;
  throw new Error(message);
}

module.exports = config;
