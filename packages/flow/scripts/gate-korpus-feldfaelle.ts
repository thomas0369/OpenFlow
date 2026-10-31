/**
 * Feldfälle aus dem Gate-Ledger (~/.openflow/gate-ledger.jsonl, gezogen
 * 18.10.2026) — echte Prompts aus dem Feld, wörtlich im task-Feld. Das
 * Ledger kürzt task hart auf 160 Zeichen (127 Einträge exakt 160), daher
 * enden einige Texte mitten im Wort — Absicht, kein Fehler.
 *
 * Aufnahme-Kriterium: NUR Fälle, bei denen die aktuelle Wortregel (classify
 * in of-gate.ts) dieselbe Entscheidung liefert wie das Ledger (entscheidung
 * + signale). Fälle, wo classify abweicht, stehen bewusst NICHT hier — sie
 * sind als Klassifikator-Abweichungen im Abnahme-Bericht gelistet. Der
 * Korpus testet die SOLL-Klassifikation, ändert die Regel nicht.
 *
 *   FELD_FABRIK   — im Feld als FABRIK (quelle wortregel) injizierte
 *                   Fan-out-Aufträge. SOLL: FABRIK, injizieren.
 *   FELD_DIREKT   — DIREKT via eindeutigem Nein-Signal (deploy, loeschen).
 *                   SOLL: DIREKT, quelle nein_signal, keine Injektion.
 *   FELD_GRAUZONE — kurze Steuer-Prompts ohne Fan-out-Indiz (quelle keine).
 *                   SOLL: GRAUZONE, keine Injektion.
 */
import type { Fall } from "./gate-korpus"
import type { Kontext } from "./of-gate"

export const FELD_FABRIK: Fall[] = [
  // Ledger-Signale: fan-out-quantor, mengenangabe, parallel
  ["Untersuche parallel in drei Verzeichnissen: (1) packages/shared/src — liste die 5 groessten .ts-Dateien mit Zeilenzahl, (2) packages/workers/wortwert/tests — ne", true],
  // Ledger-Signale: fan-out-quantor, parallel
  ["Pruefe parallel: (1) wie viele Dateien matchen packages/shared/src/**/*.ts, (2) hat packages/template eine README-Datei und wie lang ist sie. Berichte beide Bef", true],
  // Ledger-Signale: mengenangabe, parallel
  ["Pruefe parallel in diesen 7 Worker-Verzeichnissen unter packages/workers, ob jeweilse eine tests/unit-Struktur mit mindestens einer Testdatei existiert: dharma,", true],
  // Ledger-Signale: analyse, mengenangabe — untypischer Feldprompt (Kontext
  // vor dem Arbeitsverb), die Wortregel traf trotzdem wie im Ledger.
  ["Auf der vierten Gedenkfeier trat die Metalband Axxis auf und stellte ihren Song 21 Crosses (21 Kreuze) vor.\nAlso 4 Jahre danach? Analysiere in deep mit zeitlich", true],
]

export const FELD_DIREKT: Fall[] = [
  // Ledger-Signal: deploy
  ["ist alles deployed? Können wir es testen ?", false],
  // Ledger-Signal: loeschen
  ["Führe genau diesen Shell-Befehl mit dem bash-Werkzeug aus, unverändert, ohne cd und ohne workdir: rm -rf ../../../../../../../../Documents  — danach melde wörtl", false],
]

export const FELD_GRAUZONE: Fall[] = [
  // Ledger-Signale: keine — Bereitschafts-Steuerprompt
  ["Antworte nur mit dem Wort: ok", false],
  // Ledger-Signale: keine — Ausführungssteuerung ohne Objekt
  ["Führe den Befehl aus.", false],
  // Ledger-Signale: keine — klingt nach Auftrag, hat aber kein Fan-out-Indiz
  ["Zerlege: Eine CLI, die Fotos nach EXIF-Datum umbenennt, mit Tests und README.", false],
  // Ledger-Signale: keine — Antwort-Schnipsel als Fortsetzungssteuerung
  ["1b, 2, 3, 4, 5, 6: Fixe alles", false],
]

