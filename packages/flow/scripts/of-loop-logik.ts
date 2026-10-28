/**
 * of-loop-logik — die reinen Regeln des Loops (eine Stelle, getestet),
 * getrennt vom Laufzeit-Skript of-loop.ts (das beim Import bereits einen
 * Zyklus startet und daher für Unit-Tests unbrauchbar ist).
 *
 * Enthalten:
 *   - computeI3     — Regeltreue-Messung, korrigiert (O6)
 *   - dedupAlerts   — Alert-Dedup: neu / stumm / Bestätigung nach 24 h (O1)
 *   - gapLueckeMin  — Stillstand-Schwelle für den Gap-Marker (O5)
 *   - letzterTick   — letzte Loop-Aktivität: Herzschlag vor State-Datei (O4/O5)
 *   - offeneAlerts  — was die Sonde als offen zählt: Aktiv-Zustand statt Historie (B1)
 *   - teileAlerts   — Quittung: welche Zeilen ins Archiv wandern (B1, --loop-ack)
 *   - gapMarker     — Gap-Zeile mit boot_id/boot_ts, Ursache vm_neustart (B2)
 */

import { echteStarts } from "./of-fabrik-aufruf.ts"
import { loeseAuf, quoteFuer } from "./of-regeltreue.ts"

export const I3_FENSTER_MS = 7 * 24 * 3_600_000
export const BESTAETIGUNG_MS = 24 * 3_600_000
export const GAP_SCHWELLE_MIN = 15
/** Ohne Aktiv-Zustand zählt die Sonde die Alert-Zeilen dieses Fensters (B1). */
export const ALERT_FALLBACK_MS = 24 * 3_600_000
/**
 * Alerts, die ein EREIGNIS melden statt eines Zustands: I5-fehlerserie steht
 * genau einen Tick im Aktiv-Zustand (der Marker loop.alarm am Ursprung
 * verhindert die Wiederholung) — gemessen am Zustand wäre die Sonde fünf
 * Minuten später wieder grün, obwohl die Heilung gestoppt bleibt. Sie bleiben
 * offen, bis sie quittiert werden (of-run.sh --loop-ack).
 */
export const EREIGNIS_ALERTS: ReadonlySet<string> = new Set(["I5-fehlerserie"])

/**
 * computeI3 — Regeltreue-Messung (O6, korrigiert am 17.10.2026).
 *
 * Definition (seit 23.10.2026, Defekt 2 — of-regeltreue.ts):
 *   Kandidaten     = ZUGESTELLTE FABRIK-Empfehlungen (user_prompt UND task mit
 *                    injiziert=true) im 7-Tage-Fenster, deren 30-min-Frist
 *                    abgelaufen ist (aufgelöst). Nie zugestellte task-Zeilen
 *                    (bis 23.10. alle) zählen nicht — niemand hat sie gesehen.
 *   Treffer        = befolgt (Fabrik-Start ODER subagent-Aufruf derselben
 *                    Session/Kind-Session) ODER begründet abgewichen
 *                    (event=abweichung). Belege 1:1 verbraucht.
 *   Fabrik-Aufrufe = echte Starts im Fenster (of-fabrik-aufruf.ts), Kontext.
 *   Quote          = Treffer / Kandidaten; Alert ab Kandidaten >= 3 und
 *                    Quote < 50 %.
 *
 * Forensik 16.10.2026 (gate-ledger.jsonl + of-loop-state.jsonl:5452-5464):
 *   Alt falsch gemessen: 11 fabrik_run (davon 3 monitoring:true —
 *   --loop-check/ls/--scorecard, keine echten Runs) zu 24 Kandidaten
 *   event=task — 11/24 = 46 % < 50 % → 13x identischer Alert in 1 h
 *   (21:20-22:20Z). Beide Seiten des Bruchs waren verkehrt: event=task|FABRIK
 *   sind REGEL-4-Stufe-1-Fan-outs aus der Sitzung (87,5 % bewusst ohne
 *   Fabrik-Run), keine Empfehlungen an den Nutzer; die echten
 *   user_prompt|FABRIK-Aufträge (34 im Ledger, mehrere mündeten real in
 *   Runs) wurden nicht gezählt. Das GESAMTE Ledger ohne Fenster bestrafte
 *   zudem für lange zurückliegende, bereits erklärte Abweichungen.
 *
 * task|FABRIK-Einträge zählen seit dem 23.10. als Kandidaten, sobald sie
 * zugestellt sind (Defekt 1); `fanouts` bleibt ihre Gesamtzahl als Kontext.
 */
