/**
 * Aufgabenklasse (22.11.2026): `aufgabenKlasse` ordnet jeden Fabrik-Auftrag
 * einer von fünf Klassen zu (oder `unbekannt`), damit je Klasse gemessen
 * werden kann, welche Pipeline am besten liefert. Fixtures unten „echt“ sind
 * gekürzte `input`-Felder echter Läufe aus flow-lab/.openflow/runs.
 */
import { describe, expect, test } from "bun:test"
import { AUFGABEN_KLASSEN, aufgabenKlasse } from "./of-gate"

const faelle: [string, string][] = [
  // review
  ["Review des Codes in packages/flow/scripts/of-gate.ts", "review"],
  ["Please review the pull request for the cache layer", "review"],
  ["Audit der Berechtigungen im Worker", "review"],
  ["Prüfe, ob die Tests in src/graph noch die Doku treffen", "review"],
  // code-fix
  ["fixe den Bug im Login", "code-fix"],
  ["FIXE DEN BUG IM LOGIN", "code-fix"],
  ["Fix the race condition in the scheduler", "code-fix"],
  ["Implementiere das Feature Export als CSV", "code-fix"],
  ["Schreib einen Test für parseCsv", "code-fix"],
  ["Refactor the retry loop into a helper", "code-fix"],
  ["fixe den Bug im Artikel-Renderer", "code-fix"],
  // artikel
  ["schreib einen Artikel über die Venus als Morgenstern", "artikel"],
  ["Write a blog post about retry backoff", "artikel"],
  ["Überarbeite den Newsletter für Dezember", "artikel"],
  ["Schreib einen Artikel über den Bugfix von gestern", "artikel"],
  // analyse
  ["analysiere warum der Cron um 3 Uhr ausfällt", "analyse"],
  ["Analysiere, warum der Bug auftritt", "analyse"],
  ["Recherchiere die besten Router für 2026", "analyse"],
  ["Compare SQLite and DuckDB for embedded analytics", "analyse"],
  ["Erstelle einen Bericht über den Stand der Migration", "analyse"],
  ["Erstelle einen kurzen Analysebericht (300–500 Wörter) über die Tier-Ketten", "analyse"],
  // batch
  ["verarbeite alle Videos der Queue", "batch"],
  ["Tageslauf", "batch"],
  ["Process the queue of pending videos", "batch"],
  ["Arbeite alle 500 Dateien im Ordner ab", "batch"],
  // unbekannt
  ["", "unbekannt"],
  ["   ", "unbekannt"],
  ["x", "unbekannt"],
  ["Berechne die Summe aller Primzahlen kleiner als 1000.", "unbekannt"],
  ["Nenne drei Farben", "unbekannt"],
  // gemischte Signale
  ["Review der Tageslauf-Ergebnisse von gestern", "review"],
  ["Read-only Diagnose: der Test failt, fixe nichts, finde die Ursache", "analyse"],
  ["Lies .openflow/aufgaben/merkspur-analyse.md und arbeite den Auftrag ab.", "unbekannt"],
  ["Zwei Teile: (a) zähle Zeilen. (b) prüfe die Summe. Keine Dateien ändern, fixe nichts.", "review"],
]

