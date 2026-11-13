# Briefly AI — Deployment

Briefly AI has four processes and three external services:

| Part | Runs | Free option |
|---|---|---|
| Frontend (static build) | `cd frontend && npm ci && npm run build` → `frontend/dist` | Cloudflare Pages, Netlify, Vercel |
| API (Express) | `cd backend && npm ci --omit=dev && npm start` | Render / Koyeb / Fly.io free instance, or any VM |
| Worker (BullMQ) | `cd backend && npm run worker` | same host as the API (second process) |
| Processing service (FastAPI) | `cd processing-service && pip install -r requirements.txt && python -m app` | same host as the API (private, never public) |
| MongoDB | MongoDB Atlas M0 (free), with the vector index | Atlas M0 |
| Redis | Upstash Redis (free) | Upstash |
| Object storage (uploads) | Any S3-compatible bucket: Backblaze B2 (verified) or Cloudflare R2 | B2 / R2 free tiers (10 GB) |
| AI | Google Gemini API, **free tier only** | Google AI Studio API key |

Free tiers, quotas and the providers' terms are set by those providers and change over time; check them before relying on them. Nothing in Briefly requires billing.

## 1. Topology and the cookie rule

The refresh token is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/auth`. **The browser must reach the API on the same site as the frontend.** Use one of:

- **Recommended:** serve the frontend and proxy `/api/*` to the API from the same domain.
  - Cloudflare Pages / Netlify / Vercel: add a rewrite from `/api/*` to `https://<your-api-host>/api/:splat`.
  - A single VM: one reverse proxy (Caddy/nginx) for both.

  Keep `VITE_API_BASE_URL=/api`.
- Or host both on subdomains of one registered domain (`app.example.com` and `api.example.com` are the same *site*). Then set `VITE_API_BASE_URL=https://api.example.com/api` and `FRONTEND_ORIGIN=https://app.example.com`.

Different registrable domains (for example `*.vercel.app` and `*.onrender.com`) will **not** keep users signed in after a reload. Use the proxy instead.

The processing service must **not** be reachable from the internet. Run it on the API host, bound to `127.0.0.1` (the default), and set `PROCESSING_SERVICE_URL=http://127.0.0.1:8000` in the backend.

## 2. Production environment

Generate secrets with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

**backend/.env**

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (enforces `COOKIE_SECURE=true`) |
| `PORT` | host-provided port |
| `TRUST_PROXY` | `1` behind one proxy / load balancer (needed for correct rate-limit IPs) |
| `FRONTEND_ORIGIN` | exact frontend origin(s), comma-separated |
| `MONGODB_URI` | Atlas connection string (database `briefly_ai`) |
| `REDIS_URL` | Upstash `rediss://` URL |
| `JWT_ACCESS_SECRET`, `INTERNAL_SERVICE_SECRET` | long random values (`INTERNAL_SERVICE_SECRET` identical in the processing service) |
| `COOKIE_SECURE` | `true` |
| `PROCESSING_SERVICE_URL` | `http://127.0.0.1:8000` |
| `STORAGE_*` | see section 3 |
| `VECTOR_STORE` | `auto` (Atlas index) |
| AI budgets (`AI_*`) | keep the conservative defaults until you have checked your AI Studio quotas |

**processing-service/.env**

| Variable | Production value |
|---|---|
| `ENVIRONMENT` | `production` (hides `/docs`, requires `STORAGE_DOWNLOAD_HOSTS`) |
| `HOST` / `PORT` | `127.0.0.1` / `8000` |
| `INTERNAL_SERVICE_SECRET` | same as the backend |
| `GEMINI_API_KEY` | your free-tier key (never in frontend code) |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` (default) |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | `gemini-embedding-001` / `768` (must match the Atlas index) |
| `STORAGE_DOWNLOAD_HOSTS` | `<account-id>.r2.cloudflarestorage.com` |

**frontend** (build time; every `VITE_*` value is public): `VITE_API_BASE_URL=/api`.

## 3a. Backblaze B2 (verified with a real bucket)

1. Create a **private** bucket (for example `your-bucket-name`). Note its S3 endpoint and region (for example `s3.us-east-005.backblazeb2.com` and `us-east-005`).
2. **Lifecycle settings → "Keep only the last version of the file"** (recommended). Briefly already removes every version of the files it deletes; this rule is a second safeguard.
3. **Application Keys → Add a New Application Key**, restricted to this bucket, with *Read and Write* access.
   - Briefly needs these capabilities: read, write, delete and list files.
   - The list permission is used only to remove old versions of a file being deleted. Briefly never lists the bucket.
4. In `backend/.env`:
   ```
   STORAGE_ENDPOINT=https://s3.us-east-005.backblazeb2.com
   STORAGE_REGION=us-east-005
   STORAGE_BUCKET=your-bucket-name
   STORAGE_ACCESS_KEY_ID=<keyID>
   STORAGE_SECRET_ACCESS_KEY=<applicationKey>
   STORAGE_FORCE_PATH_STYLE=true
   ```
   `STORAGE_FORCE_PATH_STYLE=true` is required. Otherwise the signed URLs use `<bucket>.s3.<region>.backblazeb2.com`, which the processing service rejects.
5. In `processing-service/.env`: `STORAGE_DOWNLOAD_HOSTS=s3.us-east-005.backblazeb2.com`.
6. Restart the API, the worker and the processing service.

## 3b. Cloudflare R2 (alternative)

1. In the Cloudflare dashboard, open **R2** and create a bucket (for example `briefly-uploads`).
   - Keep it **private**: no public bucket URL and no custom public domain. Briefly only uses short-lived signed URLs.
2. Go to **R2 → Manage R2 API tokens → Create API token**.
   - Permission: *Object Read & Write*, limited to that bucket.
   - Copy the **Access Key ID** and **Secret Access Key**. They are shown only once.
3. Note your **Account ID**. The S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
4. In `backend/.env`:
   ```
   STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   STORAGE_REGION=auto
   STORAGE_BUCKET=briefly-uploads
   STORAGE_ACCESS_KEY_ID=<access key id>
   STORAGE_SECRET_ACCESS_KEY=<secret access key>
   STORAGE_FORCE_PATH_STYLE=false
   ```
5. In `processing-service/.env`: `STORAGE_DOWNLOAD_HOSTS=<account-id>.r2.cloudflarestorage.com`.
6. Restart the API, the worker and the processing service. **Settings → System status** keeps working, and the upload tabs no longer say storage isn't configured.

No bucket CORS rule is needed. Uploads stream through the API, and the browser only opens signed GET URLs (for video playback and the PDF viewer).

**Retention.**
- Uploaded videos are deleted after `UPLOAD_RETENTION_DAYS` (default 7) and documents after `DOCUMENT_RETENTION_DAYS` (default 30), by the hourly cleanup in the worker.
- Files of permanently failed uploads are deleted after `UPLOAD_FAILED_RETENTION_HOURS`.
- Summaries, transcripts and extracted text are kept.
- Interrupted or invalid uploads are aborted, so no partial objects remain.

## 4. One-time setup

```bash
cd backend
npm run rag:create-index   # Atlas vector index (once per cluster / embedding model)
npm run rag:backfill       # index sources created before indexing existed (worker must run)
npm run test:infra         # optional: checks MongoDB, Redis, the processing service and a job end to end
```

## 5. Health, logging and shutdown

- `GET /api/health`: liveness.
- `GET /api/health/ready`: MongoDB, Redis and the processing service; returns 503 when one is down. Use it as the platform health check.
- Processing service: `GET /health`.
- Logs are structured JSON lines on stdout, at the `LOG_LEVEL` level. Secrets, tokens, cookies and keys are redacted, and request bodies are never logged.
- `SIGTERM` / `SIGINT`: the API stops accepting requests and closes Redis and MongoDB. The worker finishes active jobs before exiting. Delayed jobs that are waiting for quota stay in Redis and continue after a restart.
- Upstash: use a database with the default `noeviction` policy (BullMQ requires it).

## 6. Monitoring the free tier

- Briefly: **Settings → AI usage**, or `GET /api/usage`, shows Briefly's budgets, usage per feature and model, and Gemini's state.
- Google: **AI Studio → Rate limits** (https://aistudio.google.com/rate-limit) shows your project's real quotas.
- Raise the `AI_*` budgets only after checking that page. Quotas apply per project, not per key.
