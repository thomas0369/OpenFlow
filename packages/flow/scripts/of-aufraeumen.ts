/**
 * of-aufraeumen — alte Checkpoints wegräumen (B6, 28.10.2026).
 *
 * headless-run schreibt je Lauf `openflow-checkpoint-<id>.json` und daneben
 * `.ergebnis.md` (gekürzt: zusätzlich `.ergebnis.voll.md`). Nichts löschte sie
 * je: am 28.10. lagen 342 Dateien (12 MB) in /tmp, die ältesten vom 25.05. —
 * /tmp liegt hier auf `/`, nicht auf tmpfs, und überlebt jeden Neustart.
 *
 * Regel: eine Gruppe (alle Dateien einer Run-ID) wird gelöscht, wenn ihre
 * JÜNGSTE Datei älter als `maxAlterMs` (30 Tage) ist — und der Lauf weder laut
 * Checkpoint noch laut Run-Log `running` ist. Ein `running`-Lauf bleibt, egal
 * wie alt: ihn zu bergen ist Sache des Reapers, und ohne Checkpoint kann ihn
 * kein Resume mehr fortsetzen. Ein Checkpoint, der sich nicht lesen lässt,
 * zählt nicht als `running` (er ist 30 Tage unberührt und nicht fortsetzbar).
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

export const AUFRAEUMEN_MAX_ALTER_MS = 30 * 24 * 3_600_000
const MUSTER = /^openflow-checkpoint-(.+?)(\.json|\.ergebnis\.md|\.ergebnis\.voll\.md)$/

export function raeumeCheckpointsAuf(o: {
  dir: string
  runsDir: string
  now: number
  maxAlterMs?: number
  dryRun?: boolean
}): { geloescht: string[]; behalten_running: string[] } {
  const maxAlter = o.maxAlterMs ?? AUFRAEUMEN_MAX_ALTER_MS
  const gruppen = new Map<string, { pfade: string[]; juengste: number }>()
  for (const name of readdirSync(o.dir)) {
    const id = name.match(MUSTER)?.[1]
    if (!id) continue
    const pfad = join(o.dir, name)
    const mtime = (() => {
      try {
        return statSync(pfad).mtimeMs
      } catch {
        return undefined
      }
    })()
    if (mtime === undefined) continue
    const g = gruppen.get(id) ?? { pfade: [], juengste: 0 }
    g.pfade.push(pfad)
    g.juengste = Math.max(g.juengste, mtime)
    gruppen.set(id, g)
  }
  const geloescht: string[] = []
  const behalten_running: string[] = []
  for (const [id, g] of gruppen) {
    if (o.now - g.juengste <= maxAlter) continue
    if (laeuft(join(o.dir, `openflow-checkpoint-${id}.json`)) || laeuft(join(o.runsDir, `${id}.json`))) {
      behalten_running.push(id)
      continue
    }
    if (!o.dryRun) for (const p of g.pfade) rmSync(p, { force: true })
    geloescht.push(...g.pfade)
  }
  return { geloescht, behalten_running }
}

function laeuft(pfad: string): boolean {
  try {
    return JSON.parse(readFileSync(pfad, "utf8"))?.status === "running"
  } catch {
    return false
  }
}
