/**
 * K2p (24.10.2026, Betreiber-Wunsch „bessere Ergebnisse mit der Fabrik bei
 * Analysen, Recherchen, etc.“): Ergebnisaufträge des NUTZERS → Fabrik.
 * Regeltext: ~/.config/opencode/AGENTS.md REGEL 4 („Ergebnisaufträge“).
 *
 * Gemessen über `classify(text, { herkunft: "nutzer" })` — der Weg, den der
 * Nutzer-Prompt-Hook nimmt (`classify --llm` → `entscheide`). soll = true:
 * FABRIK mit Injektion.
 *
 * ERGEBNIS_NUTZER: Fälle mit „(Ledger)“ sind wörtlich aus
 *   ~/.openflow/gate-ledger.jsonl (event user_prompt, gezogen 24.10.2026,
 *   Tippfehler und Kleinschreibung original); dort standen sie auf GRAUZONE
 *   oder hingen am LLM-Urteiler. Die übrigen sind die Formulierungen aus dem
 *   Auftrag („wie steht es um …“, „vergleiche …“) und kurze Alltagsformen.
 * NEIN_NUTZER: Gegenfälle — Implementierung/Fix/Refactor, Deploy/Merge,
 *   Rückfrage, Einzelschritt, interne Kind-Aufträge, Sitzungsbezug,
 *   Erklärfrage. soll = false (keine Injektion durch K2p; ein Nein-Signal
 *   gibt ohnehin DIREKT).
 */
import type { Fall } from "./gate-korpus"

export const ERGEBNIS_NUTZER: Fall[] = [
  ["analysiere den status von wortwert", true], // (Ledger)
  ["Recherchiere nun in der tiefe zu mina 2015", true], // (Ledger)
  ["analysiere speziell Luxor-Finsternis-Tourismus", true], // (Ledger)
  ["Tiefen analyse von houston mit dem wissen von duisburg", true], // (Ledger)
  ["analysiere warum openflow in meiner anderen instanz nie verwendet wird", true], // (Ledger)
  ["analysiere in deep was die verschiedenen Mond/Saros phasen aussagen könnten. geht es immer um das selbe ritual?", true], // (Ledger)
  ["recherchiere ob manche symbolisch wirklich Z wie eine 2 behandeln. Es ist ja nucht gematria", true], // (Ledger)
  ["dann lass uns das ganze mal testen: Analysiere wortwert in deep und mache vorschläge wie wir es auf eine 10/10 bringen können.", true], // (Ledger)
  ["lass uns analysieren was die message der 1. Loveparade war? GIbt es einen hinweis, dass es enden wird.", true], // (Ledger)
  ["Wie steht es um merkspur?", true],
  ["wie ist der stand von dharma", true],
  ["Was ist der Status von zerez-sync?", true],
  ["Vergleiche Hetzner und Netcup für unseren VPS.", true],
  ["vergleiche opencode und claude code beim subagent-handling", true],
  ["Schreib mir einen Bericht über die Canary-Ausfälle der Woche.", true],
  ["Ich brauche eine Analyse der dharma-Kosten im Oktober.", true],
  ["Bestandsaufnahme der offenen PRs in OpenFlow, bitte.", true],
  ["Research the current state of MCP OAuth support in Claude clients.", true],
  ["Compare Cloudflare D1 and Turso for our read profile.", true],
  ["Analysiere, warum rille im Oktober mehr 5xx liefert als im September.", true],
]

export const NEIN_NUTZER: Fall[] = [
  // Implementierung / Fix / Refactor — enge Schreibschritte in der Sitzung
  ["Analysiere den Fehler in src/router.ts und behebe ihn.", false],
  ["Fixe den fehlschlagenden Test in rille und analysiere vorher die Ursache.", false],
  ["Refactore of-gate.ts und vergleiche danach die Laufzeit.", false],
  ["Implementiere den Vergleich der Versionen im version-gate.", false],
  ["Recherchiere, wie man den Cooldown konfiguriert, und füge ihn in dharma hinzu.", false],
  // Deploy / Merge — Nein-Signal
  ["Recherchiere die aktuelle wrangler-Version und deploye dann dharma.", false],
  ["Schreib einen Bericht über den Rollout und merge danach den PR.", false],
  // Rückfrage nötig
  ["Vergleiche die Ansätze LRU und TTL für den Cache und frag mich, welchen ich nehmen soll.", false],
  // Einzelschritt
  ["Analysiere src/opus-lokal.ts: Wo wird die Abtastrate auf 48000 gesetzt? Berichte Datei:Zeile.", false],
  ["Recherchiere kurz die Uhrzeit in Tokio.", false],
  // interne Kind-Aufträge
  ["Abnahme: prüfe die Lieferung von p5-guete gegen die Kriterien und analysiere die Abweichungen.", false],
  ["Fortsetzung deines Tasks p1-schema: analysiere die restlichen Fehlschläge und berichte.", false],
  ["Nachfeuern: Präzisierung für Aufgabe 3 — vergleiche nur die Zeitstempel.", false],
  ["Analysiere die Testabdeckung von befehl.ts. fertig_wenn: Zahl der ungetesteten Zweige steht im Bericht.", false],
  // Sitzungsbezug — die Fabrik sähe das Material nicht
  ["analysiere welche großen feste in diese zeiträume passen. Ich denke hier an riesige events", false], // (Ledger)
  ["Analysiere die Ausgabe oben und sag mir, was fehlt.", false],
  // Erklärfragen
  ["Was ist eine Analyse im Sinne von REGEL 4?", false],
  ["Erklär mir, wie die Fabrik eine Recherche zusammenführt.", false],
]
