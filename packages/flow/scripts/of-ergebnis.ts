/**
 * of-ergebnis — was headless-run am Ende eines Laufs meldet, als reine
 * Funktionen (testbar ohne Engine, ohne Prozessstart).
 *
 * K11 (12.10.2026): Ein Resume übernahm 2 fertige Karten aus dem Checkpoint
 * (worker-1, worker-3 von run-2026-10-12T14-03-22-434Z), der boss scheiterte
 * vor jedem Dispatch, die Engine trug beide Karten als `skipped` — ihr Output
 * war im neuen Log weg. Der Auto-Retry säte daraus „0 Karte(n) gehalten", und
 * die SCORECARD meldete `reused 0` und 0 Wörter. `uebernimm` legt das
 * Übernommene deshalb in den Log zurück, bevor gesät, gezählt oder gedruckt
 * wird — eine Karte, die nicht lief, behält das Ergebnis, das sie schon hatte.
 *
 * (c) (12.10.2026): Die Zeile `checkpoint: <pfad>` stand VOR den Karten-
 * Outputs; ein Modelltext mit einer eigenen Zeile „checkpoint: /…json" kam
 * danach, und Leser, die die letzte Zeile nehmen (openflow-status:
 * `[...matchAll(/^checkpoint: …$/gm)].pop()`), nahmen die des Modells.
 * `bericht` schreibt die Engine-Zeile deshalb als LETZTE Zeile, auf
 * demselben Kanal wie die Outputs (stdout), damit keine Pufferung zwischen
 * stdout und stderr die Reihenfolge im Log umdrehen kann.
 */

import { rmSync, writeFileSync } from "node:fs"
import { isCritic, ORCHESTRATOR_ROLE } from "../src/graph/orchestration"
import { recordedTurns, type RecordedTurn } from "../src/server/turn-hash"

export interface Scorecard {
  runId: string
  pipeline: string
  verdict: string
  attempts: number
  predecessors: string[]
  nodes: { total: number; done: number; error: number; stopped: number; skipped: number; reused: number }
  durationSec: number | null
  outputWords: number
  outputChars: number
}

/**
 * Seeds a continuation from a run log: done cards keep their output, and every
 * card that held a session names it. A done card's session is not reopened in
 * a pipeline (the engine drops it); in an orchestration the orchestrator's
 * later turns continue there, which is what keeps their context.
 */
export function seedFrom(log: any, outputs: Record<string, string>, held: Record<string, string>) {
  for (const node of log?.nodes ?? []) {
    if (node.status === "done" && typeof node.output === "string") outputs[node.id] = node.output
    if (node.sessionID) held[node.id] = node.sessionID
  }
}

/**
 * K7: die aufgezeichneten Züge jeder fertigen Karte (Eingabe-Hash + Antwort),
 * damit die Engine eine Karte nur übernimmt, wenn ihre Eingabe dieselbe ist —
 * auch wenn der Orchestrator sie neu anlegt. Alte Logs ohne `turns`: der
 * letzte Prompt gilt als Zug 1 (siehe `recordedTurns`).
 */
export function turnsFrom(log: any, turns: Record<string, RecordedTurn[]>) {
  for (const node of log?.nodes ?? []) {
    const recorded = recordedTurns(node)
    if (recorded) turns[node.id] = recorded
  }
}

/**
 * Vorgänger eines Laufs für die SCORECARD: der Checkpoint-Lauf, aus dem
 * fortgesetzt wurde (falls Resume), dann die früheren Versuche dieses
 * Prozesses. Abnahme R13 K11: ein Resume meldete `predecessors: []`.
 */
export function vorgaenger(resumeId: string | undefined, versuche: string[]): string[] {
  return [...(resumeId ? [resumeId] : []), ...versuche.slice(0, -1)]
}

/** Zustände, in denen eine Karte in DIESEM Versuch nichts eigenes geliefert hat. */
const OHNE_EIGENES = new Set(["skipped", "stopped", "queued", "idle", undefined])

