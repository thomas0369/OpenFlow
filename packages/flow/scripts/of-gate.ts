/**
 * of-gate — deterministischer Fabrik-Gate für REGEL 4 (Subagenten-Fabrik).
 *
 * Bewertet einen Task-Text gegen die Ja-/Nein-Fälle der Nutzerorder vom
 * 18.09.2026 — ohne LLM, reine Signale. Liefert eine EMPFEHLUNG:
 *
 *   FABRIK    — klarer Ja-Fall (Research-Fächer, Multi-Review, Artikel,
 *               Varianten, Testsuiten — abgeschlossenes Deliverable)
 *   DIREKT    — klarer Nein-Fall (Geldpfad, Deploy, Secrets, Rückfragen,
 *               Einzelschritt <1 min) oder Nutzer-Prefix "direkt:"
 *   GRAUZONE  — beides unbelegt; Eskalationsleiter entscheidet der Agent,
 *               Begründung wird Pflicht
 *
 * Präfix "fabrik:" erzwingt FABRIK. Sicherheits-/Geldpfad-Signale schlagen
 * Fabrik-Signale (ein "deploy" im Text macht jeden Artikel-Laufen-Auftrag
 * zum Nein-Fall).
 *
 * Usage:
 *   echo "<task>" | bun of-gate.ts classify        # Text via stdin
 *   bun of-gate.ts classify --text "<task>"        # Text als Arg
 *   bun of-gate.ts log <entscheidung> "<task>" "<grund>" [--event task|fabrik_run]
 *
 * Ausgabe classify: eine JSON-Zeile {entscheidung, signale, prefix, grund}.
 * log hängt an ${OPENFLOW_LEDGER:-~/.openflow/gate-ledger.jsonl}.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"

const LEDGER = process.env.OPENFLOW_LEDGER ?? join(homedir(), ".openflow/gate-ledger.jsonl")

// Ja-Fall-Signale (REGEL 4): Fan-out-artige Arbeit mit Endprodukt.
const FABRIK_SIGNALS: { re: RegExp; name: string }[] = [
  { re: /recherche|recherchier|\bresearch\b/i, name: "recherche" },
  { re: /\breview|code[- ]review|multi[- ]review\b/i, name: "review" },
  { re: /\bartikel|blogpost|post schreiben\b/i, name: "artikel" },
  { re: /\banalyse|analysiere|analyz/i, name: "analyse" },
  { re: /\bvarianten|alternativen vergleichen\b/i, name: "varianten" },
  { re: /\bvergleich|vergleiche\b/i, name: "vergleich" },
  { re: /\btestsuite|test-suite|regressionssuite\b/i, name: "testsuite" },
  { re: /\bbenchmark\b/i, name: "benchmark" },
  { re: /\baudit\b/i, name: "audit" },
  { re: /\bbericht|report erstellen\b/i, name: "bericht" },
  { re: /zusammenfass|synthese|literaturüberblick|literaturueberblick/i, name: "zusammenfassung" },
  { re: /\bfür jede[nrs]? |je datei |per datei /i, name: "fan-out-quantor" },
  { re: /\bparallel(?!e leitung)/i, name: "parallel" },
  { re: /\bmehrere (unabhängige|getrennte|eigene )/i, name: "mehrere-unabhaengige" },
]

// Nein-Fall-Signale: kontextgebunden, gefährlich, dialogisch, trivial.
const DIREKT_SIGNALS: { re: RegExp; name: string }[] = [
  { re: /\bdeploy|deployment|rollout\b/i, name: "deploy" },
  { re: /\bgeld|payment|stripe|abrechnung|invoice\b/i, name: "geldpfad" },
  { re: /\bsecret|passwort|password|api[- ]key|token rotat|credentials\b/i, name: "secrets" },
  { re: /\bssh|produktionsserver|prod-server\b/i, name: "server-zugriff" },
  { re: /\bmainnet|wallet|transaktion senden\b/i, name: "krypto-geldpfad" },
  { re: /\brückfrage|frage den nutzer|den nutzer fragen|nachfragen beim nutzer\b/i, name: "rueckfrage" },
  { re: /\beinzelschritt|ein schritt|quick fix|hotfix|trivial\b/i, name: "einzelschritt" },
  { re: /\bmerge|squash-merge|pr mergen\b/i, name: "merge" },
  { re: /\bpush(en)? zu (main|master|origin)\b/i, name: "push" },
  { re: /\b(löschen|loeschen|delete|drop)\b.{0,30}\b(produktiv|prod|live|datenbank)\b/i, name: "destruktiv-prod" },
]

function classify(text: string) {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  const prefix = lower.startsWith("fabrik:") ? "fabrik" : lower.startsWith("direkt:") ? "direkt" : null

  const fabrik = FABRIK_SIGNALS.filter((s) => s.re.test(trimmed)).map((s) => s.name)
  const direkt = DIREKT_SIGNALS.filter((s) => s.re.test(trimmed)).map((s) => s.name)

  // Nutzer-Prefix ist Wille, kein Rat.
  if (prefix === "fabrik") return { entscheidung: "FABRIK", signale: fabrik, prefix, grund: "Nutzer-Prefix fabrik:" }
  if (prefix === "direkt") return { entscheidung: "DIREKT", signale: direkt, prefix, grund: "Nutzer-Prefix direkt:" }

  // Sicherheit schlägt Effizienz.
  if (direkt.length > 0)
    return { entscheidung: "DIREKT", signale: direkt, prefix, grund: `Nein-Fall-Signal(e): ${direkt.join(", ")}` }
  if (fabrik.length >= 2)
    return { entscheidung: "FABRIK", signale: fabrik, prefix, grund: `mindestens 2 Ja-Fall-Signale: ${fabrik.join(", ")}` }
  if (fabrik.length === 1)
    return { entscheidung: "GRAUZONE", signale: fabrik, prefix, grund: `nur ein Ja-Fall-Signal (${fabrik[0]}) — Eskalationsleiter entscheidet, Begründung Pflicht` }
  return { entscheidung: "GRAUZONE", signale: [], prefix, grund: "keine Signale — Eskalationsleiter entscheidet, Begründung Pflicht" }
}

const argv = process.argv.slice(2)
const cmd = argv[0]

if (cmd === "classify") {
  const i = argv.indexOf("--text")
  const text = i >= 0 ? argv[i + 1] : readFileSync(0, "utf8")
  console.log(JSON.stringify(classify(text)))
  process.exit(0)
}

if (cmd === "log") {
  // of-gate.ts log <entscheidung> "<task>" "<grund>" [--event task|fabrik_run]
  const [entscheidung, task = "", grund = ""] = argv.slice(1)
  const ev = argv.includes("--event") ? argv[argv.indexOf("--event") + 1] : "task"
  const entry = {
    ts: new Date().toISOString(),
    event: ev,
    entscheidung,
    task: task.slice(0, 160),
    grund: grund.slice(0, 240),
  }
  mkdirSync(dirname(LEDGER), { recursive: true })
  appendFileSync(LEDGER, JSON.stringify(entry) + "\n")
  console.log(JSON.stringify(entry))
  process.exit(0)
}

console.error("usage: bun of-gate.ts classify [--text <task>] | log <entscheidung> <task> <grund> [--event task|fabrik_run]")
process.exit(2)
