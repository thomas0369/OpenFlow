/**
 * Tests für of-reap.ts (bun test).
 *
 * Läuft of-reap.ts als Subprozess gegen ein Temp-Runs-Dir (--runs-dir).
 * Checkpoints leben fest in /tmp/openflow-checkpoint-<id>.json (Skript-Quelltext,
 * Pfad nicht konfigurierbar) — daher eindeutige Test-IDs, damit keine echten
 * Run-Checkpoints getroffen werden; Cleanup in afterEach. Es wird nirgendwo
 * in echte Runs, $HOME oder ~/.openflow geschrieben.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const REAP = join(import.meta.dir, "of-reap.ts")

let runsDir: string
let checkpointFiles: string[] = []
let seq = 0

const uniqId = () => `reaptest-${Date.now()}-${process.pid}-${seq++}`

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "of-reap-test-runs-"))
  checkpointFiles = []
})

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true })
  for (const p of checkpointFiles) rmSync(p, { force: true })
})

function writeRun(file: string, log: unknown) {
  writeFileSync(file, JSON.stringify(log, null, 2))
}

function setCheckpoint(id: string, ageMin: number): string {
  const p = `/tmp/openflow-checkpoint-${id}.json`
  writeFileSync(p, "{}")
  const t = new Date(Date.now() - ageMin * 60_000)
  utimesSync(p, t, t)
  checkpointFiles.push(p)
  return p
}

function reap(args: string[]) {
  const proc = Bun.spawnSync(["bun", REAP, "--runs-dir", runsDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

describe("of-reap", () => {
  it("lässt frischen Checkpoint stehen (kein Reap)", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() })
    setCheckpoint(id, 0) // mtime: jetzt
    const r = reap(["--min-age-min", "1", "--grace-min", "5"])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("0 Zombie(s) geborgen")
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("running")
  })

  it("reappt alten Checkpoint jenseits der Schwelle", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 120 * 60_000 })
    setCheckpoint(id, 60) // 60 min stumm, Schwelle 30
    const r = reap(["--min-age-min", "30", "--grace-min", "5"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("stopped")
    expect(log.error).toMatch(/^reaped: zombie — checkpoint seit \d+ min stumm/)
    expect(log.reaped.reason).toContain("stumm")
    expect(log.finished).toBeNumber()
  })

  it("respektiert Grace: fehlender Checkpoint, started innerhalb --grace-min → kein Reap", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 2 * 60_000 })
    const r = reap(["--grace-min", "5", "--min-age-min", "30"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("running")
  })

  it("reappt fehlenden Checkpoint nach Ablauf der Grace", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 10 * 60_000 })
    const r = reap(["--grace-min", "5", "--min-age-min", "30"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("stopped")
    expect(log.error).toContain("kein Checkpoint")
    expect(log.reaped.reason).toContain("Grace 5 min")
  })

  it("überspringt kaputte JSON-Datei ohne Exception und ohne Änderung", () => {
    const file = join(runsDir, `broken-${uniqId()}.json`)
    writeFileSync(file, "{nicht gültiges json")
    const empty = join(runsDir, `empty-${uniqId()}.json`)
    writeFileSync(empty, "")
    const r = reap([])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("2 runs geprüft, 0 Zombie(s) geborgen")
    expect(readFileSync(file, "utf8")).toBe("{nicht gültiges json")
    expect(readFileSync(empty, "utf8")).toBe("")
  })

  it("dry-run meldet Kandidaten, ändert aber nichts", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "running", started: Date.now() - 120 * 60_000 })
    setCheckpoint(id, 60)
    const r = reap(["--min-age-min", "30", "--grace-min", "5", "--dry-run"])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain(`DRY ${id}.json`)
    expect(r.stdout).toContain("1 Zombie(s) gefunden (dry-run)")
    // Datei unangetastet, kein Reaping-Rest
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("running")
    expect(log.reaped).toBeUndefined()
    expect(existsSync(`${file}.reaping`)).toBe(false)
  })

  it("lässt Runs ohne status=running unberührt", () => {
    const id = uniqId()
    const file = join(runsDir, `${id}.json`)
    writeRun(file, { id, status: "done", started: Date.now() - 999 * 60_000 })
    const r = reap(["--grace-min", "0", "--min-age-min", "1"])
    expect(r.code).toBe(0)
    const log = JSON.parse(readFileSync(file, "utf8"))
    expect(log.status).toBe("done")
    expect(log.reaped).toBeUndefined()
  })
})
