# Briefly AI — Architecture

This document describes the system as of **Milestone 4 (document summarization)** and the direction it is designed to grow in.

## 1. Service responsibilities

### Frontend (`frontend/`)
- React SPA served by Vite. It owns presentation and client-side validation only.
- Holds the **access token in memory** (module variable in `services/apiClient.js`), never in `localStorage`/`sessionStorage`.
- Talks only to the Express API under `/api`. In development the Vite dev server proxies `/api` to `http://localhost:5000`, so the browser sees a single origin and the refresh cookie stays first-party.
- Never talks to the processing service and never sees any secret or API key. Anything prefixed `VITE_` is public.

### Express API (`backend/src/server.js`)
- Public entry point for all client traffic.
- Responsibilities: authentication and sessions, request validation (zod), authorization (ownership checks), persistence (Mongoose), job submission (BullMQ), and health/readiness reporting.
- Stateless across instances: sessions live in MongoDB and queue state in Redis, so the API can be scaled horizontally.

### Worker (`backend/src/workers/index.js`)
- Separate Node.js process sharing the backend codebase (models, config, services).
- Consumes the `processing` BullMQ queue, calls the processing service, and records job progress and results in MongoDB.
- Kept separate so long-running processing never blocks HTTP handling, and so workers can be scaled independently of the API.

### Processing service (`processing-service/`)
- Internal FastAPI service for CPU/IO-heavy and Python-ecosystem work. It fetches and extracts articles (M2), reads YouTube metadata, probes uploaded videos and extracts their audio with ffmpeg, transcribes through a pluggable provider (Gemini) and calls Gemini for summaries (M3). It also extracts PDF/DOCX/TXT documents, OCRs scanned pages and runs map-reduce document summaries (M4).
- **Not public:** binds to `127.0.0.1` by default, and every `/internal/*` route requires the shared secret. In production it should sit on a private network with no public ingress.
- Stateless: it receives everything it needs in the request and returns results; it does not access MongoDB directly. This keeps data ownership and authorization in one place (the Node backend).

### MongoDB and Redis
- MongoDB is the system of record (users, sessions, jobs; later sources, summaries, conversations).
- Redis holds only transient BullMQ state. Losing Redis loses in-flight queue entries but no user data. Redis must run with `maxmemory-policy noeviction`.

## 2. Communication between services

| From → To | Protocol | Auth | Notes |
|---|---|---|---|
| Browser → API | HTTPS/JSON (`/api`) | Bearer access token; refresh cookie on `/api/auth/*` | CORS restricted to `FRONTEND_ORIGIN`, credentials enabled |
| API → MongoDB | MongoDB wire protocol | connection string | `serverSelectionTimeoutMS: 5s`, fail fast on boot |
| API → Redis | RESP (ioredis) | `REDIS_URL` | Shared connection with **offline queue disabled**: if Redis is down, job submission fails immediately with 503 instead of hanging |
| Worker → Redis | RESP (BullMQ) | `REDIS_URL` | Dedicated connection (`maxRetriesPerRequest: null`, as BullMQ requires) |
| API/Worker → Processing | HTTP/JSON | `X-Internal-Token: <INTERNAL_SERVICE_SECRET>` | Constant-time comparison (`hmac.compare_digest`); timeout via `AbortSignal.timeout` |

All JSON responses (Node and Python) share one envelope:

```json
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "STABLE_CODE", "message": "Human readable", "details": [] } }
```

The processing-service client (`backend/src/services/processingClient.js`) normalizes failures into `ProcessingServiceError` with a `retryable` flag:
- network error / timeout / HTTP 5xx / 429 → retryable
- HTTP 4xx (e.g. 401 wrong secret, 422 bad payload) → **not** retryable (retrying cannot fix it)

## 3. Authentication flow

Two-token design:

| Token | Format | Lifetime | Stored where | Sent how |
|---|---|---|---|---|
| Access token | JWT HS256 (`sub`, `iss=briefly-ai-api`, `aud=briefly-ai-web`) | 15 min (`JWT_ACCESS_EXPIRES_IN`) | Browser memory only | `Authorization: Bearer` |
| Refresh token | 48 random bytes (opaque) | 7 days (`REFRESH_TOKEN_TTL_DAYS`) | httpOnly cookie `briefly_rt`; **SHA-256 hash** in MongoDB | Cookie, `SameSite=Strict`, `Path=/api/auth`, `Secure` in production |

```
Register / Login
  client ──POST /api/auth/login {email,password}──► API
         ◄── 200 {user, accessToken} + Set-Cookie: briefly_rt (httpOnly)

Authenticated request
  client ──GET /api/auth/me  Authorization: Bearer <access>──► API (requireAuth verifies JWT)

Page reload / access token expired
  client ──POST /api/auth/refresh (cookie sent automatically)──► API
         API: atomically revoke old token, issue new one (rotation)
         ◄── 200 {user, accessToken} + new cookie

Logout
  client ──POST /api/auth/logout──► API revokes token, clears cookie
```