/**
 * Legt übernommene Outputs in den Log zurück: jede Karte, die in diesem
 * Versuch nicht lief (skipped/stopped/queued/idle) und aus einem früheren Lauf
 * einen Output hat, wird `done` + `reused` mit diesem Output. Eine Karte, die
 * in diesem Versuch `error` oder `done` endete, bleibt, wie sie ist — ihr
 * eigener Ausgang ist die Wahrheit. Gibt die Zahl zurückgelegter Karten.
 */
export function uebernimm(log: any, outputs: Record<string, string>, held: Record<string, string> = {}): number {
  let n = 0
  for (const node of log?.nodes ?? []) {
    const seed = outputs[node?.id]
    if (seed === undefined || !OHNE_EIGENES.has(node.status)) continue
    node.status = "done"
    node.output = seed
    node.reused = true
    delete node.error
    if (!node.sessionID && held[node.id]) node.sessionID = held[node.id]
    n++
  }
  return n
}

/**
 * K11 (R18): was die Startzeile „angeboten" hat, gegen das, was die Engine
 * wirklich übernommen hat (`reused`). Ein Resume meldete „3 card(s) kept" und
 * die SCORECARD `reused 0` — die Worker liefen neu. Die Zahl hier IST die der
 * SCORECARD (dieselbe Eigenschaft), und neu Gerechnetes steht namentlich da.
 */
export function uebernahme(log: any, angeboten: string[]) {
  const reused = new Set((log?.nodes ?? []).filter((n: any) => n?.reused).map((n: any) => n.id as string))
  const uebernommen = (log?.nodes ?? []).filter((n: any) => n?.reused).map((n: any) => n.id as string)
  const neu = angeboten.filter((id) => !reused.has(id))
  const zeile = angeboten.length
    ? `übernommen: ${uebernommen.length} von ${angeboten.length} angebotenen Karte(n)${neu.length ? ` — neu gerechnet: ${neu.join(", ")}` : ""}`
    : ""
  return { uebernommen, neu, zeile }
}

export function buildScorecard(log: any, attempts: number, predecessors: string[], startedMs: number, now = Date.now()): Scorecard {
  const nodes: any[] = Array.isArray(log.nodes) ? log.nodes : []
  const count = (s: string) => nodes.filter((n) => n?.status === s).length
  const outputs = nodes.filter((n) => n?.status === "done" && typeof n.output === "string").map((n) => n.output as string)
  const durationSec = typeof log.finished === "number" && typeof log.started === "number"
    ? Math.round((log.finished - log.started) / 1000)
    : Math.round((now - startedMs) / 1000)
  return {
    runId: log.id,
    pipeline: log.pipeline,
    verdict: log.status === "done" ? (attempts > 1 ? "PASS_RETRIED" : "PASS") : log.status === "error" ? "FAIL" : String(log.status).toUpperCase(),
    attempts,
    predecessors,
    nodes: {
      total: nodes.length,
      done: count("done"),
      error: count("error"),
      stopped: count("stopped"),
      skipped: count("skipped"),
      reused: nodes.filter((n) => n?.reused).length,
    },
    durationSec,
    outputWords: outputs.reduce((a, o) => a + o.split(/\s+/).filter(Boolean).length, 0),
    outputChars: outputs.reduce((a, o) => a + o.length, 0),
  }
}

/** Die Engine-Zeile, die Leser des Logs als Checkpoint nehmen. */
export const checkpointZeile = (id: string) => `checkpoint: /tmp/openflow-checkpoint-${id}.json`

/**
 * Schlussbericht in Log-Reihenfolge. `out` = stdout (Ergebnis), `err` =
 * stderr (Status). Die Checkpoint-Zeile kommt zuletzt und auf `out`: nach
 * allen Modelltexten, im selben Strom wie sie.
 */
