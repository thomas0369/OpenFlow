/**
 * of-referenz — Referenzaufgaben für die Messdaten der Template-Wahl.
 *
 * of-template-wahl.ts wählt je Aufgabenklasse erst ab MIN_N bewerteten Läufen;
 * im Alltag kommen die für die meisten (Klasse, Pipeline)-Paare nie zusammen.
 * Dieser Runner startet die harmlosen Aufgaben aus referenz-aufgaben.json
 * NACHEINANDER über of-run.sh --wait, jede in einem eigenen Unterordner von
 * --ordner, mit OPENFLOW_KLASSE = Klasse der Aufgabe (sonst riete of-run.sh die
 * Klasse aus dem Text, und die Messung landete in der falschen Zeile).
 *
 * Usage:
 *   bun of-referenz.ts --ordner DIR [--klasse K] [--id ID] [--pipeline NAME] [--dry-run]
 *     --ordner    Pflicht: Wurzel, unter der jede Aufgabe ihren Ordner bekommt
 *     --klasse    nur Aufgaben dieser Klasse (artikel|code-fix|analyse|review)
 *     --id        nur diese eine Aufgabe
 *     --pipeline  Pipeline für alle Läufe (Default auto-orchestrator)
 *     --dry-run   nur die Befehle zeigen, nichts starten, nichts anlegen
 *
 * Läuft schon ein Fabrik-Lauf (headless-run), startet der Runner nicht: die
 * Läufe teilen Engine und Ratenlimit, ein paralleler Referenzlauf verfälscht
 * beide Messungen.
 */

import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"

type Aufgabe = { id: string; klasse: string; text: string }

const OF_RUN = join(import.meta.dir, "of-run.sh")

export async function ladeAufgaben(): Promise<Aufgabe[]> {
  return (await Bun.file(join(import.meta.dir, "referenz-aufgaben.json")).json()).aufgaben
}

export function auswahl(aufgaben: Aufgabe[], filter: { klasse?: string; id?: string }) {
  return aufgaben.filter((a) => (!filter.klasse || a.klasse === filter.klasse) && (!filter.id || a.id === filter.id))
}

export function befehl(a: Aufgabe, ordner: string, pipeline: string) {
  const dir = join(ordner, a.id)
  return { dir, klasse: a.klasse, argv: ["bash", OF_RUN, "--wait", pipeline, a.text.replaceAll("{ordner}", dir)] }
}

function laufendeFabrik(): number {
  const ps = Bun.spawnSync(["ps", "-eo", "args"]).stdout.toString()
  return ps.split("\n").filter((z) => /^\S*bun .*scripts\/headless-run\.ts/.test(z)).length
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const ordnerArg = flag("--ordner")
  if (!ordnerArg) {
    console.error("usage: bun of-referenz.ts --ordner DIR [--klasse K] [--id ID] [--pipeline NAME] [--dry-run]")
    process.exit(2)
  }
  const ordner = resolve(ordnerArg)
  const pipeline = flag("--pipeline") ?? "auto-orchestrator"
  const trocken = argv.includes("--dry-run")
  const liste = auswahl(await ladeAufgaben(), { klasse: flag("--klasse"), id: flag("--id") })
  if (!liste.length) {
    console.error("keine Aufgabe passt auf --klasse/--id")
    process.exit(2)
  }
  for (const a of liste) {
    const b = befehl(a, ordner, pipeline)
    if (trocken) {
      console.log(`[dry-run] ${a.id} OPENFLOW_KLASSE=${b.klasse} ${b.argv.slice(0, 4).join(" ")} "${b.argv[4]}"`)
      continue
    }
    if (laufendeFabrik() > 0) {
      console.error(`${a.id}: abgebrochen — ein headless-run läuft bereits (ps). Später erneut starten.`)
      process.exit(3)
    }
    mkdirSync(b.dir, { recursive: true })
    console.log(`== ${a.id} (${a.klasse}) → ${pipeline}, Ordner ${b.dir}`)
    const p = Bun.spawn(b.argv, { env: { ...process.env, OPENFLOW_KLASSE: b.klasse }, stdout: "pipe", stderr: "inherit" })
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    const zeilen = out.trim().split("\n")
    const verdict = zeilen.findLast((z) => /^verdict:/i.test(z)) ?? "verdict: ?"
    const ergebnis = zeilen.findLast((z) => z.startsWith("ergebnis:")) ?? "ergebnis: ?"
    console.log(`${a.id}: exit ${code} · ${verdict} · ${ergebnis}`)
  }
}