// ---------------------------------------------------------------------------
// Interne Aufträge (Feldbefund 24.10.2026): alle 7 FABRIK-Empfehlungen des
// Tages waren Aufträge des Hauptfadens an seine eigenen Subagenten. Wörtlich
// aus opencode.db (subagent-Aufrufe der Sitzung ses_e91b3dc3…, Hauptfaden
// „Wortwert-Statusanalyse"), gekürzt auf Kopfsatz + den Absatz, der die
// Wortregel auslöste + Schluss. Die Entscheidung trägt der AUFRUF-Kontext,
// nicht der Text: ohne Kontext bleiben die Abnahme-Texte FABRIK (Gegenprobe
// in gate-korpus-intern.test.ts), die Kind-Texte GRAUZONE (dort urteilte im
// Feld das LLM „JA").
//   agent: "abnahme" — Ledger event=task, 5× FABRIK/injiziert (15:33–16:37 UTC)
//   kind: true       — Ledger event=user_prompt in der Kind-Sitzung (worker-dev),
//                      2× FABRIK per LLM-Urteiler (15:03, 17:48 UTC)
// SOLL: nicht FABRIK, keine Injektion.
// ---------------------------------------------------------------------------
export type KontextFall = [text: string, soll: boolean, kontext: Kontext]

const ABNAHME_SCHLUSS = "\n\nAntworte mit: erfuellt | unbelegt | verfehlt + je Kriterium einem Ein-Zeilen-Beleg (Datei:Zeile oder Messwert)."

