/**
 * W2.3 (24.10.2026): ergebnis.md kürzt nur Worker-Ausgaben.
 *
 * Gemessen an 8 auto-orchestrator-Läufen der A/B-Messung: 7 von 8 lagen bei
 * genau 25 600 Byte, der Schnitt traf das Dateiende — dort stand die Kritik
 * (Log-Reihenfolge boss, worker-*, critic); in 3 Läufen fehlte sie ganz.
 * Jetzt: Synthese → Kritik → Worker, nur Worker gekürzt, volle Fassung
 * daneben, das Kritik-Urteil im Kopf (≤ 3000 Byte, den of-run.sh --wait zeigt).
 */
import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { a1Lauf, textVon } from "./ergebnis-fixture"
import {
  abschliessen,
  buildScorecard,
  ERGEBNIS_KERN_MAX_BYTES,
  ERGEBNIS_MAX_BYTES,
  ergebnisDateien,
  ergebnisMarkdown,
  ergebnisRolle,
  ergebnisVollPfad,
  kritikUrteil,
} from "./of-ergebnis"

let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "of-erg-kuerzung-"))
  dirs.push(d)
  return d
}
const bytes = (s: string) => Buffer.byteLength(s, "utf8")
const auszug = (s: string, n = 3000) => Buffer.from(s, "utf8").subarray(0, n).toString("utf8")
const sc = (log: any) => buildScorecard(log, 1, [], 0)

