/**
 * of-cron-meldung — Ergebnis unbeaufsichtigter Läufe sichtbar machen (I6).
 *
 * Befund (Abnahme 22.11.2026): `wissen-video-analyse` läuft per crontab
 * (`30 7,19 * * * … of-run.sh --wait wissen-video-analyse …`). Am 19.11. 18:30
 * und 20.11. 06:30 endeten zwei Cron-Läufe mit FAIL — gemerkt hat es niemand.
 * Sitzungsläufe melden sich über die Hintergrund-Shell bzw. das
 * openflow-status-Plugin ([OF]-Zeilen nur für host.session = eigene Sitzung);
 * ein Cron-Lauf hat keine Sitzung und damit keinen Empfänger.
 *
 * Woran ein Cron-Lauf zu erkennen ist (gemessen an den Run-Logs 17.–22.11.):
 * headless-run schreibt `host = { pid, session?, aufruf_id? }`; `session`
 * kommt nur aus OPENFLOW_SESSION, die das fabrik-gate-Plugin einer
 * opencode-Sitzung setzt. Alle 14 Cron-Läufe tragen nur `{ pid }`. Das Ledger
 * hilft nicht: of-run.sh schreibt `quelle: "of-run.sh"` für jeden Start.
 * Regel daher: Pipeline steht in der crontab (`of-run.sh … <pipeline>`) UND
 * der Lauf hat keine host.session. Ein manueller Lauf ohne Sitzung (Claude
 * Code, Shell) zählt mit — er hat ebenso keinen Empfänger.
 *
 * „Letzter Lauf" heißt: der jüngste solche Lauf der Pipeline, und er ist
 * FERTIG — Scorecard im Log (headless-run schreibt sie erst nach dem letzten
 * Auto-Retry) oder nicht running und der Prozess lebt nicht mehr (gereapter
 * Lauf). Ein Versuch 1 mit error, dessen Retry im selben Prozess gleich
 * startet, wird so nicht als FAIL gemeldet.
 *
 * Ausgabe je Zyklus:
 *   - Alerts `I6-cronlauf:<pipeline>`, solange der letzte Lauf FAIL /
 *     DELIVERED_BELOW_BAR ist oder ein Kritiker (```urteil-Block) unter 10
 *     urteilt — Zustand, gedrosselt über dedupAlerts wie I1–I3.
 *   - je fertigem Lauf EINE Meldung (auch PASS) für ~/.openflow/meldungen.jsonl;
 *     das opencode-Plugin openflow-cron zeigt ungelesene beim ersten Prompt
 *     einer neuen Sitzung und setzt gelesen:true.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { isCritic } from "../src/graph/orchestration"
import { parseVerdict } from "../src/graph/verdict"
import { kritikUrteil, verdictOf } from "./of-ergebnis"
import type { PidStatus } from "./of-lebendig"
import type { AlertLike } from "./of-loop-logik"

/** Ältere fertige Läufe werden nicht mehr nachgemeldet (erster Tick nach Einführung). */
export const MELDUNG_MAX_ALTER_MS = 7 * 24 * 3_600_000
export const ALARM_VERDICTS: ReadonlySet<string> = new Set(["FAIL", "DELIVERED_BELOW_BAR"])
export const I6_PRAEFIX = "I6-cronlauf"

export interface Meldung {
  ts: string
  pipeline: string
  run: string
  verdict: string
  ergebnis: string | null
  gelesen: false
  /** Urteil eines Kritikers mit ```urteil-Block, eine Zeile. */
  kritik?: string
  /** true, wenn derselbe Lauf einen I6-Alert ausgelöst hat. */
  alarm: boolean
}

/**
 * Pipelines, die die crontab über of-run.sh startet. Kommentarzeilen zählen
 * nicht; Flags vor dem Namen (`--wait`, `--mcp`) werden übersprungen, ein
 * Resume (`--resume <id>`) ist kein Pipeline-Name.
 */
