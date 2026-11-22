/**
 * Template-Wahl (22.11.2026): `of-gate.ts wahl` — messdaten → llm → fallback.
 * fetch ist gemockt wie in gate-llm.test.ts — kein Netz, temporäre Schlüsseldatei.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FALLBACK_PIPELINE, LLM_MODELL, parseWahlAntwort, waehlbarePipelines, waehleTemplate } from "./of-gate"

const TMP = mkdtempSync(join(tmpdir(), "of-gate-wahl-"))
const KEY = join(TMP, "dharma.key")
writeFileSync(KEY, "test-schluessel\n")

function antwort(content: unknown, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { "content-type": "application/json" } })
}
function mock(fn: (url: string, init: any) => Promise<Response> | Response) {
  const calls: { url: string; init: any }[] = []
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return fn(String(url), init)
  }) as unknown as typeof fetch
  return { f, calls }
}

const graph = { id: "x", nodes: [], edges: [] }
function pipelines(name: string, dateien: Record<string, unknown>) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  for (const [datei, inhalt] of Object.entries(dateien)) writeFileSync(join(dir, datei), typeof inhalt === "string" ? inhalt : JSON.stringify(inhalt))
  return dir
}
function wahlDatei(name: string, wahl: Record<string, string>) {
  const pfad = join(TMP, `${name}.json`)
  writeFileSync(pfad, JSON.stringify({ wahl: Object.fromEntries(Object.entries(wahl).map(([k, p]) => [k, { pipeline: p, n: 5, quote: 1, runden: 1 }])) }))
  return pfad
}

const STANDARD = pipelines("standard", {
  "auto-orchestrator.json": { ...graph, name: "auto-orchestrator", beschreibung: "Allzweck mit Gauntlet." },
  "merkspur-analyse.json": { ...graph, name: "merkspur analyse", beschreibung: "Lesende System-Analyse,\n  schreibt nichts." },
  "zahlwert-article-full.json": { ...graph, name: "zahlwert-article-full", beschreibung: "Neuer Artikel End-to-End." },
  "smoke-orch.json": { ...graph, name: "smoke-orch", beschreibung: "Testsonde.", waehlbar: false },
  "ohne-beschreibung.json": { ...graph, name: "ohne-beschreibung" },
  "leer.json": { ...graph, name: "leer", beschreibung: "  " },
  "kaputt.json": "{ nicht json",
  "auto-orchestrator.json.bak-alt": { ...graph, beschreibung: "Sicherung." },
  ".index.json": { beschreibung: "kein Template" },
})
const KEINE_WAHL = join(TMP, "fehlt.json")
const ANALYSE = "Analysiere die Speicherverwaltung von rille und berichte die Risiken mit Datei:Zeile."

describe("waehlbarePipelines", () => {
  test("nur .json mit nicht-leerer Beschreibung und ohne waehlbar:false; Name = Dateiname", () => {
    expect(waehlbarePipelines(STANDARD)).toEqual([
      { name: "auto-orchestrator", beschreibung: "Allzweck mit Gauntlet." },
      { name: "merkspur-analyse", beschreibung: "Lesende System-Analyse, schreibt nichts." },
      { name: "zahlwert-article-full", beschreibung: "Neuer Artikel End-to-End." },
    ])
  })

  test("fehlendes Verzeichnis → keine Kandidaten", () => {
    expect(waehlbarePipelines(join(TMP, "gibt-es-nicht"))).toEqual([])
  })
})

describe("parseWahlAntwort", () => {
  const namen = ["auto-orchestrator", "merkspur-analyse"]
  test("exakter Name, auch mit Zierrat, Fußzeile, <think>, anderer Schreibweise", () => {
    expect(parseWahlAntwort("merkspur-analyse", namen)).toBe("merkspur-analyse")
    expect(parseWahlAntwort("`merkspur-analyse`.", namen)).toBe("merkspur-analyse")
    expect(parseWahlAntwort("<think>hm</think>\n\n**Merkspur-Analyse**\n\n⎯⎯ qwen3.8-27b · qwen3.8-27b · yolo ⎯⎯", namen)).toBe("merkspur-analyse")
  })

  test("Halluzination, Satz um den Namen, leere Antwort → null", () => {
    expect(parseWahlAntwort("analyse-pipeline", namen)).toBeNull()
    expect(parseWahlAntwort("Ich empfehle merkspur-analyse", namen)).toBeNull()
    expect(parseWahlAntwort("merkspur", namen)).toBeNull()
    expect(parseWahlAntwort("\n\n⎯⎯ x · y · z ⎯⎯", namen)).toBeNull()
  })
})

describe("waehleTemplate", () => {
  test("Messdaten für die Klasse gewinnen — kein LLM-Aufruf", async () => {
    const { f, calls } = mock(() => antwort("zahlwert-article-full"))
    const w = await waehleTemplate(ANALYSE, { fetch: f, keyFile: KEY, pipelinesDir: STANDARD, wahlDatei: wahlDatei("mess", { analyse: "merkspur-analyse" }) })
    expect(w).toMatchObject({ pipeline: "merkspur-analyse", quelle: "messdaten", klasse: "analyse" })
    expect(calls).toHaveLength(0)
  })

  test("Messdaten-Wahl nicht wählbar (Testsonde) → LLM entscheidet", async () => {
    const { f, calls } = mock(() => antwort("merkspur-analyse"))
    const w = await waehleTemplate(ANALYSE, { fetch: f, keyFile: KEY, pipelinesDir: STANDARD, wahlDatei: wahlDatei("sonde", { analyse: "smoke-orch" }) })
    expect(w).toMatchObject({ pipeline: "merkspur-analyse", quelle: "llm" })
    expect(calls).toHaveLength(1)
  })

  test("LLM-Wahl: Prompt trägt Auftrag und genau die wählbaren {Name, Beschreibung}; Aufrufweg wie das Grauzonen-Urteil", async () => {
    const { f, calls } = mock(() => antwort("merkspur-analyse\n\n⎯⎯ qwen3.8-27b · qwen3.8-27b · yolo ⎯⎯"))
    const w = await waehleTemplate(ANALYSE, { fetch: f, keyFile: KEY, pipelinesDir: STANDARD, wahlDatei: KEINE_WAHL })
    expect(w).toMatchObject({ pipeline: "merkspur-analyse", quelle: "llm", klasse: "analyse", kandidaten: 3, llm_modell: "qwen3.8-27b@yolo", llm_versuche: 1 })
    const body = JSON.parse(calls[0]!.init.body)
    expect(calls[0]!.url).toBe("https://dharma.mcp-hub.stream/v1/chat/completions")
    expect(body.model).toBe(LLM_MODELL)
    expect(body.temperature).toBe(0)
    const prompt: string = body.messages[0].content
    expect(prompt).toContain("- merkspur-analyse: Lesende System-Analyse, schreibt nichts.")
    expect(prompt).toContain("- auto-orchestrator: Allzweck mit Gauntlet.")
    expect(prompt).toContain("- zahlwert-article-full: Neuer Artikel End-to-End.")
    expect(prompt).not.toContain("smoke-orch")
    expect(prompt).not.toContain("ohne-beschreibung")
    expect(prompt.endsWith(`Auftrag: ${ANALYSE}`)).toBe(true)
    expect(calls[0]!.init.body).not.toContain("test-schluessel")
  })

  test("Halluzination (Name nicht in der Liste) auf beiden Wegen → fallback, Antwort im Ergebnis", async () => {
    const { f, calls } = mock(() => antwort("deep-research-pipeline"))
    const w = await waehleTemplate(ANALYSE, { fetch: f, keyFile: KEY, pipelinesDir: STANDARD, wahlDatei: KEINE_WAHL, hedgeMs: 50, timeoutMs: 2000 })
    expect(w).toMatchObject({ pipeline: FALLBACK_PIPELINE, quelle: "fallback", grund: "llm_unklar", llm_antwort: "deep-research-pipeline" })
    expect(calls).toHaveLength(2)
  })

  test("erster Weg halluziniert, Hedge nennt einen gültigen Namen → llm", async () => {
    const { f } = mock((_u, init) => antwort(JSON.parse(init.body).model === LLM_MODELL ? "gibt-es-nicht" : "zahlwert-article-full"))
    const w = await waehleTemplate("Schreib einen Artikel über die Zahl 47", { fetch: f, keyFile: KEY, pipelinesDir: STANDARD, wahlDatei: KEINE_WAHL })
    expect(w).toMatchObject({ pipeline: "zahlwert-article-full", quelle: "llm", llm_versuche: 2 })
  })

  test("Zeitüberschreitung → fallback mit Grund", async () => {
    const { f } = mock((_u, init) => new Promise<Response>((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))))
    const w = await waehleTemplate(ANALYSE, { fetch: f, keyFile: KEY, pipelinesDir: STANDARD, wahlDatei: KEINE_WAHL, timeoutMs: 100, hedgeMs: 50 })
    expect(w).toMatchObject({ pipeline: FALLBACK_PIPELINE, quelle: "fallback", grund: "llm_timeout" })
  })

  test("Schlüssel fehlt → fallback ohne Aufruf", async () => {
    const { f, calls } = mock(() => antwort("merkspur-analyse"))
    const w = await waehleTemplate(ANALYSE, { fetch: f, keyFile: join(TMP, "kein.key"), pipelinesDir: STANDARD, wahlDatei: KEINE_WAHL })
    expect(w).toMatchObject({ pipeline: FALLBACK_PIPELINE, quelle: "fallback", grund: "llm_schluessel_fehlt" })
    expect(calls).toHaveLength(0)
  })

  test("nur der Fallback wählbar → kein LLM-Aufruf", async () => {
    const dir = pipelines("nur-fallback", { "auto-orchestrator.json": { ...graph, beschreibung: "Allzweck." } })
    const { f, calls } = mock(() => antwort("auto-orchestrator"))
    const w = await waehleTemplate(ANALYSE, { fetch: f, keyFile: KEY, pipelinesDir: dir, wahlDatei: KEINE_WAHL })
    expect(w).toMatchObject({ pipeline: FALLBACK_PIPELINE, quelle: "fallback", grund: "keine_kandidaten", kandidaten: 1 })
    expect(calls).toHaveLength(0)
  })
})

describe("CLI wahl", () => {
  const SKRIPT = join(import.meta.dir, "of-gate.ts")
  async function lauf(args: string[], env: Record<string, string>, stdin?: string) {
    const p = Bun.spawn(["bun", SKRIPT, "wahl", ...args], { env: { ...process.env, ...env }, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" })
    const out = await new Response(p.stdout).text()
    return { code: await p.exited, out }
  }

  test("gibt genau EINEN Namen aus und schreibt die Ledger-Zeile template_wahl", async () => {
    const ledger = join(TMP, "ledger-1.jsonl")
    const r = await lauf(["--text", ANALYSE], { OPENFLOW_LEDGER: ledger, OPENFLOW_PIPELINES_DIR: STANDARD, OPENFLOW_TEMPLATE_WAHL: wahlDatei("cli", { analyse: "merkspur-analyse" }) })
    expect(r.code).toBe(0)
    expect(r.out).toBe("merkspur-analyse\n")
    const zeile = JSON.parse(readFileSync(ledger, "utf8").trim())
    expect(zeile).toMatchObject({ event: "template_wahl", pipeline: "merkspur-analyse", quelle: "messdaten", klasse: "analyse", task: ANALYSE })
    expect(typeof zeile.ts).toBe("string")
  })

  test("Text über stdin, --json, ohne Kandidaten → auto-orchestrator (fallback)", async () => {
    const ledger = join(TMP, "ledger-2.jsonl")
    const r = await lauf(["--json"], { OPENFLOW_LEDGER: ledger, OPENFLOW_PIPELINES_DIR: join(TMP, "gibt-es-nicht"), OPENFLOW_TEMPLATE_WAHL: KEINE_WAHL }, ANALYSE)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ pipeline: FALLBACK_PIPELINE, quelle: "fallback", grund: "keine_kandidaten" })
    expect(JSON.parse(readFileSync(ledger, "utf8").trim())).toMatchObject({ event: "template_wahl", quelle: "fallback" })
  })
})
