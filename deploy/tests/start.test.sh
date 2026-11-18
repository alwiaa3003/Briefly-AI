#!/usr/bin/env bash
#
# Tests for deploy/start.sh with stand-in processes (no Node, Python, Redis or network needed):
#   bash deploy/tests/start.test.sh
#
# Each stub records its pid; after every scenario the test checks the supervisor's exit code
# and that no stub is still running (no orphans).

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START="$HERE/../start.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASS=0
FAIL=0

# stub <name> <behaviour>: run|exit:<code>|ignore-term
stub() {
  local name="$1" behaviour="$2"
  case "$behaviour" in
    run) echo "echo \$\$ > '$WORK/$name.pid'; trap 'echo term > \"$WORK/$name.term\"; exit 0' TERM; while :; do sleep 0.2; done" ;;
    ignore-term) echo "echo \$\$ > '$WORK/$name.pid'; trap '' TERM; while :; do sleep 0.2; done" ;;
    exit:*) echo "echo \$\$ > '$WORK/$name.pid'; sleep 1; exit ${behaviour#exit:}" ;;
  esac
}

no_orphans() {
  local f
  for f in "$WORK"/*.pid; do
    [[ -e "$f" ]] || continue
    if kill -0 "$(cat "$f")" 2>/dev/null; then
      echo "    orphan: $(basename "$f" .pid) still running"
      kill -KILL "$(cat "$f")" 2>/dev/null
      return 1
    fi
  done
  return 0
}

check() {
  local label="$1" expected="$2" actual="$3" extra="${4:-0}"
  if [[ "$actual" == "$expected" && "$extra" == 0 ]] && no_orphans; then
    echo "  ok   $label (exit $actual)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$WORK"/*.pid "$WORK"/*.term
}

run_start() {
  SHUTDOWN_GRACE_SECONDS="${GRACE:-2}" PROCESSING_READY_TIMEOUT_SECONDS="${READY:-5}" \
    PROCESSING_CMD="$1" API_CMD="$2" WORKER_CMD="$3" PROCESSING_HEALTH_CMD="${4:-true}" \
    bash "$START" 2>"$WORK/log" &
  SUP=$!
}

echo "deploy/start.sh"

# 1. SIGTERM: everything stops cleanly, exit 0, each process received SIGTERM.
run_start "$(stub processing run)" "$(stub api run)" "$(stub worker run)"
sleep 2
kill -TERM "$SUP"
wait "$SUP"; code=$?
missing=0
for n in processing api worker; do [[ -e "$WORK/$n.term" ]] || missing=1; done
check "SIGTERM is forwarded to all three processes" 0 "$code" "$missing"

# 2. A crash (exit 3) stops the siblings and is reported.
run_start "$(stub processing run)" "$(stub api exit:3)" "$(stub worker run)"
wait "$SUP"; code=$?
check "a crashing process stops the others and its status is returned" 3 "$code"

# 3. An unexpected clean exit of a required process is still a failure.
run_start "$(stub processing run)" "$(stub api run)" "$(stub worker exit:0)"
wait "$SUP"; code=$?
check "an unexpected exit 0 is treated as a failure" 1 "$code"

# 4. The processing service never becomes healthy: API and worker are never started.
READY=3 run_start "$(stub processing run)" "$(stub api run)" "$(stub worker run)" "false"
wait "$SUP"; code=$?
started=0
[[ -e "$WORK/api.pid" || -e "$WORK/worker.pid" ]] && started=1
check "API and worker do not start before the processing service is ready" 1 "$code" "$started"

# 5. The processing service dies during startup.
run_start "$(stub processing exit:4)" "$(stub api run)" "$(stub worker run)" "false"
wait "$SUP"; code=$?
check "a processing service that dies while starting fails the container" 4 "$code"

# 6. A process that ignores SIGTERM is killed after the grace period.
GRACE=1 run_start "$(stub processing run)" "$(stub api ignore-term)" "$(stub worker run)"
sleep 2
kill -TERM "$SUP"
wait "$SUP"; code=$?
grep -q "api did not stop within 1s; killing it" "$WORK/log"; killed=$?
check "a process ignoring SIGTERM is killed after the grace period" 0 "$code" "$killed"

echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
