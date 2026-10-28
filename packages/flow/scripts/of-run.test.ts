/**
 * of-run.sh — Schalter-Prüfung (Abnahme R18 K10).
 *
 * `of-run.sh --status` startete einen Lauf mit der Pipeline „--status"
 * (404 im Flow-Store, uncaughtException im Log). Ein unbekannter `--`-Schalter
 * muss mit Usage abgelehnt werden, Exit ≠ 0, und es darf KEIN Lauf entstehen.
 *
 * `BUN` zeigt auf ein Protokoll-Skript statt auf bun: jeder Aufruf, den
 * of-run.sh absetzt (Guard, Reap, headless-run), landet als Zeile in einer
 * Datei — ohne Engine, ohne echten Lauf.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { a1Lauf } from "./ergebnis-fixture"
import { echteStarts } from "./of-fabrik-aufruf"
import { buildScorecard, ergebnisMarkdown } from "./of-ergebnis"
import { nochmalVersuchen } from "./of-lauf"

const OF_RUN = join(import.meta.dir, "of-run.sh")
// Der detached-Start braucht setsid (POSIX/util-linux). Git Bash auf den
// Windows-Runnern hat es nicht — dort bricht of-run.sh den detached-Start
// seit dem Windows-CI-Fix laut ab (Exit 4), statt PID=/LOG= für einen Lauf zu
// melden, den es nie gab. Tests, die einen ERFOLGREICHEN detached-Start
// zusichern, laufen deshalb nur mit setsid; den Abbruch sichert
// „detached ohne setsid" unten auf beiden Plattformen zu.
const SETSID = Bun.which("setsid")

/** PATH ohne setsid: auf Windows der echte, sonst ein Spiegel aller PATH-Programme außer setsid. */
function pathOhneSetsid(dir: string): string {
  if (SETSID === null) return process.env.PATH ?? ""
  const bin = join(dir, "ohne-setsid")
  mkdirSync(bin)
  for (const quelle of (process.env.PATH ?? "").split(":")) {
    if (!existsSync(quelle)) continue
    for (const name of readdirSync(quelle)) {
      if (name === "setsid" || existsSync(join(bin, name))) continue
      try {
        symlinkSync(join(quelle, name), join(bin, name))
      } catch {
        /* Name doppelt oder unlesbar: der erste Treffer gewinnt, wie im PATH */
      }
    }
  }
  return bin
}
let dirs: string[] = []
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function lauf(...args: string[]) {
  return laufEnv({}, ...args)
}
function laufEnv(extraEnv: Record<string, string>, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "of-run-test-"))
  dirs.push(dir)
  const protokoll = join(dir, "aufrufe.txt")
  const fakeBun = join(dir, "bun")
  writeFileSync(fakeBun, `#!/usr/bin/env bash\necho "$*" >> "${protokoll}"\nexit 0\n`)
  chmodSync(fakeBun, 0o755)
  const p = Bun.spawnSync(["bash", OF_RUN, ...args], {
    // OPENFLOW_LEDGER: seit Defekt 5 schreibt of-run.sh einen gescheiterten Start ins Ledger — nie ins echte.
    env: { ...process.env, BUN: fakeBun, OPENFLOW_ENGINE: "", OPENFLOW_LOG_DIR: dir, OPENFLOW_LEDGER: join(dir, "ledger.jsonl"), ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  })
  const aufrufe = existsSync(protokoll) ? readFileSync(protokoll, "utf8").trim().split("\n").filter(Boolean) : []
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString(), aufrufe }
}

