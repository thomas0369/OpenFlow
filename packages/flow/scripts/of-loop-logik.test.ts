/**
 * Tests für of-loop-logik.ts — die reinen Loop-Regeln.
 *
 * T1-T4: computeI3 (O6 — I3-Messkorrektur)
 * T5:    dedupAlerts (O1 — Alert-Dedup)
 * dazu:  gapLueckeMin (O5), letzterTick (O4 — Herzschlag-/State-Fallback)
 */
import { describe, test, expect } from "bun:test"
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs"
import { bootInfo, computeI3, dedupAlerts, gapLueckeMin, gapMarker, letzterTick, type AlertLike, type AlertDedupEintrag } from "./of-loop-logik.ts"

const MIN = 60_000
const TAG = 24 * 3_600_000
const NOW = Date.parse("2026-10-17T12:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()

// Seit 23.10.2026 (Defekt 2) löst of-regeltreue.ts auf: ein Kandidat ist eine
// ZUGESTELLTE Empfehlung (injiziert:true), befolgt wird er in DERSELBEN
// Session binnen 30 min. Die Helfer tragen deshalb Session und Zustellung;
// die Erwartungen der Fälle T1–T4 bleiben unverändert.
const kandidat = (ts: number) => ({ event: "user_prompt", entscheidung: "FABRIK", injiziert: true, session_id: "s", ts: iso(ts) })
const taskFanout = (ts: number) => ({ event: "task", entscheidung: "FABRIK", ts: iso(ts) })
const run = (ts: number, monitoring = false) => ({
  event: "fabrik_run", session_id: "s", command: monitoring ? "bash of-run.sh --scorecard" : "bash of-run.sh auto-orchestrator x", ts: iso(ts),
  ...(monitoring ? { monitoring: true } : {}),
})

describe("computeI3 (O6: 7-Tage-Fenster, user_prompt-Kandidaten, non-monitoring-Runs)", () => {
  test("T1: 3 Kandidaten + 2 passende non-monitoring-Runs → Quote 2/3, kein Alert", () => {
    const entries = [
      kandidat(NOW - 3 * TAG),
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
      run(NOW - 3 * TAG + 10 * MIN),
      run(NOW - 2 * TAG + 10 * MIN),
    ]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.fabrikAufrufe).toBe(2)
    expect(e.matches).toBe(2)
    expect(e.bewertet).toBe(true)
    expect(e.alert).toBe(false) // 2/3 ≈ 67 % >= 50 %
  })

  test("T2: monitoring:true-Runs (--loop-check/ls/--scorecard) zählen nicht", () => {
    const entries = [
      kandidat(NOW - 3 * TAG),
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
      run(NOW - 1 * TAG + 10 * MIN, true),
      run(NOW - 1 * TAG + 20 * MIN, true),
      run(NOW - 1 * TAG + 30 * MIN, true),
    ]
    const e = computeI3(entries, NOW)
    expect(e.fabrikAufrufe).toBe(0)
    expect(e.matches).toBe(0)
    expect(e.alert).toBe(true) // 0/3 < 50 %
  })

  test("T3: Kandidat älter als 7 Tage fällt aus dem Fenster → n<3, nicht bewertet", () => {
    const entries = [
      kandidat(NOW - 8 * TAG), // aus dem Fenster
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
      run(NOW - 2 * TAG + 10 * MIN),
      run(NOW - 1 * TAG + 10 * MIN),
      run(NOW - 8 * TAG + 10 * MIN),
    ]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(2)
    expect(e.bewertet).toBe(false)
    expect(e.alert).toBe(false)
  })

  test("T4: Run VOR dem Kandidaten matcht nicht", () => {
    const entries = [
      run(NOW - 4 * TAG), // liegt vor allen Kandidaten
      kandidat(NOW - 3 * TAG),
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
    ]
    const e = computeI3(entries, NOW)
    expect(e.matches).toBe(0)
    expect(e.alert).toBe(true)
  })

  test("ein Run matcht höchstens einen Kandidaten", () => {
    const entries = [kandidat(NOW - 3 * TAG), kandidat(NOW - 2 * TAG), kandidat(NOW - 1 * TAG), run(NOW - 3 * TAG + 10 * MIN)]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.matches).toBe(1)
  })

  test("task|FABRIK sind Fan-out-Signale (Kontext fanouts), keine Kandidaten", () => {
    const entries = [taskFanout(NOW - 1 * TAG), taskFanout(NOW - 2 * TAG), kandidat(NOW - 3 * TAG), kandidat(NOW - 2 * TAG), kandidat(NOW - 1 * TAG)]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.fanouts).toBe(2)
  })

  test("Edge: Run-ts exakt GLEICH Kandidat-ts matcht NICHT (strikt danach, runs[j] <= k)", () => {
    const entries = [
      run(NOW - 3 * TAG + MIN), // strikt nach k1
      run(NOW - 2 * TAG), // exakt gleich k2: zählt nicht
      run(NOW - 1 * TAG + MIN), // strikt nach k3
      kandidat(NOW - 3 * TAG),
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
    ]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.matches).toBe(2) // der exakt-gleiche Run matcht k2 nicht
  })

  test("Edge: Kandidat exakt am Fensterrand (now - 7d) zählt NOCH (>=)", () => {
    const entries = [
      kandidat(NOW - 7 * TAG), // exakt Fensterrand
      kandidat(NOW - 2 * TAG),
      kandidat(NOW - 1 * TAG),
    ]
    const e = computeI3(entries, NOW)
    expect(e.kandidaten).toBe(3)
    expect(e.bewertet).toBe(true)
  })
})

