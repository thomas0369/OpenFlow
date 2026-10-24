/**
 * Die Regeln der Autonomie-Messung gegen Feldfälle.
 *
 * Die Shell-Zeilen und der Schlussbericht stammen wörtlich aus den
 * W4-Benchmarkläufen vom 23.10.2026 (Testdienst, opencode.db unter
 * w0/xdg). Wo die erste Fassung (Python, Regex auf den ersten 160 Zeichen)
 * falsch lag, steht sie als `alteRegel` daneben: Der Test beweist damit
 * zugleich, dass er die alte Fassung ROT gemeldet hätte.
 */
import { describe, expect, it } from "bun:test"
import feldfaelle from "./feldfaelle-w4b.json"
import feld2410 from "./feldfaelle-feld-24-10.json"
import {
  type Nachricht,
  aufrufe,
  ausschlussGrund,
  fanoutKennzahlen,
  fuehrtSkriptAus,
  istArbeitsaufruf,
  istStichprobe,
  istKurzSynchron,
  istTestZeile,
  istWarteAbfrage,
  LANG_S,
  pruefeKontrollwerte,
  quantil,
  segmente,
} from "./lib"

const AUS = /(\.\/|bash |sh |[\w.-]+\/)pruefe\.sh/
const LES = /^\s*(grep|cat|sed|head|tail|less|wc|ls)\b/
const alteRegel = (cmd: string) => AUS.test(cmd.slice(0, 160)) && !LES.test(cmd.slice(0, 160))

