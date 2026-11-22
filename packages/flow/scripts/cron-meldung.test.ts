/**
 * I6 (22.11.2026) — of-loop meldet den letzten unbeaufsichtigten Lauf jeder
 * Cron-Pipeline: FAIL / DELIVERED_BELOW_BAR / Kritik unter 10 als Alert,
 * jeden fertigen Lauf einmal als Zeile in meldungen.jsonl.
 *
 * Alles in Temp-Verzeichnissen; der of-loop-Lauf bekommt --meldungen,
 * --cron-pipelines, --runs-dir, --state-dir, --heartbeat, --digest-dir,
 * --ledger und OPENFLOW_CHECKPOINT_DIR auf temp — weder ~/.openflow noch die
 * echte crontab werden gelesen oder geschrieben.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cronPipelines, gemeldeteRuns, kritikAus, laufFertig, planeCronMeldungen, schreibeMeldungen } from "./of-cron-meldung"

const BASIS = mkdtempSync(join(tmpdir(), "of-cron-meldung-"))
afterAll(() => rmSync(BASIS, { recursive: true, force: true }))
const H = 3_600_000
const JETZT = Date.parse("2026-11-22T12:00:00Z")
const tot = () => "tot" as const
const lebt = () => "lebt" as const

const urteil = (erfuellt: boolean) =>
  "Urteil.\n```urteil\n" +
  JSON.stringify({ kriterien: [{ id: "K1", text: "Datei vorhanden", erfuellt, beleg: "ls -l x: 4123" }], blocker: [] }) +
  "\n```"

function lauf(id: string, o: { pipeline?: string; vorH?: number; status?: string; verdict?: string; session?: string; kritik?: string } = {}) {
  const started = JETZT - (o.vorH ?? 1) * H
  return {
    id,
    pipeline: o.pipeline ?? "wva",
    status: o.status ?? "done",
    started,
    finished: started + 600_000,
    host: { pid: 4242, ...(o.session ? { session: o.session } : {}) },
    ...(o.verdict ? { scorecard: { verdict: o.verdict } } : {}),
    nodes: [
      { id: "rev", role: "reviewer", status: "done", output: "| Kennzahl | Wert |" },
      ...(o.kritik ? [{ id: "wva-critic", role: "critic", status: "done", output: o.kritik }] : []),
    ],
  }
}

const plane = (logs: any[], extra: Partial<Parameters<typeof planeCronMeldungen>[0]> = {}) =>
  planeCronMeldungen({ logs, pipelines: ["wva"], gemeldet: new Set(), now: JETZT, pid: tot, ergebnis: (id) => `/ck/${id}.ergebnis.md`, ...extra })

describe("I6 cronPipelines", () => {
  test("liest Pipelines hinter of-run.sh, überspringt Flags, Kommentare und Resumes", () => {
    const tab = [
      "30 7,19 * * * cd /x && bash packages/flow/scripts/of-run.sh --wait wissen-video-analyse \"Tageslauf\" >> log 2>&1",
      "# 0 1 * * * bash of-run.sh alt-pipeline",
      "0 2 * * * bash of-run.sh --mcp --wait mcp-pipe x",
      "0 3 * * * bash of-run.sh --resume run-abc",
      "*/5 * * * * bun scripts/of-loop.ts",
    ].join("\n")
    expect(cronPipelines(tab)).toEqual(["wissen-video-analyse", "mcp-pipe"])
  })
})