describe("dedupAlerts (O1: neu / stumm / Bestätigung nach 24 h)", () => {
  const alert = (wert: string, tsMs: number): AlertLike => ({ ts: iso(tsMs), invariante: "I3-regeltreue", wert, schwelle: ">=50% ab n>=3" })

  test("T5a: erster Alert → art neu, gemeldet, erstes_ts gesetzt", () => {
    const r = dedupAlerts([alert("0/3", NOW)], {}, NOW)
    expect(r.melden).toHaveLength(1)
    expect(r.melden[0].art).toBe("neu")
    expect(r.melden[0].erstes_ts).toBe(iso(NOW))
    expect(r.zustand["I3-regeltreue"].wert).toBe("0/3")
  })

  test("T5b: 1 h später unverändert → stumm (keine Meldung — kein 13x-in-1h mehr)", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 3_600_000), letzte_bestaetigung: iso(NOW - 3_600_000) },
    }
    const r = dedupAlerts([alert("0/3", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(0)
    expect(r.zustand["I3-regeltreue"].letzte_bestaetigung).toBe(iso(NOW - 3_600_000))
  })

  test("T5c: 25 h später unverändert → art bestätigt („besteht seit“), gemeldet", () => {
    const vor = NOW - 25 * 3_600_000
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(vor), letzte_bestaetigung: iso(vor) },
    }
    const r = dedupAlerts([alert("0/3", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(1)
    expect(r.melden[0].art).toBe("bestaetigt")
    expect(r.melden[0].erstes_ts).toBe(iso(vor)) // ursprünglicher Beginn bleibt
    expect(r.zustand["I3-regeltreue"].letzte_bestaetigung).toBe(iso(NOW))
  })

  test("T5d: Wert ändert sich (Zähler 0/3 → 1/4), Alert bleibt ROT → stumm (keine Drossel-Umgehung)", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 5 * TAG), letzte_bestaetigung: iso(NOW - 3_600_000) },
    }
    const r = dedupAlerts([alert("1/4", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(0)
    expect(r.zustand["I3-regeltreue"].wert).toBe("1/4") // Wert geführt
    expect(r.zustand["I3-regeltreue"].erstes_ts).toBe(iso(NOW - 5 * TAG)) // Beginn bleibt
    expect(r.zustand["I3-regeltreue"].letzte_bestaetigung).toBe(iso(NOW - 3_600_000)) // Drossel läuft weiter
  })

  test("rot→grün→rot: verschwundener Alert kehrt zurück → art neu (Zustandswechsel)", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 2 * TAG), letzte_bestaetigung: iso(NOW - 1 * TAG) },
    }
    const weg = dedupAlerts([], alt, NOW) // grün: fällt aus dem Zustand
    expect(weg.melden).toHaveLength(0)
    expect(weg.zustand["I3-regeltreue"]).toBeUndefined()
    const zurueck = dedupAlerts([alert("0/3", NOW)], weg.zustand, NOW) // wieder rot → neu
    expect(zurueck.melden).toHaveLength(1)
    expect(zurueck.melden[0].art).toBe("neu")
    expect(zurueck.melden[0].erstes_ts).toBe(iso(NOW))
  })

  test("unparsebare letzte_bestaetigung (NaN) → wie nie bestätigt: art neu, nicht Dauerstille", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 2 * TAG), letzte_bestaetigung: "kein-datum" },
    }
    const r = dedupAlerts([alert("0/3", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(1)
    expect(r.melden[0].art).toBe("neu")
    expect(r.zustand["I3-regeltreue"].letzte_bestaetigung).toBe(iso(NOW))
  })

  test("letzte_bestaetigung in der Zukunft (Uhr-Rücklauf) → wie nie bestätigt: art neu", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 2 * TAG), letzte_bestaetigung: iso(NOW + 3_600_000) },
    }
    const r = dedupAlerts([alert("0/3", NOW)], alt, NOW)
    expect(r.melden).toHaveLength(1)
    expect(r.melden[0].art).toBe("neu")
    expect(r.zustand["I3-regeltreue"].letzte_bestaetigung).toBe(iso(NOW))
  })

  test("nicht mehr aktiver Alert fällt aus dem Zustand", () => {
    const alt: Record<string, AlertDedupEintrag> = {
      "I3-regeltreue": { wert: "0/3", erstes_ts: iso(NOW - 3_600_000), letzte_bestaetigung: iso(NOW - 3_600_000) },
    }
    const r = dedupAlerts([], alt, NOW)
    expect(r.melden).toHaveLength(0)
    expect(r.zustand["I3-regeltreue"]).toBeUndefined()
  })
})

