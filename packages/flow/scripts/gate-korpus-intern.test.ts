/**
 * Interne Aufträge (Feldbefund 24.10.2026): Abnahme-Aufträge an lesende
 * Prüf-Agenten und Nachrichten des Hauptfadens in Kind-Sitzungen sind keine
 * Fabrik-Deliverables. Fallsätze: FELD_INTERN in gate-korpus-feldfaelle.ts.
 *
 * Gegenprobe ist Teil der Suite: OHNE Aufruf-Kontext entscheiden dieselben
 * Texte wie vor dem Fix (Abnahme → FABRIK per Wortregel, Kind → per LLM-JA
 * FABRIK). Kontrollwert: jeder FABRIK-Sollfall der Korpora bleibt FABRIK,
 * auch mit einem schreibenden Ziel-Agenten (worker-dev, general).
 *
 * In-process, fetch gemockt — kein Netz. Der CLI-Fall läuft mit leerem HOME
 * (kein Schlüssel) und Temp-Ledger.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classify, entscheide, LESENDE_PRUEFER } from "./of-gate"
import { FELD_FABRIK, FELD_INTERN } from "./gate-korpus-feldfaelle"
import { EIGENE_AUFTRAEGE, HOLDOUT_AUFTRAEGE } from "./gate-korpus"
import { FANOUT_NUTZER } from "./gate-korpus-subagent"

const TMP = mkdtempSync(join(tmpdir(), "of-gate-intern-"))
const KEY = join(TMP, "dharma.key")
writeFileSync(KEY, "test-schluessel\n")

/** LLM-Mock, der immer JA sagt — so urteilte dharma/fast im Feld. */
function jaMock() {
  let aufrufe = 0
  const f = (async () => {
    aufrufe++
    return new Response(JSON.stringify({ choices: [{ message: { content: "JA" } }] }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { f, aufrufe: () => aufrufe }
}

describe("Interne Aufträge — nie FABRIK, nie Injektion", () => {
  test("7 Feldfälle: 5 Abnahme + 2 Kind-Sitzung", () => {
    expect(FELD_INTERN.length).toBe(7)
    expect(FELD_INTERN.filter(([, , k]) => k.agent === "abnahme").length).toBe(5)
    expect(FELD_INTERN.filter(([, , k]) => k.kind === true).length).toBe(2)
  })

  test.each(FELD_INTERN)("classify mit Kontext: %s", (text, soll, kontext) => {
    const r = classify(text, kontext)
    expect(soll).toBe(false)
    expect(r.entscheidung).not.toBe("FABRIK")
    expect(r.injizieren).toBe(false)
    expect(r.quelle).toBe(kontext.kind ? "kind" : "pruef_agent")
  })

  test.each(FELD_INTERN)("entscheide (LLM sagt JA) mit Kontext: %s", async (text, _soll, kontext) => {
    const m = jaMock()
    const r = await entscheide(text, { ...kontext, fetch: m.f, keyFile: KEY })
    expect(r.entscheidung).not.toBe("FABRIK")
    expect(r.injizieren).toBe(false)
    // Kind-Sitzung und Prüf-Agent fragen das LLM nie.
    expect(m.aufrufe()).toBe(0)
    expect(r.llm).toBeNull()
  })
})

describe("Gegenprobe — ohne Kontext entscheidet der Text wie vor dem Fix", () => {
  test.each(FELD_INTERN.filter(([, , k]) => k.agent))("Abnahme-Text ohne agent → FABRIK (Wortregel): %s", (text) => {
    const r = classify(text)
    expect(r.entscheidung).toBe("FABRIK")
    expect(r.quelle).toBe("wortregel")
    expect(r.injizieren).toBe(true)
  })

  test.each(FELD_INTERN.filter(([, , k]) => k.kind))("Kind-Text ohne kind → LLM-JA → FABRIK (wie im Feld): %s", async (text) => {
    expect(classify(text).entscheidung).toBe("GRAUZONE")
    const m = jaMock()
    const r = await entscheide(text, { fetch: m.f, keyFile: KEY })
    expect(m.aufrufe()).toBeGreaterThan(0)
    expect(r.entscheidung).toBe("FABRIK")
    expect(r.quelle).toBe("llm")
    expect(r.injizieren).toBe(true)
  })
})

describe("Kontrollwert — echte Deliverables bleiben FABRIK", () => {
  const sollFabrik = [...FELD_FABRIK, ...EIGENE_AUFTRAEGE, ...HOLDOUT_AUFTRAEGE, ...FANOUT_NUTZER].filter(([, soll]) => soll)

  test("Artikel / Testsuite / Varianten: FABRIK, auch an worker-dev", () => {
    for (const t of [
      "Recherchiere parallel die Tarife von Telekom, Vodafone und O2, vergleiche sie und schreib einen Artikel",
      "Könntest du bitte drei Varianten des Artikels parallel schreiben und vergleichen?",
      "Erstelle für die Module A, B, C und D je eine Testsuite mit Randfällen.",
      "Schreib je einen Artikel über die Sonnenfinsternisse 2026, 2027 und 2028.",
    ]) {
      for (const agent of [undefined, "worker-dev", "general"]) {
        const r = classify(t, { agent })
        expect(r.entscheidung).toBe("FABRIK")
        expect(r.injizieren).toBe(true)
      }
    }
  })

  test("jeder Sollfall der Korpora: schreibender Agent ändert nichts", () => {
    expect(sollFabrik.length).toBeGreaterThan(40)
    for (const [text] of sollFabrik) {
      const ohne = classify(text)
      for (const agent of ["worker-dev", "general", "build", null]) expect(classify(text, { agent })).toEqual(ohne)
      expect(classify(text, { kind: false })).toEqual(ohne)
    }
  })

  test("Präfix fabrik: an einen Prüf-Agenten bleibt Wille; Nein-Signal bleibt nein_signal", () => {
    const p = classify("fabrik: Prüfe, ob Task p1 sein Fertig-Kriterium erfüllt.", { agent: "abnahme" })
    expect(p.entscheidung).toBe("FABRIK")
    expect(p.quelle).toBe("praefix")
    const d = classify("Prüfe, ob alles deployed ist, und deploye dann wortwert.", { agent: "reviewer" })
    expect(d.entscheidung).toBe("DIREKT")
    expect(d.quelle).toBe("nein_signal")
  })

  test("die drei lesenden Prüf-Agenten (opencode.jsonc: mode subagent, edit deny)", () => {
    expect([...LESENDE_PRUEFER].sort()).toEqual(["abnahme", "explore", "reviewer"])
    const [text] = FELD_INTERN[0]
    for (const agent of ["abnahme", "reviewer", "explore", "Abnahme"]) expect(classify(text, { agent }).quelle).toBe("pruef_agent")
  })
})

describe("CLI — Kontext über --agent / --kind", () => {
  const SCRIPT = join(import.meta.dir, "of-gate.ts")
  const lauf = async (args: string[], text: string) => {
    const home = mkdtempSync(join(tmpdir(), "of-gate-intern-home-"))
    const proc = Bun.spawn(["bun", SCRIPT, "classify", ...args], {
      stdin: new Blob([text]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, OPENFLOW_LEDGER: join(TMP, "gate-ledger.jsonl") },
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    return JSON.parse(out.trim().split("\n").pop() ?? "{}")
  }

  test("--agent abnahme → DIREKT/pruef_agent; ohne → FABRIK", async () => {
    const [text] = FELD_INTERN[0]
    expect((await lauf(["--agent", "abnahme"], text)).quelle).toBe("pruef_agent")
    expect((await lauf([], text)).entscheidung).toBe("FABRIK")
  })

  test("--kind --llm → quelle kind, kein LLM-Versuch", async () => {
    const [text] = FELD_INTERN[5]
    const r = await lauf(["--kind", "--llm"], text)
    expect(r.quelle).toBe("kind")
    expect(r.injizieren).toBe(false)
    expect(r.llm_ms).toBeNull()
    expect(r.llm_fehler).toBeNull()
  })
})
