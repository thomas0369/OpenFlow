/**
 * of-loopcheck — die Sonde für die loop?-Frage (I4: Loop-Liveness).
 *
 * Der Wächter im Loop kann seinen eigenen Tod nicht melden — cron stirbt,
 * of-loop schweigt, niemand zählt die Stille. Diese Sonde läuft EXTERN
 * (Agent, Nutzer, cron-Zweittakt, TMUX-Statuszeile) und macht den Zustand
 * mit einem Befehl rot/grün:
 *
 *   GRÜN  — letzter Loop-Tick < 12 min alt (2× Timer-Abstand + Puffer),
 *           keine offenen Alerts, keine Zombies nach Reap, Regeltreue >= 50 %
 *           (ab 3 Kandidaten)
 *   ROT   — eines davon verletzt, mit benannter Ursache
 *
 * Exit-Code 0 = grün, 1 = rot — direkt als Erfolgskriterium eines
 * Loop-Engineering-Verify-Schritts verwendbar (success type: command).
 *
 * Usage: bun of-loopcheck.ts [--max-tick-min 12] [--json]
 *        bun of-loopcheck.ts --ack [invariante]   (of-run.sh --loop-ack)
 *
 * Offen ist ein Alert, solange seine Invariante im Aktiv-Zustand
 * (of-loop-alerts-aktiv.json, gepflegt von dedupAlerts) steht — die jsonl ist
 * Historie (B1, Regel in of-loop-logik.ts offeneAlerts). `--ack` verschiebt
 * Zeilen bewusst ins Archiv (of-loop-alerts.archiv.jsonl, gleiches Verzeichnis).
 *
 * Pfade: OPENFLOW_LOOP_DIR (State/Alerts, Default /tmp), OPENFLOW_LOOP_HEARTBEAT,
 * OPENFLOW_RUNS_DIR, OPENFLOW_LEDGER, OPENFLOW_CHECKPOINT_DIR — für Tests.
 */

