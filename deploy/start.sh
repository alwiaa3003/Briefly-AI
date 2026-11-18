#!/usr/bin/env bash
#
# Starts Briefly's three processes in one container and supervises them.
#
#   1. FastAPI processing service on 127.0.0.1:8000 (private), then wait until it answers /health.
#   2. Express API (+ built frontend) on $PORT.
#   3. BullMQ worker. It waits for the shared Redis itself and refuses to process jobs without it
#      (src/workers/index.js); if Redis never becomes ready it exits, and so does this container.
#
# If any process exits, the others are stopped (SIGTERM, then SIGKILL after a grace period) and the
# container exits non-zero, so the platform restarts it. SIGTERM/SIGINT to this script are
# forwarded to every process; the worker finishes active jobs within the grace period.
#
# Run under an init (tini) as PID 1 so orphans are reaped. Commands can be overridden for tests:
#   PROCESSING_CMD, API_CMD, WORKER_CMD, PROCESSING_HEALTH_CMD (strings run with bash -c).

set -uo pipefail

APP_ROOT="${APP_ROOT:-/app}"
GRACE_SECONDS="${SHUTDOWN_GRACE_SECONDS:-25}"
READY_TIMEOUT_SECONDS="${PROCESSING_READY_TIMEOUT_SECONDS:-120}"
PROCESSING_PORT="${PROCESSING_PORT:-8000}" # must match PROCESSING_SERVICE_URL

# Each process gets only the settings meant for it: the processing service must not pick up the
# public $PORT that Render sets for Express.
: "${PROCESSING_CMD:=cd '$APP_ROOT/processing-service' && HOST=127.0.0.1 PORT=$PROCESSING_PORT exec python -m app}"
: "${API_CMD:=cd '$APP_ROOT/backend' && exec node --max-old-space-size=${API_MAX_OLD_SPACE_MB:-160} src/server.js}"
: "${WORKER_CMD:=cd '$APP_ROOT/backend' && exec node --max-old-space-size=${WORKER_MAX_OLD_SPACE_MB:-192} src/workers/index.js}"
: "${PROCESSING_HEALTH_CMD:=python -c \"import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:$PROCESSING_PORT/health', timeout=2).status == 200 else 1)\"}"

declare -a PIDS=()
declare -A NAMES=()
STOPPING=0

log() {
  printf '%s supervisor: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

start() {
  local name="$1" cmd="$2"
  bash -c "$cmd" &
  local pid=$!
  PIDS+=("$pid")
  NAMES[$pid]="$name"
  log "started $name (pid $pid)"
}

alive() {
  local pid
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then return 0; fi
  done
  return 1
}

# Stops every process and exits with $1. Safe to call more than once.
shutdown() {
  local code="$1"
  if [[ $STOPPING -eq 1 ]]; then return; fi
  STOPPING=1
  trap '' TERM INT
  local pid
  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  local waited=0
  while alive && (( waited < GRACE_SECONDS * 2 )); do
    sleep 0.5
    waited=$((waited + 1))
  done
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      log "${NAMES[$pid]} did not stop within ${GRACE_SECONDS}s; killing it"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null
  log "stopped (exit $code)"
  exit "$code"
}

trap 'log "received SIGTERM"; shutdown 0' TERM
trap 'log "received SIGINT"; shutdown 0' INT

# 1. Processing service first, so the API and the worker never see it missing at startup.
start processing "$PROCESSING_CMD"
processing_pid="${PIDS[0]}"
ready=0
for ((i = 0; i < READY_TIMEOUT_SECONDS; i++)); do
  if ! kill -0 "$processing_pid" 2>/dev/null; then
    wait "$processing_pid"
    status=$?
    log "processing exited with status $status before it was ready"
    shutdown $((status == 0 ? 1 : status))
  fi
  if bash -c "$PROCESSING_HEALTH_CMD" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1 &
  wait $!
done
if [[ $ready -ne 1 ]]; then
  log "processing service was not ready within ${READY_TIMEOUT_SECONDS}s"
  shutdown 1
fi
log "processing service is ready"

# 2 + 3. API and worker.
start api "$API_CMD"
start worker "$WORKER_CMD"

# Any exit is fatal for the container: a missing process means a broken service.
while true; do
  exited=""
  wait -n -p exited "${PIDS[@]}"
  status=$?
  if [[ -z "$exited" ]]; then
    continue # interrupted by a signal; the trap handles it
  fi
  log "${NAMES[$exited]:-process $exited} exited with status $status"
  shutdown $((status == 0 ? 1 : status))
done
