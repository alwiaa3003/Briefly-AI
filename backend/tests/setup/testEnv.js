'use strict';

/**
 * Deterministic environment for unit/API tests. These values are used only in
 * tests and never reach a real deployment. MONGODB_URI is a placeholder; each
 * test file connects to its own in-memory MongoDB instead.
 */
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGODB_URI: 'mongodb://127.0.0.1:1/unused-in-unit-tests',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789-abcdefghijklmnop',
  INTERNAL_SERVICE_SECRET: 'test-internal-secret-0123456789-abcdefghijklmnop',
  PROCESSING_SERVICE_URL: 'http://127.0.0.1:1',
  BCRYPT_SALT_ROUNDS: '4',
  AUTH_RATE_LIMIT_MAX: '1000',
  FRONTEND_ORIGIN: 'http://localhost:5173',
  // rateLimit.test.js lowers this inside an isolated module registry.
  ARTICLE_RATE_LIMIT_MAX: '1000',
  UPLOAD_RATE_LIMIT_MAX: '1000',
  CHAT_RATE_LIMIT_MAX: '1000',
  STUDY_RATE_LIMIT_MAX: '1000',
  SEARCH_RATE_LIMIT_MAX: '1000',
  // Small vectors keep embedding fakes readable; the exact store is used (no Atlas in tests).
  EMBEDDING_DIMENSIONS: '64',
  VECTOR_STORE: 'exact',
  RAG_CHUNK_CHARS: '400',
  RAG_CHUNK_OVERLAP_CHARS: '60',
  RAG_EMBED_BATCH_SIZE: '4',
  // Generous AI budgets so unrelated tests are never throttled; quota tests lower them explicitly.
  AI_APP_DAILY_GENERATION_LIMIT: '100000',
  AI_APP_DAILY_SUMMARY_LIMIT: '100000',
  AI_APP_DAILY_CHAT_LIMIT: '100000',
  AI_APP_DAILY_STUDY_LIMIT: '100000',
  AI_USER_DAILY_GENERATION_LIMIT: '100000',
  AI_APP_DAILY_EMBEDDING_LIMIT: '100000',
  AI_USER_DAILY_EMBEDDING_LIMIT: '100000',
  AI_GENERATION_RPM: '100000',
  AI_EMBEDDING_RPM: '100000',
  AI_MAX_CONCURRENT_GENERATIONS: '50',
  AI_MAX_CONCURRENT_EMBEDDINGS: '50',
  AI_GATE_STORE: 'memory',
  RAG_SEARCH_MIN_SCORE: '0',
  // Small limit so the oversize test only needs ~1 MB.
  UPLOAD_MAX_BYTES: String(1024 * 1024),
  // Documents: small limits so size, chunking (map-reduce) and OCR caps are exercised quickly.
  DOCUMENT_MAX_BYTES: String(1024 * 1024),
  DOCUMENT_SINGLE_PASS_CHARS: '5000',
  DOCUMENT_CHUNK_CHARS: '5000',
  DOCUMENT_MAX_OCR_PAGES: '3',
  DOCUMENT_OCR_BATCH_PAGES: '2',
});
