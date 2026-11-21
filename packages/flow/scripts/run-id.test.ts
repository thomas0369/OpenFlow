/**
 * `run-id: <id>` im Log (21.11.2026): sobald headless-run die ID kennt, eine
 * eigene stderr-Zeile, einmal je ID — ein Retry mit neuer ID meldet sie neu,
 * Leser nehmen die letzte.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runIdMelder, runIdZeile } from "./of-ergebnis"

describe("runIdMelder", () => {
  it("meldet jede ID genau einmal, in genau dieser Form", () => {
    const zeilen: string[] = []
    const melde = runIdMelder((z) => zeilen.push(z))
    melde("run-a")
    melde("run-a")
    melde("run-a")
    melde("run-b")
    melde("run-a")
    expect(zeilen).toEqual(["run-id: run-a", "run-id: run-b"])
    expect(runIdZeile("run-x")).toMatch(/^run-id: run-x$/)
  })

  it("ohne ID nichts", () => {
    const zeilen: string[] = []
    const melde = runIdMelder((z) => zeilen.push(z))
    melde(undefined)
    melde("")
    expect(zeilen).toEqual([])
  })

  it("headless-run meldet in onRun, vor dem Checkpoint-Schreiben", () => {
    const quelle = readFileSync(join(import.meta.dir, "headless-run.ts"), "utf8")
    const onRun = quelle.slice(quelle.indexOf("onRun: (current"), quelle.indexOf("onNotice:"))
    expect(onRun).toContain("meldeRunId(current.id)")
    expect(onRun.indexOf("meldeRunId(current.id)")).toBeLessThan(onRun.indexOf("checkpointPfad(current.id)"))
  })
})
