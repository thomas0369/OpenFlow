/**
 * bench.test.ts — Nachrechnen (--auswerten) prüft den abhängigen Fix von B2 (Abnahme R3, B7).
 * Anlass: fix_ok war für alle B2-Läufe null, weil der Auswertemodus das Lauf-Verzeichnis nur aus
 * --verzeichnis kannte. Jetzt kommt es aus der Sitzung (session_v2.directory).
 */
import { Database } from "bun:sqlite"
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auswerten, fixPruefen, verzeichnisAusDb } from "./bench"

const tmp = mkdtempSync(join(tmpdir(), "bench-b7-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

function fixture(name: string, gefixt: boolean): string {
  const ziel = join(tmp, name)
  const r = spawnSync("bash", [join(import.meta.dir, "fixture.sh"), ziel], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(r.stderr)
  if (gefixt) writeFileSync(join(ziel, "delta/src/rechne.js"), "function add(a, b) { return a + b; }\nmodule.exports = { add };\n")
  return ziel
}

const ANTWORT = "delta D-7720, alpha A-4417, beta B-9062, gamma G-1385"

function db(sitzungen: Array<[string, string]>): string {
  const pfad = join(tmp, `db-${Math.random().toString(36).slice(2)}.db`)
  const d = new Database(pfad)
  d.run("create table session_v2 (id text primary key, directory text not null)")
  d.run("create table session_message (id text primary key, session_id text, type text, seq integer, data text)")
  for (const [sid, dir] of sitzungen) {
    d.run("insert into session_v2 values (?, ?)", [sid, dir])
    d.run("insert into session_message values (?, ?, 'user', 1, ?)", [`${sid}-1`, sid, JSON.stringify({ text: "auftrag" })])
    d.run("insert into session_message values (?, ?, 'assistant', 2, ?)", [
      `${sid}-2`,
      sid,
      JSON.stringify({ content: [{ type: "text", text: ANTWORT }] }),
    ])
  }
  d.close()
  return pfad
}

describe("bench --auswerten: Fix-Prüfung B2", () => {
  const gut = fixture("B2-gut", true)
  const kaputt = fixture("B2-kaputt", false)
  const pfad = db([
    ["ses_gut", gut],
    ["ses_kaputt", kaputt],
    ["ses_weg", join(tmp, "gibt-es-nicht")],
  ])

  it("Verzeichnis kommt aus der Sitzung", () => {
    expect(verzeichnisAusDb(pfad, "ses_gut")).toBe(gut)
    expect(verzeichnisAusDb(pfad, "ses_unbekannt")).toBeNull()
  })

  it("gefixtes delta → fix_ok true, ohne --verzeichnis", () => {
    const r = auswerten(pfad, "ses_gut", "B2")
    expect(r.verzeichnis).toBe(gut)
    expect(r.fix_ok).toBe(true)
  })

  it("Gegenprobe: ungefixtes delta → fix_ok false, alle_korrekt false trotz richtiger Codes", () => {
    const r = auswerten(pfad, "ses_kaputt", "B2")
    expect(r.fix_ok).toBe(false)
    expect(r.alle_korrekt).toBe(false)
  })

  it("Verzeichnis fehlt → null (ungeprüft), nicht false", () => {
    expect(auswerten(pfad, "ses_weg", "B2").fix_ok).toBeNull()
    expect(fixPruefen("B2", null)).toBeNull()
  })

  it("--verzeichnis überstimmt die Sitzung", () => {
    expect(auswerten(pfad, "ses_gut", "B2", kaputt).fix_ok).toBe(false)
  })

  it("andere Aufgaben prüfen keinen Fix", () => {
    expect(fixPruefen("B1", gut)).toBeNull()
  })
})
