# Briefly AI — Deployment

The recommended free deployment is **one Render web service** (free instance, Docker) that runs everything Briefly needs, plus three external services on their free plans:

| Part | Where | Notes |
|---|---|---|
| Express API **and** the built React app | Render web service (Docker) | one origin: the refresh cookie just works |
| BullMQ worker | same container | starts only once the shared Redis is ready |
| FastAPI processing service + FFmpeg | same container, `127.0.0.1:8000` | never reachable from the internet |
| MongoDB | MongoDB Atlas M0 (free) | with the vector index |
| Redis | Upstash Redis (free) | queue, AI budgets, locks |
| Uploaded files | Backblaze B2 (free 10 GB), private bucket | browsers upload **directly** with short-lived signed URLs |
| AI | Google Gemini API, **free tier only** | Google AI Studio API key |

Nothing requires billing or a payment card. Free plans, quotas and terms are set by the providers and change over time: check them before relying on them (links at the end).

## 1. How the single service works

```
Browser ──HTTPS──► Render :$PORT ──► Express ──┬─ /api/*        (API)
   │                                            └─ everything else (frontend/dist, SPA fallback)
   │                     Express / worker ──► 127.0.0.1:8000 FastAPI (+ FFmpeg)
   └──presigned PUT──► Backblaze B2 (file bytes never pass through Render)
```

- `deploy/start.sh` (run by `tini` as PID 1) starts FastAPI, waits for its `/health`, then starts the API and the worker. If any process exits, the others are stopped and the container exits non-zero so Render restarts it. `SIGTERM` is forwarded; the worker finishes active jobs within the grace period.
- The worker refuses to take jobs until Redis is ready (it exits after `WORKER_REDIS_READY_TIMEOUT_MS`, default 60 s), and never falls back to counting AI budgets in process memory.
- **Cookie rule:** the refresh token is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`. Serving the app and the API from one origin keeps it working. `*.onrender.com` is a public suffix, so two separate Render services would be *different sites* and users would be signed out on reload. Do not split them.

## 2. Create the Render service

1. Render dashboard → **New → Web Service** → connect the GitHub repository.
2. Settings:

   | Setting | Value |
   |---|---|
   | Language / Runtime | **Docker** (uses the `Dockerfile` in the repository root) |
   | Dockerfile path | `./Dockerfile`; build context `.` |
   | Instance type | **Free** |
   | Health check path | **`/api/health`** |
   | Auto-deploy | on commit (optional) |

   Do not set a start command: the image's `CMD` runs `deploy/start.sh`.
3. Add the environment variables from section 3 (**Environment → Add environment variable**). Mark every secret as a secret; never commit them.
4. Deploy. The first build takes several minutes. Then open `https://<service>.onrender.com`.

`/api/health` only says the API process is alive, so a short Redis or Atlas hiccup does not make Render restart the service. `/api/health/ready` (MongoDB, Redis, processing service; 503 when one is down) is for your own checks, not the platform health check.

## 3. Environment variables

The image already sets: `NODE_ENV=production`, `ENVIRONMENT=production`, `PORT=10000`, `TRUST_PROXY=1`, `COOKIE_SECURE=true`, `FRONTEND_DIST_DIR=/app/frontend/dist`, `PROCESSING_SERVICE_URL=http://127.0.0.1:8000`, `WORKER_CONCURRENCY=1`. Do not change `PROCESSING_SERVICE_URL`; the processing service gets its own host and port from `deploy/start.sh`.

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

**Required (set in Render):**

