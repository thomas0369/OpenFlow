#!/usr/bin/env bash
# OpenFlow headless, in two modes:
#
#   of-run.sh <pipeline> <task words...>       detached (setsid); prints PID/LOG
#   of-run.sh --wait <pipeline> <task...>      foreground; exits with the run's code
#   of-run.sh --resume <checkpoint|run-id> [task...]
#                                              continue an interrupted run: done
#                                              cards keep their output, the rest
#                                              continue in their sessions
#
# Prints LOG=<path> so a caller picks results up without knowing the internals;
# the run's own "checkpoint: <path>" line inside the log names the JSON to read.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"
ENTRY="$ROOT/packages/flow/scripts/headless-run.ts"

MODE=detached
RESUME_ARGS=()
if [ "${1:-}" = "--wait" ]; then MODE=wait; shift; fi
if [ "${1:-}" = "--resume" ]; then MODE=wait; RESUME_ARGS=(--resume "$2"); shift 2; fi

PIPELINE="$1"; shift
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/of-run-${PIPELINE}-${STAMP}.log"

if [ "$MODE" = "wait" ]; then
  bun "$ENTRY" "${RESUME_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 || true
else
  setsid nohup bun "$ENTRY" "${RESUME_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 < /dev/null &
  echo "PID=$!"
fi
echo "LOG=$LOG"
