/**
 * of-template-wahl — welche Pipeline liefert je Aufgabenklasse am besten?
 *
 * Liest alle Run-JSONs, gruppiert nach (klasse, pipeline) und wählt je Klasse
 * die Pipeline mit der besten barMet-Quote. Das fabrik-gate setzt die Wahl aus
 * `~/.openflow/template-wahl.json` in seinen Startbefehl ein; ohne Zeile für
 * eine Klasse bleibt es bei `auto-orchestrator`.
 *
 * Bewertbar ist nur ein Lauf mit `quality` (strukturierter Gauntlet). Alte
 * Läufe ohne `quality` zählen in n_gesamt, nie in die Quote: ein `done` ohne
 * Urteil sagt nichts darüber, ob die Latte gerissen wurde.
 *
 * Usage:
 *   bun of-template-wahl.ts [--runs-dir DIR] [--out FILE] [--dry-run]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { RunLog } from "../src/graph/types"
import { verdictOf } from "./of-ergebnis.ts"
import { AUFGABEN_KLASSEN, aufgabenKlasse, type AufgabenKlasse } from "./of-gate.ts"

export const MIN_N = 5

// Fehler der Infrastruktur (Anmeldung, Transport, Provider-Stream, Zeitlimit,
// nicht erreichbarer Server) sagen nichts über die Pipeline: dieselbe Karte
// wäre mit funktionierendem Provider gelaufen. Solche error-Läufe fallen aus
// der Wertung, statt die Quote der Pipeline zu drücken, die gerade lief.
export const INFRA_FEHLER: RegExp[] = [
  /unauthorized/i,
  /HTTP transport/i,
  /stream/i,
  /timed out/i,
  /cannot reach opencode serve/i,
  /ECONNREFUSED/,
  /fetch failed/i,
]

type Lauf = Partial<RunLog> & { error?: unknown; scorecard?: { attempts?: number } }

export type Zeile = {
  klasse: AufgabenKlasse
  pipeline: string
  /** Gewertete Läufe (ohne Infra-Ausschlüsse und laufende), mit oder ohne quality. */
  n_gesamt: number
  /** Bewertbar: Läufe mit quality. */
  n: number
  erfuellt: number
  quote: number | null
  runden: number | null
  tokens_median: number | null
  infra: number
}

export type Wahl = { pipeline: string; n: number; quote: number; runden: number }

export type WahlDatei = {
  erzeugt: string
  min_n: number
  wahl: Partial<Record<AufgabenKlasse, Wahl>>
  tabelle: Zeile[]
}

export function istInfraFehler(log: Lauf): boolean {
  if (log.status !== "error") return false
  const texte = [log.error, ...(log.nodes ?? []).map((n) => n?.error)].filter((t): t is string => typeof t === "string")
  return texte.some((t) => INFRA_FEHLER.some((re) => re.test(t)))
}

export function klasseVon(log: Lauf): AufgabenKlasse {
  const k = AUFGABEN_KLASSEN.find((x) => x === log.klasse)
  return k ?? aufgabenKlasse(log.input ?? "")
}

// Ohne Cache-Tokens: cacheRead wächst mit jeder Runde um den ganzen Kontext und
// würde den Vergleich auf „wer hat weniger Züge“ reduzieren.
function tokensVon(log: Lauf): number | null {
  const t = log.usage?.tokens
  if (!t) return null
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0)
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const mittel = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const runde = (x: number | null, stellen: number) => (x === null ? null : +x.toFixed(stellen))