export interface I3Ergebnis {
  kandidaten: number
  fabrikAufrufe: number
  matches: number
  fanouts: number
  bewertet: boolean
  alert: boolean
  /** Regeltreue-Quote in % (null ohne aufgelöste Empfehlung) */
  quote: number | null
}

function tsMs(e: any): number | null {
  const t = typeof e?.ts === "number" ? e.ts : Date.parse(String(e?.ts ?? ""))
  return Number.isFinite(t) ? t : null
}

export function computeI3(entries: any[], now: number): I3Ergebnis {
  const fensterStart = now - I3_FENSTER_MS
  const imFenster = (t: number) => t >= fensterStart && t <= now

  // Defekt 2 (23.10.2026): Kandidaten und Treffer kommen aus der EINEN
  // Auflösung (of-regeltreue.ts) — zugestellte FABRIK-Empfehlungen (user_prompt
  // UND task) im Fenster, deren 30-min-Frist abgelaufen ist; Treffer =
  // befolgt (Stufe 1/2) oder begründet abgewichen. Vorher: jeder Run irgendwo
  // nach irgendeiner Empfehlung, ohne Session-Bezug und ohne Begründung.
  const auf = loeseAuf(entries, now).filter((a) => imFenster(a.ms))
  const q = quoteFuer("7 Tage", auf)

  // Defekt 3: nur echte Starts (of-fabrik-aufruf.ts).
  const runs = echteStarts(entries)
    .map((e) => tsMs(e))
    .filter((t): t is number => t !== null && imFenster(t))

  // Fan-out-Signale (task|FABRIK): Kontext für den Alert-Text
  const fanouts = entries.filter((e) => {
    if (e?.event !== "task" || e?.entscheidung !== "FABRIK") return false
    const t = tsMs(e)
    return t !== null && imFenster(t)
  }).length

  const matches = q.befolgt_fabrik + q.befolgt_subagent + q.begruendet
  const bewertet = q.aufgeloest >= 3
  const alert = bewertet && matches / q.aufgeloest < 0.5
  return { kandidaten: q.aufgeloest, fabrikAufrufe: runs.length, matches, fanouts, bewertet, alert, quote: q.quote }
}

/**
 * dedupAlerts — aktive Alerts nur melden, wenn es Neues gibt (O1; Schlüssel
 * nur invariante, Zustandswechsel-Logik seit 17.10.2026).
 *
 *   - invariante nicht im Zustand (Zustandswechsel grün→rot: der Alert war
 *     weg und kommt zurück) → art "neu", erstes_ts startet neu, gemeldet.
 *   - im Zustand (bleibt ROT): Wert-Änderungen lösen KEINE Meldung aus —
 *     der I3-wert enthält Zähler (gemessen: 24→25-Wechsel innerhalb 90 min),
 *     sonst umging jede Zähleränderung die 24-h-Drossel. Der Wert wird im
 *     Zustand geführt, erstes_ts und letzte_bestaetigung bleiben.
 *   - innerhalb 24 h seit letzter Meldung → stumm (kein Tick-/State-Eintrag,
 *     keine Wiederholung wie bei den 13x in 1 h).
 *   - >= 24 h seit letzter Meldung → art "bestaetigt" („besteht seit"),
 *     wird einmal gemeldet, dann wieder stumm.
 *   - unparsebare oder zukünftige letzte_bestaetigung (NaN, Uhr-Rücklauf)
 *     gilt als „nie bestätigt" → art "neu", nicht Dauerstille.
 *   - Alert nicht mehr aktiv (rot→grün) → Eintrag fällt aus dem Zustand
 *     (kommt er später zurück, gilt er wieder als neu).
 *
 * Rein: gibt gemeldete KOPIEN zurück, mutiert die Eingaben nicht. Der
 * zurückgegebene Zustand ersetzt den bisherigen als Ganzes.
 */
export interface AlertLike {
  ts: string
  invariante: string
  wert: string
  schwelle: string
  erstes_ts?: string
  art?: "neu" | "bestaetigt"
}

export interface AlertDedupEintrag {
  wert: string
  erstes_ts: string
  letzte_bestaetigung: string
}