describe("fuehrtSkriptAus — Arbeitsaufruf (Ausführung) vs. Stichprobe (Lesen)", () => {
  const ausfuehrung = [
    "./pruefe.sh",
    './pruefe.sh 2>&1; echo "EXIT=$?"',
    "./pruefe.sh > /tmp/opencode/gamma-pruefe-stdout.log 2> /tmp/opencode/gamma-pruefe-stderr.log; printf 'EXIT_CODE=%s\\n' \"$?\"",
    "bash ./pruefe.sh",
    "cd alpha && ./pruefe.sh",
    "cd /home/x/bench/laeufe/B1-dharma_power-2/beta && ./pruefe.sh",
    "cd /home/x/bench/laeufe/B1-dharma_power-0/beta && timeout 60 ./pruefe.sh >/tmp/opencode/beta_out.txt 2>/tmp/opencode/beta_err.txt;",
    'cd alpha && ./pruefe.sh; echo "ERGEBNIS-Code:$?"; echo "TODO-Anzahl:$(grep -rIn \'TODO\' src/ 2>/dev/null | wc -l)"',
    'for p in alpha beta gamma; do echo "== $p =="; (cd "$p" && ./pruefe.sh; echo "EXIT=$?"; echo "TODOs=$(grep -rn \'TODO\' src/ | wc -l)"); done',
    'timeout 60 ./pruefe.sh >/tmp/opencode/alpha_pruefe_stdout.txt 2>/tmp/opencode/alpha_pruefe_stderr.txt; echo "EXIT_CODE=$?"',
  ]
  const stichprobe = [
    "cat epsilon/pruefe.sh",
    'grep -H "ERGEBNIS" alpha/pruefe.sh beta/pruefe.sh gamma/pruefe.sh delta/pruefe.sh; ls .git/worktrees 2>/dev/null',
    'ls -la alpha/ && ls -d alpha/src 2>&1; test -x alpha/pruefe.sh && echo "EXECUTABLE=yes" || echo "EXECUTABLE=no"',
    'pwd && ls -la && echo "---" && find . -maxdepth 3 -name "pruefe.sh" 2>/dev/null',
    "ls -l pruefe.sh src",
    'git add delta/src/rechne.js && git commit -m "fix(delta): add() subtrahierte statt addiert (a - b -> a + b)\n\npruefe.sh schlug fehl, weil add(2,3)=-1 statt 5 lieferte"',
  ]
  // Feldfälle, an denen die erste Fassung irrte
  const alteIrrte: [string, boolean][] = [
    ['echo "=== beta/pruefe.sh ==="; cat beta/pruefe.sh; echo "=== TODO-Zählung beta (Stichprobe) ==="; grep -rn "TODO" beta/src/ | wc -l', false],
    ['echo "--- ls gamma ---"; ls -la gamma/; echo "--- pruefe.sh ---"; cat gamma/pruefe.sh; echo "--- TODO-Zaehlung ---"; grep -rn "TODO" gamma/src/ | wc -l', false],
    ['pwd && echo "=== STRUKTUR ===" && ls -la && for p in alpha beta gamma; do echo "=== $p ==="; ls -la "$p" 2>&1; echo "--- $p/pruefe.sh ---"; cat "$p/pruefe.sh" 2>&1; done', false],
    ['cd /home/x/bench/laeufe/B4-dharma_power-3 && echo "=== epsilon/pruefe.sh ==="; cat -n epsilon/pruefe.sh; echo "=== gamma/pruefe.sh ==="; cat -n gamma/pruefe.sh', false],
    ['ls -la .erster-lauf && git status --short && echo "--- Testlauf ---" && ./pruefe.sh; echo "exit=$?"', true],
    [
      'git merge ses-b2/wt-delta-fix && echo "=== MERGE OK ===" && git log --oneline -2 && git diff 243bd30 HEAD --stat && echo "=== STICHPROBE ===" && cd delta && ./pruefe.sh; echo "EXIT:$?"',
      true,
    ],
  ]

  for (const c of ausfuehrung) it(`führt aus: ${c.slice(0, 60)}`, () => expect(fuehrtSkriptAus(c)).toBe(true))
  for (const c of stichprobe) it(`liest nur: ${c.slice(0, 60)}`, () => expect(fuehrtSkriptAus(c)).toBe(false))
  for (const [c, soll] of alteIrrte) {
    it(`Feldfall (alte Regel irrte): ${c.slice(0, 50)}`, () => {
      expect(fuehrtSkriptAus(c)).toBe(soll)
      expect(alteRegel(c)).toBe(!soll) // Gegenprobe: die erste Fassung wäre hier rot
    })
  }

  it("Trenner in Anführungszeichen trennen nicht, 2>&1 trennt nicht", () => {
    expect(segmente('echo "a; ./pruefe.sh" && cat x 2>&1')).toEqual(['echo "a; ./pruefe.sh"', "cat x 2>&1"])
  })
})

describe("Stichprobe und Warte-Abfrage (Feld)", () => {
  it("reine Lesezeilen sind Stichproben", () => {
    expect(istStichprobe('grep -rn "TODO" src/ | wc -l && grep -rn "TODO" src/')).toBe(true)
    expect(istStichprobe("git status --short && git log --oneline -3")).toBe(true)
    expect(istStichprobe("cd x && sed -n 1,20p a.ts")).toBe(true)
  })
  it("schreibende oder ausführende Zeilen sind keine Stichproben", () => {
    expect(istStichprobe("sed -i s/a/b/ x.ts")).toBe(false)
    expect(istStichprobe("npm test")).toBe(false)
    expect(istStichprobe("git worktree add /tmp/x -b y")).toBe(false)
    expect(istStichprobe("git commit -m x")).toBe(false)
    expect(istStichprobe("tail -f /tmp/x.log")).toBe(false)
  })
  it("sleep/ps/pgrep/tail -f sind Warte-Abfragen, auch hinter 160 Zeichen", () => {
    expect(istWarteAbfrage("sleep 30; cat log")).toBe(true)
    expect(istWarteAbfrage("tail -f /tmp/x.log")).toBe(true)
    expect(istWarteAbfrage(`echo "${"x".repeat(200)}"; ps aux | grep -i w0`)).toBe(true)
    expect(istWarteAbfrage('echo "sleep gut"; tail -n 5 x')).toBe(false)
  })
  it("Arbeitsaufruf im Feld: subagent immer, shell nur ohne Lesen/Warten", () => {
    expect(istArbeitsaufruf({ tool: "subagent", cmd: "" })).toBe(true)
    expect(istArbeitsaufruf({ tool: "shell", cmd: "npm run test:unit" })).toBe(true)
    expect(istArbeitsaufruf({ tool: "shell", cmd: "cat x" })).toBe(false)
    expect(istArbeitsaufruf({ tool: "shell", cmd: "sleep 60" })).toBe(false)
    expect(istArbeitsaufruf({ tool: "read", cmd: "" })).toBe(false)
  })
})

