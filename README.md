# Briefly AI

Briefly AI is a content summarization and study platform.
- **Summarize:** articles (by URL), YouTube videos, uploaded videos and documents (PDF, DOCX, TXT, including scanned PDFs via OCR).
- **Study:** read structured summaries with takeaways, concepts, chapters, timestamps and page references; ask grounded questions with citations (**Ask AI**); search your library by meaning; generate study notes, quizzes and flashcards; rewrite summaries in seven styles.

Everything is saved per user in a private library. AI runs on Google Gemini's **free tier** only, with a quota-aware request manager (see "Free-tier operation").

> **Status:** feature complete (milestones 1–5 plus free-tier optimization).
> - **Uploads:** video and document uploads need S3-compatible object storage (Backblaze B2, verified; or Cloudflare R2); without it they return a clear "storage not configured" message.
> - **AI:** AI features need a free `GEMINI_API_KEY`.
>
> See "What needs which credentials", [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (production, B2 / R2 setup) and [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md) (step-by-step test checklist).

---

## Architecture overview

```
 Browser (React + Vite, :5173)
    │  /api/*  (Vite dev proxy → same origin, httpOnly refresh cookie)
    ▼
 Express API (:5000) ───────────────► MongoDB (:27017)
    │  enqueue jobs                       ▲
    ▼                                     │ job status
 Redis (:6379) ◄── BullMQ ──► Worker process (npm run worker)
                                          │  X-Internal-Token
                                          ▼
                              FastAPI processing service (:8000, localhost only)
```

| Service | Responsibility |
|---|---|
| `frontend/` | React SPA: auth screens, dashboard, summarize/library/settings pages |
| `backend/` (API) | Auth (JWT + rotating refresh tokens), validation, data access, job submission |
| `backend/` (worker) | Consumes BullMQ jobs, calls the processing service, records job status in MongoDB |
| `processing-service/` | Internal Python service for content processing (extraction/transcription/Gemini in later milestones) |
| MongoDB | Users, refresh tokens, processing jobs (later: sources, summaries, conversations) |
| Redis | BullMQ queue state |

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Technology stack

- **Frontend:** React 18, Vite 5, React Router 6, Tailwind CSS 3, Axios, lucide-react icons. Tests: Vitest + Testing Library.
- **Backend:** Node.js (≥ 20.11), Express 4, Mongoose 8, jsonwebtoken, bcrypt, zod, helmet, cors, express-rate-limit, cookie-parser, BullMQ 5 + ioredis. Tests: Jest + Supertest + mongodb-memory-server.
- **Processing service:** Python 3.11+ (developed on 3.13), FastAPI, Pydantic v2, pydantic-settings, Uvicorn, httpx. Tests: pytest.
- **Infrastructure:** Docker Compose (MongoDB 7, Redis 7.4).

## Repository structure

```
briefly-ai/
├── frontend/                 React + Vite app
│   ├── public/               static assets (favicon)
│   └── src/
│       ├── assets/
│       ├── components/
│       │   ├── common/       Button, Input, Card, Spinner, EmptyState, Badge, Notice, Logo, ToastViewport
│       │   ├── dashboard/    StatCard, ContentTypeCard, RecentSummaries
│       │   ├── layout/       AppLayout, Sidebar, Header, PageContainer, AuthLayout
│       │   └── routing/      ProtectedRoute, PublicOnlyRoute
│       ├── context/          AuthContext, ToastContext
│       ├── hooks/            useAuth, useToast, useDocumentTitle
│       ├── pages/            auth/Login, auth/Register, Dashboard, Summarize, Library, Settings, NotFound
│       ├── services/         apiClient (axios), authService, systemService
│       ├── styles/           Tailwind entry
│       ├── tests/            Vitest suites
│       └── utils/            validation, errors, formatting, content types
├── backend/
│   ├── src/
│   │   ├── config/           env (validated config), database, redis
│   │   ├── controllers/      auth, health, jobs
│   │   ├── middleware/       auth, validate, rate limiters, error handler, request logger
│   │   ├── models/           User, RefreshToken, ProcessingJob
│   │   ├── queues/           queue constants, processing queue
│   │   ├── routes/
│   │   ├── services/         auth, tokens, jobs, processing-service client
│   │   ├── validators/       zod schemas
│   │   ├── workers/          worker entry, processor, job handlers
│   │   ├── utils/            ApiError, logger, http helpers
│   │   ├── app.js            Express app factory
│   │   └── server.js         API entry point
│   └── tests/                unit/API tests + integration/ (real services)
├── processing-service/
│   ├── app/
│   │   ├── api/routes/       health, internal
│   │   ├── core/             config, security, exceptions, logging
│   │   ├── schemas/          Pydantic models
│   │   ├── extractors/       (later milestones)
│   │   ├── processors/       (later milestones)
│   │   ├── services/         (later milestones)
│   │   ├── main.py           FastAPI app factory
│   │   └── __main__.py       `python -m app`
│   ├── tests/
│   ├── requirements.txt
│   └── requirements-dev.txt
├── docs/ARCHITECTURE.md
├── docker-compose.yml
├── .env.example              ports used by docker compose
└── README.md
```

## Prerequisites

- **Node.js 20.11+** (developed with 22.15) and npm
- **Python 3.11+** (developed with 3.13)
- **MongoDB 7** and **Redis 6.2+** (5.0 minimum for BullMQ). The easiest route is **Docker Desktop** with the included `docker-compose.yml`. On Windows without Docker you can use a local MongoDB Community Server install plus [Memurai](https://www.memurai.com/) (free developer edition) or Redis inside WSL.

## Installation

```bash
# 1. Backend
cd backend
npm install

# 2. Frontend
cd ../frontend
npm install

# 3. Processing service
cd ../processing-service
python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate
pip install -r requirements-dev.txt
```

## Environment configuration

Copy each example file and fill in the values:

| File | Copy to | Purpose |
|---|---|---|
| `.env.example` | `.env` | Optional: host ports for Docker Compose |
| `backend/.env.example` | `backend/.env` | API + worker: MongoDB, Redis, JWT, CORS, processing-service URL & secret |
| `processing-service/.env.example` | `processing-service/.env` | Bind host/port, internal secret, Gemini key placeholder |
| `frontend/.env.example` | `frontend/.env.local` | Optional: API base URL and dev proxy target |

Required secrets (generate fresh random values; never commit them):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

- `backend/.env` → `JWT_ACCESS_SECRET` (≥ 32 chars)
- `backend/.env` → `INTERNAL_SERVICE_SECRET` **and** `processing-service/.env` → `INTERNAL_SERVICE_SECRET`. These must be **identical**.

Both services refuse to start if a secret is missing, too short, or still the `change-me…` placeholder. All `.env` files are git-ignored; only `*.env.example` files are tracked. `GEMINI_API_KEY` is reserved for later milestones and lives only in the processing service.

## Docker Compose (MongoDB + Redis)

```bash
docker compose up -d        # start (ports bound to 127.0.0.1)
docker compose ps           # both should become "healthy"
docker compose logs -f      # follow logs
docker compose down         # stop, keep data
docker compose down -v      # stop and DELETE local data volumes
```

Data persists in the named volumes `briefly-ai_mongodb_data` and `briefly-ai_redis_data`. Redis runs with `noeviction` (required by BullMQ) and AOF persistence.

## Starting the services

Use four terminals (after infrastructure is up):

```bash
# 1. Processing service  → http://127.0.0.1:8000  (docs at /docs in development)
cd processing-service && .venv\Scripts\activate && python -m app

# 2. API                 → http://localhost:5000/api
cd backend && npm run dev

# 3. Worker (processes background jobs)
cd backend && npm run worker:dev

# 4. Frontend            → http://localhost:5173
cd frontend && npm run dev
```

Open http://localhost:5173, create an account, then go to **Settings → System status**. It shows the state of MongoDB, Redis and the processing service, and the **Run test** button sends a job through the whole pipeline (API → BullMQ → worker → FastAPI → MongoDB).

| Service | Port | Scripts |
|---|---|---|
| Frontend (Vite) | 5173 | `npm run dev`, `npm run build`, `npm run preview` |
| API (Express) | 5000 | `npm run dev` (watch), `npm start` |
| Worker (BullMQ) | n/a | `npm run worker:dev` (watch), `npm run worker` |
| Processing (FastAPI) | 8000 | `python -m app` (reload in development) |
| MongoDB | 27017 | Docker Compose |
| Redis | 6379 | Docker Compose |

### API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | none | Liveness |
| GET | `/api/health/ready` | none | Dependency readiness (200 or 503) |
| POST | `/api/auth/register` | none | Create account; returns user + access token, sets refresh cookie |
| POST | `/api/auth/login` | none | Sign in |
| POST | `/api/auth/refresh` | cookie | Rotate refresh token, new access token |
| POST | `/api/auth/logout` | cookie | Revoke refresh token |
| GET | `/api/auth/me` | Bearer | Current user |
| POST | `/api/jobs/test` | Bearer | Queue the infrastructure test job (202) |
| GET | `/api/jobs/:id` | Bearer | Status of one of your jobs |
| POST | `/api/articles` | Bearer | Submit `{ "url" }` for summarization. **202** `{ source, job, duplicate: false }` when queued; **200** `{ source, duplicate: true }` when you already have that URL. Rate-limited per user. |
| POST | `/api/videos/youtube` | Bearer | Submit `{ "url" }` (watch, youtu.be, Shorts, embed, live links). 202 queued / 200 duplicate (same video id). |
| POST | `/api/videos/uploads` | Bearer | `multipart/form-data` with one `file` field (MP4, MOV, WEBM, MKV). Streamed to object storage. 202 / 200 duplicate (same file hash) / 413 too large / 415 bad type or signature / 503 storage not configured. |
| GET | `/api/videos/uploads/config` | Bearer | `{ enabled, maxBytes, maxDurationMinutes, retentionDays, ... }` |
| GET | `/api/sources` | Bearer | Your library. Query: `search`, `kind=article\|youtube\|video\|document`, `status=completed\|failed\|processing\|…`, `page`, `limit` (≤ 50) |
| GET | `/api/sources/stats` | Bearer | `{ total, completed, processing, failed }` for the dashboard |
| GET | `/api/sources/:id` | Bearer | Metadata, status, progress, error, latest job, summary (incl. chapters and key moments for videos), transcript availability, upload info |
| GET | `/api/sources/:id/transcript` | Bearer | Full timed transcript `{ segments: [{ start, end, text, speaker }], language, provider, ... }` (404 until finished) |
| POST | `/api/documents/uploads` | Bearer | `multipart/form-data` with one `file` (PDF, DOCX, TXT). 202 / 200 duplicate / 413 / 415 (bad type or signature) / 503 storage not configured |
| GET | `/api/documents/uploads/config` | Bearer | Document upload limits and whether uploads are enabled |
| GET | `/api/sources/:id/original` | Bearer | Signed URL for the original upload (inline for PDFs; `?download=1` for an attachment); 410 after retention |
| GET | `/api/sources/:id/document-text` | Bearer | Extracted text with page/section references, paginated (`page`, `limit` ≤ 50) |
| GET | `/api/sources/:id/playback` | Bearer | Uploaded videos only: short-lived signed URL for in-app playback (410 after the file's retention period) |
| POST | `/api/sources/:id/retry` | Bearer | Re-queue a **failed** summary (409 otherwise, or if the uploaded file has expired) |

| GET / POST | `/api/conversations` | Bearer | List (`sourceId`, `scope`, `page`) / create `{ scope: "library" \| "source", sourceId? }` Ask AI conversations |
| GET / PATCH / DELETE | `/api/conversations/:id` | Bearer | Conversation with messages / rename `{ title }` / delete (with its messages) |
| POST | `/api/conversations/:id/messages` | Bearer | Ask `{ content }` (≤ 2000 chars). 201 `{ conversation, messages: [question, answer], retrieval }`. The answer has `support` (`supported` \| `partial` \| `not_found`), `citations[]` and `followUps[]`. 409 `SOURCE_NOT_INDEXED` while a source is being prepared; 503 `AI_NOT_CONFIGURED`. Rate-limited. |
| GET | `/api/search` | Bearer | Smart search. Query: `q`, `kind`, `from` / `to` (YYYY-MM-DD), `limit` (≤ 30). Returns `{ mode: "hybrid" \| "keyword", results: [{ source, overview, matches[], titleMatch }] }` |
| GET / POST | `/api/sources/:id/index` | Bearer | Retrieval-index status / queue re-indexing |
| GET / POST | `/api/sources/:id/notes` | Bearer | Study notes / generate (`{ regenerate }`); 202 when queued |
| GET / POST | `/api/sources/:id/quizzes` | Bearer | List / generate `{ count (3–30), difficulty, types[] }` |
| GET / DELETE | `/api/quizzes/:id` | Bearer | Quiz **without answers** / delete |
| GET / POST | `/api/quizzes/:id/attempts` | Bearer | Attempts / submit `{ answers: { q1: 0, q2: true, q3: "text" } }`, which returns the score and full review |
| GET | `/api/quizzes/:id/attempts/:attemptId` | Bearer | Review of a past attempt |
| GET / POST | `/api/sources/:id/flashcards` | Bearer | Deck / generate `{ count (5–60), regenerate }` |
| POST | `/api/flashcards/:id/cards/:cardId/review` | Bearer | `{ status: "known" \| "learning" }` |
| POST | `/api/flashcards/:id/reset` | Bearer | Reset review progress |
| GET | `/api/sources/:id/summary-styles` | Bearer | Generated summary styles |
| GET / POST | `/api/sources/:id/summary-styles/:style` | Bearer | One style / generate it (`concise`, `detailed`, `bullet_points`, `academic`, `beginner`, `technical`, `exam_revision`) |
| GET / PUT | `/api/preferences` | Bearer | Study preferences (default summary style, quiz difficulty / count / types, flashcard count) |
| GET | `/api/usage` | Bearer | Briefly's AI budgets and usage today (app and you), per feature and model, and Gemini status (`available` / `rate_limited` / `quota_exhausted` / `unavailable`). Never Google's remaining quota |

Every `/api/sources`, conversation, quiz, flashcard and search query is scoped to the signed-in user; another user's id returns 404.

Processing service (all `/internal/*` routes require `X-Internal-Token`): `GET /health`, `POST /internal/test`, `POST /internal/articles/extract`, `POST /internal/articles/summarize`, `POST /internal/youtube/metadata`, `POST /internal/youtube/transcribe`, `POST /internal/videos/probe`, `POST /internal/videos/transcribe`, `POST /internal/videos/summarize`, `POST /internal/documents/extract`, `POST /internal/documents/ocr`, `POST /internal/documents/summarize-chunk`, `POST /internal/documents/summarize`, `POST /internal/ai/embeddings`, `POST /internal/ai/answer`, `POST /internal/ai/study/notes`, `POST /internal/ai/study/quiz`, `POST /internal/ai/study/flashcards`, `POST /internal/ai/summaries/restyle`, `GET /internal/ai/config` (configured models, no secrets). Every response carries `X-Gemini-Requests`.

## Article summarization (Milestone 2)

1. Paste an article URL on **Summarize → Article URL**.
2. The API validates the URL, rejects duplicates and unsafe hosts, creates a `Source` and queues a `summarize_article` job, then returns immediately (Express never waits for Gemini).
3. The worker asks the processing service to **fetch and extract** the article (SSRF-safe fetch, trafilatura extraction), stores the text and metadata once on the `Source`, then asks it to **summarize** with Gemini.
4. Gemini returns structured JSON, which is validated in Python and again in Node before a `Summary` is saved.
5. The result page (`/library/:id`) polls until the summary is ready and shows the overview, detailed sections, key takeaways, concepts, main arguments and source metadata, with **Copy summary** (Markdown) and **Try again** on failure.

**A Gemini API key is required**: set `GEMINI_API_KEY` in `processing-service/.env` (free keys: https://aistudio.google.com/apikey). Without it, extraction still works, but jobs fail with "AI summarization is not configured on the server."

### New environment variables

| File | Variable | Default | Purpose |
|---|---|---|---|
| `processing-service/.env` | `GEMINI_API_KEY` | (empty) | Gemini key. Server-side only, never logged or sent to the browser. |
| | `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Generation model (the only place it is configured); see “Free-tier operation” |
| | `GEMINI_TIMEOUT_SECONDS` | `90` | Per-request timeout |
| | `GEMINI_TEMPERATURE` | `0.2` | Lower is more faithful |
| | `GEMINI_MAX_OUTPUT_TOKENS` | `16384` | Output token cap |
| | `ARTICLE_FETCH_TIMEOUT_SECONDS` | `15` | Timeout per request to the article site |
| | `ARTICLE_MAX_BYTES` | `5242880` | Max page size (5 MB) |
| | `ARTICLE_MAX_REDIRECTS` | `5` | Redirect hops (each re-validated) |
| | `ARTICLE_MIN_WORDS` | `120` | Below this, the page is treated as paywalled/empty |
| | `ARTICLE_MAX_SUMMARY_CHARS` | `60000` | Text sent to Gemini (longer articles are truncated at a paragraph) |
| | `ARTICLE_MAX_STORED_CHARS` | `300000` | Text stored in MongoDB |
| | `ARTICLE_USER_AGENT` | `BrieflyAI/0.2 …` | User-Agent for article fetches |
| `backend/.env` | `PROCESSING_EXTRACT_TIMEOUT_MS` | `45000` | Worker → extract call timeout |
| | `PROCESSING_SUMMARIZE_TIMEOUT_MS` | `200000` | Worker → summarize call timeout |
| | `ARTICLE_RATE_LIMIT_MAX` | `20` | Summary submissions (articles, videos **and documents**) + retries per user per hour |

## Video summarization (Milestone 3)

Users can summarize **YouTube videos** and **uploaded video files**. Results include an overview, a detailed summary, key takeaways, concepts, main arguments, **chapters and key moments with clickable timestamps**, and a **searchable transcript**.

```
YouTube:  POST /api/videos/youtube → summarize_youtube job
          preparing    metadata from the YouTube Data API (or oEmbed) + availability checks
          transcribing Gemini reads the public video, one 10-minute window at a time
          summarizing  summary + chapters + key moments grounded in the transcript

Upload:   POST /api/videos/uploads (streamed to R2/S3) → summarize_video_upload job
          preparing    ffmpeg probes the stored file via a signed URL (duration limit, audio track)
          transcribing ffmpeg extracts each window's audio → Gemini transcribes it
          summarizing  as above
```

Clicking a timestamp plays the YouTube embed (privacy-enhanced `youtube-nocookie.com`) or the uploaded video from that second.

### What needs which credentials

| Feature | Required | Optional |
|---|---|---|
| YouTube summaries | `GEMINI_API_KEY` | `YOUTUBE_API_KEY` (recommended): duration, publish date, caption-track info, privacy/age/live checks, and **windowed transcription of long videos**. Without it, metadata comes from oEmbed (title, channel, thumbnail), the duration is unknown, and the whole video is transcribed in one request (best for videos under about an hour). |
| Uploaded videos | `GEMINI_API_KEY` **and** object storage (`STORAGE_*` in `backend/.env`) | `STORAGE_DOWNLOAD_HOSTS` in `processing-service/.env` (recommended hardening) |

Without storage, the Upload tab says uploads aren't set up and the API returns `503 STORAGE_NOT_CONFIGURED`. Nothing pretends to work.

### Transcript source (important)

Briefly does **not** download YouTube caption tracks. The official YouTube Data API only lets a video's *owner* download captions, and scraping the player's caption endpoints is not permitted by YouTube's terms. Transcripts are instead produced by **Gemini's officially supported YouTube video input** (public videos only) or, for uploads, from the extracted audio. Caption availability (creator-provided vs auto-generated) is still shown when the Data API reports it, but the transcript is labelled "Generated by AI from the video's audio, not YouTube's captions". Private, unlisted, age-restricted, removed and live videos are rejected with a clear reason.

### Setting up Cloudflare R2 for uploads

1. In the Cloudflare dashboard, create an R2 bucket (e.g. `briefly-videos`) and keep **public access disabled**.
2. Create an **R2 API token** with *Object Read & Write* for that bucket. Note the Access Key ID, Secret Access Key and your account ID.
3. In `backend/.env` set:
   ```
   STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   STORAGE_BUCKET=briefly-videos
   STORAGE_ACCESS_KEY_ID=<access key id>
   STORAGE_SECRET_ACCESS_KEY=<secret access key>
   STORAGE_REGION=auto
   ```
4. In `processing-service/.env` set `STORAGE_DOWNLOAD_HOSTS=<account-id>.r2.cloudflarestorage.com`.
5. Recommended: add a bucket lifecycle rule that aborts incomplete multipart uploads after 1 day.
6. Restart the API, worker and processing service. The worker logs "Maintenance worker started" when cleanup is active.

Any S3-compatible service works (AWS S3: regional endpoint and region; MinIO: `STORAGE_FORCE_PATH_STYLE=true`). Browsers never talk to the bucket directly except to play back your own uploads via short-lived signed URLs, so no bucket CORS rule is needed for uploads. If you want in-app playback of uploaded videos, allow `GET` from your frontend origin in the bucket's CORS policy.

### Upload security and retention

- Extension, declared MIME type **and file signature** (magic bytes read from the stream) must agree; renamed images, scripts or playlists are rejected (415).
- Files are streamed (never buffered in memory or written to the API's disk), size-limited while streaming (413), and stored under random keys; the filename is display-only (no path traversal).
- Duration is checked in the browser (best effort) and enforced by the worker with ffmpeg (`VIDEO_MAX_DURATION_MINUTES`).
- ffmpeg runs with a forced demuxer and `-protocol_whitelist https,tls,tcp`, so a crafted file can't make it read local files or other URLs.
- Identical files from the same user are de-duplicated by SHA-256.
- Video files are deleted after `UPLOAD_RETENTION_DAYS` (default 7) by an hourly cleanup job; failed uploads after `UPLOAD_FAILED_RETENTION_HOURS` (24). Transcripts and summaries are kept.

### Environment variables added in Milestone 3

| File | Variable | Default | Purpose |
|---|---|---|---|
| `backend/.env` | `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | (empty) | S3-compatible storage; uploads are disabled unless **all four** are set |
| | `STORAGE_REGION` | `auto` | `auto` for R2 |
| | `STORAGE_FORCE_PATH_STYLE` | `false` | `true` for MinIO |
| | `STORAGE_SIGNED_URL_TTL_SECONDS` | `900` | Lifetime of signed URLs |
| | `UPLOAD_MAX_BYTES` | `524288000` | 500 MB |
| | `VIDEO_MAX_DURATION_MINUTES` | `180` | Upload duration limit |
| | `YOUTUBE_MAX_DURATION_MINUTES` | `180` | YouTube duration limit (when known) |
| | `UPLOAD_RETENTION_DAYS` | `7` | Then the video file is deleted |
| | `UPLOAD_FAILED_RETENTION_HOURS` | `24` | For failed uploads |
| | `UPLOAD_RATE_LIMIT_MAX` | `10` | Uploads per user per hour |
| | `TRANSCRIPTION_CHUNK_SECONDS` | `600` | Transcription window length |
| | `PROCESSING_VIDEO_PREPARE_TIMEOUT_MS` | `120000` | Metadata/probe call timeout |
| | `PROCESSING_TRANSCRIBE_TIMEOUT_MS` | `420000` | Per-window transcription timeout |
| `processing-service/.env` | `YOUTUBE_API_KEY` | (empty) | YouTube Data API v3 key (optional, recommended) |
| | `TRANSCRIPTION_PROVIDER` | `gemini` | Provider registry key |
| | `TRANSCRIPTION_MODEL` | (= `GEMINI_MODEL`) | Model used for transcription |
| | `TRANSCRIPTION_MAX_OUTPUT_TOKENS` | `32768` | Per window |
| | `VIDEO_MAX_SUMMARY_CHARS` | `250000` | Transcript text sent to the summarizer |
| | `FFMPEG_PATH` | (bundled) | Override the ffmpeg bundled with `imageio-ffmpeg` |
| | `FFMPEG_TIMEOUT_SECONDS` | `300` | Per ffmpeg run |
| | `STORAGE_DOWNLOAD_HOSTS` | (empty) | Allowed hosts for signed media URLs |

## Document summarization (Milestone 4)

Users can upload **PDF, DOCX and TXT** files (Summarize → **Document**). Results include an executive overview, a detailed summary, a section-by-section breakdown, key takeaways, definitions, facts and figures, main arguments and **page references** (PDF) or **section references** (DOCX/TXT). The result page switches between **Summary**, **Original PDF** (opened at the referenced page) and **Extracted text**, and offers **Copy summary** and **Download original**.

```
POST /api/documents/uploads (streamed to R2/S3, signature-checked) → summarize_document job
  extracting   Python: download (signed URL) → PDF (pdfminer.six layout, page by page) / DOCX (python-docx) / TXT
               → parts saved per page (PDF) or per section (DOCX/TXT)
               scanned PDF pages → rendered (pypdfium2) → OCR (Gemini), in batches, capped
  summarizing  ≤ DOCUMENT_SINGLE_PASS_CHARS: one request
               longer: chunks at page/section boundaries → structured notes per chunk (map)
  combining    notes → final summary (reduce; hierarchical merge if the notes are still large)
```

### What needs which credentials

| Feature | Required |
|---|---|
| Document uploads | Object storage (`STORAGE_*` in `backend/.env`, same as video uploads) |
| Summaries and OCR | `GEMINI_API_KEY` (processing service) |

Without storage the Document tab explains that uploads aren't set up (`503 STORAGE_NOT_CONFIGURED`).

### Accuracy guarantees

- Page numbers come from the PDF itself; DOCX/TXT have no fixed pages, so references point to sections (headings) and the UI says so.
- Every page or section the model cites is checked against the pages/headings that actually contain text in what was summarized; anything else is discarded. Fake `[Page N]` markers inside a document are neutralised before the text reaches the model.
- Scanned pages beyond `DOCUMENT_MAX_OCR_PAGES` are **not** silently ignored: the summary page lists a warning, and the summary is marked as covering only part of the document.

### Document security

- Extension + MIME type + **file signature** must agree (`%PDF-`, ZIP header for DOCX, text heuristics for TXT); legacy `.doc`, macro-enabled `.docm` and templates are rejected.
- DOCX: zip-bomb guard (uncompressed size, entry count, compression ratio), macro-enabled content types rejected, XML parsed with entity resolution disabled (no XXE). Macros, scripts, form actions and embedded files are never executed in any format.
- Files are streamed to private storage under random keys; downloads and the inline PDF viewer use short-lived signed URLs issued only to the owner. DOCX/TXT are always served as attachments.
- Document text is untrusted: rules live only in the system instruction, the text is wrapped in markers, and output is schema-constrained and validated (Python, then Node).
- Temporary files are written to a per-request temporary directory and removed on success and on failure.
- Original files are deleted after `DOCUMENT_RETENTION_DAYS` (default 30) by the hourly cleanup; extracted text and summaries are kept.

### Environment variables added in Milestone 4

| File | Variable | Default | Purpose |
|---|---|---|---|
| `backend/.env` | `DOCUMENT_MAX_BYTES` | `52428800` | 50 MB upload limit |
| | `DOCUMENT_MAX_PAGES` | `1000` | Pages processed per PDF |
| | `DOCUMENT_RETENTION_DAYS` | `30` | Then the original file is deleted |
| | `DOCUMENT_SINGLE_PASS_CHARS` | `150000` | Up to this size: one summary request |
| | `DOCUMENT_CHUNK_CHARS` | `60000` | Chunk size for long documents (map step) |
| | `DOCUMENT_MAX_OCR_PAGES` | `50` | OCR cost cap per document |
| | `DOCUMENT_OCR_BATCH_PAGES` | `5` | Pages per OCR request |
| | `PROCESSING_DOCUMENT_EXTRACT_TIMEOUT_MS` / `PROCESSING_OCR_TIMEOUT_MS` / `PROCESSING_DOCUMENT_SUMMARIZE_TIMEOUT_MS` | `600000` / `420000` / `900000` | Worker → processing-service timeouts |
| `processing-service/.env` | `DOCUMENT_MAX_BYTES`, `DOCUMENT_MAX_PAGES` | as above | Enforced again by the extractor |
| | `DOCUMENT_MAX_CHARS` | `2000000` | Extracted text kept per document |
| | `DOCUMENT_PART_CHARS` | `4000` | DOCX/TXT part size |
| | `DOCUMENT_MAX_BLOCK_CHARS` | `4000` | Long paragraphs split at sentence boundaries |
| | `DOCX_MAX_UNCOMPRESSED_BYTES` | `209715200` | Zip-bomb guard |
| | `DOCUMENT_COMBINE_MAX_CHARS` | `150000` | Above this, chunk notes are merged hierarchically |
| | `OCR_PROVIDER` | `gemini` | OCR provider registry key |
| | `OCR_MODEL` | (= `GEMINI_MODEL`) | Model used for OCR |
| | `OCR_DPI` | `150` | Page render resolution for OCR |
| | `OCR_MAX_PAGES_PER_REQUEST` | `5` | Upper bound per OCR request |

## Ask AI, smart search and study tools (Milestone 5)

Every completed summary is automatically **indexed** for retrieval. The stored content is split into ~1,200-character chunks: article text, transcript segments with timestamps, or document parts with pages and sections, plus the summary itself. Each chunk is embedded with Gemini (`gemini-embedding-001`, 768 dimensions) and saved in MongoDB (`contentchunks`). Nothing is re-fetched, re-transcribed or re-extracted. On top of that index:

- **Ask AI** (sidebar → *Ask AI*, or the *Ask AI* tab on any source): persistent conversations about one source or the whole library.
  - Each question retrieves the most relevant chunks of **your own** content (hybrid semantic + keyword search) and sends only those, plus the last few messages, to Gemini.
  - Answers come with citations (source, page / timestamp / section).
  - Answers say clearly when the content does not cover the question (*not found in the source* / *partly answered*).
  - Conversations can be continued, renamed and deleted.
- **Smart search** (Library → *Smart search*): natural-language search inside all summaries, transcripts and documents, with type and date filters and matching passages. When embeddings are unavailable it falls back to keyword matching and says so.
- **Study tools** (tabs on a completed source):
  - **Study notes**: overview, key concepts, definitions, facts, examples, formulas and revision points. Copy or export them as Markdown. Background knowledge from outside the source is shown separately and labelled.
  - **Quizzes**: multiple choice, true/false and short answer, with a chosen difficulty and question count. Answers stay hidden until you submit. Scoring happens on the server, and the review shows explanations and references. Quizzes can be retried.
  - **Flashcards**: flip, previous/next, shuffle, a progress bar, and "I knew it / still learning" tracking.
- **Summary styles**: the summary can be rewritten as concise, detailed, bullet points, academic, beginner friendly, technical or exam revision, using only the stored content. The default style and the study-tool defaults are set in *Settings → Study preferences*.

Expensive work (indexing, notes, quizzes, flashcards, styles) runs as background jobs in the existing worker. Only Ask AI answers and searches run during the request.

### What needs which credentials

| Feature | Needs |
|---|---|
| Indexing, Ask AI, semantic search, study tools, summary styles | `GEMINI_API_KEY` in `processing-service/.env` (the same key as before; no new credentials) |
| Keyword search fallback, browsing saved conversations / notes / quizzes / flashcards | nothing extra |
| Atlas Vector Search (recommended) | A MongoDB **Atlas** cluster (the free M0 tier works) and the index, created once with `npm run rag:create-index` |

### Vector search setup (MongoDB Atlas)

Briefly stores vectors in MongoDB itself. **MongoDB Atlas Vector Search was evaluated first and chosen**, so no extra database or service is needed (see `docs/ARCHITECTURE.md`, section 9). After configuring `backend/.env`:

```bash
cd backend
npm run rag:create-index     # creates the "content_chunks_vector" index and waits until it is queryable
npm run rag:backfill         # queues indexing for sources summarized before Milestone 5 (the worker must be running)
```

The script creates this index definition. You can also paste it into Atlas → *Search & Vector Search* → *JSON editor* on the `contentchunks` collection:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "user" },
    { "type": "filter", "path": "source" },
    { "type": "filter", "path": "kind" },
    { "type": "filter", "path": "sourceCreatedAt" }
  ]
}
```

With `VECTOR_STORE=auto` (the default), the backend uses Atlas Vector Search once the index is queryable. Until then, and on local MongoDB or in tests, it uses an exact in-process cosine search bounded by `RAG_EXACT_SCAN_LIMIT`.

Changing `EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS` means re-running `rag:create-index` and then `npm run rag:backfill -- --all`, because vectors from different models are not comparable.

### Security

- **Ownership:** every retrieval is filtered by the signed-in user three times: inside `$vectorSearch` (pre-filter), again with `$match`, and once more in code. Keyword search uses a `{ user, text }` index. A source-scoped chat can only use that source's chunks. Another user's ids return 404 everywhere.
- **Prompt injection:** saved content is treated as untrusted.
  - Chunks are wrapped in markers, and marker look-alikes inside them are neutralised.
  - The rules live only in the system instruction.
  - Output is schema-constrained and validated in Python, then again in Node.
  - Citations and references must be ids of chunks that were actually supplied.
- **Quiz answers:** answer keys never leave the server before an attempt is submitted.
- **Rate limits** per user per hour: questions (`CHAT_RATE_LIMIT_MAX`), study generations (`STUDY_RATE_LIMIT_MAX`) and searches (`SEARCH_RATE_LIMIT_MAX`).
- **Context limits:** each question sends at most `RAG_TOP_K` chunks and `CHAT_HISTORY_MESSAGES` previous messages. Study tools receive an evenly spread sample of at most `STUDY_INPUT_CHARS` characters. Whole documents are never sent.

### Environment variables added in Milestone 5

| File | Variable | Default | Purpose |
|---|---|---|---|
| `backend/.env` | `VECTOR_STORE` | `auto` | `atlas`, `exact` or `auto` |
| | `VECTOR_INDEX_NAME` | `content_chunks_vector` | Atlas vector index name |
| | `EMBEDDING_DIMENSIONS` | `768` | Must match the processing service and the index |
| | `RAG_AUTO_INDEX` | `true` | Index sources when their summary completes |
| | `RAG_CHUNK_CHARS` / `RAG_CHUNK_OVERLAP_CHARS` | `1200` / `150` | Chunk size and overlap |
| | `RAG_MAX_CHUNKS_PER_SOURCE` | `3000` | Cap per source |
| | `RAG_EMBED_BATCH_SIZE` | `64` | Chunks per embedding request |
| | `RAG_TOP_K` / `RAG_NUM_CANDIDATES` | `8` / `150` | Chunks per question / Atlas candidates |
| | `RAG_EXACT_SCAN_LIMIT` | `20000` | Exact-store scan cap |
| | `CHAT_HISTORY_MESSAGES` / `CHAT_MAX_MESSAGE_CHARS` | `8` / `2000` | Conversation context and question length |
| | `STUDY_INPUT_CHARS` | `60000` | Content sampled for one study generation |
| | `CHAT_RATE_LIMIT_MAX` / `STUDY_RATE_LIMIT_MAX` / `SEARCH_RATE_LIMIT_MAX` | `60` / `30` / `120` | Per user per hour |
| | `PROCESSING_EMBED_TIMEOUT_MS` / `PROCESSING_ANSWER_TIMEOUT_MS` / `PROCESSING_STUDY_TIMEOUT_MS` | `60000` / `90000` / `300000` | Timeouts for AI calls |
| `processing-service/.env` | `EMBEDDING_PROVIDER` | `gemini` | Embedding provider registry key |
| | `EMBEDDING_MODEL` | `gemini-embedding-001` | Embedding model |
| | `EMBEDDING_DIMENSIONS` | `768` | Output dimensionality (64–3072) |
| | `EMBEDDING_BATCH_SIZE` | `100` | Texts per Gemini embedding call |
| | `RAG_MAX_CONTEXT_CHARS` | `16000` | Retrieved context per answer |
| | `STUDY_MAX_INPUT_CHARS` | `80000` | Content per study generation |

## Free-tier operation (Gemini)

Briefly AI is designed to run on Google's **free** Gemini API tier only. No billing is enabled, and no paid AI, embedding or transcription service is used. **Free-tier availability, models and quotas are set by Google and may change at any time.** Briefly never assumes a quota; it reacts to what Gemini actually returns.

### Models

The generation model and the embedding model are configured independently in `processing-service/.env` (`TRANSCRIPTION_MODEL` and `OCR_MODEL` default to `GEMINI_MODEL`):

| Setting | Current default | Notes |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Stable and listed as *Free of charge*. Verified with Briefly's structured outputs (summaries, quizzes, grounding), and the fastest of the free models tested. It replaces `gemini-2.5-flash`, which Google deprecated (requests route to `gemini-3.5-flash-lite` from 1 Dec 2026; 20 requests/day was observed on a free project). |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | Listed as free; verified working (768 dimensions). |

**Changing models safely**
1. Pick a model that the [pricing page](https://ai.google.dev/gemini-api/docs/pricing) lists as *Free of charge* on the Free tier. Then check its quota on the [AI Studio rate-limit page](https://aistudio.google.com/rate-limit).
2. Set `GEMINI_MODEL` (or `EMBEDDING_MODEL`) in `processing-service/.env` and restart the processing service. Briefly never switches models on its own.
3. If the model isn't available to your key, requests fail with `AI_MODEL_UNAVAILABLE` and a clear message. AI calls then pause for 10 minutes instead of failing one by one.
4. Changing the **embedding** model also requires `npm run rag:create-index` (if the dimensions change) and `npm run rag:backfill -- --all`, because vectors from different models are not comparable.
5. Raise or lower Briefly's budgets (below) to match the new model's quota.

A model that appears in the model list is not necessarily usable: `gemini-2.5-flash-lite` is listed for the tested key, but generation returns 404. Always test one real request.

### Quota-aware request manager

Every Gemini call (summaries, transcription, OCR, Ask AI, study tools, styles and embeddings) goes through one manager (`backend/src/services/ai/aiGate.js`). It keeps its state in Redis, so the API and every worker share it.

1. **Provider state.** When Gemini returns 429, the manager reads the quota id and `RetryInfo.retryDelay`:
   - A daily quota (`…PerDay…`) is reported as `AI_QUOTA_EXHAUSTED`.
   - Per-minute or unknown limits are reported as `AI_RATE_LIMITED`.

   Further calls to that model pause until the provider's delay has passed; nobody keeps hammering an exhausted quota. If Gemini gives no delay, a configurable fallback is used and the UI labels the time as an estimate.
2. **Briefly's budgets.** Before each call, one request is reserved atomically (a Redis Lua script) against several counters: the per-minute pace, the app-wide daily total, the feature group (summaries / Ask AI / study tools), and the user's daily total. Concurrent workers can never overshoot a budget.
3. **Concurrency.** A bounded number of simultaneous Gemini calls is allowed per kind (shared leases).
4. **Accounting.** The processing service reports how many Gemini requests a call really made (`X-Gemini-Requests`: validation retries, transcription windows, embedding batches). Usage is recorded per feature, model and user, together with the token counts Gemini returns.

**Background jobs** that hit a limit are moved to BullMQ's *delayed* set until the provider's retry time or the budget reset. The wait occupies no worker and uses no attempt, and the visible item says why it is paused. Delays are bounded (`AI_MAX_DEFERRALS`, `AI_MAX_DEFER_HOURS`). After the bound, the item fails with a clear message and can be retried. Invalid keys, unavailable models and malformed requests are never retried. Transient errors (an overloaded model, timeouts) use bounded exponential backoff starting at 20 s.

**Ask AI** checks availability first. When Gemini or the budget is exhausted, it answers immediately with a clear message and a `Retry-After` header, without spending an embedding request. Saved content stays available.

### Briefly's own usage limits

These are protective limits **chosen by Briefly**, not Google's quotas. The defaults are conservative for a free project. Raise them only after checking your quotas in AI Studio.

| Variable (`backend/.env`) | Default | Meaning |
|---|---|---|
| `AI_APP_DAILY_GENERATION_LIMIT` | `15` | Gemini generation requests per day, whole app |
| `AI_APP_DAILY_SUMMARY_LIMIT` / `_CHAT_LIMIT` / `_STUDY_LIMIT` | `10` / `8` / `6` | Daily share per feature group |
| `AI_USER_DAILY_GENERATION_LIMIT` | `10` | Per user per day |
| `AI_APP_DAILY_EMBEDDING_LIMIT` / `AI_USER_DAILY_EMBEDDING_LIMIT` | `500` / `200` | Embedding requests per day |
| `AI_GENERATION_RPM` / `AI_EMBEDDING_RPM` | `4` / `30` | Requests per minute Briefly allows itself |
| `AI_MAX_CONCURRENT_GENERATIONS` / `_EMBEDDINGS` | `2` / `2` | Parallel calls |
| `AI_BUDGET_TIMEZONE` | `America/Los_Angeles` | Daily budgets reset at midnight here (Google resets daily quotas at midnight Pacific) |
| `AI_RATE_LIMIT_FALLBACK_SECONDS` / `AI_QUOTA_FALLBACK_SECONDS` | `60` / `3600` | Wait used only when Gemini gives no retry delay |
| `AI_MAX_DEFERRALS` / `AI_MAX_DEFER_HOURS` / `AI_MAX_DELAY_SECONDS` | `30` / `48` / `21600` | Bounds for jobs waiting for quota |
| `AI_TRANSIENT_RETRY_SECONDS` | `20` | First retry delay for transient AI errors |
| `AI_GATE_STORE` | `auto` | `redis` (shared), `memory` (one process) or `auto` |
| `RAG_SEARCH_MIN_SCORE` | `0.8` | Smart-search relevance threshold (see below) |
| `RAG_CHAT_MIN_SCORE` | `0` | Ask AI retrieval threshold (off) |

When a limit is reached, no API call is made and the user sees which limit it was and when it resets. Saved summaries, notes, quizzes, flashcards, conversations and keyword search keep working. **Settings → AI usage** shows today's usage per feature, the remaining budget, and whether Gemini is available, rate-limited or out of quota. It also links to AI Studio, the only place that shows Google's remaining quota.

### Avoiding unnecessary requests

- **Summaries** are cached by a hash of the content sent to the summarizer. A retry with unchanged content reuses the summary; changed content or a new `SUMMARY_CACHE_VERSION` invalidates it. Summary styles are cached per style.
- **Embeddings:**
  - An unchanged, fully indexed source is never re-embedded (content hash).
  - Re-indexing reuses vectors for unchanged chunks (same model and dimensions), and identical texts are embedded once.
  - Search-query vectors are cached per user for 30 minutes.
- **Study material** (notes, flashcards, styles, quizzes with the same settings) is reused until the source content changes or you explicitly regenerate. Changed sources are flagged *stale*.
- **Ask AI:**
  - A second question while one is being answered gets 409.
  - Re-sending the same question id returns the stored answer.
  - Context stays limited to `RAG_TOP_K` passages and `CHAT_HISTORY_MESSAGES` messages.

All caches are scoped to the same source and user; nothing is shared across users.

### Smart-search relevance

Semantic scores use one scale for both stores: cosine similarity mapped to 0..1, as Atlas `vectorSearchScore` reports for cosine indexes. Keyword-only matches are scored against the query vector too, and anything below `RAG_SEARCH_MIN_SCORE` is dropped, so unrelated sources are no longer returned. In keyword-only mode (embeddings unavailable), keyword matches are kept and the UI says so.

**How 0.80 was chosen.** It was calibrated with real `gemini-embedding-001` vectors (2 embedding requests): 10 passages × 11 queries, labelled relevant or unrelated.
- Every relevant pair scored ≥ 0.842.
- Unrelated-topic pairs scored ≤ 0.788.
- The only "unrelated" pairs above 0.80 were same-topic neighbours.

At 0.80, 100% of relevant passages and none of the off-topic ones were kept.

### Monitoring usage

- **Briefly:** Settings → AI usage, or `GET /api/usage`.
- **Google:** [AI Studio → Rate limits](https://aistudio.google.com/rate-limit) shows your project's actual limits and usage. Limits apply per project, not per key, and are not guaranteed.

### Known free-tier limitations

- Daily free quotas can be small (20 requests/day was observed for `gemini-2.5-flash`). A long video or document can need several requests (one per transcription window or document chunk) and may finish over more than one day.
- Briefly can't know Google's remaining quota or the exact reset time. Times shown come from Gemini's retry delay when it gives one, and are labelled as estimates otherwise.
- Free-tier models can be overloaded (HTTP 503) or slow. Such errors are retried with backoff, but a job may still fail and need a retry.
- Google may change or retire free models (for example the `gemini-2.5-flash` deprecation). Check the pricing page when something stops working.

## Running tests

```bash
# Frontend: rendering, navigation, auth forms, protected routes, article/YouTube submission,
# video upload (validation, progress, cancel, storage-not-configured), summary pages (processing,
# failed/retry, copy, chapters seeking the player, transcript search), document upload and results (tabs,
# page references opening the PDF, extracted text, download), library filters, dashboard, Ask AI (citations,
# not-found answers, errors, history), workspace tabs, study notes, quizzes, flashcards, summary styles,
# smart search and study preferences
cd frontend && npm test
cd frontend && npm run lint
cd frontend && npm run build

# Backend unit/API tests: auth, jobs, worker retry/failure logic, URL validation, article/source API,
# YouTube URL parsing, streaming upload validation (signatures, size, traversal, dedupe), transcript and
# playback ownership, video job handlers (windowing, resume, failures), expired-upload cleanup, rate limits,
# document upload validation, original-file and extracted-text ownership, document job handler
# (direct vs map-reduce, OCR batching and cap, resume, failures), chunking, indexing (batches, resume,
# dimension checks), retrieval ownership (exact and Atlas pipelines, cross-user isolation), Ask AI, smart
# search, study notes / quizzes (hidden answers, scoring) / flashcards / summary styles, preferences,
# the AI quota manager (budgets, atomic reservations, pacing, concurrency, 429 handling, delayed job
# retries), summary / embedding / study caching, search relevance threshold and the usage overview.
# Uses an in-memory MongoDB (downloaded automatically on first run); the queue and the
# processing service and object storage are mocked, so no other services are needed.
cd backend && npm test
cd backend && npm run lint

# Processing service: health, internal auth, SSRF/URL safety, safe fetching, article extraction,
# YouTube parsing/metadata, ffmpeg probing/audio extraction on generated test videos, transcription
# normalization, timestamp grounding, PDF/DOCX/TXT extraction on generated documents (scanned, encrypted,
# corrupted, macro, zip bomb, encodings), chunking, page/section reference grounding, hierarchical merge,
# Gemini output validation and error mapping, embeddings, RAG answers (citation grounding, injection
# markers, not-found handling), study tools, quota-error classification (daily vs per-minute, retry
# delays), request counting, all endpoints.
# Gemini and YouTube are always mocked.
cd processing-service && .venv\Scripts\python -m pytest
cd processing-service && .venv\Scripts\python -m ruff check app tests

# Infrastructure tests against REAL MongoDB, Redis and the processing service:
# MongoDB/Redis connectivity, Python communication, readiness, and a BullMQ job
# completing end to end. Requires `docker compose up -d`, the processing service
# running, and backend/.env configured. Uses database `briefly_ai_infra_test` and
# queue prefix `briefly-infra-test`, so dev data is untouched.
cd backend && npm run test:infra
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Invalid configuration: JWT_ACCESS_SECRET is required` | Create `backend/.env` from the example and set real secrets. |
| API exits with `MongoDB ... ECONNREFUSED` / server selection timeout | MongoDB is not running: `docker compose up -d`, check `MONGODB_URI`. |
| `Redis connection error (api)` in logs; jobs return 503 `QUEUE_UNAVAILABLE` | Redis is not running or `REDIS_URL` is wrong. The API keeps working for auth; jobs resume once Redis is reachable. |
| Test job stays `queued` | The worker is not running: `npm run worker:dev` in `backend/`. |
| Test job fails with `PROCESSING_UNAUTHORIZED` | `INTERNAL_SERVICE_SECRET` differs between `backend/.env` and `processing-service/.env`. |
| Test job fails with `PROCESSING_SERVICE_UNREACHABLE` after 3 attempts | Start the processing service; check `PROCESSING_SERVICE_URL`. |
| Processing service: `ValidationError ... internal_service_secret` | Set a secret of at least 32 characters in `processing-service/.env`. |
| Login works but you're signed out on reload | The refresh cookie is `Secure` while you're on http. Set `COOKIE_SECURE=false` for local development. Also make sure you use the Vite proxy (`VITE_API_BASE_URL=/api`). |
| `429 RATE_LIMITED` on login | More than `AUTH_RATE_LIMIT_MAX` auth requests in 15 minutes from your IP; wait or raise it locally. |
| Port 5173 already in use | Vite uses `strictPort`; stop the other process or change `server.port` in `vite.config.js`. |
| First `npm test` in backend is slow | mongodb-memory-server downloads a MongoDB binary once and caches it in `node_modules/.cache`. |
| Article fails with "AI summarization is not configured on the server" | Set `GEMINI_API_KEY` in `processing-service/.env` and restart the processing service, then press **Try again**. |
| Article fails with "AI summarization is not available right now" | The key is invalid/unauthorized or `GEMINI_MODEL` does not exist for your key. Check both. |
| "We couldn't find enough readable article text…" | The page is paywalled, needs JavaScript to render, or is not an article. Briefly does not execute page scripts. |
| "This URL cannot be fetched for security reasons" | The link (or a redirect) points to a private/internal address, a non-standard port, or contains credentials. This is intentional SSRF protection. |
| Summary stays on "Queued" | The worker is not running (`npm run worker:dev`). |
| Upload tab says "Video uploads aren't set up on this server" | Configure object storage (see "Setting up Cloudflare R2 for uploads") and restart the API and worker. |
| YouTube video fails with "Only public YouTube videos are supported…" | Gemini can only read public videos. Private, unlisted, age-restricted and removed videos are not supported. |
| Long YouTube video fails or times out | Set `YOUTUBE_API_KEY` so the duration is known and the video is transcribed in windows. |
| "No speech could be detected in this video" | The audio has no speech (music only, silent). Nothing is summarized rather than inventing content. |
| Uploaded video fails with "could not be read from storage" | Check `STORAGE_DOWNLOAD_HOSTS` matches your storage host, and that the processing service can reach it over HTTPS. |
| Uploaded video player shows an error | Add a CORS rule on the bucket allowing `GET` from your frontend origin, or use the transcript and timestamps without playback. |
| Document fails: "This PDF is password-protected" | Remove the password (e.g. print to PDF) and upload again. Briefly never asks for document passwords. |
| "We couldn't find any readable text" / scanned PDF not summarized | Check `GEMINI_API_KEY` (OCR uses Gemini) and `DOCUMENT_MAX_OCR_PAGES`. |
| Summary says only some scanned pages were read | Raise `DOCUMENT_MAX_OCR_PAGES` (costs more Gemini calls) and retry by uploading again. |
| Original PDF tab is blank | The browser blocked the cross-origin PDF viewer or the signed URL expired; use "Open in a new tab" or reload. |
| `429` "hourly limit for new summaries" | More than `ARTICLE_RATE_LIMIT_MAX` submissions/retries in an hour for your account. |
