# syntax=docker/dockerfile:1.7
#
# Briefly AI: one container for a single Render (free) web service.
#
#   Express API + built React app (one origin)  -> $PORT (Render sets it, default 10000)
#   BullMQ worker                               -> no port
#   FastAPI processing service + FFmpeg         -> 127.0.0.1:8000 only (never public)
#
# deploy/start.sh supervises the three processes. Secrets are never baked in: every
# environment variable is set in the Render dashboard (see docs/DEPLOYMENT.md).
#
#   docker build -t briefly-ai .
#   docker run --rm -p 10000:10000 --env-file <your env file> briefly-ai

ARG NODE_VERSION=22
ARG PYTHON_VERSION=3.13

# ---------------------------------------------------------------- frontend build
FROM node:${NODE_VERSION}-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# Same origin as the API: requests go to /api on the serving host.
ENV VITE_API_BASE_URL=/api
RUN npm run build

# ---------------------------------------------------------------- backend production dependencies
FROM node:${NODE_VERSION}-bookworm-slim AS backend
WORKDIR /build/backend
# Toolchain only in this stage, in case a native module (bcrypt) has no prebuilt binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------------------------------------------------------------- processing-service dependencies
FROM python:${PYTHON_VERSION}-slim-bookworm AS python-deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
COPY processing-service/requirements.txt /tmp/requirements.txt
# imageio-ffmpeg ships a static FFmpeg binary; pypdfium2 and pillow ship their native libraries.
RUN /opt/venv/bin/pip install -r /tmp/requirements.txt

# ---------------------------------------------------------------- runtime
FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 briefly \
 && useradd --system --uid 10001 --gid briefly --home-dir /app --shell /usr/sbin/nologin briefly

# Node runtime (same Debian release as the Python image, so the binary is compatible).
COPY --from=frontend /usr/local/bin/node /usr/local/bin/node

COPY --from=python-deps /opt/venv /opt/venv
WORKDIR /app
COPY --from=backend --chown=briefly:briefly /build/backend/node_modules ./backend/node_modules
COPY --chown=briefly:briefly backend/package.json ./backend/package.json
COPY --chown=briefly:briefly backend/src ./backend/src
COPY --chown=briefly:briefly processing-service/app ./processing-service/app
COPY --from=frontend --chown=briefly:briefly /build/frontend/dist ./frontend/dist
COPY --chown=briefly:briefly deploy/start.sh ./deploy/start.sh
RUN chmod 0755 ./deploy/start.sh \
 && /opt/venv/bin/python -c "import imageio_ffmpeg, subprocess; subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-version'], check=True, capture_output=True)"

# Non-secret defaults for this topology. Everything else (and every secret) comes from Render.
ENV PATH="/opt/venv/bin:${PATH}" \
    NODE_ENV=production \
    ENVIRONMENT=production \
    PORT=10000 \
    TRUST_PROXY=1 \
    COOKIE_SECURE=true \
    FRONTEND_DIST_DIR=/app/frontend/dist \
    PROCESSING_SERVICE_URL=http://127.0.0.1:8000 \
    WORKER_CONCURRENCY=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    APP_ROOT=/app

USER briefly
EXPOSE 10000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/deploy/start.sh"]
