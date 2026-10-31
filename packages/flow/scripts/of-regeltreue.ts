/**
 * of-regeltreue — Auflösung jeder FABRIK-Empfehlung des fabrik-gate (Defekt 2,
 * 23.10.2026). DIE Regel steht hier; Scorecard, Digest und Loop (I3) rufen sie.
 *
 * Anlass: Das Ledger kannte weder „befolgt" noch „abgewichen" noch eine
 * Begründung. Die Loop-Sonde meldete eine absolute Zahl (`I3-regeltreue:
 * 5/18`), 16 von 37 FABRIK-Empfehlungen der Woche blieben ohne fabrik_run —
 * ob begründet, war nicht festzustellen. Zudem zählten 19 task-Empfehlungen
 * mit, die nie jemand gesehen hat (injiziert:false bei allen task-Zeilen).
 *
 * Empfehlung = Ledger-Zeile user_prompt|task mit entscheidung=FABRIK. Ausgang
 * (Fenster REGELTREUE_FENSTER_MS ab der Empfehlung, Belege werden 1:1
 * verbraucht — ein Start deckt nicht zwei Empfehlungen):
 *   nicht_zugestellt            injiziert ≠ true — der Pflichtweg erreichte nie
 *                               einen Kontext; gezählt, aber NICHT in der Quote
 *   befolgt_fabrik              echter Fabrik-Start (of-fabrik-aufruf.ts) in
 *                               derselben Session, über task_ref=gate_id oder
 *                               aus der Kind-Session eines task-Aufrufs
 *   befolgt_subagent            Stufe 1 der Eskalationsleiter (GATE_BLOCK:
 *                               „STUFE 1 (Standard)"): subagent-Aufruf derselben
 *                               Session bzw. aus der Kind-Session
 *   abgewichen_begruendet       event=abweichung (of-gate.ts abweichung "<grund>")
 *                               derselben Session im Fenster
 *   abgewichen_ohne_begruendung Fenster abgelaufen, nichts davon
 *   offen                       Fenster läuft noch
 *   fehlklassifiziert           Neubewertung (31.10.2026): die Empfehlung traf
 *                               einen internen Auftrag (of-gate.ts
 *                               `internerAuftrag`: Prüfung/Fortsetzung einer
 *                               bestehenden Lieferung) — laut Regel Nein-Fall,
 *                               heute DIREKT. Gezählt, aber NICHT in der Quote,
 *                               wie nicht_zugestellt. Nur DIESE eine Regel wird
 *                               rückwirkend angewandt, keine sonstige Drift.
 *
 * Zuordnung (31.10.2026, Feldbefund ses_e7dabcfb): je Empfehlung zählt der
 * FRÜHESTE Beleg im Fenster, gleich welcher Art — vorher ging ein Start immer
 * vor; eine Empfehlung, deren Agent 23 s später begründet abwich, schnappte
 * sich so den Start, der 24 min später zur NÄCHSTEN Empfehlung gehörte, und
 * diese stand als „ohne Begründung" da. Bündel: Ein Fabrik-Start deckt
 * zusätzlich jede weitere Nutzer-Empfehlung derselben Session, die NACH der
 * ersten und VOR dem Start eintraf (der Nutzer schob einen zweiten Prompt nach,
 * bevor der Agent reagiert hatte; Feld: zwei Prompts in 27 s, EIN Lauf „für
 * ZWEI Schnittstellen"). Danach eintreffende Empfehlungen deckt er nicht.
 *
 * Quote = (befolgt_fabrik + befolgt_subagent + abgewichen_begruendet) /
 *         aufgelöste zugestellte Empfehlungen. Daneben `fabrikQuote` (nur
 * Stufe 2) — Stufe 1 ist laut Pflichtweg der Standard, die enge Zahl bleibt
 * als Vergleich sichtbar.
 */
import { echteStarts } from "./of-fabrik-aufruf.ts"
import { internerAuftrag } from "./of-gate.ts"

export const REGELTREUE_FENSTER_MS = 30 * 60_000
/**
 * K7/D1 (23.10.2026 20:31Z): ab hier injiziert das fabrik-gate den Pflichtweg
 * auch in task-Aufträge. Davor erreichte er Subagenten nie — alle 49
 * „nicht_zugestellt" stammen vom 12.–22.10. Das Fenster „gesamt" beginnt
 * deshalb hier (B7, 28.10.2026); ältere Empfehlungen sind nicht bewertbar und
 * werden getrennt gezählt (`vorK7`).
 */
