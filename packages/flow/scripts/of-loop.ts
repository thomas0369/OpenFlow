/**
 * of-loop — der Selbstheilungs-Zyklus der Fabrik (Dauerbetrieb).
 *
 * Ein Zyklus (Aufruf durch systemd-Timer alle 5 min oder manuell):
 *   1. REAP: Zombies bergen (Checkpoint stumm > 10 min).
 *   2. MESSen: Scorecard-Logik über alle Runs.
 *   3. HEILEN: error-Runs, die noch nie resumed wurden und frisch genug sind
 *      (finished innerhalb --max-age-h, default 24), bekommen ein
 *      checkpoint-resume via of-run.sh --resume (detached, AUTO_RETRY aktiv).
 *      Der alte Run wird mit loop.resumedAt markiert — jede Heilungskette
 *      läuft höchstens einmal pro Run, nichts reiht sich endlos.
 *   4. BERICHTEN: eine Zeile in /tmp/of-loop-state.jsonl; der letzte Zustand
 *      steht in /tmp/of-loop-last.json.
 *
 * Guardrails:
 *   - Bewusst OHNE flock: Zyklen stapeln sich nicht praktisch (Timer 5 min,
 *     ein Zyklus < 10 s). Ein Doppelzyklus wäre harmlos — markResumed ist
 *     atomar pro Run (Temp+Rename), der zweite Zugriff fliegt am
 *     loop.resumedAt-Kriterium vorbei. Der Timer-Abstand macht Überlappung
 *     zur Theorie; sollte sie real werden, ist ein flock nachrüstbar, ohne
 *     dass sich etwas anderes ändert.
 *   - Nur Pipelines aus --pipelines (default auto-orchestrator,feature-build)
 *     werden geheilt — Test-/Probe-Pipelines (refine-probe & Co.) bleiben
 *     ehrlich FAIL.
 *   - Kein Resume für Runs mit eigener scorecard.attempts >= 2 (der Runner
 *     hat bereits selbst einmal wiederholt).
 *
 * Usage:
 *   bun of-loop.ts [--interval MIN]        # einmalig; mit --interval endlos
 *   of-run.sh --loop [flags]               # weitergereicht
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, statSync, renameSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const RUNS_DIR = flag("--runs-dir", join(homedir(), "workspace/flow-lab/.openflow/runs"))
const MAX_AGE_H = Number(flag("--max-age-h", "24"))
const REAP_MIN = Number(flag("--reap-min-age-min", "10"))
const PIPELINES = (flag("--pipelines", "auto-orchestrator,feature-build") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
const INTERVAL = argv.includes("--interval") ? Number(flag("--interval", "300")) : 0
const STATE = "/tmp/of-loop-state.jsonl"
const LAST = "/tmp/of-loop-last.json"

const ROOT = join(homedir(), "workspace/OpenFlow")
const OF_RUN = join(ROOT, "packages/flow/scripts/of-run.sh")

function reap(): number {
  const before = readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).length
  // process.execPath: der eigene Interpreter — cron-Umgebungen haben kein bun im PATH.
  const out = Bun.spawnSync([process.execPath, join(ROOT, "packages/flow/scripts/of-reap.ts"), "--min-age-min", String(REAP_MIN)], {
    stdout: "pipe", stderr: "pipe",
  })
  const text = new TextDecoder().decode(out.stdout)
  const m = text.match(/(\d+) Zombie\(s\) geborgen/)
  if (out.exitCode !== 0) console.error(`of-loop: reap meldete exit ${out.exitCode}`)
  return m ? Number(m[1]) : 0
}

interface HealCandidate { file: string; id: string }

function findHealable(): HealCandidate[] {
  if (!existsSync(RUNS_DIR)) return []
  const now = Date.now()
  const out: HealCandidate[] = []
  for (const file of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(RUNS_DIR, file)
    let log: any
    try { log = JSON.parse(readFileSync(path, "utf8")) } catch { continue }
    if (log?.status !== "error") continue
    if (!PIPELINES.includes(log?.pipeline)) continue
    if (log?.loop?.resumedAt) continue // schon einmal geheilt — Kette endet
    if ((log?.scorecard?.attempts ?? 1) >= 2) continue // Runner-Auto-Retry verbraucht
    const finished = typeof log?.finished === "number" ? log.finished : 0
    if (!finished || (now - finished) / 3_600_000 > MAX_AGE_H) continue
    const checkpoint = `/tmp/openflow-checkpoint-${log.id}.json`
    if (!existsSync(checkpoint)) continue // ohne Checkpoint kein Resume-Material
    // Tiefen-Grenze: Nachkommen einer Heilung nicht erneut heilen — die
    // Kette endet nach original + Auto-Retry + EINER Loop-Heilung (mit deren
    // Auto-Retry), sonst repetiert ein kaputter Task im 5-Minuten-Takt.
    try {
      const ck = JSON.parse(readFileSync(checkpoint, "utf8"))
      if (ck?.resumeOf) continue
    } catch { continue }
    // Finale-Absicherung: nicht anfassen, wenn gerade ein Prozess dazu läuft
    if (now - statSync(checkpoint).mtimeMs < 15 * 60_000) continue
    out.push({ file: path, id: log.id })
  }
  return out
}

function markResumed(path: string): boolean {
  try {
    const log = JSON.parse(readFileSync(path, "utf8"))
    log.loop = { ...(log.loop ?? {}), resumedAt: new Date().toISOString(), by: "of-loop" }
    const tmp = `${path}.looping`
    writeFileSync(tmp, JSON.stringify(log, null, 2))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

function startResume(id: string): boolean {
  const proc = spawn("bash", [OF_RUN, "--resume", id], {
    detached: true, stdio: "ignore", cwd: ROOT,
    env: { ...process.env, OPENFLOW_AUTO_RETRY: "1" },
  })
  proc.unref()
  return true
}

async function cycle(): Promise<{ ts: string; gereapt: number; geheilt: string[] }> {
  // Überlappungs-Schutz bewusst ohne Lock: Ein Doppelzyklus wäre harmlos —
  // markResumed ist atomar pro Run (Temp+Rename), ein zweiter Resume-Start
  // für denselben Run fliegt am loop.resumedAt-Kriterium vorbei. Der
  // Timer-Abstand (5 min) macht Überlappung praktisch unmöglich.
  const gereapt = reap()
  const geheilt: string[] = []
  for (const c of findHealable()) {
    if (!markResumed(c.file)) continue
    startResume(c.id)
    geheilt.push(c.id)
    console.error(`of-loop: heile ${c.id} via checkpoint-resume (detached)`)
  }
  const state = { ts: new Date().toISOString(), gereapt, geheilt }
  try {
    appendFileSync(STATE, JSON.stringify(state) + "\n")
    writeFileSync(LAST, JSON.stringify(state, null, 2))
  } catch { /* Bericht ist best effort */ }
  return state
}

if (INTERVAL > 0) {
  console.error(`of-loop watch: alle ${INTERVAL}s ein Zyklus (PID ${process.pid})`)
  while (true) {
    const s = await cycle()
    console.error(`of-loop: reaped=${s.gereapt} geheilt=${s.geheilt.length}`)
    await new Promise((r) => setTimeout(r, INTERVAL * 1000))
  }
} else {
  const s = await cycle()
  console.log(JSON.stringify(s))
}