Security properties:
- Passwords: bcrypt (cost `BCRYPT_SALT_ROUNDS`, default 12). Policy: 8+ characters, at least one letter and one number, at most 72 bytes (bcrypt's input limit, rejected rather than silently truncated). Hashes are `select: false` and stripped from every JSON response.
- Login returns the same `401 INVALID_CREDENTIALS` for unknown email and wrong password, and compares against a dummy hash when the user doesn't exist to reduce timing differences.
- **Refresh rotation with reuse detection:** each refresh token works once. Replaying a token that was revoked more than 30 seconds ago is treated as theft and revokes *all* of that user's sessions. The 30 s grace window avoids logging users out when two tabs refresh simultaneously; the frontend also de-duplicates concurrent refresh calls (important because React StrictMode double-runs effects in development).
- Expired refresh tokens are removed automatically by a MongoDB TTL index.
- Rate limiting: `AUTH_RATE_LIMIT_MAX` (default 20) requests per 15 minutes per IP on register/login/refresh; 30 job submissions per 15 minutes.
- Other HTTP hardening: Helmet headers, `x-powered-by` disabled, 100 kB body limit, strict CORS, generic 500 messages, request logs without bodies/headers, and logger-level redaction of sensitive keys.

## 4. Database design

### Implemented collections

**users**
| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | exposed as `id` |
| `name` | String | trimmed, 2–80 chars |
| `email` | String | trimmed, lowercased, ≤ 254, **unique index** |
| `passwordHash` | String | bcrypt; `select: false`; never serialized |
| `createdAt`, `updatedAt` | Date | Mongoose timestamps |

**refreshtokens**
| Field | Type | Notes |
|---|---|---|
| `user` | ObjectId → users | indexed |
| `tokenHash` | String | SHA-256 of the raw token, **unique** |
| `expiresAt` | Date | **TTL index** (`expireAfterSeconds: 0`) |
| `revokedAt` | Date \| null | set on rotation/logout |

**processingjobs**
| Field | Type | Notes |
|---|---|---|
| `user` | ObjectId → users | compound index `{ user: 1, createdAt: -1 }` |
| `type` | enum | `test` (future: `summarize_article`, `summarize_youtube`, ...) |
| `status` | enum | `queued` → `active` → `completed` \| `failed` |
| `input`, `result` | Mixed | job payload / handler output |
| `attempts`, `maxAttempts` | Number | bounded retries |
| `error` | `{ code, message }` \| null | user-safe error only |
| `startedAt`, `completedAt`, `failedAt` | Date | |

The MongoDB document id doubles as the BullMQ job id, so each record maps 1:1 to a queue entry and enqueueing is idempotent.

**sources** (Milestone 2): one per URL per user
| Field | Type | Notes |
|---|---|---|
| `user` | ObjectId → users | every query filters on it |
| `kind` | enum | `article` (later: `youtube`, `video`, `document`) |
| `submittedUrl` | String | cleaned URL (no fragment / tracking params) |
| `normalizedUrl` | String | lowercase host, no trailing slash: duplicate key; never returned to clients |
| `finalUrl`, `canonicalUrl` | String | after redirects / from `<link rel=canonical>` (re-validated) |
| `metadata` | `{ title, author, publishedAt, siteName, description, language, wordCount }` | from extraction |
| `content` | String | extracted text, stored **once**; `select: false`, never sent to the browser, never put in Redis |
| `contentTruncated`, `extractedAt` | Boolean, Date | |
| `status` | enum | `queued` → `extracting` → `summarizing` → `completed` \| `failed` |
| `error` | `{ code, message }` | user-safe message only |
| `summary`, `latestJob` | ObjectId refs | |
| `completedAt`, `failedAt`, timestamps | Date | |

Indexes: `{ user, createdAt: -1 }` (library), `{ user, status, createdAt: -1 }` (status filter), **unique** `{ user, normalizedUrl }` (duplicate detection, race-safe).

**summaries** (Milestone 2): exactly one per source
| Field | Type | Notes |
|---|---|---|
| `user`, `source` | ObjectId refs | **unique** index on `source`; `{ user, createdAt: -1 }` |
| `title`, `overview` | String | overview is 2–4 sentences |
| `sections[]` | `{ heading, content }` | detailed summary; paragraphs separated by blank lines |
| `keyTakeaways[]`, `mainArguments[]` | String | 3–8 and 1–8 items |
| `concepts[]` | `{ term, explanation }` | up to 12 |
| `model`, `promptVersion` | String | provenance (`article-summary-v1`) |
| `inputTruncated`, `inputCharacters`, `usage.{inputTokens,outputTokens}` | | cost / quality tracking |

`processingjobs` gained an optional `source` reference. Article jobs carry only `{ sourceId }` as input and `{ sourceId, summaryId }` as result, so no article text or summary content is duplicated in jobs or Redis.

Milestone 5 collections (chunks, conversations, messages, study material, preferences) are described in section 9.

## 5. Background job architecture

```
POST /api/jobs/test
  └─ jobService.enqueueProcessingJob({ userId, type, input })
       1. 503 immediately if the shared Redis connection isn't ready
       2. create ProcessingJob { status: queued }
       3. queue.add(type, { processingJobId, type, input }, { jobId: processingJobId })
          on failure → mark job failed (QUEUE_UNAVAILABLE), return 503
  └─ 202 { job }

Worker (processor.js) for each job
  1. look up handler by type (handlers/index.js); unknown → failed + UnrecoverableError
  2. mark active (attempt n)
  3. run handler → e.g. testJobHandler calls POST /internal/test on FastAPI
  4. success → mark completed with result
     retryable failure, attempts left → mark queued (+ error), rethrow → BullMQ retries
     final attempt or non-retryable → mark failed, UnrecoverableError stops retries

Client polls GET /api/jobs/:id (ownership enforced)
```

Configuration (`backend/src/queues/processingQueue.js`):
- `attempts: JOB_MAX_ATTEMPTS` (default 3), exponential backoff starting at `JOB_BACKOFF_MS` (default 2 s).
- `removeOnComplete` after 24 h / 1000 jobs; `removeOnFail` after 7 days / 5000 jobs. MongoDB keeps the durable history.
- Worker `concurrency: WORKER_CONCURRENCY` (default 2), `maxStalledCount: 2` so a job whose worker keeps crashing eventually fails instead of looping.
- Graceful shutdown on SIGINT/SIGTERM: `worker.close()` waits for active jobs.

Adding a job type later: add it to `JOB_TYPES` (`queues/constants.js`), write a handler in `workers/handlers/`, register it in `workers/handlers/index.js`, and expose a route that calls `enqueueProcessingJob`. Retries, status tracking and error handling come for free. Heavy job types may get their own queue (e.g. `transcription`) so slow work cannot starve fast work.

## 6. Article summarization (Milestone 2)

```
Browser ──POST /api/articles {url}──► Express
  1. zod body validation, articleUrl.parseArticleUrl (protocol, credentials, port,
     local/private hosts; tracking params and fragment stripped; normalizedUrl)
  2. duplicate? (user, normalizedUrl) → 200 existing source | failed → re-queue
  3. Source{queued} + ProcessingJob{summarize_article, input:{sourceId}} → BullMQ
  ◄── 202 { source, job }            (Express never waits on extraction or Gemini)

Worker: articleSummaryHandler
  4. Source.status = extracting
     POST /internal/articles/extract {url}  ── FastAPI ──► safe fetch + trafilatura
  5. store metadata + content on Source (skipped on retries if already extracted)
  6. Source.status = summarizing
     POST /internal/articles/summarize {url,title,…,content} ── FastAPI ──► Gemini (JSON schema)
  7. validate (zod) → upsert Summary (unique per source) → Source.status = completed
  on final failure → onFinalFailure hook → Source.status = failed + user-safe error

Browser polls GET /api/sources/:id every 2 s while queued/extracting/summarizing
```

### Error classification

The Python service returns `{ code, message, retryable }`. The Node client honours `retryable`; only codes matching `ARTICLE_*`, `AI_*`, `UNSAFE_URL`, `INVALID_URL` pass their (user-written) message through, and anything else becomes a generic message.

| Situation | Code | Retry? |
|---|---|---|
| Unsafe destination (incl. via redirect / DNS) | `UNSAFE_URL` | no |
| 401/402/403/451 from site (login, paywall) | `ARTICLE_ACCESS_DENIED` | no |
| 404/410 | `ARTICLE_NOT_FOUND` | no |
| Not HTML (e.g. PDF) | `ARTICLE_UNSUPPORTED_CONTENT` | no |
| > `ARTICLE_MAX_BYTES` | `ARTICLE_TOO_LARGE` | no |
| Too little readable text (paywall, JS-only page) | `ARTICLE_CONTENT_UNAVAILABLE` | no |
| Site 5xx / 429, timeouts, connection errors | `ARTICLE_SITE_ERROR` / `ARTICLE_RATE_LIMITED` / `ARTICLE_TIMEOUT` / `ARTICLE_UNREACHABLE` | yes |
| Gemini 429 / 5xx / timeout | `AI_RATE_LIMITED` / `AI_UNAVAILABLE` / `AI_TIMEOUT` | yes |
| Gemini output invalid twice in a row | `AI_INVALID_RESPONSE` | yes |
| Missing key / invalid key / unknown model | `AI_NOT_CONFIGURED` / `AI_CONFIGURATION_ERROR` | no |
| Safety block, 400 from Gemini | `AI_BLOCKED` / `AI_REQUEST_REJECTED` | no |

Retries are bounded by `JOB_MAX_ATTEMPTS` (3) with exponential backoff.

### SSRF protection (processing-service/app/extractors/url_safety.py, fetcher.py)

- Only `http`/`https`, ports 80/443, no `user:pass@`, URL ≤ 2048 chars.
- Hostnames such as `localhost`, `*.local`, `*.internal`, `metadata.google.internal` and single-label names are rejected. IP literals in any notation (`127.1`, `0x7f000001`, `2130706433`, IPv4-mapped or 6to4 IPv6) are unwrapped and checked.
- DNS is resolved by the service; **every** returned address must be globally routable (no loopback, RFC 1918, CGNAT, link-local/`169.254.169.254`, multicast, reserved, ULA).
- The connection is made **to the validated IP**, with the original hostname as `Host` and TLS SNI, so certificates are still verified and DNS rebinding cannot redirect the request.
- Redirects are followed manually (max 5), and each hop goes through the same checks.
- `trust_env=False` (proxies would bypass pinning); 15 s per-request timeout plus an overall deadline; 5 MB streamed size cap; HTML content types only.
- Pages are parsed (lxml/trafilatura), never executed. Canonical URLs found in the page are re-validated before use.
- Node performs the same syntax checks up front for fast feedback, but the Python checks are the security boundary.

### Prompt-injection and faithfulness

- All rules live in the **system instruction**: summarize only the supplied article, treat it as untrusted data rather than instructions, add no facts, keep the author's certainty and attribution, avoid filler, and write in the article's language.
- Article text sits between `<<<ARTICLE_START>>>` / `<<<ARTICLE_END>>>` markers; marker look-alikes inside the article are neutralised.
- Output is constrained by a JSON schema (`response_schema`) and then validated strictly (Pydantic, and zod again in Node): lengths, item counts, de-duplication. Invalid output is retried once, then the job is retried.
- The frontend renders every field as plain text (no HTML/Markdown rendering), so model output cannot inject markup. External links are restricted to `http(s)` and open with `rel="noopener noreferrer nofollow"`.
- Temperature defaults to 0.2. Very long articles are truncated at a paragraph boundary (`ARTICLE_MAX_SUMMARY_CHARS`), and the UI says so.

### Rate limits

`ARTICLE_RATE_LIMIT_MAX` (default 20) submissions plus retries per **user** per hour (keyed by user id, not IP), in addition to the existing per-IP auth limits.

## 7. Video summarization (Milestone 3)

### Flow

```
YouTube   Browser ─POST /api/videos/youtube {url}─► Express: parse video id, dedupe on "youtube:<id>"
                                                   Source{kind:youtube} + ProcessingJob{summarize_youtube} → BullMQ
Upload    Browser ─POST /api/videos/uploads (multipart)─► Express: busboy → signature check + SHA-256 → R2/S3
                                                   Upload + Source{kind:video} + ProcessingJob{summarize_video_upload}

Worker    preparing    YouTube: /internal/youtube/metadata (Data API or oEmbed; private/unlisted/age-restricted/
                                live/too long → non-retryable failure)
                       Upload:  /internal/videos/probe with a fresh 15-min signed GET URL (duration limit, audio track)
          transcribing for each window [0,600), [600,1200), …  (TRANSCRIPTION_CHUNK_SECONDS)
                       YouTube: /internal/youtube/transcribe  → Gemini file_data=YouTube URL + start/end offsets
                       Upload:  /internal/videos/transcribe   → ffmpeg audio window → Gemini inline audio
                       each window is appended atomically to the Transcript with its index (resumable)
          summarizing  /internal/videos/summarize → summary + chapters + key moments → Summary
Browser   polls GET /api/sources/:id (status, progress {current,total}); GET …/transcript; GET …/playback
```

Long recordings never become one huge request: each window is a separate, independently retryable call. A retry after window 4 of 9 failed resumes at window 4. If the YouTube duration is unknown (no Data API key), a single open-ended window is used.

### Transcript source and platform terms

- YouTube caption tracks are **not** downloaded. The Data API `captions.download` endpoint only works for a video's owner (OAuth), and scraping the player's caption endpoints is not permitted. Caption information from `captions.list` (track kinds: manual vs ASR) is stored as metadata and shown to the user, but never presented as the transcript.
- Transcripts come from Gemini's documented YouTube URL input (public videos only) or from the uploaded file's audio, and are labelled as AI-generated.
- No DRM circumvention, no media downloads from YouTube, no cookie or sign-in use.

### Timestamp integrity

1. **Transcription:** the model returns clip-relative times; the service maps them onto the video timeline and **drops** any segment outside the requested window (it never shifts or invents one). Absolute-time output for clipped YouTube input is detected and not double-offset. The worker re-checks that segments fall inside the window.
2. **Summarization:** the transcript is rendered with a `[m:ss]` timestamp on every line, and the model must copy chapter and key-moment times from those brackets. Every returned time is snapped to the nearest real segment start within 3 s, or discarded. Out-of-order or duplicate chapters are discarded. A summary with no grounded chapter is rejected and retried.
3. **UI:** timestamps are only rendered from stored values; clicking seeks the YouTube embed (`start=`) or the `<video>` element (`currentTime`).

### Storage, access and retention

| Concern | Design |
|---|---|
| Where files live | Private S3-compatible bucket (R2 recommended). MongoDB holds only the `uploads` reference record. |
| Streaming | busboy → `VideoInspector` transform (first 64 bytes held for signature check, SHA-256, byte count) → `@aws-sdk/lib-storage` multipart (8 MB parts × 2). No temp files, constant memory. |
| Validation | Extension allowlist + MIME allowlist + magic bytes (ISO-BMFF `ftyp` brands / EBML DocType) must agree; size limit enforced while streaming and via Content-Length; duration enforced by ffmpeg in the worker. |
| Keys | `videos/<userId>/<random UUID>`; the client filename is sanitized display text only (no path traversal). |
| Who can read | The owner via `GET /api/sources/:id/playback` (signed URL ≤ 1 h, `inline`); the processing service via a fresh 15-minute signed URL per request. The processing service holds **no** storage credentials. |
| ffmpeg hardening | Forced demuxer per container, `-protocol_whitelist https,tls,tcp`, list arguments (no shell), timeouts, audio-only decode. Media URLs must be https and match `STORAGE_DOWNLOAD_HOSTS`. |
| Temporary files | Audio windows are written to a per-request `TemporaryDirectory` and removed even on failure. |
| Retention | `Upload.expiresAt` = upload time + `UPLOAD_RETENTION_DAYS`; shortened to `UPLOAD_FAILED_RETENTION_HOURS` on permanent failure, and to "now" for discarded duplicates or queue failures. An hourly BullMQ job scheduler (`maintenance` queue, `cleanup_uploads`) deletes expired objects and marks records `deleted`; storage errors leave the record for the next run. Transcripts and summaries are kept. |
| Duplicates | Unique `{ user, normalizedUrl }` where uploads use `upload:<sha256>`; a re-upload of the same file reuses the summary and deletes the new object. |

### New collections

**uploads**: `user`, `source`, `storageKey` (unique, never returned), `originalName`, `mimeType`, `container`, `sizeBytes`, `sha256` (never returned), `durationSeconds`, `status` (`stored|deleted`), `expiresAt`, `deletedAt`. Indexes: `{ status, expiresAt }` (cleanup), `{ user, createdAt }`.

**transcripts**: one per source: `origin` (`youtube_video|uploaded_video`), `provider`, `model`, `language`, `segments[{ start, end, text, speaker }]`, `completedWindows[]`, `totalWindows`, `durationSeconds`, `wordCount`, `hasSpeakerLabels`, `completedAt`. Unique `{ source }`. About 100 KB per hour of speech; the maximum allowed duration stays far below the 16 MB document limit. Partial transcripts are never returned to clients.

**sources** gained `video { platform, videoId, channelTitle, channelUrl, thumbnailUrl, durationSeconds, publishedAt, captions{available, manualLanguages, autoLanguages}, metadataSource }`, `upload`, `transcript`, `progress { current, total }` and statuses `preparing` and `transcribing`. **summaries** gained `chapters[{ title, startSeconds, endSeconds, summary }]` and `keyMoments[{ seconds, description }]`.

### Transcription providers

`TRANSCRIPTION_PROVIDER` selects an implementation of `TranscriptionProvider` (`transcribe_audio`, `transcribe_youtube`) in `processing-service/app/processors/transcription.py`. Only `gemini` ships. A dedicated speech-to-text API (e.g. one with word-level timestamps and diarization) can be added by implementing the protocol and registering it, without touching the worker, which only sees windows and segments.

### Error classes (video)

| Situation | Code | Retry? |
|---|---|---|
| Private / unlisted / age-restricted / removed / live | `VIDEO_PRIVATE`, `VIDEO_UNSUPPORTED`, `VIDEO_AGE_RESTRICTED`, `VIDEO_NOT_FOUND`, `VIDEO_LIVE` | no |
| Over the duration limit | `VIDEO_TOO_LONG` | no |
| No audio / damaged file / wrong container | `MEDIA_NO_AUDIO`, `MEDIA_INVALID`, `MEDIA_UNSUPPORTED` | no |
| No speech in the whole video | `TRANSCRIPTION_NO_SPEECH` | no |
| Upload file deleted / expired | `VIDEO_UPLOAD_MISSING` (job), `UPLOAD_EXPIRED` (API) | no |
| Signed URL expired / storage or YouTube unreachable | `MEDIA_DOWNLOAD_FAILED`, `YOUTUBE_UNAVAILABLE` | yes |
| ffmpeg timeout | `MEDIA_TIMEOUT` | yes |
| Gemini 429 / 5xx / invalid output twice | `AI_RATE_LIMITED`, `AI_UNAVAILABLE`, `TRANSCRIPTION_INVALID_RESPONSE`, `AI_INVALID_RESPONSE` | yes |

### Known limitations

- Speaker labels come from the model and are only consistent within one window (default 10 minutes).
- Window boundaries may split a sentence. Timestamps stay correct, but a sentence can appear as two segments.
- Without `YOUTUBE_API_KEY`, the YouTube duration is unknown: no duration limit before processing, and very long videos may exceed the single-request output limit.
- Gemini's YouTube input supports public videos only and is subject to Gemini's daily YouTube quota.
- In-app playback of uploads needs a bucket CORS rule allowing GET from the frontend origin.
- Library search covers titles, channels and URLs; transcript search is per video (in the transcript viewer).

## 8. Document summarization (Milestone 4)

### Flow

```
Browser ─POST /api/documents/uploads (multipart)─► Express: busboy → SignatureInspector(DOCUMENT_POLICY) + SHA-256 → R2/S3
                                                   Upload + Source{kind:document} + ProcessingJob{summarize_document}
Worker  extracting   /internal/documents/extract  (fresh 15-min signed URL)
                       PDF : pypdfium2 (page count, metadata, encryption) → pdfminer.six layout per page
                       DOCX: zip checks → python-docx (body order: headings, paragraphs, lists, tables, core properties)
                       TXT : BOM / UTF-8 / charset-normalizer → paragraphs, markdown headings, lists
                     → DocumentPart per page (PDF) or per ~4000-char heading-aligned part (DOCX/TXT)
                     /internal/documents/ocr for scanned pages, OCR_BATCH pages per request,
                       at most DOCUMENT_MAX_OCR_PAGES (others recorded as skipped + warning)
        summarizing  total ≤ DOCUMENT_SINGLE_PASS_CHARS → /internal/documents/summarize mode=direct
                     else planChunks(parts, DOCUMENT_CHUNK_CHARS) → /internal/documents/summarize-chunk per chunk
                       → DocumentChunk notes (resumable)
        combining    /internal/documents/summarize mode=combine (notes + allowed pages/sections)
                       Python merges notes in groups first if they exceed DOCUMENT_COMBINE_MAX_CHARS
                     → Summary (sectionBreakdown, facts, references) ; DocumentChunk notes deleted
Browser  polls GET /api/sources/:id (progress stage: ocr | chunks | combine)
         GET /api/sources/:id/original (signed URL; inline PDF viewer or download)
         GET /api/sources/:id/document-text (extracted parts, paginated)
```

### Long-document strategy

| Concern | Approach |
|---|---|
| Meaningful chunks | Chunks are built from whole parts: PDF pages, or DOCX/TXT parts that start at headings. Paragraphs longer than `DOCUMENT_MAX_BLOCK_CHARS` are split at sentence, then word, boundaries. Nothing is cut mid-sentence. |
| References survive chunking | Each chunk is rendered with `[Page N]` / `[Part N · Section: …]` markers, the model cites those, and citations are validated per chunk and again in the final pass. |
| Coherence, no repetition | Map prompts describe the excerpt as "part i of n" and forbid whole-document intros or conclusions. The reduce prompt merges duplicates and reports contradictions with both references instead of silently choosing. Takeaways are de-duplicated after generation. |
| No information loss | Map notes are detailed and structured (sections, key points, facts, definitions, arguments) rather than prose summaries of summaries, and the reduce step only combines them. |
| Context limits and cost | Single pass up to ~37k tokens. Map chunks are ~15k tokens. The reduce input is capped (`DOCUMENT_COMBINE_MAX_CHARS`) with hierarchical merging, at most 4 rounds. Extraction is capped at `DOCUMENT_MAX_CHARS` / `DOCUMENT_MAX_PAGES`, OCR at `DOCUMENT_MAX_OCR_PAGES`. Token usage is summed across all calls into `Summary.usage`. |
| Intermediate state | Kept only where it saves work on retry: `DocumentPart` (extraction and OCR) and `DocumentChunk` (map notes, deleted after success). |

### Storage model

**document_parts**: `source`, `index` (unique together), `page` (PDF) or null, `headingPath[]`, `blocks[{ kind: heading|paragraph|list|table, level, text }]`, `needsOcr`, `ocrDone`, `charCount`. One small MongoDB document per page or part, so no single document approaches the 16 MB limit even for 1000-page PDFs.

**document_chunks** (temporary): `source`, `index`, `partStart`, `partEnd`, `notes`, `usage`.

**sources.document**: `format`, `pageCount`, `pagesProcessed`, `partCount`, `wordCount`, `charCount`, `author`, `subject`, `created`, `modified`, `encoding`, `ocrPages[]`, `ocrSkippedPages[]`, `truncated`, `warnings[]`, `strategy` (`direct|combine`), `extractedAt`.

**summaries** gained `sectionBreakdown[{ title, summary, pages, section }]`, `facts[{ statement, pages, section }]` and `references.{ keyTakeaways, mainArguments, concepts }[{ pages, section }]` (index-aligned).

### Error classes (documents)

| Situation | Code | Retry? |
|---|---|---|
| Password-protected PDF | `DOCUMENT_ENCRYPTED` | no |
| Corrupt or mismatched file | `DOCUMENT_INVALID` | no |
| Macro-enabled DOCX / template | `DOCUMENT_MACROS` / `DOCUMENT_UNSUPPORTED` | no |
| Zip bomb / over size | `DOCUMENT_TOO_LARGE` | no |
| No text at all (or none within the OCR cap) | `DOCUMENT_NO_TEXT` / `DOCUMENT_EMPTY` | no |
| File deleted before extraction finished | `DOCUMENT_UPLOAD_MISSING` (job), `UPLOAD_EXPIRED` (retry API) | no |
| Signed URL expired / storage unreachable | `DOCUMENT_DOWNLOAD_FAILED` | yes |
| OCR or summary output invalid twice | `OCR_INVALID_RESPONSE` / `AI_INVALID_RESPONSE` | yes |

Once a document is extracted (and its OCR is complete), retries no longer need the original file.

### OCR providers

`OCR_PROVIDER` selects an `OcrProvider` in `processing-service/app/documents/ocr.py`. Only `gemini` ships: one rendered page image (OCR_DPI, longest side ≤ 2400 px, grayscale PNG) per request, returning structured blocks. A local engine (e.g. Tesseract) or another cloud OCR service can be added behind the same interface.

### Known limitations

- PDF headings come from font-size heuristics; unusual typography can mislabel a heading as a paragraph or the reverse.
- Complex multi-column, table-heavy or rotated layouts may be read out of order; PDF tables come out as text, not structured tables (DOCX tables keep their structure).
- Images, charts and equations are not interpreted, except when a whole page is scanned and OCR reads its text.
- DOCX page numbers are not available (Word computes pages at render time), so references point to sections.
- Footnotes, comments, headers/footers and text boxes in DOCX are not extracted.
- OCR is capped per document for cost control; pages beyond the cap are listed in the warnings.
- Extremely long documents are truncated at `DOCUMENT_MAX_CHARS` / `DOCUMENT_MAX_PAGES`, and the summary is marked accordingly.

## 9. Ask AI, retrieval and study tools (Milestone 5)

### Flow

```
summary job completes ──onCompleted──▶ index_source job (worker)
   chunk stored content (article text / transcript segments / document parts + summary)
   → ContentChunk docs (keyword search works from here)
   → POST /internal/ai/embeddings in batches (task = document) → vectors stored on the chunks
   → Source.rag = { status: ready, chunkCount, embeddedCount, model, dimensions }

POST /api/conversations/:id/messages (synchronous, rate-limited)
   embed the question (task = query)            ┐
   $vectorSearch (filter: user [, source])       ├─ reciprocal rank fusion → top RAG_TOP_K chunks
   $text search on { user, text }                ┘
   → POST /internal/ai/answer { question, last N messages, chunks as c1..cN }
   → citations validated (subset of c1..cN), resolved to source / page / timestamp / section
   → Message documents saved; the question is removed again if answering fails

POST /api/sources/:id/{notes|quizzes|flashcards|summary-styles/:style}
   → target document created in "queued" state → generate_* job (worker)
   → evenly spread, in-order sample of the source's chunks (≤ STUDY_INPUT_CHARS)
   → POST /internal/ai/study/* or /internal/ai/summaries/restyle → validated → refs resolved → saved
   → the UI polls the document until completed / failed
```

### Vector search: evaluation and decision

The milestone required evaluating MongoDB Atlas Vector Search before introducing any other vector database. The project's existing Atlas cluster (MongoDB 8.0) was tested directly with a throwaway collection:

- `createSearchIndex({ type: 'vectorSearch' })` was accepted, and the index became READY and queryable in about 30 seconds.
- `$vectorSearch` with a `filter: { user }` pre-filter returned only that user's documents.
- The temporary collection was dropped afterwards.

**Decision: Atlas Vector Search.** It keeps vectors next to the data they describe, needs no new service, credentials or dependency, and supports the pre-filters that ownership requires. It also works on the free tier. A second vector database (Pinecone, Qdrant, pgvector, …) would add infrastructure and a second copy of user content without a benefit at this scale.

`mongodb-memory-server` and plain MongoDB have no vector search. For those, `vectorStore.js` includes an **exact** store: cosine similarity computed in-process over the user's own chunks, bounded by `RAG_EXACT_SCAN_LIMIT`. `VECTOR_STORE=auto` picks Atlas whenever the index exists and is queryable (re-checked every 5 minutes) and the exact store otherwise.

### Ownership and prompt-injection defences

- **Ownership:** `vectorStore.buildFilter` throws without a userId. The Atlas pipeline is `$vectorSearch` (with `filter.user`), then `$match: { user }`, then `$project` (no embeddings). The final results are filtered by owner once more in code. Keyword search requires the `user` equality prefix of the `{ user: 1, text: 'text' }` index. Tests cover both pipelines and cross-user isolation.
- **Untrusted content:** retrieved chunks are treated as untrusted. The processing service wraps them in `<<<CONTEXT_START>>>` / `<<<CONTEXT_END>>>`, neutralises marker and `[chunk …]` look-alikes inside content, questions and history, and keeps all rules in the system instruction.
- **Grounding:** `support` is downgraded from `supported` to `partial` when there is no valid citation, and to `not_found` when no context was found. Citations and refs that are not supplied chunk ids are discarded (`refs_discarded`, `citations_discarded`).
- **Validated output:** Gemini output is schema-constrained, validated by pydantic (quiz questions must be internally consistent) and validated again with zod in Node before anything is stored.
- **Quiz answer keys:** `Quiz.toJSON()` strips answers. The full review is only returned by `POST /api/quizzes/:id/attempts`, and scoring happens server-side. Short answers are graded deterministically after normalisation: exact match, whole-word containment, or at least 80% word coverage.

### New collections

- **contentchunks**: `user`, `source`, `kind`, `sourceCreatedAt`, `index`, `chunkType` (`content` \| `summary`), `text`, `label`, `page`, `section`, `startSeconds`, `endSeconds`, `embedding` (not selected by default), `embeddingModel`.
  - Indexes: `{ source, index }` unique, `{ user, source }`, `{ user, text: 'text' }`, plus the Atlas vector index `content_chunks_vector` (filters `user`, `source`, `kind`, `sourceCreatedAt`).
- **conversations**: `user`, `scope` (`source` \| `library`), `source`, `title`, `messageCount`, `lastMessageAt`. Indexes `{ user, updatedAt }` and `{ user, source, updatedAt }`.
- **messages**: `user`, `conversation`, `role`, `content`, `support`, `citations[] { source, sourceTitle, sourceKind, chunk, label, page, section, startSeconds, snippet }`, `followUps`, `model`, `usage`. Indexes `{ conversation, createdAt }` and `{ user, createdAt }`.
- **studynotes** (one per source), **flashcarddecks** (one per source, cards with `review { status, reviews, lastReviewedAt }`), **summaryvariants** (unique `{ source, style }`) and **quizzes** (many per source, `{ user, source, createdAt }`).
  - All of them share the generation fields `status`, `error`, `job`, `model`, `promptVersion`, `inputCharacters`, `usage` and `generatedAt`.
  - Every reference is stored resolved (`{ label, page, section, startSeconds }`).
- **quizattempts**: `user`, `quiz`, `source`, `answers[] { questionId, response, correct }`, `score`, `total`.
- **userpreferences**: unique `user`, `summaryStyle`, `quizDifficulty`, `quizQuestionCount`, `quizQuestionTypes`, `flashcardCount`.
- `sources` gained `rag { status, chunkCount, embeddedCount, model, dimensions, indexedAt, job, error }`.

### Jobs

`index_source` and `generate_study_notes` / `generate_quiz` / `generate_flashcards` / `generate_summary_style` run on the existing processing queue with the existing retry and backoff.

- Indexing is resumable: the first attempt rebuilds the chunks, and retries only embed chunks that have no embedding yet.
- A vector of the wrong size fails permanently (`EMBEDDING_INVALID_RESPONSE`).
- Each handler's `onFinalFailure` marks the index or the study item `failed` with a safe message.
- The worker now also opens the shared producer connection, so it can enqueue `index_source` after a summary.

### Providers

- **Embeddings:** `EMBEDDING_PROVIDER` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS`. Gemini `gemini-embedding-001` at 768 dimensions, with separate `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` task types and L2-normalised vectors.
- **Answers and study material:** `GEMINI_MODEL`.

Switching the embedding model or its dimensions requires re-creating the index and re-indexing (`npm run rag:create-index`, `npm run rag:backfill -- --all`).

### Known limitations

- Ask AI answers are generated synchronously (typically 3–10 s) and are not streamed.
- Very long sources are indexed up to `RAG_MAX_CHUNKS_PER_SOURCE` chunks.
- Study tools see a representative sample of at most `STUDY_INPUT_CHARS` characters, not every sentence of very long sources.
- Retrieval quality depends on the embedding model. Library-wide questions use the top `RAG_TOP_K` chunks, so "summarize everything" questions get a partial answer by design.
- The exact store scans up to `RAG_EXACT_SCAN_LIMIT` chunks per user and is meant for development and tests. Production should use the Atlas index.
- Short-answer grading is keyword-based: a correct answer phrased very differently can be marked wrong, and the review shows the accepted answers.
- Flashcard review tracking is basic (new / learning / known), not spaced repetition.

## 10. Free-tier quota management

```
caller (worker job / Ask AI / search)
   └─ runWithAiContext({ feature, userId })               AsyncLocalStorage
        └─ processingClient.<ai call>
             └─ aiGate.withAiCall({ kind, operation })
                  1. provider block?    Redis value block:<kind> (set from Gemini 429 / config errors)
                  2. reserve budgets    Lua: minute pace, app daily, feature group, user daily (all or nothing)
                  3. concurrency lease  Lua ZSET lease:<kind> with expiry
                  4. POST /internal/... processing service → Gemini
                     ← data + X-Gemini-Requests (real request count, incl. retries/windows/batches)
                     ← or error { code, retryable, meta: { scope, retry_after_seconds, quota_id, model } }
                  5. adjust reservation to the real count; record feature/model/user usage and tokens;
                     429 → block the model for retry_after (or a configured fallback); release lease
```

- **Classifying Gemini errors** (`processing-service/app/services/gemini.py` → `parse_quota_error` / `map_api_error`):

  | Gemini error | Code | Retry behaviour |
  |---|---|---|
  | 429 with a `…PerDay…` quota id | `AI_QUOTA_EXHAUSTED` | Delayed until quota is back |
  | 429, per-minute or unknown | `AI_RATE_LIMITED` | Delayed by the provider's retry delay |
  | 404 | `AI_MODEL_UNAVAILABLE` | Not retryable |
  | 401 / 403 / bad key | `AI_CONFIGURATION_ERROR` | Not retryable |
  | other 400 | `AI_REQUEST_REJECTED` | Not retryable |
  | 5xx / timeouts | `AI_UNAVAILABLE` / `AI_TIMEOUT` | Retryable with backoff |

  Messages are feature-neutral. The backend words them per feature (`services/ai/aiMessages.js`).
- **Jobs** (`workers/processor.js`): these codes defer the job instead of retrying it:
  - `AI_QUOTA_EXHAUSTED`, `AI_RATE_LIMITED`: limits reported by Gemini;
  - `AI_BUDGET_EXHAUSTED`: Briefly's daily budget;
  - `AI_PACED`: Briefly's per-minute pace;
  - `AI_BUSY`: no concurrency slot free.

  The processor calls `job.moveToDelayed(until, token)` and throws `DelayedError`. The job leaves the worker without using an attempt, `ProcessingJob` records `nextAttemptAt` and the reason, and the target item (source, index, study item) shows "paused". When it wakes, the gate is checked first, so a still-exhausted quota costs no request. Deferrals are bounded (count and total hours); after that the job fails with a clear, retryable-by-user message. Other retryable errors use the worker's custom backoff (longer for transient AI errors).
- **Sync requests:** Ask AI calls `aiGate.assertAvailable` before retrieval, so it fails fast with no wasted embedding. Limits map to 429 or 503 with `Retry-After` (`services/aiErrors.js`). Search degrades to keyword matching.
- **Models** are never switched automatically. The gate learns the configured models from responses (and from `GET /internal/ai/config` for the usage overview), and ignores a block recorded for a model that is no longer configured.
- **Store:** `RedisStore` (shared, atomic Lua; covered by `tests/integration/aiGateRedis.test.js` against real Redis) or `MemoryStore` (tests, or Redis unavailable).

### Caching

| What | Key | Reused when | Invalidated when |
|---|---|---|---|
| Summary | `Summary.inputHash` = sha256(cache version, kind, content sent to the summarizer) | Retry / re-run with the same input | Content or `SUMMARY_CACHE_VERSION` changes |
| Embeddings | `ContentChunk.textHash`, `Source.rag.contentHash` | Unchanged source (no calls); unchanged chunk text (vector copied) | Text changes, embedding model changes |
| Study items, styles | `sourceContentHash` + configuration (count, difficulty, types, style) | Same source content and configuration | Content hash changes, explicit regenerate |
| Query vectors | per user + sha256(normalised query), 30 min, in process | Repeated searches | Expiry |
| Ask AI answers | `Message.clientRequestId` (unique per conversation) | Re-sending the same request id | — |

Every lookup filters by source and user, so cached content is never shared between users.

## 11. Future content-processing architecture

New content types reuse the same pieces: a `Source` of a new `kind`, an upload policy (signature check, size limit, storage prefix, retention), a job type with its own handler, an extraction endpoint, and a kind-specific summarization prompt. New kinds only need a chunker branch in `services/rag/chunker.js` to get Ask AI, smart search and study tools.

- **Long inputs:** chunking with map-reduce style summarization (instead of today's truncation), with transcript timestamps preserved through chunks.
- **Progress:** finer-grained progress (BullMQ `updateProgress`), mirrored to MongoDB; server-sent events instead of polling.