export function bericht(log: any, scorecard: Scorecard, io: { out: (s: string) => void; err: (s: string) => void }) {
  io.out(`=== SCORECARD ===\n${JSON.stringify(scorecard, null, 2)}`)
  for (const node of log.nodes ?? []) {
    io.err(`[${node.id}] ${node.status}`)
    if (node.output !== undefined) io.out(`=== ${node.id} ===\n${node.output}`)
  }
  io.err(`run ${log.id}: ${log.status} — verdict ${scorecard.verdict} (${scorecard.attempts} Versuch(e), ${scorecard.outputWords} Wörter Output)`)
  io.out(checkpointZeile(log.id))
}

// ---------------------------------------------------------------------------
// W2.2 (Plan „Autonomie 10/10", A10, 23.10.2026): JEDES Ende läuft durch
// einen Abschlusspunkt. Vorher hatte headless-run keinen Signal-Handler — ein
// Reap (SIGTERM), Strg-C (SIGINT) oder ein geschlossenes Terminal (SIGHUP)
// beendete ihn ohne Verdict, ohne Bericht, ohne etwas Lesbares für die
// aufrufende Sitzung. Jetzt schreibt jedes Ende — regulär oder per Signal —
// Checkpoint + `ergebnis.md` und nennt den Pfad als letzte stdout-Zeile.

/**
 * Obergrenze der ergebnis.md (Byte, UTF-8). Sie gilt für die KÜRZBAREN Teile:
 * Synthese und Kritik stehen ungekürzt darin (bis `ERGEBNIS_KERN_MAX_BYTES`),
 * gekürzt werden nur Worker-Ausgaben — die Synthese hat sie schon verarbeitet.
 *
 * W2.3 (24.10.2026): Vorher wurde die Datei in Log-Reihenfolge (boss, worker-*,
 * critic) am Ende abgeschnitten. Gemessen an 8 auto-orchestrator-Läufen:
 * 7 von 8 lagen bei genau 25 600 Byte, und abgeschnitten wurde, was zuletzt
 * stand — die Kritik, in 3 von 8 Läufen ganz. Der Kritiker ist aber der
 * Mehrwert der Fabrik. Gemessene Größen (dieselben 8 Läufe): boss median
 * 7 929 / max 10 730, critic median 4 269 / max 5 064, Worker median 5 116 /
 * max 11 444, Summe median 27 713 / max 36 191, boss+critic max 15 590 Byte.
 * Die 25 KB bleiben: Synthese + Kritik passen im gemessenen Höchstfall mit
 * 10 KB Rest für die Worker, und die Datei bleibt in einem Read lesbar.
 */
export const ERGEBNIS_MAX_BYTES = 25 * 1024
/** Erst darüber wird auch der Kern gekürzt (Schutz gegen ausufernde Modelltexte; gemessen max 15 590). */
export const ERGEBNIS_KERN_MAX_BYTES = 2 * ERGEBNIS_MAX_BYTES
/** Länge des Kritik-Urteils im Kopf (die erste Zeile der Kritik, so verlangt es der Kritiker-Prompt). */
const URTEIL_MAX_BYTES = 400

/** Die ergebnis.md liegt neben dem Checkpoint und teilt seinen Stamm. */
export const ergebnisPfad = (id: string, dir = "/tmp") => `${dir}/openflow-checkpoint-${id}.ergebnis.md`
/** Ungekürzte Fassung — nur geschrieben, wenn die ergebnis.md gekürzt ist. */
export const ergebnisVollPfad = (id: string, dir = "/tmp") => `${dir}/openflow-checkpoint-${id}.ergebnis.voll.md`
export const checkpointPfad = (id: string, dir = "/tmp") => `${dir}/openflow-checkpoint-${id}.json`

/** Exit-Code je Signal (128 + Signalnummer, wie die Shell ihn meldet). */
export const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const
export type AbbruchSignal = keyof typeof SIGNAL_EXIT