describe("ergebnis.md — das Wichtigste vollständig", () => {
  it("gemessene Größen (F-A1-1): Synthese und Kritik ganz, ≤ 25 KB, Worker gekürzt mit Pfad", () => {
    const log = a1Lauf()
    const { md, voll } = ergebnisDateien(log, sc(log), ERGEBNIS_MAX_BYTES, "/d")
    const out = (id: string) => log.nodes.find((n) => n.id === id)!.output
    expect(bytes(md)).toBeLessThanOrEqual(ERGEBNIS_MAX_BYTES)
    expect(md).toContain(out("boss"))
    expect(md).toContain(out("critic"))
    expect(md).toContain("ENDE-critic")
    expect(md).not.toContain("ENDE-worker-2")
    expect(md).toContain(`vollständig in ${ergebnisVollPfad("run-A1", "/d")}`)
    expect(md).not.toContain("�")
    // Jede Karte bleibt sichtbar, auch gekürzt.
    for (const n of log.nodes) expect(md).toContain(`## ${n.id} — done`)
    expect(voll).toBeDefined()
    for (const n of log.nodes) expect(voll!).toContain(n.output)
  })

  it("Reihenfolge: Synthese → Kritik → Worker, Scorecard am Ende", () => {
    const log = a1Lauf()
    const md = ergebnisMarkdown(log, sc(log))
    const at = (s: string) => md.indexOf(s)
    expect(at("## boss")).toBeLessThan(at("## critic"))
    expect(at("## critic")).toBeLessThan(at("## worker-1"))
    expect(at("## worker-1")).toBeLessThan(at("## worker-2"))
    expect(at("## worker-3")).toBeLessThan(at("## Scorecard"))
    expect(md).toContain('"verdict": "PASS"')
  })

  it("die ersten 3000 Byte (of-run.sh --wait) tragen Verdict, Kritik-Urteil und den Anfang der Synthese", () => {
    const log = a1Lauf()
    const kopf = auszug(ergebnisMarkdown(log, sc(log)))
    expect(kopf).toContain("- Verdict: PASS")
    expect(kopf).toContain("- Kritik-Urteil (critic): VERDICT: ANNEHMBAR — kein Beleg widerlegt.")
    expect(kopf).toContain("SYNTHESE: 10 von 14 Workern haben einen Canary.")
    expect(kopf).toContain("gekürzt: nur Worker-Ausgaben")
  })

  it("Wasserstand: ein kurzer Worker bleibt ganz, nur die langen werden gekürzt", () => {
    const log = a1Lauf({ boss: 8_000, "worker-1": 500, "worker-2": 12_000, "worker-3": 12_000, critic: 4_000 })
    const md = ergebnisMarkdown(log, sc(log))
    expect(bytes(md)).toBeLessThanOrEqual(ERGEBNIS_MAX_BYTES)
    expect(md).toContain(log.nodes[1].output)
    expect(md).not.toContain("ENDE-worker-2")
    expect(md).not.toContain("ENDE-worker-3")
    // Das Budget wird ausgeschöpft: nichts Großes verschenkt.
    expect(bytes(md)).toBeGreaterThan(ERGEBNIS_MAX_BYTES - 200)
  })

  it("passt alles: eine Fassung, keine volle daneben, kein Kürzungshinweis", () => {
    const log = a1Lauf({ boss: 3_000, "worker-1": 2_000, critic: 1_000 })
    const { md, voll } = ergebnisDateien(log, sc(log))
    expect(voll).toBeUndefined()
    expect(md).not.toContain("gekürzt")
    expect(md).toContain("ENDE-worker-1")
  })

  it("ausufernder Kern (> ERGEBNIS_KERN_MAX_BYTES) wird auch gekürzt — das Urteil steht trotzdem im Kopf", () => {
    const log = a1Lauf({ boss: 80_000, "worker-1": 5_000, critic: 40_000 })
    const md = ergebnisMarkdown(log, sc(log))
    expect(bytes(md)).toBeLessThan(ERGEBNIS_KERN_MAX_BYTES + 3_000)
    expect(md).toContain("und (über")
    expect(auszug(md)).toContain("Kritik-Urteil (critic): VERDICT: ANNEHMBAR")
  })

  it("Rollen: role zuerst (reviewer zählt als Kritik), ohne role die auto-orchestrator-IDs", () => {
    expect(ergebnisRolle({ id: "x", role: "orchestrator" })).toBe("synthese")
    expect(ergebnisRolle({ id: "x", role: "reviewer" })).toBe("kritik")
    expect(ergebnisRolle({ id: "critic", role: "subagent" })).toBe("worker")
    expect(ergebnisRolle({ id: "boss" })).toBe("synthese")
    expect(ergebnisRolle({ id: "critic" })).toBe("kritik")
    expect(ergebnisRolle({ id: "worker-1" })).toBe("worker")
  })

  it("Kritik-Urteil = erste nicht leere Zeile ohne #, höchstens 400 Byte", () => {
    expect(kritikUrteil("\n\n## VERDICT: ANNEHMBAR\n\nRest")).toBe("VERDICT: ANNEHMBAR")
    expect(kritikUrteil(undefined)).toBeUndefined()
    expect(kritikUrteil("  \n ")).toBeUndefined()
    const lang = kritikUrteil("ä".repeat(1000))!
    expect(bytes(lang)).toBeLessThanOrEqual(400)
    expect(lang.endsWith("…")).toBe(true)
  })

  it("abschliessen schreibt die volle Fassung daneben und räumt eine alte weg", () => {
    const dir = tmp()
    const io = { out: () => {}, err: () => {} }
    const log = a1Lauf()
    abschliessen(log, sc(log), io, dir)
    const vollPfad = ergebnisVollPfad("run-A1", dir)
    expect(existsSync(vollPfad)).toBe(true)
    for (const n of log.nodes) expect(readFileSync(vollPfad, "utf8")).toContain(n.output)
    expect(bytes(readFileSync(join(dir, "openflow-checkpoint-run-A1.ergebnis.md"), "utf8"))).toBeLessThanOrEqual(ERGEBNIS_MAX_BYTES)
    const klein = a1Lauf({ boss: 100, critic: 100 })
    abschliessen(klein, sc(klein), io, dir)
    expect(existsSync(vollPfad)).toBe(false)
  })
})

// textVon selbst: die Fixture-Größen müssen stimmen, sonst misst der Test nichts.
describe("Fixture", () => {
  it("textVon liefert genau n Byte", () => {
    for (const n of [200, 4_468, 10_075]) expect(bytes(textVon(n, "K", "E"))).toBe(n)
  })
})