export const K7_STICHTAG = "2026-10-23T20:31:00Z"
const K7_MS = Date.parse(K7_STICHTAG)
const TAG_MS = 24 * 3_600_000
export const FENSTER = [
  { name: "24 h", ms: TAG_MS },
  { name: "7 Tage", ms: 7 * TAG_MS },
  { name: "gesamt", ms: Number.POSITIVE_INFINITY },
] as const

export type Ausgang =
  | "nicht_zugestellt"
  | "befolgt_fabrik"
  | "befolgt_subagent"
  | "abgewichen_begruendet"
  | "abgewichen_ohne_begruendung"
  | "offen"
  | "fehlklassifiziert"

export interface Aufloesung {
  ts: string
  ms: number
  event: string
  session_id: string | null
  gate_id: string | null
  task: string
  status: Ausgang
  beleg_ts?: string
  grund?: string
  /** befolgt_fabrik über einen Start, der einer früheren Empfehlung derselben Session zugeordnet ist (Bündel). */
  gebuendelt?: boolean
}

const tsMs = (e: any): number | null => {
  const t = typeof e?.ts === "number" ? e.ts : Date.parse(String(e?.ts ?? ""))
  return Number.isFinite(t) ? t : null
}

export function istEmpfehlung(e: any): boolean {
  return (e?.event === "user_prompt" || e?.event === "task") && e?.entscheidung === "FABRIK"
}

export function loeseAuf(entries: any[], now: number, fensterMs = REGELTREUE_FENSTER_MS): Aufloesung[] {
  const gueltig = entries.filter((e) => e && tsMs(e) !== null)
  const kind = new Map<string, string>()
  for (const e of gueltig)
    if (e.event === "task_kind" && typeof e.gate_id === "string" && typeof e.kind_session === "string") kind.set(e.gate_id, e.kind_session)

  const nachZeit = (xs: any[]) => [...xs].sort((a, b) => (tsMs(a) as number) - (tsMs(b) as number))
  const starts = nachZeit(echteStarts(gueltig))
  const subagent = nachZeit(gueltig.filter((e) => e.event === "task" && e.quelle === "subagent"))
  const abweichungen = nachZeit(gueltig.filter((e) => e.event === "abweichung"))
  const verbraucht = new Set<any>()

  const ergebnis: Aufloesung[] = []
  // Fabrik-Starts mit ihrer ersten Empfehlung — Grundlage der Bündel-Regel.
  const startZuordnung: { session: string; abMs: number; startMs: number; start: any }[] = []
  for (const r of nachZeit(gueltig.filter(istEmpfehlung))) {
    const t = tsMs(r) as number
    const basis: Aufloesung = {
      ts: String(r.ts), ms: t, event: r.event,
      session_id: typeof r.session_id === "string" ? r.session_id : null,
      gate_id: typeof r.gate_id === "string" ? r.gate_id : null,
      task: String(r.task ?? "").slice(0, 80),
      status: "offen",
    }
    if (r.injiziert !== true) {
      ergebnis.push({ ...basis, status: "nicht_zugestellt" })
      continue
    }
    if (internerAuftrag(String(r.task ?? ""))) {
      ergebnis.push({ ...basis, status: "fehlklassifiziert" })
      continue
    }
    const sessions = new Set<string>()
    if (basis.session_id) sessions.add(basis.session_id)
    const kindSession = basis.gate_id ? kind.get(basis.gate_id) : undefined
    if (kindSession) sessions.add(kindSession)
    const imFenster = (e: any) => {
      const s = tsMs(e) as number
      return s > t && s - t <= fensterMs // strikt danach (O6-Edge: gleicher ts zählt nicht)
    }
    const finde = (xs: any[], passt: (e: any) => boolean) => xs.find((e) => e !== r && !verbraucht.has(e) && imFenster(e) && passt(e))

    const kandidaten = [
      finde(starts, (e) => sessions.has(e.session_id) || (basis.gate_id !== null && e.task_ref === basis.gate_id)),
      // Stufe 1: bei einer task-Empfehlung zählt nur ein subagent-Aufruf AUS dem Kind
      // (der Aufruf selbst ist die Empfehlung), bei einer Nutzer-Empfehlung jeder der Session.
      finde(subagent, (e) => (r.event === "task" ? e.session_id === kindSession : sessions.has(e.session_id))),
      finde(abweichungen, (e) => sessions.has(e.session_id)),
    ]
    // Der früheste Beleg gewinnt (bei Gleichstand Start vor Stufe 1 vor Abweichung).
    const beleg = nachZeit(kandidaten.filter(Boolean))[0]
    if (beleg) verbraucht.add(beleg)
    const art = beleg ? kandidaten.indexOf(beleg) : -1
    if (art === 0) {
      ergebnis.push({ ...basis, status: "befolgt_fabrik", beleg_ts: beleg.ts })
      if (basis.session_id) startZuordnung.push({ session: basis.session_id, abMs: t, startMs: tsMs(beleg) as number, start: beleg })
      continue
    }
    if (art === 1) {
      ergebnis.push({ ...basis, status: "befolgt_subagent", beleg_ts: beleg.ts })
      continue
    }
    if (art === 2) {
      ergebnis.push({ ...basis, status: "abgewichen_begruendet", beleg_ts: beleg.ts, grund: String(beleg.grund ?? "") })
      continue
    }
    const buendel = r.event === "user_prompt" && basis.session_id ? startZuordnung.find((z) => z.session === basis.session_id && z.abMs < t && t < z.startMs) : undefined
    if (buendel) ergebnis.push({ ...basis, status: "befolgt_fabrik", beleg_ts: buendel.start.ts, gebuendelt: true })
    else ergebnis.push({ ...basis, status: now - t < fensterMs ? "offen" : "abgewichen_ohne_begruendung" })
  }
  return ergebnis
}