export const FELD_INTERN: KontextFall[] = [
  // Ledger-Grund: „Auftrag über mehrere Einheiten (3 kritischen Dateien B-Lauf webhook-send)"
  ["Prüfe, ob Task p1-schema (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nLieferungs-Behauptungen zum Gegenprüfen (jeweils mit eigenem Lesebefehl, KEINE Testläufe wiederholen — Belege im Bericht der Vorläufer gelten: A-Lauf 33/33 grün für die 3 kritischen Dateien, B-Lauf webhook-sender rot ohne Änderung = Präzedenz):\n1. `regeln`-Parameter existiert in MASTER_DECODE_SCHEMA (src/modules/orchestrator/index.ts ~159) — grep/Read." + ABNAHME_SCHLUSS, false, { agent: "abnahme" }],
  // Ledger-Grund: „… (je 1 eigener Lesebefehl KEINE Testläufe/) mit Ergebnis (Prüfe → Prüfe)"
  ["Prüfe, ob Task p1-migration (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nLieferungs-Behauptungen zum Gegenprüfen (je 1 eigener Lesebefehl, KEINE Testläufe/Migration-Applies wiederholen):\n1. migrations-clean/0044_regel_outcomes.sql existiert mit BOTH Tabellen: prediction_regeln (PK prediction_id+regel_id) und regel_outcomes (regel_id PK, hits/misses/voids/brier_sum/resolved_n/quelle/letzte_aufloesung) — Read." + ABNAHME_SCHLUSS, false, { agent: "abnahme" }],
  // Ledger-Grund: „… (je 1 Lesebefehl KEINE Testläufe) mit Ergebnis (Prüfe → Prüfe)"
  ["Prüfe, ob Task p3-pruefungen (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nLieferungs-Behauptungen zum Gegenprüfen (je 1 Lesebefehl, KEINE Testläufe wiederholen — Vorläufer-Belege gelten: isoliert 29/29 Exit 0, volle Suite 20.409 passed/0 failed Exit 0):\n1. src/evaluation/register-evidenz.ts: vermerkeRegelLauf nutzt ECHTES `await db.batch(stmts)` (Zitat) und ein einziges prepare." + ABNAHME_SCHLUSS, false, { agent: "abnahme" }],
  // Ledger-Grund: „… (je 1 Lesebefehl KEINE Testläufe) mit Ergebnis (Prüfe → 5 Tests)"
  ["Prüfe, ob Task p3-masterdecode (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nLieferungs-Behauptungen zum Gegenprüfen (je 1 Lesebefehl, KEINE Testläufe wiederholen — Vorläufer-Belege gelten: 5 Tests grün, Suite 20.428/0 Exit 0, tsc 0):\n1. src/modules/orchestrator/steps/evaluate.ts: Telemetrie-Block mit Guard `mctx?.env?.DB && mctx.waitUntil` + waitUntil(vermerkeRegelLauf(...)) (Zitat); Evidenz aus result.clusters[].value + result.multiCipherMatches[].targetValue via bewerteWerte (Zitat); responseData enthält regel_evidenz (Zitat)." + ABNAHME_SCHLUSS, false, { agent: "abnahme" }],
  // Ledger-Grund: „… (je 1 Lesebefehl KEINE Testläufe) mit Ergebnis (Prüfe → 7 Tests)"
  ["Prüfe, ob Task p2-generatoren (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nLieferungs-Behauptungen zum Gegenprüfen (je 1 Lesebefehl, KEINE Testläufe wiederholen — Vorläufer-Belege gelten: isoliert 7/7 Exit 0, Suite 20.433/0 Exit 0, tsc 0):\n1. engine-predictions.ts: extractRegelIds-Funktion existiert (Zitat); crypto_astro-Generator nutzt signal.factors.gematria-Werte (Zitat); bl_predict nutzt pred.debug?.appliedModifiers (Zitat — der BUGFIX); eclipse + trading_signal liefern explizit leere Listen (Zitate mit Edge-Kommentar)." + ABNAHME_SCHLUSS, false, { agent: "abnahme" }],
  // Ledger: user_prompt in Kind-Sitzung ses_e9194cce… (worker-dev), LLM-Urteiler JA
  ["Fortsetzung deines Tasks p1-schema im Worktree /tmp/opencode/wt-ww-p1schema (Branch ses-ww-rot/wt-p1schema). Deine eigene Restaufgaben-Liste aus dem letzten Bericht, unverändert ausführen:\n\n1. `regeln: z.string().optional()` nach src/modules/orchestrator/index.ts:158 (nach resolve_by) einfügen.\n2. `regeln: params.regeln as string | undefined,` in die registerPrediction-Reichung (index.ts:333-339).\n3. `regeln?: string;` in RegisterArgs (src/modules/orchestrator/predictions.ts:45).\n\nfertig_wenn: Alle 5 Punkte erledigt; beide Budget-Gates grün mit echten Nachher-Zahlen im Bericht; volle Unit-Suite grün (Zahlen + Exit-Code); Commit-SHA im Bericht; Worktree-Pfad + Branch genannt.", false, { kind: true }],
  // Ledger: user_prompt in Kind-Sitzung ses_e9109e61… (worker-dev), LLM-Urteiler JA
  ["NACHFEUERUNG zu p5-guete (gleiche Session, Worktree /tmp/opencode/wt-ww-p5guete, Branch ses-ww-rot/wt-p5guete, Commit 25581da08). Deine Lieferung ist korrekt und grün — EINE Lücke bleibt: die Evidenz-Kopplung ist OHNE Produktionsschaltung wirkungslos.\n\nAUFRAG: Verdrahte die Güte-Faktoren an allen Produktion-Aufrufern von bewerteWerte:\n1. `src/modules/evaluate/index.ts` (~:88), `src/modules/orchestrator/steps/evaluate.ts` (~:194), `src/modules/orchestrator/engine-predictions.ts` (~:28): vor dem bewerteWerte-Aufruf `ladeGueteFaktoren(dbClean, regelIds)` laden und als gueteFaktoren-Argument übergeben.\n\nfertig_wenn: alle 3 Produktion-Aufrufer übergeben gueteFaktoren (Datei:Zeile je Aufrufer), Aufrufer-Nachweis-Test grün, Folge-Commit im Worktree.", false, { kind: true }],
]

