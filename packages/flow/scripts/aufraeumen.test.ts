/**
 * T-10 (B6, 28.10.2026) — of-loop räumt Checkpoints älter als 30 Tage weg,
 * außer der Lauf ist laut Checkpoint oder Run-Log noch `running`.
 *
 * Alles in Temp-Verzeichnissen; der of-loop-Lauf bekommt OPENFLOW_CHECKPOINT_DIR,
 * --state-dir, --heartbeat, --runs-dir, --digest-dir und --ledger auf temp —
 * echte Checkpoints, /tmp/of-loop-* und das Ledger bleiben unberührt.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AUFRAEUMEN_MAX_ALTER_MS, raeumeCheckpointsAuf } from "./of-aufraeumen"

const BASIS = mkdtempSync(join(tmpdir(), "of-aufraeumen-"))
afterAll(() => rmSync(BASIS, { recursive: true, force: true }))
const TAG = 24 * 3_600_000
let n = 0

function stand() {
  const dir = join(BASIS, `f${n++}`)
  mkdirSync(join(dir, "runs"), { recursive: true })
  return { ck: dir, runs: join(dir, "runs") }
}

function datei(pfad: string, inhalt: string, alterTage: number) {
  writeFileSync(pfad, inhalt)
  const t = new Date(Date.now() - alterTage * TAG)
  utimesSync(pfad, t, t)
  return pfad
}

function lauf(d: { ck: string }, id: string, alterTage: number, status = "done") {
  return [
    datei(join(d.ck, `openflow-checkpoint-${id}.json`), JSON.stringify({ id, status }), alterTage),
    datei(join(d.ck, `openflow-checkpoint-${id}.ergebnis.md`), "# E", alterTage),
    datei(join(d.ck, `openflow-checkpoint-${id}.ergebnis.voll.md`), "# V", alterTage),
  ]
}

describe("T-10 raeumeCheckpointsAuf", () => {
  test(">30 Tage alt → alle Dateien des Laufs gelöscht; jüngere bleiben", () => {
    const d = stand()
    const alt = lauf(d, "run-alt", 31)
    const jung = lauf(d, "run-jung", 29)
    const r = raeumeCheckpointsAuf({ dir: d.ck, runsDir: d.runs, now: Date.now() })
    expect(r.geloescht.sort()).toEqual([...alt].sort())
    expect(alt.some(existsSync)).toBe(false)
    expect(jung.every(existsSync)).toBe(true)
  })

  test("running laut Checkpoint bleibt, auch wenn alt", () => {
    const d = stand()
    const f = lauf(d, "run-laeuft", 60, "running")
    const r = raeumeCheckpointsAuf({ dir: d.ck, runsDir: d.runs, now: Date.now() })
    expect(r.geloescht).toEqual([])
    expect(r.behalten_running).toEqual(["run-laeuft"])
    expect(f.every(existsSync)).toBe(true)
  })

  test("running laut Run-Log bleibt, auch wenn der Checkpoint done sagt", () => {
    const d = stand()
    const f = lauf(d, "run-log", 60, "done")
    writeFileSync(join(d.runs, "run-log.json"), JSON.stringify({ id: "run-log", status: "running" }))
    expect(raeumeCheckpointsAuf({ dir: d.ck, runsDir: d.runs, now: Date.now() }).behalten_running).toEqual(["run-log"])
    expect(f.every(existsSync)).toBe(true)
  })

  test("jüngste Datei zählt: alte ergebnis.md neben frischem Checkpoint bleibt", () => {
    const d = stand()
    const md = datei(join(d.ck, "openflow-checkpoint-run-m.ergebnis.md"), "# E", 90)
    datei(join(d.ck, "openflow-checkpoint-run-m.json"), "{}", 1)
    raeumeCheckpointsAuf({ dir: d.ck, runsDir: d.runs, now: Date.now() })
    expect(existsSync(md)).toBe(true)
  })

  test("fremde Dateien im Verzeichnis werden nie angefasst; dryRun löscht nichts", () => {
    const d = stand()
    const fremd = datei(join(d.ck, "of-loop-alerts.jsonl"), "x", 400)
    const alt = lauf(d, "run-dry", 45)
    const r = raeumeCheckpointsAuf({ dir: d.ck, runsDir: d.runs, now: Date.now(), dryRun: true })
    expect(r.geloescht).toHaveLength(3)
    expect([fremd, ...alt].every(existsSync)).toBe(true)
  })

  test("Schwelle ist 30 Tage", () => {
    expect(AUFRAEUMEN_MAX_ALTER_MS).toBe(30 * TAG)
  })

  test("of-loop-Tick räumt im OPENFLOW_CHECKPOINT_DIR auf", () => {
    const d = stand()
    const alt = lauf(d, "run-tick", 40)
    const laeuft = lauf(d, "run-tick-running", 40, "running")
    const p = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "of-loop.ts"), "--runs-dir", d.runs, "--state-dir", d.ck, "--heartbeat", join(d.ck, "hb"), "--digest-dir", d.ck, "--ledger", join(d.ck, "ledger.jsonl"), "--pipelines", "keine"],
      { env: { ...process.env, OPENFLOW_CHECKPOINT_DIR: d.ck, OPENFLOW_RUNS_DIR: d.runs, OPENFLOW_LEDGER: join(d.ck, "ledger.jsonl") }, stdout: "pipe", stderr: "pipe" },
    )
    expect(p.exitCode).toBe(0)
    expect(p.stderr.toString()).toContain("3 Checkpoint-Datei(en) älter 30 Tage gelöscht (1 running behalten)")
    expect(alt.some(existsSync)).toBe(false)
    expect(laeuft.every(existsSync)).toBe(true)
  })
})
