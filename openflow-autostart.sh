#!/bin/sh
# OpenFlow Autostart (WSL, kein systemd) — Restart-Loop mit Crash-Recovery
# Logs: /tmp/opencode/openflow.log
LOG=/tmp/opencode/openflow.log
mkdir -p /tmp/opencode
cd /home/thoma/workspace/OpenFlow || exit 1
export FLOW_MANAGE_SERVER=1
export OPENFLOW_PROJECT=/home/thoma/workspace/flow-lab
# bash-Standard-Timeout der Karten-Sessions (gemessen 02.11.2026). Karten-Sessions
# laufen ueber das CORE-Werkzeug (packages/core/src/tool/bash.ts) — Beleg: der
# Fehlertext "Command exceeded timeout of 120000 ms" existiert nur dort
# (core/src/tool/bash.ts:179), und 120000 ist dessen DEFAULT_TIMEOUT_MS. Dieses
# Werkzeug las die Variable bis Commit c059512a3 NICHT; der Export hier lief also
# ins Leere, und die Karten rissen nach 2 min ab (Verifikationslauf 42v6ur), obwohl
# die Engine 30 min trug. Seit c059512a3 wertet core/tool/bash.ts die Variable aus
# (wie tool/shell.ts) und zieht MAX_TIMEOUT_MS mit — sonst haette das Eingabe-Schema
# genau den Wert abgelehnt, den der Standard vorgibt.
# Warum ueberhaupt: Karten mit langen Kommandos mussten den Timeout selbst setzen,
# und das ging zweimal schief — wva-worker-3 waehlte 600000 (das Skript darf
# innerlich 1500 s), die Pull-Karte schrieb 180000 statt der im Prompt genannten
# 1800000. Eine Zahl im Prompt ist kein Schutz gegen Zahlendreher; der
# Server-Standard ist einer. Wirkt nach einem Neustart der Kette.
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