export function tabelle(logs: Lauf[]): Zeile[] {
  const gruppen = Map.groupBy(
    logs.filter((l) => l.status !== "running"),
    (l) => `${klasseVon(l)}\u0000${l.pipeline || "?"}`,
  )
  return [...gruppen.entries()]
    .map(([key, alle]) => {
      const [klasse, pipeline] = key.split("\u0000") as [AufgabenKlasse, string]
      return { klasse, pipeline, logs: alle.filter((l) => !istInfraFehler(l)), infra: alle.filter(istInfraFehler).length }
    })
    .map((g) => {
      const bewertbar = g.logs.filter((l) => l.quality)
      const erfuellt = bewertbar.filter((l) => verdictOf(l.status, l.scorecard?.attempts ?? 1, l.quality).startsWith("PASS")).length
      const tokens = bewertbar.map(tokensVon).filter((t): t is number => t !== null)
      return {
        klasse: g.klasse,
        pipeline: g.pipeline,
        n_gesamt: g.logs.length,
        n: bewertbar.length,
        erfuellt,
        quote: bewertbar.length ? runde(erfuellt / bewertbar.length, 3) : null,
        runden: runde(mittel(bewertbar.map((l) => l.quality!.rounds)), 2),
        tokens_median: median(tokens),
        infra: g.infra,
      }
    })
    .sort((a, b) => a.klasse.localeCompare(b.klasse) || a.pipeline.localeCompare(b.pipeline))
}

// Fehlende Kennzahl verliert jeden Gleichstand.
const kleiner = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity)

export function waehle(zeilen: Zeile[], minN = MIN_N): Partial<Record<AufgabenKlasse, Wahl>> {
  const wahl: Partial<Record<AufgabenKlasse, Wahl>> = {}
  for (const klasse of AUFGABEN_KLASSEN) {
    const beste = zeilen
      .filter((z) => z.klasse === klasse && z.n >= minN && z.quote !== null)
      .sort((a, b) => b.quote! - a.quote! || kleiner(a.runden, b.runden) || kleiner(a.tokens_median, b.tokens_median))[0]
    if (beste) wahl[klasse] = { pipeline: beste.pipeline, n: beste.n, quote: beste.quote!, runden: beste.runden ?? 0 }
  }
  return wahl
}

export function leseRuns(dir: string): Lauf[] {
  return readdirSync(dir)
    // .index.json ist der Run-Index, kein Run.
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort()
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(dir, f), "utf8")) as Lauf]
      } catch {
        return []
      }
    })
}

export function markdown(datei: WahlDatei): string {
  const zelle = (x: number | null) => (x === null ? "–" : String(x))
  const kopf = [
    "| klasse | pipeline | n_gesamt | n | erfüllt | quote | runden | tokens_median | infra | gewählt |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ]
  const zeilen = datei.tabelle.map((z) =>
    [
      z.klasse,
      z.pipeline,
      z.n_gesamt,
      z.n,
      z.erfuellt,
      zelle(z.quote),
      zelle(z.runden),
      zelle(z.tokens_median),
      z.infra,
      datei.wahl[z.klasse]?.pipeline === z.pipeline ? "ja" : "",
    ].join(" | "),
  )
  const wahl = Object.entries(datei.wahl).map(([k, w]) => `- ${k} → ${w!.pipeline} (n=${w!.n}, quote=${w!.quote}, runden=${w!.runden})`)
  return [
    ...kopf,
    ...zeilen.map((z) => `| ${z} |`),
    "",
    `Wahl (min_n=${datei.min_n}):`,
    ...(wahl.length ? wahl : ["- keine — keine Klasse hat eine Pipeline mit ≥ min_n bewertbaren Läufen; das Gate nimmt auto-orchestrator"]),
  ].join("\n")
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string, fallback: string) => {
    const i = argv.indexOf(name)
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback
  }
  const runsDir = resolve(flag("--runs-dir", process.env.OPENFLOW_RUNS_DIR || join(homedir(), "workspace/flow-lab/.openflow/runs")))
  const out = resolve(flag("--out", join(homedir(), ".openflow/template-wahl.json")))
  if (!existsSync(runsDir)) {
    console.error(`runs-dir fehlt: ${runsDir}`)
    process.exit(2)
  }
  const zeilen = tabelle(leseRuns(runsDir))
  const datei: WahlDatei = { erzeugt: new Date().toISOString(), min_n: MIN_N, wahl: waehle(zeilen), tabelle: zeilen }
  console.log(markdown(datei))
  if (argv.includes("--dry-run")) {
    console.log(`\n(--dry-run: ${out} nicht geschrieben)`)
    process.exit(0)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(datei, null, 2) + "\n")
  console.log(`\ngeschrieben: ${out}`)
}
