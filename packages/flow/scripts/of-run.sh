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
#   of-run.sh --reap [flags]                   zombie runs beg (of-reap.ts;
#                                              --dry-run --min-age-min 30 ...)
#   of-run.sh --scorecard [flags]              verdict statistics over all runs
#                                              (of-scorecard.ts; --limit N --json)
#
# Every start reaps first (15 min silence = dead) so the run list stays honest.
# Failed runs retry themselves once via checkpoint-resume (OPENFLOW_AUTO_RETRY,
# default 1) and end with a SCORECARD block on stdout.
#
# Prints LOG=<path> so a caller picks results up without knowing the internals;
# the run's own "checkpoint: <path>" line inside the log names the JSON to read.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"
ENTRY="$ROOT/packages/flow/scripts/headless-run.ts"

if [ "${1:-}" = "--scorecard" ]; then shift; exec bun "$ROOT/packages/flow/scripts/of-scorecard.ts" "$@"; fi
if [ "${1:-}" = "--reap" ]; then shift; exec bun "$ROOT/packages/flow/scripts/of-reap.ts" "$@"; fi

MODE=detached
RESUME_ARGS=()
if [ "${1:-}" = "--wait" ]; then MODE=wait; shift; fi
if [ "${1:-}" = "--resume" ]; then MODE=wait; RESUME_ARGS=(--resume "$2"); shift 2; fi
SPREAD_ARGS=()
if [ "${1:-}" = "--spread" ]; then SPREAD_ARGS=(--spread); shift; fi

PIPELINE="$1"; shift
STAMP=$(date +%Y%m%d-%H%M%S)
LOG="/tmp/of-run-${PIPELINE}-${STAMP}.log"

# Zombie-Reap vor jedem Start: 15 Minuten stummer Checkpoint = Prozessor tot.
bun "$ROOT/packages/flow/scripts/of-reap.ts" --min-age-min 15 --grace-min 5 >/dev/null 2>&1 || true

if [ "$MODE" = "wait" ]; then
  bun "$ENTRY" "${RESUME_ARGS[@]}" "${SPREAD_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 || true
else
  setsid nohup bun "$ENTRY" "${RESUME_ARGS[@]}" "${SPREAD_ARGS[@]}" "$PIPELINE" "$@" > "$LOG" 2>&1 < /dev/null &
  echo "PID=$!"
fi
echo "LOG=$LOG"
