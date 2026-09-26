# Plan — Phase-0-Veredelung („Dirigenten-Vertrag") für OpenFlow-Orchestrierung

Stand: 26.09.2026 · Ziel: `@openflow/flow` 1.3.0 · Alles in `packages/flow` — kein Upstream-Eingriff.

## 0. Vorbild und Kernidee

Ein Dirigenten-Prompt (rille Lane G10) verwandelt eine 2-Sätze-Nutzer-Meldung
selbstständig in einen vollständigen Agenten-Vertrag: Messwerte vorab
(`evidence`), Pflicht-Lektüre (`skills`), gesperrte Bereiche (`avoid`),
vorab definierte Abnahme (`verify`), Rückkanal-Format. OpenFlow-Orchestratoren
dispatchen heute nur `{card, task, files}` — der Vertrag wird dem Modell
überlassen. Dieser Plan kodiert den Veredelungsprozess in Engine, Briefing und
Template.

Drei Layer, unabhängig lieferbar:

- **L1 Engine** — strukturierte Vertragsteile am Dispatch (`plan`, `evidence`,
  `skills`, `avoid`, `verify`), mit Guard und Validierung. Maschinenlesbar.
- **L2 Template** — „dirigent build": eine Veredler-Karte (billiges Modell,
  Checklisten-Briefing) schreibt den Vertrag als task-Text. Funktioniert mit
  dem HEUTIGEN Code, ist der Live-Beweis des Musters.
- **L3 Skill-Merge** — die Engine liest `SKILL.md` und merged es in den ersten
  Turn des Kindes. Schließt die „Skills erreichen die Karte nicht"-Lücke
  (FLOW.md:291–294) ohne MCP, ohne Upstream-Bruch.

## 1. Verifizierte Annahmen (Code-Lage, 26.09.2026)

| Annahme | Beleg | Status |
|---|---|---|
| Parser kennt genau `dispatch \| final`, eines davon Pflicht | `graph/dispatch.ts:118–123` | ✅ |
| Assignment-Typ ist `{card, task, files?}`, Validierung streng mit model-lesbaren Gründen | `dispatch.ts:69`, `:164–218` | ✅ |
| Error-Gründe werden zurückgegeben und reaskt (malformed einmal, dann fail) | `dispatch.ts:74`, FLOW.md:200–202 | ✅ |
| „Einmal nachfragen, dann fail" existiert als Muster (Gauntlet unjudged) | `server/engine.ts:1048–1077` (`refused`-Flag, zweiter Verstoß = Karten-Fehler) | ✅ |
| Board injiziert in jeden dispatch (`withBoard(assignment.task)`) | `engine.ts:1170–1171`, `server/board.ts` | ✅ |
| Briefing enthält Protokoll-Beispiel + Regeln, modusabhängige Abschnitte | `graph/prompt.ts:310–395` (`orchestratorBriefing`), gauntletBriefing als Beispiel für konditionale Abschnitte | ✅ |
| Orchestrator-Prompt baut Sektionen (Briefing, eigener Prompt, Task) | `prompt.ts:296–308` | ✅ |
| Critic-Prompt nimmt Referenz + Bar auf | `prompt.ts:504` (`criticPrompt`) | ✅ |
| Templates bauen orchestration-Chains aus Rollen | `graph/templates.ts:82–98` | ✅ |
| Skill-Dateien lesbar über Store (`readSkill`, global + project) | FLOW.md:486–488 (`lib/store.ts`) | ✅ (Ort bei Umsetzung nachlesen) |
| Dokument-Toggles: absent = off, persistiert/exportierbar/undoable (`mode`, `gauntlet`, `isolate`) | FLOW.md:262–268 | ✅ Muster für `refine` |
| Kostenformel: Orchestrator-Turns sind bezahlt; Session-Reuse cached Prefix; Anhänge reiten nur im ersten Turn | FLOW.md:68–77 | ✅ → plan reitet am ersten dispatch, skills nur im ersten Kind-Turn |

Offen (bei Umsetzung klären): exakte reask-Zählung im error-Zweig oberhalb
engine.ts:1020; `readSkill`-Signatur in `lib/store.ts`; ob `client.v2.session`
einen Titel-Endpunkt hat (Anhang D8, nicht Kern).