describe("pruefeKontrollwerte — Tabellenzeile entscheidet", () => {
  const SOLL = { alpha: ["A-4417", 3], beta: ["B-9062", 5], gamma: ["G-1385", 2] } as const
  const soll = SOLL as unknown as Record<string, [string, number | null]>
  // Feldfall B1 dharma/power #3 (ses_e958fdfbdffeIeEEFMJrqIMEQ6), wörtlich
  const FELD =
    "Alle drei Pakete geprüft.\n\n| Paket | ERGEBNIS-Code | TODO-Anzahl |\n|---|---|---|\n| alpha | 0 | 3 |\n| beta | 0 | 5 |\n| gamma | 0 | 2 |\n\n" +
    "Alle drei Läufe endeten mit Exit-Code 0; die `pruefe.sh`-Ausgaben waren `ERGEBNIS alpha A-4417`, `ERGEBNIS beta B-9062` und `ERGEBNIS gamma G-1385`. [9/10]"

  it("Feldfall: Exit-Code 0 in der Code-Spalte ist falsch, auch wenn die Codes im Fließtext stehen", () => {
    expect(pruefeKontrollwerte(FELD, soll)).toEqual({ alpha: false, beta: false, gamma: false })
  })

  it("Gegenprobe: die alte Zeilenregel lässt sich vom Fließtext retten", () => {
    const text = FELD.replace("[9/10]", "[3/10]")
    const alt = (t: string, p: string, code: string, n: number) =>
      t.includes(code) && t.split("\n").some((z) => z.includes(p) && z.includes(code) && new RegExp(`(?<![\\d-])${n}(?![\\d-])`).test(z.replaceAll(code, "")))
    expect(alt(text, "alpha", "A-4417", 3)).toBe(true)
    expect(pruefeKontrollwerte(text, soll).alpha).toBe(false)
  })

  it("richtige Tabelle (auch mit Backticks) besteht", () => {
    const t = "| Paket | ERGEBNIS-Code | TODO-Anzahl |\n|---|---|---|\n| alpha | `A-4417` | 3 |\n| **beta** | B-9062 | 5 |\n| gamma | G-1385 | 2 |"
    expect(pruefeKontrollwerte(t, soll)).toEqual({ alpha: true, beta: true, gamma: true })
  })

  it("falsche Zahl in der Tabelle fällt durch", () => {
    const t = "| alpha | A-4417 | 4 |\n| beta | B-9062 | 5 |\n| gamma | G-1385 | 2 |"
    expect(pruefeKontrollwerte(t, soll)).toEqual({ alpha: false, beta: true, gamma: true })
  })

  it("ohne Tabelle: Code-Aufgaben (B2/B4) genügt der Code im Text", () => {
    expect(pruefeKontrollwerte("delta D-7720, alpha A-4417", { delta: ["D-7720", null], alpha: ["A-4417", null], beta: ["B-9062", null] })).toEqual({
      delta: true,
      alpha: true,
      beta: false,
    })
  })

  it("ohne Tabelle: die Zahl darf nicht Teil des Codes sein", () => {
    expect(pruefeKontrollwerte("gamma G-1385 erledigt", { gamma: ["G-1385", 3] }).gamma).toBe(false)
    expect(pruefeKontrollwerte("gamma G-1385, 2 TODOs", { gamma: ["G-1385", 2] }).gamma).toBe(true)
  })
})