export function dedupAlerts(
  aktive: AlertLike[],
  zustandAlt: Record<string, AlertDedupEintrag>,
  now: number,
  bestaetigungAbstandMs: number = BESTAETIGUNG_MS,
): { melden: AlertLike[]; zustand: Record<string, AlertDedupEintrag> } {
  const melden: AlertLike[] = []
  const zustand: Record<string, AlertDedupEintrag> = {}
  for (const a of aktive) {
    const alt = zustandAlt[a.invariante]
    if (!alt) {
      // Zustandswechsel grün→rot: neu
      melden.push({ ...a, erstes_ts: a.ts, art: "neu" })
      zustand[a.invariante] = { wert: a.wert, erstes_ts: a.ts, letzte_bestaetigung: a.ts }
      continue
    }
    const letzte = Date.parse(alt.letzte_bestaetigung)
    // Unparsebar (NaN) oder in der Zukunft (Uhr-Rücklauf) = nie bestätigt:
    // art neu, nicht Dauerstille.
    if (!Number.isFinite(letzte) || letzte > now) {
      melden.push({ ...a, erstes_ts: alt.erstes_ts, art: "neu" })
      zustand[a.invariante] = { wert: a.wert, erstes_ts: alt.erstes_ts, letzte_bestaetigung: new Date(now).toISOString() }
      continue
    }
    if (now - letzte >= bestaetigungAbstandMs) {
      melden.push({ ...a, erstes_ts: alt.erstes_ts, art: "bestaetigt" })
      zustand[a.invariante] = { wert: a.wert, erstes_ts: alt.erstes_ts, letzte_bestaetigung: new Date(now).toISOString() }
    } else {
      // Stumm: Wert (Zähler) wird geführt, Beginn und Drossel bleiben.
      zustand[a.invariante] = { wert: a.wert, erstes_ts: alt.erstes_ts, letzte_bestaetigung: alt.letzte_bestaetigung }
    }
  }
  return { melden, zustand }
}

/**
 * gapLueckeMin — Stillstand seit letzter Loop-Aktivität in ganzen Minuten,
 * oder null, solange die Lücke unter der Schwelle liegt (O5).
 */
export function gapLueckeMin(letzteTickMs: number, now: number): number | null {
  const min = Math.round((now - letzteTickMs) / 60_000)
  return min > GAP_SCHWELLE_MIN ? min : null
}

/**
 * letzterTick — letzte Loop-Aktivität lesen (O4/O5): Herzschlag-Datei
 * bevorzugt (seit O4 der einzige je-Tick-Niederschlag); Fallback letzte
 * ts aus der State-Datei für Altdaten (vor O4 enthielt sie jeden Tick).
 * Beide Pfade fehlen → null (Loop lief noch nie bzw. frische Installation).
 */
export function letzterTick(
  heartbeatPfad: string,
  statePfad: string,
  exists: (p: string) => boolean = () => true,
  read: (p: string) => string,
): { ms: number; quelle: "heartbeat" | "state"; boot_id?: string } | null {
  if (exists(heartbeatPfad)) {
    try {
      const hb = JSON.parse(String(read(heartbeatPfad))) // String(): Buffer-tolerant
      const t = Date.parse(String(hb?.ts ?? ""))
      if (Number.isFinite(t)) return { ms: t, quelle: "heartbeat", ...(typeof hb?.boot_id === "string" ? { boot_id: hb.boot_id } : {}) }
    } catch { /* kaputte Herzschlag-Datei: Fallback */ }
  }
  if (exists(statePfad)) {
    try {
      const zeilen = String(read(statePfad)).trim().split("\n").filter(Boolean)
      for (let i = zeilen.length - 1; i >= 0; i--) {
        try {
          const t = Date.parse(String(JSON.parse(zeilen[i])?.ts ?? ""))
          if (Number.isFinite(t)) return { ms: t, quelle: "state" }
        } catch { /* halbe Zeile: weiter rückwärts */ }
      }
    } catch { /* keine lesbare State-Datei */ }
  }
  return null
}

/**
 * offeneAlerts — was of-loopcheck als offenen Alert zählt (B1, 28.10.2026).
 *
 * Vorher zählte die Sonde jede Zeile von of-loop-alerts.jsonl; nichts entfernte
 * sie je, also blieb die Sonde nach dem ersten Alert für immer ROT (gemessen:
 * eine I3-Zeile vom 16.10., Aktiv-Zustand `{}`, computeI3 bei 70,8 %). Die
 * jsonl ist Historie; offen ist ein Alert, solange seine Invariante im
 * Aktiv-Zustand steht (den dedupAlerts je Tick neu schreibt).
 *
 *   - aktiv !== null: Zeilen, deren invariante im Zustand steht, dazu jede
 *     Ereignis-Zeile (EREIGNIS_ALERTS) bis zur Quittung
 *   - aktiv === null (Datei fehlt/kaputt): konservativ jede Zeile der
 *     letzten 24 h — ein verlorener /tmp-Zustand darf echte Alerts nicht
 *     verschwinden lassen
 *
 * Unparsebare Zeilen zählen nicht (keine Invariante, kein Zeitpunkt).
 */
