/**
 * K2p (24.10.2026): Ergebnisauftrag des Nutzers → Fabrik. In-process gegen
 * `classify`/`entscheide`, kein Netz (das LLM ist gemockt und darf bei einem
 * Ergebnisauftrag gar nicht gefragt werden).
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classify, entscheide, ergebnisAuftrag } from "./of-gate"
import { ERGEBNIS_NUTZER, NEIN_NUTZER } from "./gate-korpus-k2p"
import * as korpus from "./gate-korpus"
import { SUBAGENT_AUFTRAEGE, PRUEFFRAGEN } from "./gate-korpus-subagent"

const TMP = mkdtempSync(join(tmpdir(), "k2p-"))
const KEY = join(TMP, "key")
writeFileSync(KEY, "test-schluessel")
function zaehler(antwort: string) {
  const bodies: string[] = []
  const f = (async (_u: any, init: any) => {
    bodies.push(String(init?.body ?? ""))
    return new Response(JSON.stringify({ choices: [{ message: { content: antwort } }] }), { status: 200 })
  }) as unknown as typeof fetch
  return { f, bodies }
}

describe("K2p — Ergebnisauftrag des Nutzers geht an die Fabrik", () => {
  test("Korpus-Umfang: ≥ 15 Ja-Fälle, ≥ 10 Gegenfälle", () => {
    expect(ERGEBNIS_NUTZER.length).toBeGreaterThanOrEqual(15)
    expect(NEIN_NUTZER.length).toBeGreaterThanOrEqual(10)
  })

  test.each(ERGEBNIS_NUTZER)("FABRIK: %s", (text, soll) => {
    const v: any = classify(text, { herkunft: "nutzer" })
    expect(soll).toBe(true)
    expect(v.entscheidung).toBe("FABRIK")
    expect(v.injizieren).toBe(true)
    expect(["ergebnisauftrag", "wortregel"]).toContain(v.quelle)
    expect(["analyse", "recherche", "vergleich", "bericht", "lage"]).toContain(v.ergebnis)
  })

  test.each(NEIN_NUTZER)("kein Pflichtweg: %s", (text, soll) => {
    const v: any = classify(text, { herkunft: "nutzer" })
    expect(soll).toBe(false)
    expect(v.injizieren).toBe(false)
    expect(v.quelle).not.toBe("ergebnisauftrag")
  })

  test.each(ERGEBNIS_NUTZER)("entscheide (Nutzer-Weg) fragt das LLM nicht: %s", async (text) => {
    const { f, bodies } = zaehler("NEIN")
    const v: any = await entscheide(text, { fetch: f, keyFile: KEY })
    expect(v.injizieren).toBe(true)
    expect(bodies).toHaveLength(0)
  })
})

describe("K2p — gilt NUR für den Nutzer-Weg", () => {
  test.each(ERGEBNIS_NUTZER)("Standard-Weg (Subagent/Messung) unverändert: %s", (text) => {
    const v: any = classify(text)
    expect(v.quelle).not.toBe("ergebnisauftrag")
    expect(v.ergebnis).toBeUndefined()
  })

  test("Subagent-Aufträge und Prüffragen bleiben auch im Nutzer-Weg ohne K2p", () => {
    for (const [text] of [...SUBAGENT_AUFTRAEGE, ...PRUEFFRAGEN]) {
      const v: any = classify(text, { herkunft: "nutzer" })
      expect({ text, quelle: v.quelle }).not.toEqual({ text, quelle: "ergebnisauftrag" })
    }
  })

  test("Kind-Sitzung (#14, --kind) schlägt K2p — auch im Nutzer-Weg und in entscheide", async () => {
    const v: any = classify("analysiere den status von wortwert", { herkunft: "nutzer", kind: true })
    expect(v).toMatchObject({ quelle: "kind", injizieren: false })
    const { f, bodies } = zaehler("JA")
    const e: any = await entscheide("analysiere den status von wortwert", { fetch: f, keyFile: KEY, kind: true })
    expect(e).toMatchObject({ quelle: "kind", injizieren: false })
    expect(bodies).toHaveLength(0)
  })

  test("Lesender Prüf-Agent (#14, --agent explore) schlägt K2p", () => {
    const v: any = classify("Vergleiche Hetzner und Netcup für unseren VPS.", { herkunft: "nutzer", agent: "explore" })
    expect(v).toMatchObject({ quelle: "pruef_agent", entscheidung: "DIREKT", injizieren: false })
  })

  test("Präfix direkt: schlägt K2p", () => {
    const v: any = classify("direkt: analysiere den status von wortwert", { herkunft: "nutzer" })
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.injizieren).toBe(false)
  })

  test("Nein-Signal schlägt K2p (Deploy)", () => {
    const v: any = classify("Analysiere den Stand von dharma und deploye danach.", { herkunft: "nutzer" })
    expect(v.entscheidung).toBe("DIREKT")
    expect(v.quelle).toBe("nein_signal")
  })

  test("Wortregel-FABRIK eines Nutzers trägt die Ergebnis-Art, Quelle bleibt wortregel", () => {
    const v: any = classify("Analysiere die Testabdeckung von rille, merkspur und dharma und schreib je Paket einen kurzen Bericht.", { herkunft: "nutzer" })
    expect(v.quelle).toBe("wortregel")
    expect(v.ergebnis).toBe("analyse")
  })

  test("Erklärfragen der Bestandskorpora kippen im Nutzer-Weg nicht", () => {
    for (const name of ["EIGENE_FRAGEN", "HOLDOUT_FRAGEN"] as const) {
      for (const [text] of (korpus as any)[name] as korpus.Fall[]) {
        expect({ text, inj: classify(text, { herkunft: "nutzer" }).injizieren }).toEqual({ text, inj: false })
      }
    }
  })
})

describe("K2p — Gegenproben (Sabotage einzelner Ausschlüsse)", () => {
  test("ohne Ergebnis-Signal kein Ergebnisauftrag", () => {
    expect(ergebnisAuftrag("analysiere den status von wortwert", [])).toBeNull()
    expect(ergebnisAuftrag("analysiere den status von wortwert", ["analyse"])).toBe("analyse")
  })
  test("Implementierung kippt den Fall — mit und ohne Fix-Verb", () => {
    expect(ergebnisAuftrag("Analysiere den Fehler in src/router.ts.", ["analyse"])).toBe("analyse")
    expect(ergebnisAuftrag("Analysiere den Fehler in src/router.ts und behebe ihn.", ["analyse"])).toBeNull()
  })
  test("Kind-Marker kippt den Fall", () => {
    expect(ergebnisAuftrag("analysiere die restlichen Fehlschläge.", ["analyse"])).toBe("analyse")
    expect(ergebnisAuftrag("Fortsetzung: analysiere die restlichen Fehlschläge.", ["analyse"])).toBeNull()
  })
  test("ein großes ‚Fix‘ mitten im Satz ist ein Substantiv, keine Implementierung", () => {
    expect(ergebnisAuftrag("Analysiere, warum der Fix in dharma nicht greift.", ["analyse"])).toBe("analyse")
  })
})
