#!/bin/sh
# OpenFlow Autostart (WSL, kein systemd) — Restart-Loop mit Crash-Recovery
# Logs: /tmp/opencode/openflow.log
LOG=/tmp/opencode/openflow.log
mkdir -p /tmp/opencode
cd /home/thoma/workspace/OpenFlow || exit 1
export FLOW_MANAGE_SERVER=1
export OPENFLOW_PROJECT=/home/thoma/workspace/flow-lab
# bash-Standard-Timeout der Karten-Sessions (gemessen 02.11.2026): Der Default ist
# 2 min (shell.ts:347, flags.bashDefaultTimeoutMs ?? 2*60*1000). Karten, die ein
# langes Kommando fahren, müssen ihn dann selbst setzen — und das ging zweimal
# schief: wva-worker-3 wählte 600000 (Skript darf innerlich 1500 s), die Pull-Karte
# im Verifikationslauf schrieb 180000 statt der im Prompt genannten 1800000. Eine
# Prompt-Zahl ist kein Schutz gegen Zahlendreher; der Server-Standard ist einer.
export OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=1800000
# Engine-Basic-Auth (opencode/<password>) — Secret liegt außerhalb des Repos
if [ -f "$HOME/.config/opencode/.secrets/engine.password" ]; then
  OPENCODE_SERVER_PASSWORD="$(cat "$HOME/.config/opencode/.secrets/engine.password")"
  export OPENCODE_SERVER_PASSWORD
  OPENCODE_SERVER_USERNAME=admin
  export OPENCODE_SERVER_USERNAME
else
  echo "WARNUNG: engine.password fehlt — Engine startet UNGESCHÜTZT" >> "$LOG"
fi
export PATH="/home/thoma/.local/bin:/usr/local/bin:/usr/bin:/bin"
while true; do
  echo "=== $(date -Is) openflow start ===" >> "$LOG"
  bun openflow.ts >> "$LOG" 2>&1
  code=$?
  echo "=== $(date -Is) openflow exit ($code) — Neustart in 5s ===" >> "$LOG"
  [ "$code" -eq 0 ] && sleep 5 || sleep 5
done