describe("K10 (R18) — unbekannte Schalter starten keinen Lauf", () => {
  for (const schalter of ["--status", "--help-me", "--wait --bogus", "--spread --x"]) {
    test(`of-run.sh ${schalter} → Usage, Exit 2, kein headless-run`, () => {
      const r = lauf(...schalter.split(" "), "aufgabe")
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain("unbekannter Schalter")
      expect(r.stderr).toContain("usage")
      expect(r.aufrufe.some((a) => a.includes("headless-run.ts"))).toBe(false)
      expect(r.stdout).not.toContain("LOG=")
    })
  }

  test.skipIf(SETSID === null)("Kontrollwert: ein gültiger Pipeline-Name startet headless-run (detached)", () => {
    const r = lauf("auto-orchestrator", "aufgabe", "--mit-strich-im-text")
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("LOG=")
    // detached: der Aufruf kann einen Moment nach dem Exit im Protokoll landen
    const ende = Date.now() + 3000
    let aufrufe = r.aufrufe
    while (!aufrufe.some((a) => a.includes("headless-run.ts")) && Date.now() < ende) {
      Bun.sleepSync(50)
      const p = join(dirs[dirs.length - 1]!, "aufrufe.txt")
      aufrufe = existsSync(p) ? readFileSync(p, "utf8").trim().split("\n") : []
    }
    expect(aufrufe.some((a) => a.includes("headless-run.ts") && a.includes("auto-orchestrator"))).toBe(true)
  })

  // Läuft auf BEIDEN Plattformen: auf Windows fehlt setsid wirklich, unter
  // Linux nimmt ein PATH-Spiegel es weg. Vorher meldete of-run.sh dort
  // PID=/LOG= mit Exit 0, und kein headless-run lief.
  test("detached ohne setsid: lauter Abbruch (Exit 4), kein LOG=, kein headless-run, Ledger-Zeile", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-run-ohne-setsid-"))
    dirs.push(dir)
    const r = laufEnv({ PATH: pathOhneSetsid(dir) }, "auto-orchestrator", "aufgabe")
    expect(r.exitCode).toBe(4)
    expect(r.stderr).toContain("setsid fehlt")
    expect(r.stdout).not.toContain("LOG=")
    expect(r.stdout).not.toContain("PID=")
    expect(r.aufrufe.some((a) => a.includes("headless-run.ts"))).toBe(false)
    const ledgerPfad = join(dirs[dirs.length - 1]!, "ledger.jsonl")
    const zeilen = readFileSync(ledgerPfad, "utf8").trim().split("\n").map((z) => JSON.parse(z))
    expect(zeilen.at(-1)).toMatchObject({ event: "fabrik_start_fehlgeschlagen", exit: 4, grund: "setsid fehlt (detached nur unter POSIX)" })
  })

  test("detached ohne setsid, aber --wait: startet trotzdem (braucht kein setsid)", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-run-ohne-setsid-"))
    dirs.push(dir)
    const r = laufEnv({ PATH: pathOhneSetsid(dir) }, "--wait", "auto-orchestrator", "aufgabe")
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("LOG=")
    expect(r.aufrufe.some((a) => a.includes("headless-run.ts") && a.includes("auto-orchestrator"))).toBe(true)
  })

  test("Kontrollwert: --scorecard bleibt ein bekannter Schalter", () => {
    const r = lauf("--scorecard", "--limit", "3")
    expect(r.exitCode).toBe(0)
    expect(r.aufrufe.some((a) => a.includes("of-scorecard.ts") && a.includes("--limit 3"))).toBe(true)
  })
})

/**
 * Defekt 5 (17.10.2026 13:30): ein Fabrik-Start hinterließ weder Log noch Run.
 * Ursache (opencode-Datenbank): der Agent rief das Shell-Werkzeug mit
 * `timeout: 60` — Millisekunden. Die Shell wurde beendet, bevor of-run.sh das
 * Log anlegte (Reap und Guard laufen davor); Ausgabe „(no output)", Ledger
 * führte den Start als fabrik_run. Jeder Abbruch VOR dem Start blieb still.
 * Jetzt: Exit ≠ 0 UND eine Ledger-Zeile event=fabrik_start_fehlgeschlagen.
 */