export interface FensterQuote {
  name: string
  empfehlungen: number
  nicht_zugestellt: number
  /** Neubewertung: interner Auftrag (heute DIREKT) — außerhalb der Quote */
  fehlklassifiziert: number
  offen: number
  aufgeloest: number
  befolgt_fabrik: number
  befolgt_subagent: number
  begruendet: number
  ohne_begruendung: number
  /** (befolgt + begründet) / aufgelöst in %, null ohne aufgelöste Empfehlung */
  quote: number | null
  /** nur Stufe 2 (Fabrik-Start) / aufgelöst in % */
  fabrikQuote: number | null
}

export function quoteFuer(name: string, a: Aufloesung[]): FensterQuote {
  const n = (s: Ausgang) => a.filter((x) => x.status === s).length
  const aufgeloest = a.length - n("nicht_zugestellt") - n("offen") - n("fehlklassifiziert")
  const treu = n("befolgt_fabrik") + n("befolgt_subagent") + n("abgewichen_begruendet")
  const pct = (z: number) => (aufgeloest > 0 ? +((z / aufgeloest) * 100).toFixed(1) : null)
  return {
    name,
    empfehlungen: a.length,
    nicht_zugestellt: n("nicht_zugestellt"),
    fehlklassifiziert: n("fehlklassifiziert"),
    offen: n("offen"),
    aufgeloest,
    befolgt_fabrik: n("befolgt_fabrik"),
    befolgt_subagent: n("befolgt_subagent"),
    begruendet: n("abgewichen_begruendet"),
    ohne_begruendung: n("abgewichen_ohne_begruendung"),
    quote: pct(treu),
    fabrikQuote: pct(n("befolgt_fabrik")),
  }
}

export function regeltreueJeFenster(a: Aufloesung[], now: number, ab = K7_MS): FensterQuote[] {
  return FENSTER.map((f) =>
    quoteFuer(f.name, a.filter((x) => x.ms <= now && now - x.ms <= f.ms && (f.name !== "gesamt" || x.ms >= ab))),
  )
}

/** Empfehlungen vor dem K7-Stichtag — „vor K7 (nicht bewertbar)". */
export function vorK7(a: Aufloesung[], ab = K7_MS): number {
  return a.filter((x) => x.ms < ab).length
}

/** „1/2 (50 %)" bzw. „keine aufgelöste Empfehlung". */
export function quoteText(q: FensterQuote): string {
  if (q.quote === null) return "keine aufgelöste Empfehlung"
  const treu = q.befolgt_fabrik + q.befolgt_subagent + q.begruendet
  return `${treu}/${q.aufgeloest} (${q.quote} %)`
}
