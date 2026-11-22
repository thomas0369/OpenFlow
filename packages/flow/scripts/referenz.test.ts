/**
 * Referenzaufgaben (22.11.2026): Messdaten für die Template-Wahl. Geprüft wird
 * der Katalog und der Runner im --dry-run — gestartet wird hier nichts.
 */

import { describe, expect, test } from "bun:test"
import { auswahl, befehl, ladeAufgaben } from "./of-referenz"

describe("referenz-aufgaben.json", () => {
  test("je 3 Aufgaben für artikel, code-fix, analyse, review; eindeutige ids; jede schreibt nur in {ordner}", async () => {
    const aufgaben = await ladeAufgaben()
    const je = Map.groupBy(aufgaben, (a) => a.klasse)
    expect([...je.keys()].sort()).toEqual(["analyse", "artikel", "code-fix", "review"])
    expect([...je.values()].map((l) => l.length)).toEqual([3, 3, 3, 3])
    expect(new Set(aufgaben.map((a) => a.id)).size).toBe(aufgaben.length)
    for (const a of aufgaben) {
      expect(a.text).toContain("{ordner}")
      expect(a.text).toContain("Schreibe nichts außerhalb von {ordner}.")
      expect(a.text).toMatch(/Sollwert/)
    }
  })
})

describe("of-referenz", () => {
  test("auswahl nach Klasse und id; befehl setzt den Unterordner ein", async () => {
    const aufgaben = await ladeAufgaben()
    expect(auswahl(aufgaben, { klasse: "review" }).map((a) => a.id)).toEqual(["review-1", "review-2", "review-3"])
    expect(auswahl(aufgaben, { id: "code-fix-2" })).toHaveLength(1)
    const b = befehl(auswahl(aufgaben, { id: "code-fix-1" })[0]!, "/tmp/ref", "auto-orchestrator")
    expect(b.dir).toBe("/tmp/ref/code-fix-1")
    expect(b.klasse).toBe("code-fix")
    expect(b.argv.slice(2, 4)).toEqual(["--wait", "auto-orchestrator"])
    expect(b.argv[4]).not.toContain("{ordner}")
    expect(b.argv[4]).toContain("bun test /tmp/ref/code-fix-1/summe.test.ts")
  })

  test("--dry-run startet nichts und nennt Klasse und Befehl", async () => {
    const p = Bun.spawn(["bun", `${import.meta.dir}/of-referenz.ts`, "--ordner", "/tmp/of-referenz-nie", "--klasse", "artikel", "--dry-run"], { stdout: "pipe" })
    const out = await new Response(p.stdout).text()
    expect(await p.exited).toBe(0)
    expect(out.trim().split("\n")).toHaveLength(3)
    expect(out).toContain("[dry-run] artikel-1 OPENFLOW_KLASSE=artikel bash ")
    expect(await Bun.file("/tmp/of-referenz-nie").exists()).toBe(false)
  })
})
