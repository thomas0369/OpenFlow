/**
 * Tests für of-template-wahl.ts. Fixture-Runs entstehen nur in
 * mkdtemp-Verzeichnissen; `--out` zeigt immer in dasselbe tmp-Verzeichnis.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { istInfraFehler, leseRuns, MIN_N, tabelle, waehle, type WahlDatei } from "./of-template-wahl"

const SCRIPT = join(import.meta.dir, "of-template-wahl.ts")
const dirs: string[] = []

afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

type Fixture = {
  pipeline: string
  klasse?: string
  input?: string
  status?: string
  barMet?: boolean
  rounds?: number
  tokens?: number
  error?: string
}

function lauf(f: Fixture, i: number) {
  return {
    id: `run-${i}`,
    pipeline: f.pipeline,
    input: f.input ?? "",
    status: f.status ?? "done",
    started: 1_700_000_000_000 + i,
    ...(f.klasse ? { klasse: f.klasse } : {}),
    nodes: f.error ? [{ id: "a", status: "error", error: f.error }] : [{ id: "a", status: "done", output: "ok" }],
    usage: { cost: 0, steps: 1, models: [], unpriced: [], tokens: { input: f.tokens ?? 100, output: 0, reasoning: 0, cacheRead: 99_999, cacheWrite: 0 } },
    ...(f.barMet === undefined ? {} : { quality: { barMet: f.barMet, rounds: f.rounds ?? 0, open: [], criteria: 3, criticModels: ["m"] } }),
  }
}

function runsDir(fixtures: Fixture[]) {
  const dir = mkdtempSync(join(tmpdir(), "template-wahl-"))
  dirs.push(dir)
  fixtures.forEach((f, i) => writeFileSync(join(dir, `run-${i}.json`), JSON.stringify(lauf(f, i))))
  return dir
}

const mal = (n: number, f: Fixture) => Array.from({ length: n }, () => f)
const wahlAus = (fixtures: Fixture[]) => waehle(tabelle(leseRuns(runsDir(fixtures))))

describe("Auswahl", () => {
  test("beste barMet-Quote gewinnt", () => {
    const w = wahlAus([
      ...mal(4, { pipeline: "a", klasse: "analyse", barMet: true }),
      ...mal(2, { pipeline: "a", klasse: "analyse", barMet: false }),
      ...mal(5, { pipeline: "b", klasse: "analyse", barMet: true }),
      ...mal(1, { pipeline: "b", klasse: "analyse", barMet: false }),
    ])
    expect(w.analyse).toEqual({ pipeline: "b", n: 6, quote: 0.833, runden: 0 })
  })

  test("Gleichstand: weniger mittlere Runden gewinnt", () => {
    const w = wahlAus([
      ...mal(5, { pipeline: "a", klasse: "review", barMet: true, rounds: 2, tokens: 10 }),
      ...mal(5, { pipeline: "b", klasse: "review", barMet: true, rounds: 1, tokens: 1000 }),
    ])
    expect(w.review?.pipeline).toBe("b")
  })

  test("Gleichstand bei Quote und Runden: weniger Median-Tokens gewinnt, Cache-Tokens zählen nicht", () => {
    const w = wahlAus([
      ...mal(5, { pipeline: "a", klasse: "review", barMet: true, rounds: 1, tokens: 500 }),
      ...mal(5, { pipeline: "b", klasse: "review", barMet: true, rounds: 1, tokens: 400 }),
    ])
    expect(w.review?.pipeline).toBe("b")
    const t = tabelle(leseRuns(runsDir(mal(5, { pipeline: "b", klasse: "review", barMet: true, tokens: 400 }))))
    expect(t[0]?.tokens_median).toBe(400)
  })

  test("n < MIN_N → keine Wahl für die Klasse", () => {
    const w = wahlAus(mal(MIN_N - 1, { pipeline: "a", klasse: "artikel", barMet: true }))
    expect(w.artikel).toBeUndefined()
  })

  test("Wahl je Klasse getrennt", () => {
    const w = wahlAus([
      ...mal(5, { pipeline: "a", klasse: "analyse", barMet: true }),
      ...mal(5, { pipeline: "b", klasse: "code-fix", barMet: true }),
    ])
    expect(w.analyse?.pipeline).toBe("a")
    expect(w["code-fix"]?.pipeline).toBe("b")
  })

  test("done mit barMet false und error mit quality zählen als nicht erfüllt", () => {
    const t = tabelle(
      leseRuns(
        runsDir([
          { pipeline: "a", klasse: "analyse", barMet: true },
          { pipeline: "a", klasse: "analyse", barMet: false },
          { pipeline: "a", klasse: "analyse", barMet: true, status: "error", error: "orchestrator never produced a block" },
        ]),
      ),
    )
    expect(t[0]).toMatchObject({ n: 3, erfuellt: 1, quote: 0.333 })
  })
})

describe("Infra-Ausschluss", () => {
  test("error-Läufe mit Infrastrukturfehler fallen aus der Wertung", () => {
    const fehler = [
      'Provider request failed with HTTP 401: { "error": "unauthorized" }',
      "HTTP transport failed",
      "Invalid dharma/openai-compatible-chat stream event",
      "timed out waiting for the session to finish",
      "cannot reach opencode serve at http://127.0.0.1:4096",
      "connect ECONNREFUSED 127.0.0.1:4096",
      "fetch failed",
    ]
    const t = tabelle(
      leseRuns(
        runsDir([
          ...fehler.map((error) => ({ pipeline: "a", klasse: "analyse", status: "error", error, barMet: false })),
          ...mal(5, { pipeline: "a", klasse: "analyse", barMet: true }),
        ]),
      ),
    )
    expect(t[0]).toMatchObject({ infra: fehler.length, n_gesamt: 5, n: 5, quote: 1 })
    expect(waehle(t).analyse?.pipeline).toBe("a")
  })

  test("Fehlertext auf Lauf-Ebene zählt, Nicht-Infra-Fehler und done-Läufe nicht", () => {
    expect(istInfraFehler({ status: "error", error: "fetch failed" })).toBe(true)
    expect(istInfraFehler({ status: "error", nodes: [{ id: "x", role: "coder", status: "error", error: 'unknown model "glm"' }] })).toBe(false)
    expect(istInfraFehler({ status: "done", error: "fetch failed" })).toBe(false)
  })
})

describe("alte Läufe", () => {
  test("ohne quality zählen sie in n_gesamt, nicht in die Quote; Klasse aus input", () => {
    const t = tabelle(
      leseRuns(
        runsDir([
          ...mal(10, { pipeline: "a", input: "analysiere warum der Cron um 3 Uhr ausfällt" }),
          ...mal(4, { pipeline: "a", klasse: "analyse", barMet: true }),
        ]),
      ),
    )
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ klasse: "analyse", n_gesamt: 14, n: 4, quote: 1 })
    expect(waehle(t).analyse).toBeUndefined()
  })

  test("laufende Läufe zählen nirgends", () => {
    const t = tabelle(leseRuns(runsDir([{ pipeline: "a", klasse: "analyse", status: "running", barMet: true }])))
    expect(t).toEqual([])
  })
})

describe("CLI", () => {
  test("--out schreibt die Datei, --dry-run nicht", () => {
    const dir = runsDir(mal(5, { pipeline: "x", klasse: "analyse", barMet: true }))
    const out = join(dir, "wahl", "template-wahl.json")
    const trocken = Bun.spawnSync(["bun", SCRIPT, "--runs-dir", dir, "--out", out, "--dry-run"])
    expect(trocken.exitCode).toBe(0)
    expect(existsSync(out)).toBe(false)
    expect(trocken.stdout.toString()).toContain("| analyse | x | 5 | 5 | 5 | 1 | 0 | 100 | 0 | ja |")

    const echt = Bun.spawnSync(["bun", SCRIPT, "--runs-dir", dir, "--out", out])
    expect(echt.exitCode).toBe(0)
    const datei = JSON.parse(readFileSync(out, "utf8")) as WahlDatei
    expect(datei.min_n).toBe(MIN_N)
    expect(Number.isNaN(Date.parse(datei.erzeugt))).toBe(false)
    expect(datei.wahl).toEqual({ analyse: { pipeline: "x", n: 5, quote: 1, runden: 0 } })
    expect(datei.tabelle).toHaveLength(1)
  })

  test("ohne Kandidaten: leere Wahl und Hinweis auf den Fallback", () => {
    const dir = runsDir(mal(3, { pipeline: "x", klasse: "analyse" }))
    const out = join(dir, "template-wahl.json")
    const r = Bun.spawnSync(["bun", SCRIPT, "--runs-dir", dir, "--out", out])
    expect(r.stdout.toString()).toContain("das Gate nimmt auto-orchestrator")
    expect((JSON.parse(readFileSync(out, "utf8")) as WahlDatei).wahl).toEqual({})
  })
})