import { appendFileSync, readFileSync, existsSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { computeI3, letzterTick, offeneAlerts, teileAlerts } from "./of-loop-logik.ts"
import { reapUrteil } from "./of-lebendig.ts"
import { CHECKPOINT_DIR, letzteAktivitaet, pidStatus } from "./of-lauf.ts"

const argv = process.argv.slice(2)
const MAX_TICK_MIN = Number(argv.includes("--max-tick-min") ? argv[argv.indexOf("--max-tick-min") + 1] : "12")
const JSON_OUT = argv.includes("--json")

// O4: LAST (/tmp/of-loop-last.json) wird vom Loop weiter je Tick geschrieben,
// ist aber NICHT mehr Liveness-Quelle: Fallback ist die State-Datei (Altdaten)
// wie beauftragt, Primärquelle der Herzschlag.
const LOOP_DIR = process.env.OPENFLOW_LOOP_DIR || "/tmp"
const STATE = join(LOOP_DIR, "of-loop-state.jsonl")
const ALERTS = join(LOOP_DIR, "of-loop-alerts.jsonl")
const ALERTS_AKTIV = join(LOOP_DIR, "of-loop-alerts-aktiv.json")
const ALERTS_ARCHIV = join(LOOP_DIR, "of-loop-alerts.archiv.jsonl")
// O4 — Herzschlag: seit O4 schreibt der Loop jeden Tick EINE überschriebene
// Zeile hierher; die State-Datei enthält nur noch Ereigniszeilen. Pfad wie
// im Loop fest verdrahtet (--heartbeat überschreibbar, für Tests).
const HEARTBEAT = argv.includes("--heartbeat")
  ? argv[argv.indexOf("--heartbeat") + 1]
  : process.env.OPENFLOW_LOOP_HEARTBEAT || "/tmp/opencode/of-loop-heartbeat"
const RUNS_DIR = process.env.OPENFLOW_RUNS_DIR || join(homedir(), "workspace/flow-lab/.openflow/runs")

// --ack [invariante]: quittieren statt prüfen. Archiv zuerst (Anhängen), dann
// die jsonl atomar ersetzen — ein Abbruch dazwischen verdoppelt eine Zeile im
// Archiv, verliert aber keine.
if (argv.includes("--ack")) {
  const inv = argv[argv.indexOf("--ack") + 1]
  const zeilen = existsSync(ALERTS) ? readFileSync(ALERTS, "utf8").split("\n") : []
  const t = teileAlerts(zeilen, inv && !inv.startsWith("--") ? inv : undefined)
  if (t.archiv.length > 0) {
    appendFileSync(ALERTS_ARCHIV, t.archiv.join("\n") + "\n")
    writeFileSync(`${ALERTS}.ack`, t.bleiben.length ? t.bleiben.join("\n") + "\n" : "")
    renameSync(`${ALERTS}.ack`, ALERTS)
  }
  console.log(`of-loop-ack: ${t.archiv.length} Alert-Zeile(n) quittiert → ${ALERTS_ARCHIV} · ${t.bleiben.length} bleiben in ${ALERTS}`)
  process.exit(0)
}
const LEDGER = process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl")

const problems: string[] = []
const facts: Record<string, unknown> = {}

// 1 — Loop-Liveness: letzter Herzschlag frisch? (O4) Herzschlag-Datei
//     bevorzugt; Fallback letzte ts aus der State-Datei für Altdaten (vor
//     O4 enthielt sie jeden Tick). Regel in of-loop-logik.ts (rein, getestet).
{
  const letzter = letzterTick(HEARTBEAT, STATE, existsSync, (p) => readFileSync(p, "utf8"))
  if (!letzter) {
    problems.push(`I4-loop: kein Herzschlag (${HEARTBEAT}) und keine State-Historie (${STATE}) — der Loop lief noch nie oder wurde neu installiert`)
  } else {
    const ageMin = (Date.now() - letzter.ms) / 60_000
    facts.letzterTickMin = Math.round(ageMin * 10) / 10
    facts.letzteTickQuelle = letzter.quelle
    if (ageMin > MAX_TICK_MIN) problems.push(`I4-loop: letzter Herzschlag vor ${Math.round(ageMin)} min (Schwelle ${MAX_TICK_MIN}, Quelle ${letzter.quelle}) — cron of-loop tot?`)
  }
}

// 2 — letzte Ticks (Historie sichtbar machen)
if (existsSync(STATE)) {
  facts.letzteTicks = readFileSync(STATE, "utf8").trim().split("\n").slice(-3)
}

// 3 — offene Alerts (B1): nur die, deren Invariante im Aktiv-Zustand steht
//     (bzw. Ereignis-Alerts bis zur Quittung); ohne Aktiv-Datei konservativ
//     die jsonl-Zeilen der letzten 24 h. Regel in of-loop-logik.ts.
if (existsSync(ALERTS)) {
  const aktiv = (() => {
    try {
      const z = JSON.parse(readFileSync(ALERTS_AKTIV, "utf8"))
      return z && typeof z === "object" && !Array.isArray(z) ? (z as Record<string, unknown>) : null
    } catch {
      return null
    }
  })()
  const offen = offeneAlerts(readFileSync(ALERTS, "utf8").split("\n").filter(Boolean), aktiv, Date.now())
  facts.alertQuelle = aktiv === null ? "jsonl (24 h, Aktiv-Zustand fehlt)" : "aktiv-zustand"
  if (offen.length > 0) {
    facts.offeneAlerts = offen.length
    problems.push(`I1-3: ${offen.length} offene Alerts (letzte: ${JSON.stringify(offen[offen.length - 1]).slice(0, 160)}) — quittieren: of-run.sh --loop-ack [invariante]`)
  }
}

// 4 — Zombies: running-Runs, die der Reaper hätte abräumen müssen. Dieselbe
//     Regel wie of-reap/of-loop (of-lebendig.ts) — hier stand eine dritte
//     Zahl (15 min), die eine lebende, nur stille Karte als Zombie meldete.
let zombies = 0
if (existsSync(RUNS_DIR)) {
  for (const f of readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))) {
    let log: any
    try { log = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) } catch { continue }
    if (log?.status !== "running") continue
    const ck = join(CHECKPOINT_DIR, `openflow-checkpoint-${log.id}.json`)
    const hatCheckpoint = existsSync(ck)
    const urteil = reapUrteil({
      jetzt: Date.now(),
      started: typeof log.started === "number" ? log.started : 0,
      letzteAktivitaet: Math.max(hatCheckpoint ? statSync(ck).mtimeMs : 0, letzteAktivitaet(log)),
      hatCheckpoint,
      pid: pidStatus(log?.host?.pid),
    })
    if (urteil.reapen) zombies++
  }
}
facts.zombies = zombies
if (zombies > 0) problems.push(`I1-zombies: ${zombies} running-Run(s) mit stummem Checkpoint — Reaper versagt?`)

// 5 — Regeltreue (O6): die Mess-Regel steht in of-loop-logik.ts (rein,
//     getestet) — user_prompt|FABRIK-Kandidaten im 7-Tage-Fenster gegen
//     non-monitoring fabrik_run strikt danach gematcht (computeI3).
//     Vorher hier alt gemessen (task|FABRIK als Kandidaten, alle fabrik_run,
//     kein Fenster, kein Matching) — 11/24 = 46 % < 50 % → dauerhaft ROT.
if (existsSync(LEDGER)) {
  const entries = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean) as any[]
  const i3 = computeI3(entries, Date.now())
  facts.fabrikKandidaten = i3.kandidaten
  facts.fabrikAufrufe = i3.fabrikAufrufe
  facts.fabrikMatches = i3.matches
  facts.fabrikFanouts = i3.fanouts
  if (i3.alert) {
    const zusatz = i3.fanouts > 0 ? ` (${i3.fanouts} task|FABRIK im Fenster)` : ""
    problems.push(`I3-regeltreue: ${i3.matches}/${i3.kandidaten} (${i3.quote} %) — aufgelöste FABRIK-Empfehlungen befolgt oder begründet${zusatz}`)
  }
}

const gruen = problems.length === 0
const report = { verdict: gruen ? "GRÜN" : "ROT", problems, facts }

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`OpenFlow-Loop: ${gruen ? "GRÜN" : "ROT"}`)
  for (const t of (facts.letzteTicks as string[]) ?? []) console.log(`  tick ${t}`)
  console.log(`  letzter Tick: ${facts.letzterTickMin ?? "?"} min her · Zombies: ${zombies} · I3: ${facts.fabrikMatches ?? 0}/${facts.fabrikKandidaten ?? 0} matches · Aufrufe: ${facts.fabrikAufrufe ?? 0}`)
  for (const p of problems) console.log(`  !! ${p}`)
}
process.exit(gruen ? 0 : 1)
