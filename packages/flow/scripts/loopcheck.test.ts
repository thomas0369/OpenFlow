/**
 * T-05 (B1, 28.10.2026) — of-loopcheck zählt offene Alerts aus dem
 * Aktiv-Zustand, nicht aus der Historie; `--ack` quittiert ins Archiv.
 *
 * Befund: eine I3-Zeile vom 16.10. in of-loop-alerts.jsonl hielt die Sonde zwölf
 * Tage ROT, obwohl der Aktiv-Zustand `{}` war und computeI3 70,8 % maß.
 *
 * Alles läuft in einem Temp-Verzeichnis: OPENFLOW_LOOP_DIR, _LOOP_HEARTBEAT,
 * _RUNS_DIR, _LEDGER und _CHECKPOINT_DIR zeigen dorthin — die echten
 * /tmp/of-loop-*-Dateien und das echte Ledger werden nie gelesen oder geschrieben.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EREIGNIS_ALERTS, offeneAlerts, teileAlerts } from "./of-loop-logik"

const BASIS = mkdtempSync(join(tmpdir(), "of-loopcheck-"))
afterAll(() => rmSync(BASIS, { recursive: true, force: true }))
const H = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString()
const zeile = (invariante: string, ts: number) => JSON.stringify({ ts: iso(ts), invariante, wert: "w", schwelle: "s", art: "neu" })

let n = 0
function fall(o: { alerts: string[]; aktiv?: Record<string, unknown> | "kaputt" }) {
  const dir = join(BASIS, `fall-${n++}`)
  mkdirSync(join(dir, "runs"), { recursive: true })
  writeFileSync(join(dir, "hb"), JSON.stringify({ ts: iso(Date.now()) }))
  writeFileSync(join(dir, "of-loop-alerts.jsonl"), o.alerts.map((z) => z + "\n").join(""))
  if (o.aktiv !== undefined) writeFileSync(join(dir, "of-loop-alerts-aktiv.json"), o.aktiv === "kaputt" ? "{halb" : JSON.stringify(o.aktiv))
  return dir
}

function sonde(dir: string, args: string[] = ["--json"]) {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "of-loopcheck.ts"), ...args], {
    env: {
      ...process.env,
      OPENFLOW_LOOP_DIR: dir,
      OPENFLOW_LOOP_HEARTBEAT: join(dir, "hb"),
      OPENFLOW_RUNS_DIR: join(dir, "runs"),
      OPENFLOW_LEDGER: join(dir, "ledger.jsonl"),
      OPENFLOW_CHECKPOINT_DIR: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}
const urteil = (dir: string) => JSON.parse(sonde(dir).out) as { verdict: string; problems: string[]; facts: Record<string, unknown> }

describe("T-05 of-loopcheck — offene Alerts aus dem Aktiv-Zustand", () => {
  test("Altzeile ohne Aktiv-Eintrag → GRÜN (der Befund vom 28.10.)", () => {
    const dir = fall({ alerts: [zeile("I3-regeltreue", Date.parse("2026-10-16T23:12:51Z"))], aktiv: {} })
    const r = sonde(dir)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out).verdict).toBe("GRÜN")
  })

  test("Invariante im Aktiv-Zustand → ROT, mit Quittungs-Hinweis", () => {
    const dir = fall({
      alerts: [zeile("I3-regeltreue", Date.now() - 50 * H)],
      aktiv: { "I3-regeltreue": { wert: "w", erstes_ts: iso(Date.now() - 50 * H), letzte_bestaetigung: iso(Date.now() - H) } },
    })
    const r = sonde(dir)
    expect(r.code).toBe(1)
    const u = JSON.parse(r.out)
    expect(u.verdict).toBe("ROT")
    expect(u.problems.join("\n")).toContain("I1-3: 1 offene Alerts")
    expect(u.problems.join("\n")).toContain("--loop-ack")
  })

  test("Aktiv-Datei fehlt → konservativ: Zeile der letzten 24 h zählt (ROT), ältere nicht", () => {
    expect(urteil(fall({ alerts: [zeile("I2-failquote24h", Date.now() - 2 * H)] })).verdict).toBe("ROT")
    const alt = urteil(fall({ alerts: [zeile("I2-failquote24h", Date.now() - 30 * H)] }))
    expect(alt.verdict).toBe("GRÜN")
    expect(alt.facts.alertQuelle).toBe("jsonl (24 h, Aktiv-Zustand fehlt)")
  })

  test("kaputte Aktiv-Datei gilt als fehlend (24-h-Fallback), nicht als leer", () => {
    expect(urteil(fall({ alerts: [zeile("I3-regeltreue", Date.now() - H)], aktiv: "kaputt" })).verdict).toBe("ROT")
  })

  test("I5-fehlerserie (Ereignis) bleibt ROT ohne Aktiv-Eintrag — bis zur Quittung", () => {
    const dir = fall({ alerts: [zeile("I5-fehlerserie", Date.now() - 72 * H)], aktiv: {} })
    expect(urteil(dir).verdict).toBe("ROT")
    const ack = sonde(dir, ["--ack", "I5-fehlerserie"])
    expect(ack.code).toBe(0)
    expect(ack.out).toContain("1 Alert-Zeile(n) quittiert")
    expect(urteil(dir).verdict).toBe("GRÜN")
    expect(readFileSync(join(dir, "of-loop-alerts.archiv.jsonl"), "utf8")).toContain("I5-fehlerserie")
  })

  test("--ack <invariante> verschiebt nur passende Zeilen; ohne Argument alle", () => {
    const dir = fall({ alerts: [zeile("I3-regeltreue", Date.now()), zeile("I1-zombies", Date.now()), zeile("I3-regeltreue", Date.now())] })
    sonde(dir, ["--ack", "I3-regeltreue"])
    const rest = readFileSync(join(dir, "of-loop-alerts.jsonl"), "utf8").trim().split("\n")
    expect(rest).toHaveLength(1)
    expect(rest[0]).toContain("I1-zombies")
    expect(readFileSync(join(dir, "of-loop-alerts.archiv.jsonl"), "utf8").trim().split("\n")).toHaveLength(2)
    sonde(dir, ["--ack"])
    expect(readFileSync(join(dir, "of-loop-alerts.jsonl"), "utf8")).toBe("")
    expect(readFileSync(join(dir, "of-loop-alerts.archiv.jsonl"), "utf8").trim().split("\n")).toHaveLength(3)
  })

  test("--ack ohne Treffer ändert nichts und legt kein Archiv an", () => {
    const dir = fall({ alerts: [zeile("I1-zombies", Date.now())] })
    expect(sonde(dir, ["--ack", "I9-gibtsnicht"]).out).toContain("0 Alert-Zeile(n) quittiert")
    expect(existsSync(join(dir, "of-loop-alerts.archiv.jsonl"))).toBe(false)
    expect(readFileSync(join(dir, "of-loop-alerts.jsonl"), "utf8")).toContain("I1-zombies")
  })

  test("of-run.sh --loop-ack reicht an die Sonde weiter (ohne Guard, ohne Ledger)", () => {
    const dir = fall({ alerts: [zeile("I3-regeltreue", Date.now())] })
    const p = Bun.spawnSync(["bash", join(import.meta.dir, "of-run.sh"), "--loop-ack", "I3-regeltreue"], {
      env: { ...process.env, OPENFLOW_LOOP_DIR: dir, OPENFLOW_LEDGER: join(dir, "ledger.jsonl"), BUN: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toContain("1 Alert-Zeile(n) quittiert")
    expect(existsSync(join(dir, "ledger.jsonl"))).toBe(false)
  })
})

describe("offeneAlerts / teileAlerts (rein)", () => {
  const jetzt = Date.parse("2026-10-28T12:00:00Z")
  test("unparsebare Zeilen zählen nie; Ereignis-Liste enthält I5", () => {
    expect(offeneAlerts(["{halb", "", zeile("I1-zombies", jetzt)], null, jetzt)).toHaveLength(1)
    expect(EREIGNIS_ALERTS.has("I5-fehlerserie")).toBe(true)
  })
  test("Grenze 24 h: genau 24 h alt zählt noch, eine Sekunde älter nicht", () => {
    expect(offeneAlerts([zeile("I1-zombies", jetzt - 24 * H)], null, jetzt)).toHaveLength(1)
    expect(offeneAlerts([zeile("I1-zombies", jetzt - 24 * H - 1000)], null, jetzt)).toHaveLength(0)
  })
  test("teileAlerts lässt Unparsebares stehen", () => {
    const t = teileAlerts(["{halb", zeile("I1-zombies", jetzt)])
    expect(t.bleiben).toEqual(["{halb"])
    expect(t.archiv).toHaveLength(1)
  })
})