describe("I6 planeCronMeldungen", () => {
  test("FAIL des letzten Laufs → Alert und Meldung mit alarm:true", () => {
    const r = plane([lauf("run-a", { vorH: 13, verdict: "PASS" }), lauf("run-b", { verdict: "FAIL", status: "error" })])
    expect(r.alerts.map((a) => a.invariante)).toEqual(["I6-cronlauf:wva"])
    expect(r.alerts[0].wert).toContain("run-b FAIL")
    expect(r.alerts[0].wert).toContain("ergebnis: /ck/run-b.ergebnis.md")
    expect(r.meldungen).toMatchObject([{ pipeline: "wva", run: "run-b", verdict: "FAIL", gelesen: false, alarm: true, ergebnis: "/ck/run-b.ergebnis.md" }])
  })

  test("PASS → kein Alert, aber eine Meldung", () => {
    const r = plane([lauf("run-a", { vorH: 13, verdict: "FAIL" }), lauf("run-b", { verdict: "PASS" })])
    expect(r.alerts).toEqual([])
    expect(r.meldungen).toMatchObject([{ run: "run-b", verdict: "PASS", alarm: false }])
  })

  test("DELIVERED_BELOW_BAR alarmiert", () => {
    expect(plane([lauf("run-c", { verdict: "DELIVERED_BELOW_BAR" })]).alerts).toHaveLength(1)
  })

  test("Lauf mit host.session ist ein Sitzungslauf und zählt nicht", () => {
    const r = plane([lauf("run-a", { vorH: 13, verdict: "PASS" }), lauf("run-s", { verdict: "FAIL", session: "ses_1" })])
    expect(r.alerts).toEqual([])
    expect(r.meldungen.map((m) => m.run)).toEqual(["run-a"])
  })

  test("jüngster Lauf noch running → nichts (auch kein Alert vom Vorgänger)", () => {
    const r = plane([lauf("run-a", { vorH: 13, verdict: "FAIL" }), lauf("run-b", { status: "running" })])
    expect(r).toEqual({ meldungen: [], alerts: [] })
  })

  test("Versuch 1 error ohne Scorecard, Prozess lebt (Auto-Retry folgt) → noch nicht fertig", () => {
    const log = lauf("run-v1", { status: "error" })
    expect(laufFertig(log, lebt)).toBe(false)
    expect(plane([log], { pid: lebt })).toEqual({ meldungen: [], alerts: [] })
    // Prozess weg (gereapt): Verdict aus dem Status
    expect(plane([log]).meldungen).toMatchObject([{ verdict: "FAIL", alarm: true }])
  })

  test("schon gemeldeter Lauf: Alert bleibt (Zustand), keine zweite Meldung", () => {
    const r = plane([lauf("run-b", { verdict: "FAIL" })], { gemeldet: new Set(["run-b"]) })
    expect(r.alerts).toHaveLength(1)
    expect(r.meldungen).toEqual([])
  })

  test("älter als 7 Tage: keine Nachmeldung", () => {
    expect(plane([lauf("run-alt", { vorH: 24 * 8, verdict: "PASS" })]).meldungen).toEqual([])
  })

  test("fremde Pipeline zählt nicht", () => {
    expect(plane([lauf("run-x", { pipeline: "andere", verdict: "FAIL" })])).toEqual({ meldungen: [], alerts: [] })
  })

  test("Kritik unter 10 alarmiert auch bei PASS; Urteilszeile in der Meldung", () => {
    const r = plane([lauf("run-k", { verdict: "PASS", kritik: urteil(false) })])
    expect(r.alerts).toHaveLength(1)
    expect(r.meldungen[0].kritik).toBe("wva-critic: Note 0/10 · 1 offen: K1: Datei vorhanden")
    expect(r.meldungen[0].alarm).toBe(true)
  })

  test("Kritik 10/10 bei PASS: kein Alert; Reviewer-Tabelle ohne urteil-Block ist kein Urteil", () => {
    const log = lauf("run-ok", { verdict: "PASS", kritik: urteil(true) })
    expect(kritikAus(log)).toEqual({ zeile: "wva-critic: Note 10/10 · 0 offen", offen: false })
    expect(plane([log]).alerts).toEqual([])
  })
})

describe("I6 meldungen.jsonl", () => {
  test("schreiben und gemeldete Runs zurücklesen; halbe Zeile wird übergangen", () => {
    const pfad = join(BASIS, "unter", "meldungen.jsonl")
    schreibeMeldungen(pfad, plane([lauf("run-1", { verdict: "PASS" })]).meldungen)
    writeFileSync(pfad, readFileSync(pfad, "utf8") + '{"run":"run-h')
    expect([...gemeldeteRuns(pfad)]).toEqual(["run-1"])
    expect(gemeldeteRuns(join(BASIS, "fehlt.jsonl")).size).toBe(0)
  })
})

describe("I6 of-loop-Tick", () => {
  test("FAIL-Cronlauf → ALERT-Zeile + eine Meldung; zweiter Tick meldet nicht doppelt", () => {
    const dir = join(BASIS, "tick")
    const runs = join(dir, "runs")
    mkdirSync(runs, { recursive: true })
    const jetzt = Date.now()
    const log = { ...lauf("run-tick", { verdict: "FAIL", status: "error" }), started: jetzt - H, finished: jetzt - H / 2, host: { pid: 999_999_999 } }
    writeFileSync(join(runs, "run-tick.json"), JSON.stringify(log))
    writeFileSync(join(dir, "openflow-checkpoint-run-tick.ergebnis.md"), "# Ergebnis run-tick\n")
    const meldungen = join(dir, "meldungen.jsonl")
    const tick = () =>
      Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "of-loop.ts"), "--runs-dir", runs, "--state-dir", dir, "--heartbeat", join(dir, "hb"), "--digest-dir", dir, "--ledger", join(dir, "ledger.jsonl"), "--pipelines", "keine", "--cron-pipelines", "wva", "--meldungen", meldungen],
        { env: { ...process.env, OPENFLOW_CHECKPOINT_DIR: dir, OPENFLOW_RUNS_DIR: runs, OPENFLOW_LEDGER: join(dir, "ledger.jsonl") }, stdout: "pipe", stderr: "pipe" },
      )
    const p1 = tick()
    expect(p1.exitCode).toBe(0)
    expect(p1.stderr.toString()).toContain("of-loop ALERT [I6-cronlauf:wva] run-tick FAIL")
    expect(p1.stderr.toString()).toContain("of-loop: Cron-Meldung wva FAIL run-tick")
    const zeilen = readFileSync(meldungen, "utf8").trim().split("\n").map((z) => JSON.parse(z))
    expect(zeilen).toMatchObject([{ pipeline: "wva", run: "run-tick", verdict: "FAIL", gelesen: false, ergebnis: join(dir, "openflow-checkpoint-run-tick.ergebnis.md") }])
    const p2 = tick()
    expect(p2.exitCode).toBe(0)
    expect(p2.stderr.toString()).not.toContain("Cron-Meldung")
    expect(p2.stderr.toString()).not.toContain("ALERT [I6")
    expect(readFileSync(meldungen, "utf8").trim().split("\n")).toHaveLength(1)
  })
})