describe("ausschlussGrund — Benchmark-, Abnahme- und Testsitzungen", () => {
  const alle = new Map([
    ["ses_b", { id: "ses_b", directory: "/home/t/workspace/OpenFlow/packages/flow/bench/laeufe/B1-dharma_power-1" }],
    ["ses_j", { id: "ses_j", directory: "/home/t/.claude/jobs/9de35ddc/tmp/ab/repo", title: "ab-neu-1" }],
    ["ses_a", { id: "ses_a", directory: "/home/t/workspace/mcp-workers", title: "abnahme-live W1 23.10." }],
    ["ses_k", { id: "ses_k", parent_id: "ses_a", directory: "/home/t/workspace/mcp-workers", title: "Tests dharma" }],
    ["ses_f", { id: "ses_f", directory: "/home/t/workspace/mcp-workers", title: "Abnahme Loop-Fixes" }],
    ["ses_testende1", { id: "ses_testende1" }],
  ])
  it("Gründe", () => {
    expect(ausschlussGrund(alle.get("ses_b")!, alle)).toBe("benchmark")
    expect(ausschlussGrund(alle.get("ses_j")!, alle)).toBe("job-tmp")
    expect(ausschlussGrund(alle.get("ses_a")!, alle)).toBe("abnahme-live")
    expect(ausschlussGrund(alle.get("ses_testende1")!, alle)).toBe("test")
  })
  it("ein Kind erbt den Grund seiner Wurzel", () => {
    expect(ausschlussGrund(alle.get("ses_k")!, alle)).toBe("abnahme-live")
  })
  it("Feldsitzung zählt — auch „Abnahme …“ ohne den festen Präfix", () => {
    expect(ausschlussGrund(alle.get("ses_f")!, alle)).toBeNull()
  })
  it("Ledger-Testzeilen", () => {
    expect(istTestZeile({ sessionID: "ses_testende2", parent: "ses_parent1" })).toBe(true)
    expect(istTestZeile({ sessionID: "ses_ed3448f73ffeu8KolaC6zDJu9f" })).toBe(false)
  })
})

describe("fanoutKennzahlen", () => {
  const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool", name, state: { input } })
  const ms: Nachricht[] = [
    { type: "user" },
    // ganz im Hintergrund
    { type: "assistant", content: [tool("subagent", { background: true }), tool("subagent", { background: true })] },
    // halb im Hintergrund: Fan-out, aber nicht „mit background"
    { type: "assistant", content: [tool("shell", { command: "npm test", background: true }), tool("subagent", {})] },
    // zwei Stichproben: kein Fan-out
    { type: "assistant", content: [tool("shell", { command: "cat a" }), tool("shell", { command: "grep x b" })] },
    // Warte-Abfrage
    { type: "assistant", content: [tool("shell", { command: "sleep 20; tail -n 5 log" })] },
  ]
  it("Feld: Fan-outs, davon ganz im Hintergrund, Warte-Abfragen", () => {
    expect(fanoutKennzahlen(ms)).toEqual({
      arbeitsaufrufe: 4,
      davon_bg: 3,
      fanouts: 2,
      fanouts_bg: 1,
      max_parallel_in_einer_nachricht: 2,
      warte_abfragen: 1,
      kurz_synchron: 0, // Parts ohne Zeitangabe: Laufzeit unbekannt, also nie „kurz"
    })
  })
  it("Benchmark: nur Ausführungen des Skripts zählen", () => {
    const b: Nachricht[] = [
      { type: "assistant", content: [tool("shell", { command: "cd alpha && ./pruefe.sh", background: true }), tool("shell", { command: "cat beta/pruefe.sh" })] },
    ]
    expect(fanoutKennzahlen(b, "pruefe.sh")).toMatchObject({ arbeitsaufrufe: 1, fanouts: 0 })
  })
})