| Variable | Secret | Value |
|---|---|---|
| `FRONTEND_ORIGIN` | no | `https://<service>.onrender.com` (exact origin, no trailing slash) |
| `MONGODB_URI` | **yes** | Atlas connection string (database `briefly_ai`) |
| `REDIS_URL` | **yes** | Upstash `rediss://…` URL |
| `JWT_ACCESS_SECRET` | **yes** | long random value |
| `INTERNAL_SERVICE_SECRET` | **yes** | long random value (used by both the API and the processing service) |
| `GEMINI_API_KEY` | **yes** | your free-tier key |
| `STORAGE_ENDPOINT` | no | `https://s3.us-east-005.backblazeb2.com` (your bucket's endpoint) |
| `STORAGE_REGION` | no | `us-east-005` |
| `STORAGE_BUCKET` | no | your bucket name |
| `STORAGE_ACCESS_KEY_ID` | **yes** | B2 application key ID |
| `STORAGE_SECRET_ACCESS_KEY` | **yes** | B2 application key |
| `STORAGE_FORCE_PATH_STYLE` | no | `true` (required for B2) |
| `STORAGE_DOWNLOAD_HOSTS` | no | `s3.us-east-005.backblazeb2.com` (host of the endpoint) |

**Recommended for Render Free** (set these too; they fit the 0.1 CPU / 512 MB instance):

| Variable | Value | Why |
|---|---|---|
| `PROCESSING_READY_TIMEOUT_SECONDS` | `300` | at 0.1 CPU the processing service can take well over a minute to import and start; the default (120 s) could make `start.sh` give up and restart the container in a loop |
| `DOCUMENT_MAX_BYTES` | `20971520` (20 MB) | large PDFs and TXT files are parsed in memory; a 20 MB limit keeps one document from exhausting the 512 MB shared by all three processes (the code default is 50 MB) |

**Optional** (defaults shown are what the code uses when unset):

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | log verbosity |
| `GEMINI_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | `gemini-3.5-flash-lite`, `gemini-embedding-001`, `768` | keep these; the dimensions must match the Atlas index |
| `AI_*` budgets | conservative defaults | raise only after checking AI Studio quotas |
| `WORKER_DRAIN_DELAY_SECONDS` | `60` | idle Redis polling of the worker (see section 5) |
| `WORKER_STALLED_INTERVAL_MS` | `120000` | how often crashed jobs are looked for |
| `MAINTENANCE_INTERVAL_MS` | `3600000` | expired-upload cleanup interval |
| `AUTH_RATE_LIMIT_MAX` | `20` | login/registration attempts per IP per 15 min |
| `AUTH_REFRESH_RATE_LIMIT_MAX` | `120` | session refreshes (page loads) per IP per 15 min |
| `UPLOAD_MAX_BYTES` / `DOCUMENT_MAX_BYTES` | 500 MB / 50 MB | upload limits (on Render Free set `DOCUMENT_MAX_BYTES=20971520`, see above) |
| `STORAGE_UPLOAD_URL_TTL_SECONDS` | `900` | lifetime of a presigned upload URL |
| `UPLOAD_PENDING_GRACE_SECONDS` | `3600` | how long an unfinished upload is kept before cleanup |
| `UPLOAD_MAX_PENDING_PER_USER` | `3` | uploads a user may have started but not completed |
| `SHUTDOWN_GRACE_SECONDS` | `25` | time processes get to stop after `SIGTERM` |

`AI_MOCK_MODE` must stay unset in production (the processing service refuses it there).

## 4. External services

### MongoDB Atlas (M0)
- **Network Access:** Atlas must accept connections from Render. If Render lists outbound IP addresses for your service's region, add those to the Atlas IP access list; otherwise allow `0.0.0.0/0`. The latter relies entirely on the database credentials: use a dedicated database user with a long random password and access to `briefly_ai` only.
- Once per cluster: `cd backend && npm run rag:create-index` (Atlas vector index), and `npm run rag:backfill` if older sources exist.
- M0 pauses after 30 days without any connection; a sleeping Render service holds no connection.

### Upstash Redis (free)
- Use the database's `rediss://` URL as `REDIS_URL`. Keep the default **`noeviction`** policy (BullMQ requires it).
- The free plan includes 500K commands a month. Briefly's worker is tuned for it (section 5).

### Backblaze B2
1. Create a **private** bucket. Note its S3 endpoint and region.
2. **Lifecycle settings → "Keep only the last version of the file"** (recommended). Briefly already removes every version of files it deletes.
3. **Application Keys → Add a New Application Key**, restricted to this bucket, *Read and Write*. Briefly needs read, write, delete and list (list is used only to remove old versions of a file being deleted).
4. Set the `STORAGE_*` variables above. `STORAGE_FORCE_PATH_STYLE=true` is required.
5. **Set the CORS rule** below. Without it, browsers cannot upload.
6. **Caps & Alerts:** set caps (storage, downloads, transactions) at the free amounts so usage can never be charged.

#### B2 CORS rule (direct uploads)

Only the browser's `PUT` to a presigned URL needs CORS. Video playback and the PDF viewer use signed URLs as media/frames and need no CORS rule. Replace the origin with your Render URL:

```json
[
  {
    "corsRuleName": "briefly-direct-uploads",
    "allowedOrigins": ["https://<service>.onrender.com"],
    "allowedOperations": ["s3_put"],
    "allowedHeaders": ["content-type", "content-disposition"],
    "exposeHeaders": ["etag"],
    "maxAgeSeconds": 3600
  }
]
```

- No wildcard origin, only the `PUT` operation, only the two headers the app sends. Uploads send no cookies or credentials to B2.
- Apply it with the [B2 command-line tool](https://www.backblaze.com/docs/cloud-storage-enable-cors-with-the-cli): save the JSON as `cors.json`, then `b2 bucket update --cors-rules "$(cat cors.json)" <bucket-name>`. This **replaces** the bucket's existing CORS rules: if the bucket already has rules, add this object to them. Keep the bucket `allPrivate`.
- The dashboard's built-in CORS options are reported not to be enough for presigned S3 uploads; use the CLI (or `b2_update_bucket`).
- For local development (`http://localhost:5173`) add that origin to `allowedOrigins` of the same rule.

### Cloudflare R2 (alternative to B2)
Endpoint `https://<account-id>.r2.cloudflarestorage.com`, `STORAGE_REGION=auto`, `STORAGE_FORCE_PATH_STYLE=false`, `STORAGE_DOWNLOAD_HOSTS=<account-id>.r2.cloudflarestorage.com`, an API token with *Object Read & Write* for the bucket, and an R2 CORS policy allowing `PUT` from your origin with the `Content-Type` and `Content-Disposition` headers.

## 5. Free-tier limits and how Briefly fits them

| Limit | Effect | What Briefly does |
|---|---|---|
| Render free: 512 MB RAM, 0.1 CPU | three processes share it (~300 MB idle, measured locally) | `WORKER_CONCURRENCY=1`; heap caps for the Node processes (`API_MAX_OLD_SPACE_MB`=160, `WORKER_MAX_OLD_SPACE_MB`=192) |
| Render free sleeps after 15 min without inbound traffic; ~1 min to wake | first request after idle is slow | the frontend retries safe requests with backoff and shows "Briefly is waking up"; session restore never signs you out because of a cold start |
| Background jobs only run while the service is awake | a long job may be cut off if nobody is using the app; quota-paused jobs continue on the next visit | jobs resume (finished windows/chunks are kept); stalled jobs are re-queued when the worker restarts |
| Render Hobby: 5 GB outbound bandwidth a month | over the limit, services are suspended until next month | **file bytes go browser → B2 directly**; only small API responses leave Render |
| Upstash free: 500K commands a month | an always-on BullMQ worker polls Redis | idle wait raised to 60 s (new jobs still start immediately), stalled checks every 2 min, and the hourly cleanup is a timer with a Redis lock instead of a second polling queue. Delayed (quota-paused) jobs are still checked every 10 s while they wait (BullMQ) |
| Ephemeral disk | lost on restart / spin-down | only temporary audio files (FFmpeg) are written, inside the request |

Processing is slow at 0.1 CPU (long PDFs, OCR, FFmpeg), and Render may suspend free services that create an "uncommonly high" volume of outbound traffic. Briefly suits personal and demo use on this plan.

## 6. After the first deploy: check it

1. `https://<service>.onrender.com/api/health` → `{"success":true,"data":{"status":"ok",…}}`.
2. Open the app, register, reload the page: you stay signed in (cookie on the same origin).
3. Add an article, then a YouTube video: both summarize.
4. **Upload a small PDF** (Summarize → Document). In the browser's developer tools (Network), the file goes as a `PUT` to `s3.…backblazeb2.com` and only small JSON requests go to `/api/…/uploads/direct…`. The summary is created.
5. Upload a DOCX, a TXT and a short MP4: all process. The video plays on its summary page; the PDF opens in the viewer.
6. Ask AI, smart search, notes, quiz and flashcards on a summarized source.
7. Leave the app for 20 minutes, then reload: the "waking up" notice appears and the app loads within about a minute.
8. Render **Logs**: three processes started (`supervisor: started processing / api / worker`), `Processing worker started … "aiBudgetStore":"redis (required)"`.

If uploads fail with a network/CORS error, the B2 CORS rule is missing or its origin does not match exactly.

## 7. Health, logging and shutdown

- `GET /api/health`: liveness (platform health check). `GET /api/health/ready`: dependencies (503 when one is down). Processing service: `GET /health` (internal only).
- Logs are structured JSON lines on stdout. Secrets, tokens, cookies and keys are redacted; request bodies are never logged.
- `SIGTERM`: the supervisor forwards it; the API stops accepting requests, the worker finishes active jobs, and processes still running after `SHUTDOWN_GRACE_SECONDS` are killed. Delayed jobs stay in Redis and continue after a restart.

## 8. Retention and cleanup

- Uploaded videos are deleted after `UPLOAD_RETENTION_DAYS` (default 7), documents after `DOCUMENT_RETENTION_DAYS` (default 30); files of permanently failed uploads after `UPLOAD_FAILED_RETENTION_HOURS`. Summaries, transcripts and extracted text are kept.
- Direct uploads use two keys: the browser's presigned URL writes to an *upload key*; on completion the API copies it inside the bucket to a separate key the browser never sees, verifies **that copy** (size, type, SHA-256) and processes only the copy. Reusing the URL afterwards therefore cannot change what is processed.
- The upload key is deleted after completion, and deleted again once its URL can no longer be used (`STORAGE_UPLOAD_URL_TTL_SECONDS` + `UPLOAD_PENDING_GRACE_SECONDS`), whatever happened to the upload (completed, cancelled, rejected, duplicate). Uploads started but never completed are removed by the same hourly cleanup once their deadline passes. Only the exact keys recorded on each upload are deleted; a stored upload's own copy is never removed before its retention ends.

## 9. Monitoring the free tier

- Briefly: **Settings → AI usage**, or `GET /api/usage`: Briefly's budgets, usage per feature and model, and Gemini's state.
- Google: **AI Studio → Rate limits** (https://aistudio.google.com/rate-limit) shows your project's real quotas. Raise the `AI_*` budgets only after checking it.
- Render: **Metrics** (memory, bandwidth). Upstash: **Usage** (commands). B2: **Caps & Alerts**.

## 10. Local build of the image (optional)

```bash
docker build -t briefly-ai .
docker run --rm -p 10000:10000 --env-file ./deploy.env briefly-ai   # deploy.env: your own file, never committed
```

`.dockerignore` keeps `.env` files, `node_modules`, `.venv`, tests and local data out of the build context.

## References

Render free instances: https://render.com/docs/free · Render bandwidth: https://render.com/docs/outbound-bandwidth · Upstash pricing: https://upstash.com/pricing/redis · Upstash with BullMQ: https://upstash.com/docs/redis/integrations/bullmq · Atlas free cluster limits: https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/ · B2 CORS rules: https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules · B2 caps: https://www.backblaze.com/docs/cloud-storage-data-caps-and-alerts
