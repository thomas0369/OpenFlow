/**
 * of-stop — einen laufenden Fabrik-Run sauber beenden (21.11.2026).
 *
 * Aufrufer: das Sidebar-Plugin in opencode (Knopf „Stopp"), per
 * `of-run.sh --stop <pid>`. Die PID stammt aus dem Ledger (`fabrik_log.pid`)
 * und ist eines von zwei Dingen:
 *   - der headless-run.ts-Prozess selbst (detached-Start), oder
 *   - die of-run.sh-Shell eines `--wait`/`--resume`-Starts, deren
 *     Vordergrund-Kind headless-run.ts ist. Bash stellt seine TERM-Falle
 *     zurück, bis das Vordergrund-Kind endet — die Shell allein zu
 *     signalisieren hält also nichts an. Getroffen wird deshalb das Kind.
 * Alles andere wird verweigert (Exit 2): eine wiederverwendete PID darf nie
 * einen fremden Prozess treffen.
 *
 * SIGTERM auf headless-run löst `installiereSignalAbschluss` aus: Checkpoint,
 * Verdict `stopped`, ergebnis.md — derselbe Abschluss wie bei einem Reap.
 *
 * Exit: 0 gestoppt · 1 PID lebt nicht · 2 kein OpenFlow-Run (verweigert) ·
 * 3 lebt nach der Wartezeit noch.
 *
 * Usage: bun of-stop.ts <pid> [--wait-s 8]   ·   of-run.sh --stop <pid>
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

/** Die Sicht auf die Prozesstabelle — injizierbar, damit die Auflösung ohne echte Prozesse testbar ist. */
export type Prozesse = {
  /** argv des Prozesses; undefined, wenn er nicht (mehr) lebt. Ein Zombie gilt als tot. */
  argv(pid: number): string[] | undefined
  /** Direkte Kinder. */
  kinder(pid: number): number[]
}

export type Aufloesung = { ziel: number; ueber?: number } | { code: 1 | 2; grund: string }

/**
 * Das Skript, das ein Prozess ausführt: das erste Argument nach dem
 * Interpreter, das auf .ts/.sh endet. Nicht `includes` über die ganze
 * Kommandozeile — Aufgabenwörter eines Laufs dürfen beide Namen enthalten.
 * Und nur unter dem passenden Interpreter: `vim headless-run.ts` ist kein Lauf.
 */
export function skript(argv: string[]) {
  const pfad = argv.slice(1).find((arg) => /\.(ts|sh)$/.test(arg))
  if (!pfad || !argv[0]) return undefined
  const interpreter = basename(argv[0])
  const name = basename(pfad)
  if (name.endsWith(".ts") && interpreter.startsWith("bun")) return name
  if (name.endsWith(".sh") && /^(ba)?sh$/.test(interpreter)) return name
  return undefined
}

export function zielAufloesen(pid: number, proc: Prozesse): Aufloesung {
  if (!Number.isInteger(pid) || pid <= 1) return { code: 2, grund: `keine gültige PID: ${pid}` }
  const argv = proc.argv(pid)
  if (!argv) return { code: 1, grund: `PID ${pid} lebt nicht` }
  const name = skript(argv)
  if (name === "headless-run.ts") return { ziel: pid }
  if (name !== "of-run.sh") return { code: 2, grund: `PID ${pid} ist kein OpenFlow-Run (${argv.join(" ").slice(0, 120)}) — verweigert` }
  // Breitensuche, drei Ebenen: --wait startet headless-run als direktes Kind,
  // ein Zwischenprozess (setsid/nohup, falls einer forkt) kostet eine Ebene.
  const ebene = (pids: number[], tiefe: number): number | undefined => {
    if (!pids.length || tiefe > 3) return undefined
    const treffer = pids.find((kind) => {
      const a = proc.argv(kind)
      return a !== undefined && skript(a) === "headless-run.ts"
    })
    return treffer ?? ebene(pids.flatMap((kind) => proc.kinder(kind)), tiefe + 1)
  }
  const kind = ebene(proc.kinder(pid), 1)
  if (kind === undefined) return { code: 2, grund: `of-run.sh ${pid} hat keinen headless-run.ts unter sich (Start noch nicht so weit oder Lauf schon beendet)` }
  return { ziel: kind, ueber: pid }
}

/** /proc als Prozesstabelle. */
export const procTabelle: Prozesse = {
  argv(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const zustand = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)
      if (zustand === "Z" || zustand === "X") return undefined
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
      return argv.length ? argv : undefined
    } catch {
      return undefined
    }
  },
  kinder(pid) {
    // /proc/<pid>/task/*/children braucht CONFIG_PROC_CHILDREN; die ppid aus
    // /proc/*/stat gibt es überall.
    return readdirSync("/proc")
      .filter((eintrag) => /^\d+$/.test(eintrag))
      .flatMap((eintrag) => {
        try {
          const stat = readFileSync(`/proc/${eintrag}/stat`, "utf8")
          const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
          return ppid === pid ? [Number(eintrag)] : []
        } catch {
          return []
        }
      })
  },
}

/** SIGTERM, dann bis `wartenMs` auf das Ende pollen. */
export async function stoppe(ziel: number, proc: Prozesse, wartenMs = 8000, takt = 100) {
  try {
    process.kill(ziel, "SIGTERM")
  } catch (error) {
    // Zwischen Auflösung und Signal von selbst geendet: auch ein Ende.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
    throw error
  }
  const ende = Date.now() + wartenMs
  while (Date.now() < ende) {
    if (!proc.argv(ziel)) return true
    await Bun.sleep(takt)
  }
  return !proc.argv(ziel)
}

/** Eine Ledger-Zeile im Format der of-run.sh-Ereignisse; fail-open. */
export function ledgerZeile(eintrag: { pid: number; target: number; ergebnis: string }, ledger = process.env.OPENFLOW_LEDGER || join(homedir(), ".openflow/gate-ledger.jsonl")) {
  try {
    mkdirSync(dirname(ledger), { recursive: true })
    appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), event: "fabrik_stop", quelle: "of-stop.ts", ...eintrag }) + "\n")
  } catch {
    // Das Ledger ist Protokoll, kein Teil des Stopps.
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf("--wait-s")
  const wartenMs = (i >= 0 ? Number(argv[i + 1]) : 8) * 1000
  const pid = Number(argv.find((arg, n) => !arg.startsWith("--") && argv[n - 1] !== "--wait-s"))
  const aufgeloest = zielAufloesen(pid, procTabelle)
  if ("code" in aufgeloest) {
    console.error(`of-stop: ${aufgeloest.grund}`)
    process.exit(aufgeloest.code)
  }
  const ziel = aufgeloest.ziel
  if (aufgeloest.ueber !== undefined) console.error(`of-stop: of-run.sh ${aufgeloest.ueber} → headless-run ${ziel}`)
  const weg = await stoppe(ziel, procTabelle, wartenMs).catch((error) => {
    console.error(`of-stop: SIGTERM an ${ziel} fehlgeschlagen: ${String(error)}`)
    return false
  })
  ledgerZeile({ pid, target: ziel, ergebnis: weg ? "gestoppt" : "lebt noch" })
  if (!weg) {
    console.error(`of-stop: ${ziel} lebt nach ${wartenMs / 1000} s noch — Abschluss hängt; erneut versuchen oder of-run.sh --reap`)
    process.exit(3)
  }
  console.log(`gestoppt: ${ziel}`)
}