describe("Hintergrund-Erkennung — Feldfälle W4-Neulauf 24.10.2026 (feldfaelle-w4b.json)", () => {
  const fall = (sid: string) => {
    const f = feldfaelle.find((x) => x.session === sid)
    if (!f) throw new Error(`Feldfall ${sid} fehlt`)
    return f.nachrichten as Nachricht[]
  }
  /** Die alte Regel: Hintergrund NUR, wenn die gespeicherte Eingabe background:true trägt. */
  const alteBg = (ms: Nachricht[]) =>
    ms.flatMap((m) => (m.type === "assistant" ? (m.content ?? []) : []))
      .filter((c) => c.name === "subagent" || c.name === "shell")
      .map((c) => Boolean(c.state?.input?.background))
  const arbeitsBg = (ms: Nachricht[]) => aufrufe(ms).filter((a) => a.tool === "subagent" || a.tool === "shell")

  it("Guard-Umstellung (created): beide subagents im Hintergrund, obwohl die Eingabe kein background trägt", () => {
    const ms = fall("ses_e9212f657ffeJEjoPEaJmtndHq")
    const sub = aufrufe(ms).filter((a) => a.tool === "subagent")
    expect(sub.map((a) => [a.bg, a.umgestellt])).toEqual([[true, true], [true, true]])
    expect(fanoutKennzahlen(ms, "pruefe.sh")).toMatchObject({ arbeitsaufrufe: 2, davon_bg: 2, fanouts: 1, fanouts_bg: 1 })
    // Gegenprobe: die alte Regel misst denselben Lauf als Vordergrund — so stand er in ergebnis.jsonl (fanouts_bg 0).
    expect(alteBg(ms).filter((b) => b).length).toBe(0)
  })

  it("Guard-Umstellung (session.get): drei umgestellte subagents, der Fan-out zählt als Hintergrund", () => {
    const ms = fall("ses_e921b7a98ffe2nPBn1FbfXcZ2l")
    expect(aufrufe(ms).filter((a) => a.umgestellt).length).toBe(3)
    expect(fanoutKennzahlen(ms, "pruefe.sh")).toMatchObject({ fanouts: 1, fanouts_bg: 1 })
  })

  it("echter Vordergrund (B4 #1): 6 synchrone shells bleiben Vordergrund, der Fan-out auch", () => {
    const ms = fall("ses_e921b7aa0ffesUjnc7EMjxwF99")
    const sh = arbeitsBg(ms)
    expect(sh.length).toBe(6)
    expect(sh.every((a) => !a.bg && !a.umgestellt)).toBe(true)
    expect(ms.some((m) => m.type === "synthetic")).toBe(false)
    expect(fanoutKennzahlen(ms, "pruefe.sh")).toMatchObject({ arbeitsaufrufe: 2, davon_bg: 0, fanouts: 1, fanouts_bg: 0 })
  })

  it("Vordergrund-subagent (23.10.): Ergebnis im Part, sogar mit <subagent …>-Text — trotzdem Vordergrund", () => {
    const ms = fall("ses_e958a6e3cffeulkvAu8FUday5r")
    const sub = aufrufe(ms).filter((a) => a.tool === "subagent")
    expect(sub.length).toBe(2)
    expect(sub.every((a) => !a.bg)).toBe(true)
  })

  it("Modell setzt background: subagents und shells im Hintergrund, nichts davon umgestellt", () => {
    for (const sid of ["ses_e921b7a9affePVMnQNsiHyQIMf", "ses_e921b7a9dffea8Yo0JwCxsdicS"]) {
      const ms = fall(sid)
      const bg = arbeitsBg(ms).filter((a) => a.bg)
      expect(bg.length).toBe(4)
      expect(bg.every((a) => !a.umgestellt)).toBe(true)
      expect(fanoutKennzahlen(ms, "pruefe.sh")).toMatchObject({ fanouts: 1, fanouts_bg: 1 })
    }
  })

  it("Kennzeichen aus dem Part allein genügt (Fertig-Meldung außerhalb des Fensters, wie in woche.ts)", () => {
    const ohneMeldung = fall("ses_e9212f657ffeJEjoPEaJmtndHq").filter((m) => m.type !== "synthetic")
    expect(fanoutKennzahlen(ohneMeldung, "pruefe.sh")).toMatchObject({ fanouts_bg: 1 })
  })

  it("Fertig-Meldung allein genügt (Part ohne running-Status, Kennung in der synthetic-Meldung)", () => {
    const ms: Nachricht[] = [
      { type: "assistant", content: [{ type: "tool", name: "subagent", state: { input: {}, metadata: { sessionID: "ses_k1", status: "completed" } } }] },
      { type: "synthetic", metadata: { source: "subagent", childID: "ses_k1", state: "completed" } },
    ]
    expect(aufrufe(ms)[0]).toMatchObject({ bg: true, umgestellt: true })
  })

  it("Summe über alle Feldfälle: neue Regel 4/6 Fan-outs im Hintergrund, alte Regel 2/6", () => {
    // Alte Regel nachgestellt: nur die gespeicherte Eingabe zählt — Status und Fertig-Meldungen weg.
    const nurEingabe = (ms: Nachricht[]): Nachricht[] =>
      ms
        .filter((m) => m.type !== "synthetic")
        .map((m) => ({ ...m, content: m.content?.map((c) => ({ ...c, state: { input: c.state?.input } })) }))
    const summe = (f: (ms: Nachricht[]) => Nachricht[]) =>
      feldfaelle
        .map((x) => fanoutKennzahlen(f(x.nachrichten as Nachricht[]), "pruefe.sh"))
        .reduce((a, k) => [a[0] + k.fanouts_bg, a[1] + k.fanouts], [0, 0])
    expect(summe((ms) => ms)).toEqual([4, 6])
    expect(summe(nurEingabe)).toEqual([2, 6])
  })
})

