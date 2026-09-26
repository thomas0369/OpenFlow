/**
 * of-reap — Zombie-Reaper für OpenFlow-Runs.
 *
 * Ein Run, dessen headless-Prozess starb (kill, Reboot, Crash), bleibt für
 * immer "running" in der Run-Liste: Niemand finalisiert ihn. Gemessen
 * 26.09.2026: 8 solcher Zombies in flow-lab/.openflow/runs.
 *
 * Zombie-Kriterium (beweisbar ohne PID-Datei):
 *   status === "running"
 *   UND (Checkpoint /tmp/openflow-checkpoint-<id>.json fehlt und der Run
 *        started vor mehr als --grace-min Minuten
 *        ODER Checkpoint mtime älter als --min-age-min Minuten)
 *
 * Der Runner schreibt den Checkpoint bei JEDEM onRun-Patch neu — ein lebender
 * Run hat also einen frischen Checkpoint. Stille = tot.
 *
 * Reap = Ehrlichkeit, kein Datenverlust: status "stopped", error-Begründung,
 * finished=now, reaped-Block mit Messwerten. Atomic via temp+rename, damit
 * der Canvas-Store nie eine halbe JSON liest.
 *
 * Usage:
 *   bun of-reap.ts [--runs-dir DIR] [--min-age-min 30] [--grace-min 5] [--dry-run]
 *   of-run.sh --reap [weitere Flags]
 */

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const RUNS_DIR = flag("--runs-dir", join(homedir(), "workspace/flow-lab/.openflow/runs"))
const MIN_AGE_MIN = Number(flag("--min-age-min", "30"))
const GRACE_MIN = Number(flag("--grace-min", "5"))
const DRY = argv.includes("--dry-run")

if (!existsSync(RUNS_DIR)) {
  console.error(`runs-dir fehlt: ${RUNS_DIR}`)
  process.exit(2)
}

const now = Date.now()
let inspected = 0
let reaped = 0
const details: string[] = []

for (const file of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const path = join(RUNS_DIR, file)
  inspected++
  let log: any
  try {
    log = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    continue // keine Zombie-Entscheidung auf kaputter Datei
  }
  if (log?.status !== "running") continue

  const id = log.id ?? file.replace(/\.json$/, "")
  const checkpoint = `/tmp/openflow-checkpoint-${id}.json`
  const startedMs = typeof log.started === "number" ? log.started : 0
  let lastActivityMs = startedMs
  let hasCheckpoint = false
  if (existsSync(checkpoint)) {
    hasCheckpoint = true
    lastActivityMs = Math.max(lastActivityMs, statSync(checkpoint).mtimeMs)
  }

  const silentMin = (now - lastActivityMs) / 60_000
  const noCheckpointOld = !hasCheckpoint && (now - startedMs) / 60_000 > GRACE_MIN
  const checkpointStale = hasCheckpoint && silentMin > MIN_AGE_MIN
  if (!noCheckpointOld && !checkpointStale) continue

  const reason = hasCheckpoint
    ? `zombie — checkpoint seit ${Math.round(silentMin)} min stumm (Schwelle ${MIN_AGE_MIN} min)`
    : `zombie — kein Checkpoint, Run startete vor ${Math.round((now - startedMs) / 60_000)} min (Grace ${GRACE_MIN} min)`

  if (DRY) {
    details.push(`DRY ${file} — würde reaps: ${reason}`)
    reaped++
    continue
  }

  log.status = "stopped"
  log.error = `reaped: ${reason}`
  log.finished = now
  log.reaped = {
    at: new Date(now).toISOString(),
    reason,
    lastActivity: new Date(lastActivityMs).toISOString(),
  }
  const tmp = `${path}.reaping`
  writeFileSync(tmp, JSON.stringify(log, null, 2))
  renameSync(tmp, path)
  details.push(`REAPED ${file} — ${reason}`)
  reaped++
}

for (const line of details) console.error(line)
console.log(`of-reap: ${inspected} runs geprüft, ${reaped} ${DRY ? "Zombie(s) gefunden (dry-run)" : "Zombie(s) geborgen"}`)
process.exit(0)