function laufMit(bunSkript: string, args: string[], signalNachMs?: number, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "of-run-frueh-"))
  dirs.push(dir)
  const fakeBun = join(dir, "bun")
  writeFileSync(fakeBun, `#!/usr/bin/env bash\n${bunSkript}\n`)
  chmodSync(fakeBun, 0o755)
  const ledger = join(dir, "ledger.jsonl")
  // eigene Prozessgruppe (setsid): das Shell-Werkzeug beendet bei Timeout die
  // ganze Gruppe, nicht nur bash — sonst wartet bash den Kindprozess ab.
  const gruppe = signalNachMs !== undefined && SETSID !== null
  const p = Bun.spawn(gruppe ? [SETSID!, "bash", OF_RUN, ...args] : ["bash", OF_RUN, ...args], {
    env: { ...process.env, BUN: fakeBun, OPENFLOW_ENGINE: "", OPENFLOW_LOG_DIR: dir, OPENFLOW_LEDGER: ledger, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (signalNachMs !== undefined) setTimeout(() => process.kill(-p.pid, "SIGTERM"), signalNachMs)
  return p.exited.then(async (exitCode) => ({
    exitCode,
    stdout: await new Response(p.stdout).text(),
    stderr: await new Response(p.stderr).text(),
    ledger: existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((z) => JSON.parse(z)) : [],
  }))
}

describe("Defekt 5 — früher Abbruch vor dem Log wird sichtbar", () => {
  // Prozessgruppen-Signal braucht setsid (POSIX); auf Windows gibt es weder das eine noch das andere.
  test.skipIf(SETSID === null)("SIGTERM während des Reaps (wie der 60-ms-Timeout): Exit ≠ 0 + Ledger-Zeile", async () => {
    // Reap hängt (sleep), headless-run wird nie erreicht
    const r = await laufMit(`case "$*" in *of-reap.ts*) sleep 5;; esac; exit 0`, ["auto-orchestrator", "aufgabe"], 300)
    expect(r.exitCode).not.toBe(0)
    expect(r.stdout).not.toContain("LOG=")
    expect(r.ledger).toHaveLength(1)
    expect(r.ledger[0]).toMatchObject({ event: "fabrik_start_fehlgeschlagen", quelle: "of-run.sh", pipeline: "auto-orchestrator" })
    expect(String(r.ledger[0].grund)).toContain("TERM")
    expect(r.stderr).toContain("Start abgebrochen")
  })

  test("Guard lehnt ab (Exit 3): Exit 3 + Ledger-Zeile mit Grund", async () => {
    const r = await laufMit(`case "$*" in *of-guard.ts*) echo "verschachtelt" >&2; exit 3;; esac; exit 0`, ["auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(3)
    expect(r.ledger).toHaveLength(1)
    expect(r.ledger[0]).toMatchObject({ event: "fabrik_start_fehlgeschlagen", exit: 3 })
  })

  test("Session und aufruf_id aus der Umgebung (setzt das Plugin) → Scorecard zieht den Start ab", async () => {
    const r = await laufMit(`case "$*" in *of-guard.ts*) exit 3;; esac; exit 0`, ["auto-orchestrator", "x"], undefined, {
      OPENFLOW_SESSION: "ses_P", OPENFLOW_AUFRUF_ID: "call_P",
    })
    expect(r.ledger[0]).toMatchObject({ session_id: "ses_P", aufruf_id: "call_P" })
    const start = { ts: "2026-10-23T10:00:00Z", event: "fabrik_run", art: "start", aufruf_id: "call_P" }
    expect(echteStarts([start, ...r.ledger])).toEqual([])
  })

  test("unbekannter Schalter: Exit 2 + Ledger-Zeile", async () => {
    const r = await laufMit(`exit 0`, ["--status"])
    expect(r.exitCode).toBe(2)
    expect(r.ledger[0]).toMatchObject({ event: "fabrik_start_fehlgeschlagen", exit: 2 })
  })

  test.skipIf(SETSID === null)("Kontrollwert: erfolgreicher Start schreibt KEINE Fehlerzeile", async () => {
    const r = await laufMit(`exit 0`, ["auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("LOG=")
    // seit dem Lauf-Anker steht dort genau EIN fabrik_log — aber keine Fehlerzeile
    expect(r.ledger.filter((z: any) => z.event === "fabrik_start_fehlgeschlagen")).toHaveLength(0)
    expect(r.ledger.map((z: any) => z.event)).toEqual(["fabrik_log"])
  })

  test("Kontrollwert: Monitoring (--scorecard) schreibt nie ins Ledger", async () => {
    const r = await laufMit(`exit 0`, ["--scorecard"])
    expect(r.exitCode).toBe(0)
    expect(r.ledger).toHaveLength(0)
  })
})

/**
 * T-03 (Plan „Autonomie 10/10", A9) + Zusatz W0: `--wait` gibt den Exit-Code
 * des Runs zurück (vorher `|| true` → immer 0) und schreibt eine
 * Zusammenfassung auf stdout — denn opencode liefert die stdout eines
 * Hintergrund-Shellbefehls als Fertig-Meldung an die Eltern-Sitzung (Spike W0,
 * 18/18). Vorher stand dort nur `LOG=<pfad>`: die Meldung trug kein Ergebnis.
 *
 * Der Fake-headless-run schreibt, was der echte am Ende schreibt (verdict:,
 * checkpoint:, ergebnis:) und eine echte ergebnis.md.
 */
describe("T-03 of-run.sh --wait: Exit-Code und Zusammenfassung", () => {
  function fakeLauf(rc: number, verdict: string | null, ergebnisText: string | null) {
    const ziel = mkdtempSync(join(tmpdir(), "of-run-wait-erg-"))
    dirs.push(ziel)
    const cp = join(ziel, "openflow-checkpoint-run-W.json")
    const erg = join(ziel, "openflow-checkpoint-run-W.ergebnis.md")
    if (ergebnisText !== null) writeFileSync(erg, ergebnisText)
    const zeilen = verdict === null
      ? [`echo "[boss] running" >&2`]
      : [
          `echo "=== boss ==="`,
          `echo "Modelltext mit eigener Zeile:"`,
          `echo "ergebnis: /tmp/FALSCH.md"`,
          `echo "checkpoint: ${cp}"`,
          `echo "verdict: ${verdict} · run run-W"`,
          ...(ergebnisText !== null ? [`echo "ergebnis: ${erg}"`] : []),
        ]
    return { skript: `case "$*" in *headless-run.ts*) ${zeilen.join("; ")}; exit ${rc};; esac; exit 0`, cp, erg }
  }
  const zeilen = (s: string) => s.trimEnd().split("\n")

  test("PASS: Exit 0, LOG= zuerst, Verdict, Anfang der ergebnis.md, ergebnis: als letzte Zeile", async () => {
    const f = fakeLauf(0, "PASS", "# Ergebnis run-W\n\nDer Bericht steht hier.\n")
    const r = await laufMit(f.skript, ["--wait", "auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(0)
    const z = zeilen(r.stdout)
    expect(z[0]).toMatch(/^LOG=.+\.log$/)
    expect(r.stdout).toContain("verdict: PASS")
    expect(r.stdout).toContain("Der Bericht steht hier.")
    expect(r.stdout).toContain(`checkpoint: ${f.cp}`)
    expect(z[z.length - 1]).toBe(`ergebnis: ${f.erg}`)
  })

  test("FAIL: Exit = Exit des Runs (1), Verdict FAIL", async () => {
    const f = fakeLauf(1, "FAIL", "# Ergebnis run-W\n\nKarte boss: error\n")
    const r = await laufMit(f.skript, ["--wait", "auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain("verdict: FAIL")
    expect(r.stdout).toContain("exit: 1")
    expect(zeilen(r.stdout).at(-1)).toBe(`ergebnis: ${f.erg}`)
  })

  test("lange ergebnis.md: Auszug ~3000 Zeichen, gekürzt mit Hinweis", async () => {
    const lang = "# Ergebnis\n" + "x".repeat(10_000) + "\nENDE-MARKE\n"
    const f = fakeLauf(0, "PASS", lang)
    const r = await laufMit(f.skript, ["--wait", "auto-orchestrator", "aufgabe"])
    expect(r.stdout).toContain("gekürzt: 3000 von")
    expect(r.stdout).not.toContain("ENDE-MARKE")
    expect(r.stdout.length).toBeLessThan(4_500)
  })

  test("W2.3: echte ergebnis.md über 25 KB (gemessene Größen F-A1-1) — Auszug trägt Kritik-Urteil und Synthese-Anfang", async () => {
    const log = a1Lauf()
    const f = fakeLauf(0, "PASS", ergebnisMarkdown(log, buildScorecard(log, 1, [], 0)))
    const r = await laufMit(f.skript, ["--wait", "auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("Kritik-Urteil (critic): VERDICT: ANNEHMBAR")
    expect(r.stdout).toContain("SYNTHESE: 10 von 14 Workern haben einen Canary.")
    expect(r.stdout).toContain("gekürzt: 3000 von")
    // Byte 3000 liegt hier mitten in einem „ü" — iconv darf den Abschluss nicht abbrechen.
    expect(zeilen(r.stdout).at(-1)).toBe(`ergebnis: ${f.erg}`)
  })

  test("Lauf stirbt ohne Abschluss (SIGKILL-artig, Exit 137): Exit 137, Verdict UNBEKANNT, Log-Ende", async () => {
    const f = fakeLauf(137, null, null)
    const r = await laufMit(f.skript, ["--wait", "auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(137)
    expect(r.stdout).toContain("verdict: UNBEKANNT")
    expect(r.stdout).toContain("[boss] running")
  })

  test.skipIf(SETSID === null)("Kontrollwert: detached bleibt bei PID=/LOG= und Exit 0", async () => {
    const r = await laufMit(`exit 0`, ["auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("PID=")
    expect(r.stdout).not.toContain("verdict:")
    expect(r.ledger.filter((z: any) => z.event === "fabrik_ende")).toEqual([])
  })

  test("B5b: --wait schreibt nach dem Ende fabrik_ende mit Exit, Log, Sitzung und aufruf_id", async () => {
    const f = fakeLauf(137, null, null)
    const r = await laufMit(f.skript, ["--wait", "auto-orchestrator", "aufgabe"], undefined, {
      OPENFLOW_SESSION: "ses_B5B",
      OPENFLOW_AUFRUF_ID: "call_B5B",
    })
    const log = zeilen(r.stdout)[0]!.replace(/^LOG=/, "")
    expect(r.ledger).toEqual([
      expect.objectContaining({ event: "fabrik_log", quelle: "of-run.sh", log, session_id: "ses_B5B", aufruf_id: "call_B5B" }),
      expect.objectContaining({ event: "fabrik_ende", quelle: "of-run.sh --wait", exit: 137, log, session_id: "ses_B5B", aufruf_id: "call_B5B", pipeline: "auto-orchestrator" }),
    ])
  })

  test("B5b: --wait ohne Plugin-Umgebung → fabrik_ende mit session_id/aufruf_id null", async () => {
    const f = fakeLauf(0, "PASS", "# E\n")
    const r = await laufMit(f.skript, ["--wait", "auto-orchestrator", "aufgabe"], undefined, { OPENFLOW_SESSION: "", OPENFLOW_AUFRUF_ID: "" })
    expect(r.ledger).toEqual([
      expect.objectContaining({ event: "fabrik_log", session_id: null, aufruf_id: null }),
      expect.objectContaining({ event: "fabrik_ende", exit: 0, session_id: null, aufruf_id: null }),
    ])
  })
})

describe("B9 — --wait/--resume melden PID= (Lebendigkeits-Anker für das fabrik-gate-Plugin)", () => {
  const skript = `case "$*" in *headless-run.ts*) echo "verdict: PASS · run run-W"; exit 0;; esac; exit 0`
  test("--wait: LOG= bleibt erste Zeile, PID=<zahl> direkt danach", async () => {
    const r = await laufMit(skript, ["--wait", "auto-orchestrator", "aufgabe"])
    const z = r.stdout.trimEnd().split("\n")
    expect(z[0]).toMatch(/^LOG=.+\.log$/)
    expect(z[1]).toMatch(/^PID=\d+$/)
    expect(z.filter((x) => x.startsWith("PID="))).toHaveLength(1)
  })
  test("--resume (erzwingt wait) meldet PID= ebenso", async () => {
    const r = await laufMit(skript, ["--resume", "run-X"])
    expect(r.stdout).toMatch(/^PID=\d+$/m)
  })
})

describe("Lauf-Anker beim Start — fabrik_log steht im Ledger, solange der Lauf läuft", () => {
  // Anlass 28.10.2026: --wait im Vordergrund aus opencode → das Plugin schrieb
  // fabrik_log erst nach dem Lauf, die Sidebar zeigte „bereit · kein Run".
  // Der Fake-headless-run sieht im Ledger nach, WÄHREND er läuft.
  const skript = `case "$*" in *headless-run.ts*) grep -c '"event":"fabrik_log"' "$OPENFLOW_LEDGER" > "$OPENFLOW_LOG_DIR/waehrend" || echo 0 > "$OPENFLOW_LOG_DIR/waehrend"; echo "verdict: PASS · run run-A"; exit 0;; esac; exit 0`
  test("--wait: fabrik_log mit PID dieser Shell liegt vor, bevor headless-run läuft", async () => {
    const r = await laufMit(skript, ["--wait", "auto-orchestrator", "aufgabe"], undefined, { OPENFLOW_SESSION: "ses_A", OPENFLOW_AUFRUF_ID: "call_A" })
    const log = r.stdout.match(/^LOG=(.+)$/m)![1]!
    const pid = Number(r.stdout.match(/^PID=(\d+)$/m)![1])
    expect(readFileSync(join(dirname(log), "waehrend"), "utf8").trim()).toBe("1")
    expect(r.ledger[0]).toEqual(expect.objectContaining({ event: "fabrik_log", quelle: "of-run.sh", pipeline: "auto-orchestrator", log, pid, session_id: "ses_A", aufruf_id: "call_A" }))
  })
  test.skipIf(SETSID === null)("detached: fabrik_log trägt dieselbe PID wie die PID=-Zeile", async () => {
    const r = await laufMit(`exit 0`, ["auto-orchestrator", "aufgabe"])
    const pid = Number(r.stdout.match(/^PID=(\d+)$/m)![1])
    const log = r.stdout.match(/^LOG=(.+)$/m)![1]
    expect(r.ledger.filter((z: any) => z.event === "fabrik_log")).toEqual([expect.objectContaining({ pid, log, session_id: null, aufruf_id: null })])
  })
  test("canvas: OPENFLOW_ORIGIN des Laufs steht im fabrik_log (Sidebar-Link folgt dem Port)", async () => {
    const r = await laufMit(skript, ["--wait", "auto-orchestrator", "aufgabe"], undefined, { OPENFLOW_ORIGIN: "http://127.0.0.1:5274" })
    expect(r.ledger[0]).toEqual(expect.objectContaining({ event: "fabrik_log", canvas: "http://127.0.0.1:5274" }))
  })
  test("canvas: ohne OPENFLOW_ORIGIN → Standard-Canvas http://localhost:5174", async () => {
    const r = await laufMit(skript, ["--wait", "auto-orchestrator", "aufgabe"], undefined, { OPENFLOW_ORIGIN: "" })
    expect(r.ledger[0]).toEqual(expect.objectContaining({ event: "fabrik_log", canvas: "http://localhost:5174" }))
  })
  test("Kontrollwert: Guard lehnt ab (früher Abbruch) → KEIN fabrik_log, nur die Fehlerzeile", async () => {
    const r = await laufMit(`case "$*" in *of-guard.ts*) exit 3;; esac; exit 0`, ["--wait", "auto-orchestrator", "aufgabe"])
    expect(r.exitCode).toBe(3)
    expect(r.ledger.map((z: any) => z.event)).toEqual(["fabrik_start_fehlgeschlagen"])
  })
})

describe("T-08 (B4) — Auto-Retry nur nach error, nie nach stopped", () => {
  test("error im ersten von zwei Versuchen → genau ein weiterer Versuch", () => {
    expect(nochmalVersuchen("error", 1, 2)).toBe(true)
    expect(nochmalVersuchen("error", 2, 2)).toBe(false)
  })
  test("stopped (Canvas-Stop, Signal, Resume-Übernahme) → kein zweiter Versuch", () => {
    expect(nochmalVersuchen("stopped", 1, 2)).toBe(false)
  })
  test("done und unbekannte Status → kein zweiter Versuch; OPENFLOW_AUTO_RETRY=0 (max 1) nie", () => {
    expect(nochmalVersuchen("done", 1, 2)).toBe(false)
    expect(nochmalVersuchen(undefined, 1, 2)).toBe(false)
    expect(nochmalVersuchen("error", 1, 1)).toBe(false)
  })
  test("headless-run entscheidet über nochmalVersuchen (keine zweite Abbruchregel daneben)", () => {
    const quelle = readFileSync(join(import.meta.dir, "headless-run.ts"), "utf8")
    expect(quelle).toContain("if (!nochmalVersuchen(log.status, attempt, attemptsMax)) break")
    expect(quelle).not.toContain('log.status === "done" || attempt === attemptsMax')
  })
})

describe("T-09 (B5) — of-run.sh --resume mit relativem Pfad aus dem Aufrufer-Verzeichnis", () => {
  function resumeAus(cwd: string, ref: string) {
    const fakeBun = join(cwd, "bun")
    const protokoll = join(cwd, "aufrufe.txt")
    writeFileSync(fakeBun, `#!/usr/bin/env bash\necho "$*" >> "${protokoll}"\nexit 0\n`)
    chmodSync(fakeBun, 0o755)
    Bun.spawnSync(["bash", OF_RUN, "--resume", ref], {
      cwd,
      env: { ...process.env, BUN: fakeBun, OPENFLOW_ENGINE: "", OPENFLOW_LOG_DIR: cwd, OPENFLOW_LEDGER: join(cwd, "ledger.jsonl") },
      stdout: "pipe",
      stderr: "pipe",
    })
    return readFileSync(protokoll, "utf8").split("\n").find((z) => z.includes("headless-run.ts")) ?? ""
  }
  test("existierende relative Datei → absoluter Pfad an headless-run (of-run.sh wechselt ins Repo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-run-resume-rel-"))
    dirs.push(dir)
    mkdirSync(join(dir, "cps"))
    writeFileSync(join(dir, "cps", "openflow-checkpoint-run-R.json"), "{}")
    expect(resumeAus(dir, "cps/openflow-checkpoint-run-R.json")).toContain(`--resume ${dir}/cps/openflow-checkpoint-run-R.json`)
  })
  test("keine Datei dieses Namens → bleibt eine Run-ID", () => {
    const dir = mkdtempSync(join(tmpdir(), "of-run-resume-id-"))
    dirs.push(dir)
    expect(resumeAus(dir, "run-2026-10-28-abc")).toContain("--resume run-2026-10-28-abc ")
  })
})
