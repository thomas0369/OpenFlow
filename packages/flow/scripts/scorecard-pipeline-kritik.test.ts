/**
 * Die Bar eines PIPELINE-Laufs kommt aus seinen Kritiker-Karten (28.11.2026).
 *
 * Anlass: wissen-video-analyse 07:30 — Kritiker K2 nicht erfuellt, Blocker B1,
 * Scorecard trotzdem `PASS`, weil `log.quality` nur die Orchestrierung setzt.
 */
import { describe, expect, test } from "bun:test"
import { buildScorecard, qualitaetAusKritik } from "./of-ergebnis"

const urteil = (k2: boolean, blocker: boolean) =>
  "Urteil in einem Satz.\n\n```urteil\n" +
  JSON.stringify({
    kriterien: [
      { id: "K1", text: "Datei vorhanden", erfuellt: true, beleg: "ls -l: -rw-r--r-- 73384 x.md" },
      { id: "K2", text: "WortWert echt", erfuellt: k2, beleg: "grep -oE 'mode: …' : 236 passthrough, 26 gematria_batch" },
    ],
    blocker: blocker ? [{ id: "B1", befund: "WortWert-Rueckfall", beleg: "236/262 passthrough" }] : [],
  }) +
  "\n```\n"

const lauf = (kritik?: string, quality?: unknown) => ({
  id: "run-test",
  pipeline: "wissen-video-analyse",
  status: "done",
  started: 1,
  finished: 2,
  nodes: [
    { id: "wva-worker-1", role: "worker-1", status: "done", output: "stored" },
    ...(kritik ? [{ id: "wva-critic", role: "critic", status: "done", output: kritik, agent: { model: "dharma/critic" } }] : []),
  ],
  ...(quality ? { quality } : {}),
})

describe("Pipeline-Lauf: Bar aus dem Kritiker", () => {
  test("Kritiker mit verletztem Kriterium und Blocker → DELIVERED_BELOW_BAR", () => {
    const s = buildScorecard(lauf(urteil(false, true)), 1, [], 1, 3)
    expect(s.verdict).toBe("DELIVERED_BELOW_BAR")
    expect(s.barMet).toBe(false)
    expect(s.blocker).toBeGreaterThanOrEqual(1)
  })

  test("Kritiker bestanden → PASS mit barMet true", () => {
    const s = buildScorecard(lauf(urteil(true, false)), 1, [], 1, 3)
    expect(s.verdict).toBe("PASS")
    expect(s.barMet).toBe(true)
  })

  test("GEGENPROBE: ohne Kritiker-Karte bleibt es beim alten Verhalten (PASS, keine Bar)", () => {
    const s = buildScorecard(lauf(), 1, [], 1, 3)
    expect(s.verdict).toBe("PASS")
    expect(s.barMet).toBeUndefined()
    expect(qualitaetAusKritik(lauf())).toBeUndefined()
  })

  test("Kritiker ohne lesbaren urteil-Block zaehlt nicht als Urteil", () => {
    expect(qualitaetAusKritik(lauf("nur Prosa, kein Block"))).toBeUndefined()
  })

  test("Engine-quality (Gauntlet) hat Vorrang vor der Ableitung", () => {
    const q = { barMet: true, rounds: 2, open: [], criteria: 3, criticModels: [] }
    const s = buildScorecard(lauf(urteil(false, true), q), 1, [], 1, 3)
    expect(s.verdict).toBe("PASS")
    expect(s.runden).toBe(2)
  })
})