describe("gapLueckeMin (O5: Schwelle 15 min)", () => {
  test("unter 15 min → null (kein Marker)", () => {
    expect(gapLueckeMin(NOW - 10 * MIN, NOW)).toBeNull()
    expect(gapLueckeMin(NOW - 15 * MIN, NOW)).toBeNull() // exakt Schwelle: keine Lücke
  })
  test("über 15 min → Lücke in gerundeten Minuten", () => {
    expect(gapLueckeMin(NOW - 20 * MIN, NOW)).toBe(20)
    expect(gapLueckeMin(NOW - 20 * 3_600_000, NOW)).toBe(1200) // ~20 h Stillstand (15.10.)
  })
})

describe("letzterTick (O4: Herzschlag bevorzugt, State-Fallback für Altdaten)", () => {
  const dir = "/tmp/opencode/of-loop-logik-test"
  const hb = `${dir}/heartbeat`
  const state = `${dir}/state.jsonl`

  test("Herzschlag existiert → dessen ts, Quelle heartbeat", () => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(hb, JSON.stringify({ ts: iso(NOW - 4 * MIN), gereapt: 0, geheilt_n: 0, alerts_n: 0 }) + "\n")
    writeFileSync(state, JSON.stringify({ ts: iso(NOW - 30 * TAG) }) + "\n") // alter State darf nicht gewinnen
    const t = letzterTick(hb, state, existsSync, readFileSync)
    expect(t?.quelle).toBe("heartbeat")
    expect(t?.ms).toBe(NOW - 4 * MIN)
  })

  test("Herzschlag fehlt → letzte ts aus State (Altdaten-Kompatibilität)", () => {
    rmSync(hb, { force: true })
    const t = letzterTick(hb, state, existsSync, readFileSync)
    expect(t?.quelle).toBe("state")
    expect(t?.ms).toBe(NOW - 30 * TAG)
  })

  test("beide fehlen → null (Loop lief noch nie)", () => {
    rmSync(state, { force: true })
    const t = letzterTick(hb, state, existsSync, readFileSync)
    expect(t).toBeNull()
  })
})

describe("T-06 (B2) gapMarker — boot_id macht einen VM-Neustart sichtbar", () => {
  const jetzt = Date.parse("2026-10-25T22:05:01Z")
  const vorher = Date.parse("2026-10-25T10:55:00Z")
  const boot = { boot_id: "neu-1111", boot_ts: "2026-10-25T22:02:49.000Z" }

  test("Gap mit anderer boot_id als der letzte Herzschlag → ursache vm_neustart", () => {
    const m = gapMarker({ ms: vorher, boot_id: "alt-0000" }, boot, jetzt)
    expect(m).toMatchObject({ event: "loop_gap", luecke_min: 670, boot_id: "neu-1111", boot_ts: boot.boot_ts, boot_id_vorher: "alt-0000", ursache: "vm_neustart" })
  })

  test("gleiche boot_id → Gap ohne Ursache (Loop stand, System lief)", () => {
    const m = gapMarker({ ms: vorher, boot_id: "neu-1111" }, boot, jetzt)
    expect(m?.luecke_min).toBe(670)
    expect(m?.ursache).toBeUndefined()
  })

  test("Herzschlag ohne boot_id (vor B2) → keine Ursache geraten", () => {
    expect(gapMarker({ ms: vorher }, boot, jetzt)?.ursache).toBeUndefined()
  })

  test("unter der Schwelle → kein Marker, auch bei neuer boot_id", () => {
    expect(gapMarker({ ms: jetzt - 10 * 60_000, boot_id: "alt" }, boot, jetzt)).toBeNull()
  })

  test("letzterTick liest boot_id aus dem Herzschlag", () => {
    const hb = JSON.stringify({ ts: "2026-10-25T10:55:00Z", boot_id: "alt-0000" })
    expect(letzterTick("/hb", "/st", (p) => p === "/hb", () => hb)).toEqual({ ms: vorher, quelle: "heartbeat", boot_id: "alt-0000" })
  })

  test("bootInfo: boot_id aus /proc, boot_ts aus btime; ohne /proc leer", () => {
    const proc: Record<string, string> = {
      "/proc/sys/kernel/random/boot_id": "debffb2f-51ac\n",
      "/proc/stat": "cpu  1 2 3\nbtime 1761429769\nprocesses 5\n",
    }
    const lies = (p: string) => {
      const inhalt = proc[p]
      if (inhalt === undefined) throw new Error("ENOENT")
      return inhalt
    }
    expect(bootInfo(lies)).toEqual({ boot_id: "debffb2f-51ac", boot_ts: "2025-10-25T22:02:49.000Z" })
    expect(bootInfo(() => { throw new Error("ENOENT") })).toEqual({})
  })
})