## 2. Design

### D1 — `plan` als Begleiter des ersten Dispatch (kein Extra-Turn)

Block-Erweiterung: `{ "plan": { "verify": ["…"] }, "dispatch": [ … ] }`.

- `plan` NUR zusammen mit `dispatch` gültig; `{plan}` allein → error
  („a plan dispatches nothing — send it with your first dispatch").
- `final` bleibt unverändert; `plan + final` → error (bestehende
  Genau-eins-Regel für dispatch/final bleibt, plan ist Zusatz).
- **Sequenz-Regel (nur `refine` an):** der erste Dispatch eines
  Orchestrator-Turns muss `plan` mitführen (`spent === 0`). Verstoß →
  error-Grund über den bestehenden Reask-Kanal; zweiter Verstoß → Karten-Fehler
  (Muster engine.ts:1048–1077). Bei `first === false` (reassign) kein Zwang —
  der Vertrag steht schon im Run.
- `plan.verify: string[]` (1–7 Einträge, je ≤ 200 Zeichen, non-empty). Es ist
  bewusst schmal: kein scopes/feldgeballer — Scope steckt in `avoid`, Messwerte
  in `evidence`.

### D2 — Assignment-Felder `evidence[] / skills[] / avoid[]`

Alle optional, analog `files` validiert in `assignmentsFrom`:

- `evidence: string[]` — Messwerte/Fakten (Datei:Zeile, Zahlen), je String
  non-empty. **Budget: 4000 Zeichen je Assignment gesamt** (Summe), sonst
  error-Grund (OpenFlow-Stil: harte Grenze mit klarem Grund, wie
  MAX_DISPATCHES).
- `skills: string[]` — Namen existierender Skills. Engine prüft Existenz
  (global `~/.config/opencode/skills/<n>/SKILL.md`, dann project
  `.openflow/skills/<n>/SKILL.md` über den Store). Unbekannter Name →
  error-Grund (reask, Modell korrigiert).
- `avoid: string[]` — Pfade (wie `files` über `isPath` + `normalizePath`).
  Duplikat-Konflikt-Regel von `files` greift NICHT (avoid deklariert
  Nichtschreiben), aber `avoid`-Pfad, den ein ANDERES Assignment als `files`
  deklariert → error (Widerspruch vor dem Lauf, kostenlos zu fixen).

**Merge-Reihenfolge im Assignment-Text** (neue Builder in `prompt.ts`, von der
Engine in `runSubagent`/`orchestrate` komponiert — Kette um `withBoard`):

```
## Skill: <name>          (SKILL.md-Inhalt, nur im ERSTEN Turn des Kindes)
## Evidence               (je Zeile ein Eintrag)
<Task-Text>
## Nicht anfassen         (avoid-Pfade, je Zeile)
[Board-Abschnitt bestehender Ordnung]
```

### D3 — `verify` fließt in drei Abnehmer

1. **Gauntlet:** `criticPrompt` erhält einen `## Kriterien dieses Runs`-Block
   aus `plan.verify` — der Critic urteilt gegen die verifizierbaren Zeilen
   (neben der bestehenden Bar, nicht statt).
2. **Rückkehr-Prüfung:** `dispatchResultPrompt` erhält dieselben Zeilen — der
   Orchestrator prüft jede Rückkunft gegen den Vertrag, bevor er `final`
   schreibt oder weiterschaftet.
3. **Board:** jede verify-Zeile wird als `[T0] …`-Zeile ins Board gespiegelt
   (einmalig beim ersten dispatch). Kinder können mit `[T0]`-Referenz
   antworten — der Vertrag wird shared truth, das Board der Rückkanal
   (bestehende `boardAbsorb`-Mechanik, kein neues Format).

### D4 — `Pipeline.refine` (Dokument-Toggle)

- `types.ts`: `refine?: true` — absent = off (alle bestehenden Canvases
  unverändert), persistiert/exportierbar/undoable wie `isolate`
  (FLOW.md-Muster). Nur im Modus `orchestration` wirksam; in anderen Modi
  ignoriert (kein `shapeProblems`-Block — es kann nichts kaputt laufen, da
  kein Scheduler es liest).
- Inspector: Toggle analog `isolate`/`gauntlet` (bestehendes UI-Muster).
- `validate.ts`: max 7 verify-Einträge werden im Parser erzwungen; Warnung in
  `preflight` wenn `refine` an aber kein Card-Feld `evidence`-fähig? — Nein:
  keine Warnung, das Briefing lehrt es. (Warnen würde trainiert, Warnungen zu
  ignorieren — FLOW.md:52-55-Logik.)

### D5 — Briefing-Erweiterung (nur bei `refine`)

Neuer Abschnitt in `orchestratorBriefing` zwischen „Cards you can dispatch to"
und „How you say what happens next":

```
## Before your first dispatch — der Vertrag
1. Miss selbst, bevor du schreibst (read/bash/grep sind deine): Datei:Zeile
   und Zahlen in `evidence` — nicht die Karte suchen lassen.
2. Prüfe `skills` — nenne nur Namen, die existieren; der Inhalt wird der Karte
   vor ihren Task gestellt.
3. Schneide den Scope: Pfade, die niemand anfasst, in `avoid`.
4. Definiere `verify` (1–7): die Kriterien, an denen jede Rückkehr und der
   Critic gemessen werden. Eine Zeile, ein prüfbarer Sachverhalt.
5. Der erste Dispatch führt den `plan` mit. Ohne ihn wird er zurückgewiesen.
```

Plus Protokoll-Beispiel (dispatch.ts:370–372-Pendant im Briefing) erweitert um
`plan/evidence/skills/avoid` in einer Zeile. Beispiel BLEIBT kompakt — das
Briefing lehrt das Format, nicht die Philosophie.

### D6 — Template „dirigent build" (L2, ohne Engine-Pflicht)

`templates.ts`: neue orchestration mit zweistufiger Wurzel:

```
Veredler (Rolle orchestrator, billiges Modell, Checklisten-Prompt)
  └─ Boss (orchestrator, starkes Modell)
       ├─ architect / coder / reviewer (crew)
```

Der Veredler dispatched GENAU EINMAL: `{plan, dispatch:[{card: boss, task:
<der G10-artige Vertrag als Text>, evidence/skills/avoid gefüllt}]}` — seine
Rollanweisung (custom prompt) trägt die 6-Punkte-Checkliste wörtlich
(Original archivieren · selbst messen · skills · scope/avoid · verify vorab ·
self-contained gießen). Kostenformel: +1 Session am Run-Start, dafür
dünne-dispatch-Fehlleitung eliminiert (gemessen im `routed-orchestrator`-Fall:
ganze Runs ohne gelaufene Kinder).

### D7 — Skill-Merge (L3)

`server/skills.ts` (neu, klein): `readSkillFor(name): Promise<string |
undefined>` — global vor project (FLOW.md-Reihenfolge), Markdown roh, auf
8000 Zeichen je Skill gekappt (Hard-Limit, error-Grund beim Überschreiten von
2 Skills je Assignment). Engine merged NUR in den ersten Turn des Kindes
(analog swarm-Attachments „ride the first turn only", FLOW.md:74) — Session-
Prefix-Caching der Folge-Turns bleibt intakt.

### D8 — Anhang: Session-Titel = Kartenname

Einzelner `client.v2.session.*`-Aufruf beim Session-Create, wenn die API einen
Titel nimmt (bei Umsetzung prüfen; ohne Endpunkt: Punkt entfällt ersatzlos).

## 3. Angriffsfolge

1. `graph/types.ts` — `Pipeline.refine?`, Export/Persistenz (`state.ts`
   round-trip erweitern).
2. `graph/dispatch.ts` — `PlanBlock`-Typ, plan-Member-Validierung,
   `evidence/skills/avoid` in `assignmentsFrom`, Budget-Limits.
3. `graph/prompt.ts` — Veredelungs-Abschnitt (refine-konditional),
   Protokoll-Beispiel erweitert, `assignmentBody()`-Builder
   (skill/evidence/avoid-Komposition), verify-Blöcke für `criticPrompt` +
   `dispatchResultPrompt`.
4. `server/skills.ts` neu + `server/engine.ts` — Erst-Turn-Merge, Sequenz-Guard
   (`refused`-Muster), avoid-Post-Batch-Check (Erweiterung um `writesOf`:
   Kind-Schreibzugriff auf avoid-Pfad → Warnzeile an Orchestrator im
   Result-Prompt, kein Fail — bash ist nicht verhinderbar, FLOW.md-Philosophie).
5. `server/board.ts` — `[T0]`-Spiegelung von `plan.verify` beim ersten
   dispatch.
6. `graph/templates.ts` — „dirigent build" (L6) + Rollanweisung des Veredlers.
7. UI: Inspector-Toggle `refine` (analog `isolate`), Kanban-frei.
8. `FLOW.md` — neuer Abschnitt „Phase-0-Veredelung (refine)" als Regeln
   (when X, do Y), CHANGELOG, `package.json` → 1.3.0.

Nach jedem Schritt: `bun test` + `bun run typecheck` (aus `packages/flow`).

## 4. Tests (jeder mit Gegenprobe)

- `dispatch.test.ts`: plan+dispatch gültig · plan allein = error · plan+final =
  error · verify > 7 = error · evidence-Budget überschritten = error · skills
  kein String-Array = error · avoid-Pfad kollidiert mit files eines anderen =
  error · **Gegenprobe:** alter Block `{card,task}` ohne alles läuft unverändert.
- `prompt.test.ts`: Briefing enthält Checkliste NUR bei refine ·
  assignmentBody-Komposition (Skill → Evidence → Task → avoid → Board) ·
  criticPrompt enthält verify-Zeilen nur bei plan.
- `board.test.ts`: T0-Zeilen absorbieren, kein Doppel-T0 bei zweitem dispatch.
- `engine`-Tests (Mock-Runner, bestehendes Muster): Sequenz-Guard — erster
  dispatch ohne plan bei refine → genau ein reask mit Grund, zweiter →
  Karten-Fehler · refine aus: keine Verhaltensänderung (Gegenprobe) · Skill
  erscheint nur im ersten Turn (Gegenprobe: zweiter Turn ohne Skill-Block).
- `skills.test.ts`: global vor project · unbekannt = undefined → error-Grund ·
  8k-Kappung.

## 5. Live-Sollwerte (Abnahme durch Betreiber, G10-Stil)

1. Run „orchestrated build" mit `refine`: erster dispatch-Block führt
   `plan.verify ≥ 1` und ≥ 1 Assignment mit `evidence` (Nachweis: run log
   events in `<project>/.openflow/runs/`).
2. Kind-Task im ersten Turn enthält Skill-Block, Folge-Turn nicht.
3. `[T0]`-Zeilen ab dispatch 2 im Board sichtbar.
4. Derselbe Run ohne `refine`: bitwise identisches Protokollverhalten wie 1.2.1
   (Kompatibilität).
5. „dirigent build"-Template läuft auf Drop (runnable on drop, wie alle
   Templates).

## 6. Risiken

- **Prompt-Wachstum:** evidence+skills blähen Kind-Turns auf → Budget-Limits
  (D2/D7) sind hart, error-Gründe lehrbar.
- **Modell-Adhärenz:** schwache Orchestratoren schreiben plan nicht sauber →
  Sequenz-Guard reaskt einmal; Messpunkt der ersten Live-Runs. Bleibt es
  chronisch: `refined-orchestrator`-Warnung in validate.ts ergänzen (wie
  `routed-orchestrator`, FLOW.md:247).
- **Reask-Zählung:** exakte Fehler-Zählung im error-Zweig muss bei Umsetzung
  oberhalb engine.ts:1020 nachgelesen werden — der Plan setzt auf dem
  dokumentierten einmal/Fail auf (FLOW.md:200–202).
- **Nicht berührt:** uncommittete Debug-Änderung
  `packages/core/.../local.ts` (bleibt außerhalb; Commit der Umsetzung per
  präzisem `git add packages/flow FLOW.md` — niemals `git add -A`).

## 7. Ship

- Version `@openflow/flow` 1.3.0, CHANGELOG-Eintrag, FLOW.md-Abschnitt.
- Commit auf `dev` (Fork-Stil: `feat(flow): …`), push `origin dev`.
- Kein PR gegen SeeRay11/upstream ohne separate Entscheidung.
