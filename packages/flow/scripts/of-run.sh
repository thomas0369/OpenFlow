#!/usr/bin/env bash
# OpenFlow headless, in two modes:
#
#   of-run.sh <pipeline> <task words...>      detached (setsid); prints PID/LOG
#   of-run.sh --wait <pipeline> <task...>     foreground; exits with the run's code
#   of-run.sh --resume <checkpoint|run-id> [task...]
#                                             continue an interrupted run: done
#                                             cards keep their output, the rest
#                                             continue in their sessions
#
# Prints LOG=<path> (and CHECKPOINT= once the run id exists in the log) so a
# caller picks results up without knowing the internals.
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE=detached
if [ "${1:-}" = "--wait" ]; then MODE=wait; shift; fi
RESUME_ARG=""
if [ "${1:-}" = "--resume" ]; then MODE=wait; RESUME_ARG="--resume $2"; shift 2; fi

PIPELINE="$1"; shift
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/of-run-${PIPELINE}-${STAMP}.log"
ARGS="${RESUME_ARG:+$RESUME_ARG }'$PIPELINE'$*"

if [ "$MODE" = "wait" ]; then
  bun packages/flow/scripts/headless-run.ts $ARGS > "$LOG" 2>&1 || true
else
  setsid nohup bun packages/flow/scripts/headless-run.ts $ARGS > "$LOG" 2>&1 < /dev/null &
  echo "PID=$!"
fi
echo "LOG=$LOG"
grep -o "checkpoint: [^ ]*" "$LOG" 2>/dev/null | tail -1 | sed 's/^checkpoint: /CHECKPOINT=/' || true