export function cronPipelines(crontab: string): string[] {
  const aus = new Set<string>()
  for (const roh of crontab.split("\n")) {
    const zeile = roh.trim()
    if (!zeile || zeile.startsWith("#")) continue
    const m = zeile.match(/of-run\.sh((?:\s+--[\w-]+)*)\s+["']?([A-Za-z0-9][\w.-]*)/)
    if (!m || /--resume\b/.test(m[1])) continue
    aus.add(m[2])
  }
  return [...aus]
}

export const unbeaufsichtigt = (log: any) => !log?.host?.session

/** Fertig = Scorecard geschrieben, oder nicht running und der Prozess ist weg. */
export function laufFertig(log: any, pid: (p: unknown) => PidStatus): boolean {
  if (log?.status === "running") return false
  if (log?.scorecard?.verdict) return true
  return pid(log?.host?.pid) !== "lebt"
}

export function meldungsVerdict(log: any): string {
  const v = log?.scorecard?.verdict
  return typeof v === "string" && v ? v : verdictOf(log?.status, 1, log?.quality)
}

/**
 * Urteil der Kritiker-Karten, die einen lesbaren ```urteil-Block lieferten.
 * Ein Reviewer ohne Block (Rolle `reviewer` zählt als Kritiker-Alias) bleibt
 * außen vor — seine Tabelle ist kein Urteil.
 */
export function kritikAus(log: any): { zeile?: string; offen: boolean } {
  const zeilen: string[] = []
  let offen = false
  for (const node of Array.isArray(log?.nodes) ? log.nodes : []) {
    if (!node || !isCritic(node) || typeof node.output !== "string") continue
    const read = parseVerdict(node.output)
    if (read.kind !== "verdict") continue
    if (!read.verdict.passed) offen = true
    const u = kritikUrteil(node.output)
    if (u) zeilen.push(`${node.id}: ${u}`)
  }
  return { zeile: zeilen.length ? zeilen.join(" | ") : undefined, offen }
}

const zeitVon = (log: any) => (typeof log?.finished === "number" ? log.finished : typeof log?.started === "number" ? log.started : 0)

export function planeCronMeldungen(o: {
  logs: any[]
  pipelines: string[]
  /** Run-IDs, die schon in meldungen.jsonl stehen. */
  gemeldet: ReadonlySet<string>
  now: number
  pid: (p: unknown) => PidStatus
  ergebnis: (runId: string) => string | null
  maxAlterMs?: number
}): { meldungen: Meldung[]; alerts: AlertLike[] } {
  const maxAlter = o.maxAlterMs ?? MELDUNG_MAX_ALTER_MS
  const meldungen: Meldung[] = []
  const alerts: AlertLike[] = []
  const ts = new Date(o.now).toISOString()
  for (const pipeline of o.pipelines) {
    const letzter = o.logs
      .filter((l) => l && typeof l.id === "string" && (l.pipeline ?? l.pipelineID) === pipeline && typeof l.started === "number" && unbeaufsichtigt(l))
      .sort((a, b) => b.started - a.started)[0]
    if (!letzter || !laufFertig(letzter, o.pid)) continue
    const verdict = meldungsVerdict(letzter)
    const kritik = kritikAus(letzter)
    const ergebnis = o.ergebnis(letzter.id)
    const alarm = ALARM_VERDICTS.has(verdict) || kritik.offen
    if (alarm)
      alerts.push({
        ts,
        invariante: `${I6_PRAEFIX}:${pipeline}`,
        wert: `${letzter.id} ${verdict}${kritik.zeile ? ` · Kritik ${kritik.zeile}` : ""}${ergebnis ? ` · ergebnis: ${ergebnis}` : ""}`,
        schwelle: "letzter unbeaufsichtigter Lauf PASS und Kritik 10/10",
      })
    if (o.gemeldet.has(letzter.id) || o.now - zeitVon(letzter) > maxAlter) continue
    meldungen.push({
      ts: new Date(zeitVon(letzter) || o.now).toISOString(),
      pipeline,
      run: letzter.id,
      verdict,
      ergebnis,
      gelesen: false,
      ...(kritik.zeile ? { kritik: kritik.zeile } : {}),
      alarm,
    })
  }
  return { meldungen, alerts }
}

/** Run-IDs, die schon gemeldet sind (gelesen oder nicht). Fehlt die Datei: keine. */
export function gemeldeteRuns(pfad: string): Set<string> {
  const aus = new Set<string>()
  if (!existsSync(pfad)) return aus
  for (const z of readFileSync(pfad, "utf8").split("\n")) {
    if (!z.trim()) continue
    try {
      const d = JSON.parse(z)
      if (typeof d?.run === "string") aus.add(d.run)
    } catch { /* halbe Zeile: übergehen */ }
  }
  return aus
}

/** Anhängen, EINE Zeile je Meldung (ein write — das Plugin liest zeilenweise). */
export function schreibeMeldungen(pfad: string, meldungen: Meldung[]): void {
  if (!meldungen.length) return
  mkdirSync(dirname(pfad), { recursive: true })
  appendFileSync(pfad, meldungen.map((m) => JSON.stringify(m) + "\n").join(""))
}