// Gekürzte `input`-Felder echter Läufe (flow-lab/.openflow/runs), nur eindeutige.
const echt: [string, string][] = [
  ["Tageslauf: neue Decoder-Videos ziehen, transkribieren, per WortWert validieren, dokumentieren (LLM=dharma)", "batch"],
  ["Nachlauf: die zwei wieder eingereihten Videos aus der Queue vollstaendig verarbeiten (P3.6 bis P8) und dokumentieren.", "batch"],
  ["Liefere in /home/thoma/.claude/jobs/64cb35bb/tmp/s30/r24 ein Modul semver.py mit parse(v), compare(a,b) und bump(v, part) plus test_semver.py mit mindestens 20 pytest-Tests. Fertig-Kriterium: 'python3 -m pytest -q' grün.", "code-fix"],
  ["Liefere in /home/thoma/.claude/jobs/64cb35bb/tmp/serie/p2 ein TypeScript-Modul csv.ts (für bun) mit parseCsv(text) nach RFC 4180 und csv.test.ts mit mindestens 20 bun:test-Tests.", "code-fix"],
  ["Schreibe zwei deutschsprachige Artikel zu je ca. 1200 Wörtern für den zahlwert-research-Blog: (1) über die totale Sonnenfinsternis, (2) über die Venus.", "artikel"],
  ["Erweitere docs/XRP_VENUS_SIGNATUR.md von 1053 auf 3000+ Woerter. Ergaenze historischen Kontext in jedem Kapitel.", "artikel"],
  ["Read-only Audit: Eclipse-Kernel /home/thoma/workspace/mcp-workers/packages/workers/wortwert/src/modules/eclipse — prüfe die Formeln gegen die NASA-Tabellen.", "review"],
  ["Review und Analyse der heutigen OpenFlow-1.5.0-Änderungen (packages/flow/scripts/: of-reap.ts, of-gate.ts, of-run.sh).", "review"],
  ["Recherche-Auftrag (reine Web-/Doku-Recherche, KEINE Gerätezugriffe): Wie kann echtes 802.11k/v-Roaming (AP-gestützt) auf OpenWrt eingerichtet werden?", "analyse"],
  ["DEEP-ANALYSE (read-only, KEINE Code-Änderungen, keine Commits): Statistik-Prinzip 'Konvergenz-Evidenz' für alle Decoder-Module. Prüfe, ob ein Fix nötig wäre.", "analyse"],
  ["Repo: /home/thoma/workspace/mcp-workers, Worker: packages/workers/wortwert (Release 9.506.0, live). Tests: ~21517 Tests, 763 Dateien.\n\nAUFGABE: Analysiere wortwert umfassend auf Verbesserungspotenzial. Keine Implementierung — nur Analyse + Empfehlungen. Prüfe auch die Decoder-Video-Werte.", "analyse"],
  ["Berechne die Summe aller Primzahlen im Bereich 201 bis 299 (einschließlich). Gib nur die Zahl zurück.", "unbekannt"],
]

describe("aufgabenKlasse — Beispiele und Grenzfälle", () => {
  for (const [text, soll] of faelle) test(`${JSON.stringify(text.slice(0, 60))} → ${soll}`, () => expect(aufgabenKlasse(text)).toBe(soll))
})

describe("aufgabenKlasse — echte Aufträge aus flow-lab", () => {
  for (const [text, soll] of echt) test(`${text.slice(0, 60)} → ${soll}`, () => expect(aufgabenKlasse(text)).toBe(soll))
})

describe("aufgabenKlasse — Vertrag", () => {
  test("liefert nur die sechs festen Klassen", () => {
    const alle = [...faelle, ...echt].map(([t]) => aufgabenKlasse(t))
    expect(alle.every((k) => (AUFGABEN_KLASSEN as readonly string[]).includes(k))).toBe(true)
    expect(new Set(alle)).toEqual(new Set(AUFGABEN_KLASSEN))
  })
  test("Pfade tragen kein Signal (merkspur-analyse.md, /review/)", () => {
    expect(aufgabenKlasse("Lies /home/x/review/notes.md und nenne die erste Zeile")).toBe("unbekannt")
  })
  test("CLI: of-gate.ts klasse --text druckt die Klasse", () => {
    const p = Bun.spawnSync(["bun", `${import.meta.dir}/of-gate.ts`, "klasse", "--text", "fixe den Bug im Login"])
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString().trim()).toBe("code-fix")
  })
  test("CLI: Text über stdin", () => {
    const p = Bun.spawnSync(["bun", `${import.meta.dir}/of-gate.ts`, "klasse"], { stdin: Buffer.from("Tageslauf") })
    expect(p.stdout.toString().trim()).toBe("batch")
  })
})