describe("quantil", () => {
  it("wie die Auswertung vom 23.10.: Index floor(p·n)", () => {
    expect(quantil([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(quantil([1, 2, 3, 4], 0.9)).toBe(4)
    expect(quantil([], 0.5)).toBeNull()
  })
})

describe("Feldfälle 24.10.2026 — Hauptfaden „Wortwert-Statusanalyse“ (feldfaelle-feld-24-10.json)", () => {
  // Jede Nachricht einzeln als Sitzung gerechnet: Ein Fan-out ist eine Eigenschaft EINER Nachricht.
  const nachricht = (f: (typeof feld2410.faelle)[number]): Nachricht[] => [{ type: "assistant", content: f.content as any[] }]
  const fan = feld2410.faelle.filter((f) => f.art === "fanout")
  const warte = feld2410.faelle.filter((f) => f.art === "warte")
  const summe = (faelle: typeof fan, umbau: (ms: Nachricht[]) => Nachricht[] = (ms) => ms) =>
    faelle.map((f) => fanoutKennzahlen(umbau(nachricht(f)))).reduce((a, k) => [a[0] + k.fanouts_bg, a[1] + k.fanouts, a[2] + k.warte_abfragen], [0, 0, 0])
  /** Alte Regel nachgestellt: ohne Laufzeit ist keine Shell „kurz". */
  const ohneZeit = (ms: Nachricht[]): Nachricht[] => ms.map((m) => ({ ...m, content: m.content?.map(({ time, ...c }) => c) }))
  /** Vordergrund nachgestellt: background und running-Status weg. */
  const vordergrund = (ms: Nachricht[]): Nachricht[] =>
    ms.map((m) => ({
      ...m,
      content: m.content?.map((c) => ({ ...c, state: { ...c.state, input: { ...c.state.input, background: undefined }, metadata: { status: "completed" } } })),
    }))

  it("Bestand: 9 Vordergrund-Fan-outs und 5 Warte-Abfragen, wie woche.ts sie vor der Schärfung zählte", () => {
    expect(fan.length).toBe(9)
    expect(warte.length).toBe(5)
  })

  it("git mit globaler Option ist ein Lesebefehl (Stichprobe neben der Abnahme, msg 168/236/247/283)", () => {
    for (const msg of [168, 236, 247, 283]) {
      const sh = fan.find((f) => f.msg === msg)!.content.find((c) => c.name === "shell")!
      expect(istStichprobe(sh.state.input.command!)).toBe(true)
    }
    expect(istStichprobe("git --no-pager -c core.pager=cat log -3")).toBe(true)
    // Gegenprobe: schreibende Unterbefehle bleiben Arbeit, auch hinter -C
    expect(istStichprobe("git -C /tmp/wt commit -m x")).toBe(false)
    expect(istStichprobe("git -C /tmp/wt worktree add /tmp/x")).toBe(false)
    expect(istStichprobe("git -C /tmp/wt worktree list")).toBe(true)
  })

  it("neu: 2 Fan-outs, beide im Hintergrund — die übrigen 7 waren ein kurzer Lesebefehl neben ≤ 1 Hintergrund-Lauf", () => {
    expect(summe(fan)).toEqual([2, 2, 0])
    const echt = fan.filter((f) => fanoutKennzahlen(nachricht(f)).fanouts === 1).map((f) => f.msg)
    expect(echt).toEqual([279, 311]) // je 2 Hintergrund-Subagenten + 1 kurze Shell (26,5 s / 10,0 s)
  })

  it("Gegenprobe: ohne Laufzeit misst die neue Regel dieselben 9 Vordergrund-Fan-outs wie die alte (bis auf die git -C-Stichproben)", () => {
    // Die vier git -C-Stichproben sind auch ohne Zeit keine Arbeit mehr → 5 statt 9; mit alter git-Regel wären es 9.
    expect(summe(fan, ohneZeit)).toEqual([0, 5, 0])
  })

  it("Gegenprobe: ein LANGER Vordergrund-Lauf neben Hintergrund-Subagenten bleibt ein Vordergrund-Fan-out", () => {
    const f279 = nachricht(fan.find((f) => f.msg === 279)!)
    const lang = f279.map((m) => ({
      ...m,
      content: m.content?.map((c) => (c.name === "shell" ? { ...c, time: { ran: 0, completed: LANG_S * 1000 } } : c)),
    }))
    expect(fanoutKennzahlen(f279)).toMatchObject({ fanouts: 1, fanouts_bg: 1, kurz_synchron: 1 })
    expect(fanoutKennzahlen(lang)).toMatchObject({ fanouts: 1, fanouts_bg: 0, kurz_synchron: 0 })
  })

  it("Grenze LANG_S: 59,9 s ist kurz, 60 s nicht; Hintergrund und unbekannte Dauer sind nie kurz", () => {
    expect(LANG_S).toBe(60)
    expect(istKurzSynchron({ tool: "shell", bg: false, dauer_s: 59.9 })).toBe(true)
    expect(istKurzSynchron({ tool: "shell", bg: false, dauer_s: 60 })).toBe(false)
    expect(istKurzSynchron({ tool: "shell", bg: true, dauer_s: 1 })).toBe(false)
    expect(istKurzSynchron({ tool: "shell", bg: false, dauer_s: null })).toBe(false)
    expect(istKurzSynchron({ tool: "subagent", bg: false, dauer_s: 1 })).toBe(false)
  })

  it("Warte-Abfragen: alle 5 liefen als Hintergrund-Shell (Monitor nach REGEL 3) → 0; im Vordergrund wären es 5", () => {
    expect(warte.every((f) => f.content.every((c) => c.state.input.background === true))).toBe(true)
    expect(summe(warte)).toEqual([0, 0, 0])
    expect(summe(warte, vordergrund)).toEqual([0, 0, 5])
  })
})