export function offeneAlerts(
  zeilen: string[],
  aktiv: Record<string, unknown> | null,
  now: number,
  fallbackMs: number = ALERT_FALLBACK_MS,
): AlertLike[] {
  const alerts = zeilen.flatMap((z) => {
    try {
      const a = JSON.parse(z)
      return typeof a?.invariante === "string" ? [a as AlertLike] : []
    } catch {
      return []
    }
  })
  if (aktiv === null) {
    return alerts.filter((a) => {
      const t = Date.parse(String(a.ts ?? ""))
      return Number.isFinite(t) && now - t <= fallbackMs
    })
  }
  return alerts.filter((a) => a.invariante in aktiv || EREIGNIS_ALERTS.has(a.invariante))
}

/**
 * teileAlerts — Quittung (B1, `of-run.sh --loop-ack [invariante]`): Zeilen der
 * Invariante (ohne Angabe: alle) wandern ins Archiv, der Rest bleibt. Leere
 * Zeilen fallen weg; unparsebare bleiben stehen (nichts Unbekanntes löschen).
 */
export function teileAlerts(zeilen: string[], invariante?: string): { bleiben: string[]; archiv: string[] } {
  const bleiben: string[] = []
  const archiv: string[] = []
  for (const z of zeilen.filter((z) => z.trim())) {
    const inv = (() => {
      try {
        return JSON.parse(z)?.invariante
      } catch {
        return undefined
      }
    })()
    const passt = typeof inv === "string" && (invariante === undefined || inv === invariante)
    ;(passt ? archiv : bleiben).push(z)
  }
  return { bleiben, archiv }
}

/** Kennung des laufenden Kernels (B2): boot_id und Startzeit des Systems. */
export interface BootInfo {
  boot_id?: string
  boot_ts?: string
}

/**
 * bootInfo — boot_id aus /proc/sys/kernel/random/boot_id (neu bei jedem
 * Kernel-Start, auch nach einem WSL-VM-Neustart), boot_ts aus `btime` in
 * /proc/stat. Fehlt /proc (kein Linux), bleiben beide Felder leer.
 */
export function bootInfo(read: (p: string) => string): BootInfo {
  const lies = (p: string) => {
    try {
      return String(read(p))
    } catch {
      return undefined
    }
  }
  const id = lies("/proc/sys/kernel/random/boot_id")?.trim()
  const btime = Number(lies("/proc/stat")?.match(/^btime (\d+)$/m)?.[1])
  return {
    ...(id ? { boot_id: id } : {}),
    ...(Number.isFinite(btime) && btime > 0 ? { boot_ts: new Date(btime * 1000).toISOString() } : {}),
  }
}

/**
 * gapMarker — die Gap-Zeile des Loop-Starts (O5, ergänzt B2 28.10.2026), oder
 * null unter der Schwelle. Trägt boot_id/boot_ts des laufenden Systems; trug
 * der letzte Herzschlag eine ANDERE boot_id, lief dazwischen ein neuer Kernel
 * hoch → ursache "vm_neustart" (Anlass: 25.10. 10:55–22:02Z VM aus, die
 * Gap-Zeile sagte nur „670 min"). Ohne boot_id auf einer Seite bleibt die
 * Ursache offen — kein Raten.
 */
export function gapMarker(
  letzter: { ms: number; boot_id?: string },
  boot: BootInfo,
  now: number,
): Record<string, unknown> | null {
  const luecke = gapLueckeMin(letzter.ms, now)
  if (luecke === null) return null
  const neustart = letzter.boot_id !== undefined && boot.boot_id !== undefined && letzter.boot_id !== boot.boot_id
  return {
    event: "loop_gap",
    luecke_min: luecke,
    ts: new Date(now).toISOString(),
    ...boot,
    ...(letzter.boot_id ? { boot_id_vorher: letzter.boot_id } : {}),
    ...(neustart ? { ursache: "vm_neustart" } : {}),
  }
}
