#!/bin/sh
# OpenFlow MCP-Fabrik (21.11.2026) — zweiter Canvas-Host neben openflow-autostart.sh,
# mit dem installierten opencode 2.x als Engine statt des Fork-Kerns (1.18.17).
# Grund: Nur 2.x führt MCP-Tools in v2-Sessions aus (Messung in FLOW.md, Abschnitt
# MCP). Der Fork-Kern bleibt auf :5174/:4096 für alles Bisherige, vor allem den
# Cron `wissen-video-analyse`: dessen Karten brauchen 8–25-min-Shellbefehle im
# Vordergrund, und 2.x verschiebt jeden Befehl nach 120 s (fest, max. 600 s) in
# den Hintergrund. Aufruf eines Runs hier: of-run.sh --mcp …
# Logs: /tmp/opencode/openflow-mcp.log
LOG=/tmp/opencode/openflow-mcp.log
PORT=5274
ENGINE_PORT=4296
mkdir -p /tmp/opencode
cd /home/thoma/workspace/OpenFlow || exit 1
export FLOW_PORT=$PORT
export OPENCODE_SERVER_URL=http://127.0.0.1:$ENGINE_PORT
export FLOW_MANAGE_SERVER=1
export OPENCODE_SERVE_COMMAND="$HOME/.opencode/bin/opencode serve --port $ENGINE_PORT --hostname 127.0.0.1"
# Eigene Datenbank: ohne sie schriebe diese Engine in die opencode.db des
# Nutzer-Dienstes (`opencode serve --service`). Zugangsdaten und MCP-Tokens
# (auth.json, mcp-auth.json) bleiben gemeinsam.
export OPENCODE_DB=openflow-engine.db
export OPENFLOW_PROJECT=/home/thoma/workspace/flow-lab
if [ -f "$HOME/.config/opencode/.secrets/engine.password" ]; then
  OPENCODE_SERVER_PASSWORD="$(cat "$HOME/.config/opencode/.secrets/engine.password")"
  export OPENCODE_SERVER_PASSWORD
  # 2.x kennt nur den Benutzer `opencode`; OPENCODE_SERVER_USERNAME liest es nicht.
  export OPENCODE_SERVER_USERNAME=opencode
else
  echo "WARNUNG: engine.password fehlt — MCP-Engine startet UNGESCHÜTZT" >> "$LOG"
fi
export PATH="/home/thoma/.local/bin:/usr/local/bin:/usr/bin:/bin"
while true; do
  # Ein zweiter Autostart (doppelter Boot-Aufruf) darf den laufenden Host nicht
  # stören: belegter Port heißt „läuft schon", nicht „Fehler".
  if ss -ltn 2>/dev/null | grep -q ":$PORT "; then sleep 60; continue; fi
  echo "=== $(date -Is) openflow-mcp start ===" >> "$LOG"
  # server.ts liefert dist/ aus — einmal je Start frisch bauen, sonst zeigt der
  # Canvas einen veralteten Stand.
  bun run --cwd packages/flow build >> "$LOG" 2>&1
  bun packages/flow/server.ts >> "$LOG" 2>&1
  code=$?
  echo "=== $(date -Is) openflow-mcp exit ($code) — Neustart in 5s ===" >> "$LOG"
  sleep 5
done