const bytes = (s: string) => Buffer.byteLength(s, "utf8")

/** Kürzt auf höchstens `max` Byte UTF-8, ohne ein Zeichen zu zerschneiden. */
function aufBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8")
  if (buf.length <= max) return text
  let end = Math.max(0, max)
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

export type ErgebnisRolle = "synthese" | "kritik" | "worker"

/** Synthese = Orchestrator-Karte, Kritik = Kritiker-Karte (dieselbe Regel wie die Engine), Rest = Worker. */
export function ergebnisRolle(node: any): ErgebnisRolle {
  // Logs ohne `role` (ältere Läufe): die Karten-IDs des auto-orchestrator.
  if (node?.role === ORCHESTRATOR_ROLE || (node?.role === undefined && node?.id === "boss")) return "synthese"
  if (isCritic(node ?? {}) || (node?.role === undefined && node?.id === "critic")) return "kritik"
  return "worker"
}

/** Die erste Zeile der Kritik — der Kritiker-Prompt verlangt dort das Urteil („in one line, before anything else"). */
export function kritikUrteil(output: unknown): string | undefined {
  if (typeof output !== "string") return undefined
  const zeile = output.split("\n").map((z) => z.replace(/^\s*#+\s*/, "").trim()).find(Boolean)
  if (!zeile) return undefined
  return bytes(zeile) <= URTEIL_MAX_BYTES ? zeile : aufBytes(zeile, URTEIL_MAX_BYTES - 3) + "…"
}

const rumpf = (node: any) =>
  typeof node.output === "string" && node.output ? node.output : node.error ? `Fehler: ${String(node.error)}` : "(kein Output)"
const titel = (node: any) => `## ${node.id} — ${node.status}${node.reused ? " (übernommen)" : ""}`

/**
 * Wasserstand-Kürzung: jeder Rumpf bekommt einen gleichen Anteil am Budget;
 * was ein kurzer Rumpf nicht braucht, geht an die langen. Gekürzte Rümpfe
 * enden mit `marke(voll)`, die Marke zählt zum Anteil.
 */
function kuerzeAufBudget(ruempfe: string[], budget: number, marke: (voll: number) => string): string[] {
  const aus = [...ruempfe]
  const offen = ruempfe.map((r, i) => ({ i, n: bytes(r) })).sort((a, b) => a.n - b.n)
  let rest = Math.max(0, budget)
  while (offen.length) {
    const anteil = Math.floor(rest / offen.length)
    const { i, n } = offen.shift()!
    if (n <= anteil) {
      rest -= n
      continue
    }
    const m = marke(n)
    aus[i] = aufBytes(ruempfe[i], anteil - bytes(m)) + m
    rest -= bytes(aus[i])
  }
  return aus
}

/** Beide Fassungen: `md` (≤ max für die Worker-Teile) und `voll` (nur wenn gekürzt). */
export function ergebnisDateien(
  log: any,
  scorecard: Scorecard,
  max = ERGEBNIS_MAX_BYTES,
  dir = "/tmp",
): { md: string; voll?: string } {
  const knoten: any[] = log.nodes ?? []
  const rang = { synthese: 0, kritik: 1, worker: 2 } as const
  const geordnet = knoten.map((n, i) => ({ n, i })).sort((a, b) => rang[ergebnisRolle(a.n)] - rang[ergebnisRolle(b.n)] || a.i - b.i).map((x) => x.n)
  const kritiken = geordnet.filter((n) => ergebnisRolle(n) === "kritik")
  const urteile = kritiken.map((n) => [n.id, kritikUrteil(n.output)] as const).filter(([, u]) => u)
  const vollPfad = ergebnisVollPfad(log.id, dir)

  const kopf = (gekuerzt?: string) =>
    [
      `# Ergebnis ${log.id}`,
      "",
      `- Pipeline: ${log.pipeline ?? "?"}`,
      `- Verdict: ${scorecard.verdict} (Status ${log.status}, ${scorecard.attempts} Versuch(e), ${scorecard.outputWords} Wörter)`,
      ...urteile.map(([id, u]) => `- Kritik-Urteil (${id}): ${u}`),
      ...(log.error ? [`- Fehler: ${String(log.error)}`] : []),
      `- Checkpoint: ${checkpointPfad(log.id, dir)}`,
      ...(gekuerzt ? [`- ${gekuerzt}`] : []),
      `- Reihenfolge: Synthese → Kritik → Worker (${geordnet.map((n) => n.id).join(", ") || "keine Karten"})`,
    ].join("\n")
  const fuss = ["## Scorecard", "", "```json", JSON.stringify(scorecard, null, 2), "```"].join("\n")
  const baue = (k: string, ruempfe: string[]) =>
    [k, ...geordnet.map((n, i) => `${titel(n)}\n\n${ruempfe[i]}`), fuss].join("\n\n") + "\n"

  const ruempfe = geordnet.map(rumpf)
  const voll = baue(kopf(), ruempfe)
  if (bytes(voll) <= max) return { md: voll }

  const marke = (n: number) => `\n\n… gekürzt (Abschnitt hat ${n} Byte) — vollständig in ${vollPfad}`
  const kern = geordnet.map((n) => ergebnisRolle(n) !== "worker")
  // Kern ungekürzt, solange er unter seiner eigenen Grenze bleibt.
  const kernRuempfe = ruempfe.filter((_, i) => kern[i])
  const kernGekuerzt = kernRuempfe.reduce((a, r) => a + bytes(r), 0) > ERGEBNIS_KERN_MAX_BYTES
    ? kuerzeAufBudget(kernRuempfe, ERGEBNIS_KERN_MAX_BYTES, marke)
    : kernRuempfe
  const zwischen = [...ruempfe]
  let k = 0
  for (let i = 0; i < zwischen.length; i++) if (kern[i]) zwischen[i] = kernGekuerzt[k++]
  const hinweis = `gekürzt: nur Worker-Ausgaben${kernGekuerzt !== kernRuempfe ? " und (über " + ERGEBNIS_KERN_MAX_BYTES + " Byte) der Kern" : ""}, ${bytes(voll)} Byte vollständig in ${vollPfad}`
  // Budget der Worker-Rümpfe = Grenze minus alles Feste (mit leeren Worker-Rümpfen gemessen).
  const fest = bytes(baue(kopf(hinweis), zwischen.map((r, i) => (kern[i] ? r : ""))))
  const workerIdx = zwischen.map((_, i) => i).filter((i) => !kern[i])
  const gekuerzt = kuerzeAufBudget(workerIdx.map((i) => zwischen[i]), max - fest, marke)
  workerIdx.forEach((i, j) => (zwischen[i] = gekuerzt[j]))
  return { md: baue(kopf(hinweis), zwischen), voll }
}

/** Markdown der ergebnis.md (siehe `ergebnisDateien`). */
export function ergebnisMarkdown(log: any, scorecard: Scorecard, max = ERGEBNIS_MAX_BYTES, dir = "/tmp"): string {
  return ergebnisDateien(log, scorecard, max, dir).md
}

/** Kopie eines abgebrochenen Laufs: Run und alle noch offenen Karten `stopped`. */
export function gestoppt(log: any, signal: string, jetzt = Date.now()): any {
  const offen = new Set(["running", "queued", "idle"])
  return {
    ...log,
    status: log?.status === "running" || log?.status === undefined ? "stopped" : log.status,
    error: log?.error ?? `abgebrochen: ${signal}`,
    finished: typeof log?.finished === "number" ? log.finished : jetzt,
    stoppedBySignal: { signal, at: new Date(jetzt).toISOString() },
    nodes: (log?.nodes ?? []).map((n: any) => (offen.has(n?.status) ? { ...n, status: "stopped" } : n)),
  }
}

/**
 * Der eine Abschluss: Checkpoint + ergebnis.md schreiben (synchron — ein
 * SIGKILL danach verliert nichts mehr), Bericht drucken, dann `verdict:` und
 * `ergebnis: <pfad>` als LETZTE stdout-Zeile. Gibt den ergebnis-Pfad zurück.
 */
export function abschliessen(
  log: any,
  scorecard: Scorecard,
  io: { out: (s: string) => void; err: (s: string) => void },
  dir = "/tmp",
): string {
  try {
    writeFileSync(checkpointPfad(log.id, dir), JSON.stringify({ ...log, scorecard }, null, 2))
  } catch (error) {
    io.err(`checkpoint nicht geschrieben: ${String(error)}`)
  }
  const pfad = ergebnisPfad(log.id, dir)
  try {
    const { md, voll } = ergebnisDateien(log, scorecard, ERGEBNIS_MAX_BYTES, dir)
    // Erst die volle Fassung: die gekürzte nennt ihren Pfad. Eine alte volle
    // Fassung desselben Runs (Signal-Abschluss, dann regulärer) wird entfernt.
    if (voll) writeFileSync(ergebnisVollPfad(log.id, dir), voll)
    else rmSync(ergebnisVollPfad(log.id, dir), { force: true })
    writeFileSync(pfad, md)
  } catch (error) {
    io.err(`ergebnis.md nicht geschrieben: ${String(error)}`)
  }
  bericht(log, scorecard, io)
  io.out(`verdict: ${scorecard.verdict} · run ${log.id} · ${log.status} · ${scorecard.outputWords} Wörter`)
  io.out(`ergebnis: ${pfad}`)
  return pfad
}

export interface LaufStand {
  log: any
  attempts: number
  predecessors: string[]
  startedMs: number
}

/**
 * Handler für SIGTERM/SIGINT/SIGHUP. `stand()` liefert den aktuellen Lauf
 * (oder `undefined` vor dem ersten Checkpoint); `nachher` erledigt
 * Best-effort-Arbeit (Store-PUT, Sessions stoppen) mit Zeitlimit. Ein zweites
 * Signal während des Abschlusses wird ignoriert; nach `limitMs` endet der
 * Prozess in jedem Fall.
 */
export function installiereSignalAbschluss(opts: {
  stand: () => LaufStand | undefined
  dir?: string
  nachher?: (log: any) => Promise<unknown>
  limitMs?: number
  proc?: { on: (sig: string, fn: () => void) => unknown; exit: (code: number) => never | void }
  io?: { out: (s: string) => void; err: (s: string) => void }
}) {
  const proc = opts.proc ?? process
  const io = opts.io ?? { out: (s: string) => console.log(s), err: (s: string) => console.error(s) }
  const limit = opts.limitMs ?? 4_000
  let laeuft = false
  for (const sig of Object.keys(SIGNAL_EXIT) as AbbruchSignal[]) {
    proc.on(sig, () => {
      if (laeuft) return
      laeuft = true
      const code = SIGNAL_EXIT[sig]
      const stand = opts.stand()
      if (!stand?.log?.id) {
        io.err(`headless-run: abgebrochen (${sig}) vor dem ersten Checkpoint — kein Run-Log, nichts zu sichern`)
        proc.exit(code)
        return
      }
      const log = gestoppt(stand.log, sig)
      const scorecard = buildScorecard(log, stand.attempts, stand.predecessors, stand.startedMs)
      log.scorecard = scorecard
      io.err(`headless-run: ${sig} — Run ${log.id} wird als stopped abgeschlossen`)
      abschliessen(log, scorecard, io, opts.dir)
      const zeit = new Promise((r) => setTimeout(r, limit))
      void Promise.race([Promise.resolve(opts.nachher?.(log)).catch(() => undefined), zeit]).finally(() => proc.exit(code))
    })
  }
}