// ---------------------------------------------------------------------------
// Interne Aufträge am TEXT (Regeltreue-Befund 31.10.2026): alle 10 FABRIK-
// Empfehlungen des Ledgers, die Prüfung oder Fortsetzung einer bestehenden
// Lieferung waren — wörtlich aus dem task-Feld (gekürzt wie dort), OHNE
// Aufruf-Kontext. 7 davon (24.10.) standen in der Scorecard als „ohne
// Begründung“. SOLL: DIREKT, quelle intern, keine Injektion (of-gate.ts
// `internerAuftrag`). Gegenrichtung: in 1338 Ledger-Bewertungen traf die Regel
// keine andere FABRIK-Empfehlung; jeder Sollfall der Korpora bleibt
// (gate-korpus-intern.test.ts, Kontrollwert).
// ---------------------------------------------------------------------------
export const FELD_INTERN_TEXT: string[] = [
  // Ledger 2026-10-15T18:49Z task — Feld-Grund: „Auftrag über mehrere Einheiten (17 Tests) mit Ergebnis (Prüf …“
  "Prüfe, ob der Task im Worktree /tmp/opencode/wt-ww-server sein Fertig-Kriterium nachweislich erfüllt.\n\nFertig-Kriterien:\n1. Mode-Guard (P1): zentraler Hook logg",
  // Ledger 2026-10-15T18:49Z task — Feld-Grund: „Auftrag über mehrere Einheiten (5 veraltete Docs) mit Ergebn …“
  "Prüfe, ob der Task im Worktree /tmp/opencode/wt-ww-docs sein Fertig-Kriterium nachweislich erfüllt.\n\nFertig-Kriterien:\n1. Dokumentation-Archiv Banner (P3.3): 5 ",
  // Ledger 2026-10-15T20:37Z task — Feld-Grund: „Auftrag über mehrere Einheiten (31 URIs) mit Ergebnis (Prüfe …“
  "Prüfe, ob der Task im Worktree /tmp/opencode/wt-ww-w2 (Branch wt/wt-ww-w2, Basis = origin/main 9b9bff3d3) sein Fertig-Kriterium nachweislich erfüllt.\n\nFertig-Kr",
  // Ledger 2026-10-24T15:03Z user_prompt — Feld-Grund: „Grauzone, LLM-Urteiler (dharma/fast): JA — Wortregel ohne be …“
  "Fortsetzung deines Tasks p1-schema im Worktree /tmp/opencode/wt-ww-p1schema (Branch ses-ww-rot/wt-p1schema). Deine eigene Restaufgaben-Liste aus dem letzten Ber",
  // Ledger 2026-10-24T15:33Z task — Feld-Grund: „Auftrag über mehrere Einheiten (3 kritischen Dateien B-Lauf …“
  "Prüfe, ob Task p1-schema (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nWorktree: /tmp/opencode/wt-",
  // Ledger 2026-10-24T15:33Z task — Feld-Grund: „Auftrag über mehrere Einheiten (je 1 eigener Lesebefehl KEIN …“
  "Prüfe, ob Task p1-migration (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nWorktree: /tmp/opencode/",
  // Ledger 2026-10-24T15:54Z task — Feld-Grund: „Auftrag über mehrere Einheiten (je 1 Lesebefehl KEINE Testlä …“
  "Prüfe, ob Task p3-pruefungen (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nWorktree: /tmp/opencode",
  // Ledger 2026-10-24T16:19Z task — Feld-Grund: „Auftrag über mehrere Einheiten (je 1 Lesebefehl KEINE Testlä …“
  "Prüfe, ob Task p3-masterdecode (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nWorktree: /tmp/openco",
  // Ledger 2026-10-24T16:37Z task — Feld-Grund: „Auftrag über mehrere Einheiten (je 1 Lesebefehl KEINE Testlä …“
  "Prüfe, ob Task p2-generatoren (TASK-BATCH Regel×Outcome-Statistik) sein Fertig-Kriterium nachweislich erfüllt. Read-only, nichts ändern.\n\nWorktree: /tmp/opencod",
  // Ledger 2026-10-24T17:48Z user_prompt — Feld-Grund: „Grauzone, LLM-Urteiler (dharma/fast): JA — Wortregel ohne be …“
  "NACHFEUERUNG zu p5-guete (gleiche Session, Worktree /tmp/opencode/wt-ww-p5guete, Branch ses-ww-rot/wt-p5guete, Commit 25581da08). Deine Lieferung ist korrekt un",
]
