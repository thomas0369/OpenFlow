/**
 * K2o (18.10.2026): „alle/allen/aller <Wort>" trägt das Signal fan-out-quantor.
 * Anlass: Ledger 13.–18.10. — kurze Folge-Aufträge wie „schließe alle offenen
 * punkte" liefen ohne Signal, der STUFE-1-Hinweis der Plugins kam nie an.
 * Gegen 241 Ledger-Prompts gemessen: 0 geänderte Entscheidungen, nur Signale.
 * „alles" bleibt bewusst draußen (gemessen meist Rückfrage: „alles fertig?").
 */

import { describe, expect, test } from "bun:test"
import { classify } from "./of-gate"

const MIT_SIGNAL = [
  "schließe alle offenen punkte",
  "prüf das auch in allen anderen workers",
  "Arbeite alle diese fälle im detail auf damit wir korrelationen finden.",
  "Prüf die Tool-Beschreibungen aller Worker",
]

const OHNE_SIGNAL = [
  "alles fertig und es läuft perfekt?",
  "allerdings ist das noch offen",
  "das reicht allemal",
  "alles klar, mach weiter",
]

describe("K2o: alle/allen/aller als Fan-out-Quantor", () => {
  for (const t of MIT_SIGNAL)
    test(`Signal: ${t}`, () => {
      expect(classify(t).signale).toContain("fan-out-quantor")
    })
  for (const t of OHNE_SIGNAL)
    test(`kein Quantor: ${t}`, () => {
      expect(classify(t).signale).not.toContain("fan-out-quantor")
    })
})
