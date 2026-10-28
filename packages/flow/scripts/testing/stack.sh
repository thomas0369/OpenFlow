#!/usr/bin/env bash
# Isolated OpenFlow stack for end-to-end tests: an engine (opencode serve) on
# :4197 and a canvas dev server on :5274 --strictPort, both from THIS checkout,
# with their own XDG dirs — so a test run never touches the live engine
# (:4096), the live canvas (:5174), ~/.config/opencode, ~/.local/share/opencode
# or the gate ledger.
#
#   stack.sh start <run-dir>    start both, wait until the canvas answers
#                               /flow/api/context through to the engine;
#                               prints ENGINE_PID= / VITE_PID=
#   stack.sh stop <run-dir>     stop both (process groups), idempotent
#
# The caller prepares <run-dir>/xdg-config/opencode/opencode.json (providers,
# permissions) and <run-dir>/proj (OPENFLOW_PROJECT, pipelines). No secret is
# read or written here: the engine password is random per stack and lives only
# in <run-dir>/engine.password (mode 600) and the two processes' environment.
#
# Ports: OPENFLOW_E2E_ENGINE_PORT (4197), OPENFLOW_E2E_CANVAS_PORT (5274).
# Template: /tmp/of-k9-run/stack.sh (K9 acceptance, 13.10.2026).
set -euo pipefail
CMD="${1:?usage: stack.sh start|stop <run-dir>}"
R="$(cd "${2:?usage: stack.sh start|stop <run-dir>}" && pwd)"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
ENGINE_PORT="${OPENFLOW_E2E_ENGINE_PORT:-4197}"
CANVAS_PORT="${OPENFLOW_E2E_CANVAS_PORT:-5274}"
BUN="${BUN:-$(command -v bun || echo "$HOME/.local/bin/bun")}"

stop() {
  for f in "$R/vite.pid" "$R/engine.pid"; do
    [ -f "$f" ] || continue
    # setsid made each process its own group leader: the negative PID takes
    # bun's children (vite workers) with it.
    kill -TERM -- "-$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
}

if [ "$CMD" = "stop" ]; then stop; exit 0; fi
[ "$CMD" = "start" ] || { echo "stack.sh: unknown command $CMD" >&2; exit 2; }

for port in "$ENGINE_PORT" "$CANVAS_PORT"; do
  if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    echo "stack.sh: port $port is taken — another stack or session holds it" >&2
    exit 3
  fi
done

export XDG_CONFIG_HOME="$R/xdg-config" XDG_DATA_HOME="$R/xdg-data" XDG_STATE_HOME="$R/xdg-state" XDG_CACHE_HOME="$R/xdg-cache"
mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$R/proj/.openflow/pipelines"
[ -f "$R/engine.password" ] || (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$R/engine.password")
export OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD="$(cat "$R/engine.password")"
export OPENCODE_SERVER_PASSWORD
export OPENFLOW_PROJECT="$R/proj" OPENCODE_SERVER_URL="http://127.0.0.1:$ENGINE_PORT"

trap 'stop' ERR
cd "$ROOT/packages/opencode"
OPENFLOW_ENGINE=1 setsid nohup "$BUN" run --conditions=browser src/index.ts serve --port "$ENGINE_PORT" > "$R/engine.log" 2>&1 < /dev/null &
echo $! > "$R/engine.pid"
echo "ENGINE_PID=$!"
cd "$ROOT/packages/flow"
setsid nohup "$BUN" run dev --port "$CANVAS_PORT" --strictPort > "$R/vite.log" 2>&1 < /dev/null &
echo $! > "$R/vite.pid"
echo "VITE_PID=$!"

# The engine takes ~30 s to listen (FLOW.md); /flow/api/context only proves the
# canvas, /api/agent through the proxy proves both ends.
for _ in $(seq 1 120); do
  if curl -fsS -m 5 -o /dev/null "http://localhost:$CANVAS_PORT/flow/api/context" 2>/dev/null &&
     curl -fsS -m 5 -o /dev/null "http://localhost:$CANVAS_PORT/api/agent" 2>/dev/null; then
    echo "STACK=up"
    exit 0
  fi
  sleep 1
done
echo "stack.sh: stack did not come up in 120 s — see $R/engine.log and $R/vite.log" >&2
stop
exit 4
