/**
 * bench/lib — die reinen Regeln der Autonomie-Messung (Plan AUTONOMIE_10_10_SPEC
 * §6 W4, §9 T-06/T-07, §10 W5) plus der dünne HTTP-Zugang zur opencode-API.
 *
 * Alles, was eine Zahl im Bericht entscheidet, steht hier EINMAL und ist in
 * lib.test.ts gegen Feldfälle aus den W4-Läufen vom 23.10.2026 verriegelt:
 *   - Arbeitsaufruf vs. Stichprobe vs. Warte-Abfrage (shell/subagent)
 *   - Kontrollwert-Prüfung einer Berichtszeile
 *   - Ausschluss von Benchmark-, Abnahme- und Testsitzungen
 *   - Fan-out-Erkennung je Assistant-Nachricht
 *   - Hintergrund-Erkennung (Eingabe, running-Status, Fertig-Meldung) — Feldfälle
 *     aus dem W4-Neulauf 24.10.2026 in feldfaelle-w4b.json
 * bench.ts, wecken.ts, live.ts und woche.ts rufen nur diese Funktionen.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/* ───────────────────────── Shell-Befehle zerlegen ───────────────────────── */

/**
 * Zerlegt eine Shell-Zeile an `;`, `&`, `|`, Zeilenumbruch und Klammern —
 * aber nur AUSSERHALB von Anführungszeichen. Ohne diese Bedingung wird
 * `echo "=== beta/pruefe.sh ==="` zur Ausführung (Feldfall B1, 23.10.).
 */
export function segmente(cmd: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      cur += c
      if (c === "\\" && quote === '"') {
        cur += cmd[++i] ?? ""
        continue
      }
      if (c === quote) quote = null
      continue
    }
    if (c === "\\") {
      cur += c + (cmd[++i] ?? "")
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    // `2>&1`, `&>datei`, `<&3` sind Umleitungen, keine Trenner
    if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">")) {
      cur += c
      continue
    }
    if (";&|\n()".includes(c)) {
      out.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Wörter eines Segments, Anführungszeichen entfernt, Inhalt zusammengehalten. */
export function woerter(segment: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let hat = false
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      hat = true
      continue
    }
    if (/\s/.test(c)) {
      if (cur || hat) out.push(cur)
      cur = ""
      hat = false
      continue
    }
    cur += c
  }
  if (cur || hat) out.push(cur)
  return out
}

const VORSATZ = new Set(["do", "then", "else", "time", "nohup", "exec", "command", "env", "sudo", "!", "{"])

/**
 * Das eigentliche Kommando eines Segments: Schlüsselwörter (`do`, `then`),
 * Umgebungszuweisungen (`A=1`) und `timeout [-k 5] 60` werden übersprungen.
 */
export function kommando(segment: string): string[] {
  const w = woerter(segment)
  let i = 0
  while (i < w.length) {
    if (VORSATZ.has(w[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) {
      i++
      continue
    }
    if (w[i] === "timeout") {
      i++
      while (i < w.length && w[i].startsWith("-")) i += /^-[ks]$/.test(w[i]) ? 2 : 1
      i++ // Dauer
      continue
    }
    break
  }
  return w.slice(i)
}

/**
 * Führt die Zeile das Skript wirklich AUS? Ja, wenn ein Segment mit dem
 * Skript als Pfad beginnt (`./pruefe.sh`, `alpha/pruefe.sh`, `"$p/pruefe.sh"`)
 * oder mit einem Interpreter davor (`bash pruefe.sh`). Ein Pfad ohne `/` ist
 * kein Aufruf — bash sucht ihn im PATH, nicht im Ordner.
 */
export function fuehrtSkriptAus(cmd: string, skript = "pruefe.sh"): boolean {
  return segmente(cmd).some((s) => {
    const k = kommando(s)
    if (!k.length) return false
    if (k[0].includes("/") && k[0].endsWith("/" + skript)) return true
    return ["bash", "sh", "zsh", "source", "."].includes(k[0]) && (k[1] ?? "").split("/").pop() === skript
  })
}

const LESEN = new Set([
  "grep", "rg", "cat", "head", "less", "more", "wc", "ls", "find", "echo", "printf", "pwd", "test", "[",
  "stat", "file", "cd", "true", "jq", "sort", "uniq", "cut", "tr", "nl", "diff", "du", "tree", "which",
  "type", "date", "realpath", "basename", "dirname", "readlink", "awk",
])
const GIT_LESEN = new Set([
  "status", "log", "diff", "show", "branch", "ls-files", "rev-parse", "remote", "blame", "worktree",
  // nur lesend; `merge-base` stand im Feldfall 24.10.2026 in drei Abnahme-Stichproben
  "merge-base", "rev-list", "cat-file", "ls-tree", "describe", "shortlog", "name-rev", "for-each-ref", "grep",
])

function liestNur(k: string[]): boolean {
  if (!k.length) return true
  const c = k[0].split("/").pop() ?? ""
  if (c === "sed") return !k.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place")
  if (c === "tail") return !k.some((a) => /^-[a-zA-Z]*[fF]/.test(a))
  if (c === "git") {
    // globale Optionen vor dem Unterbefehl überspringen: `git -C <dir> show`, `git -c k=v log`, `git --no-pager diff`
    // (Feldfall 24.10.2026: `git -C /tmp/opencode/wt-… show --stat` zählte als Arbeit, weil k[1] = "-C" war)
    let i = 1
    while (i < k.length && k[i].startsWith("-")) i += k[i] === "-C" || k[i] === "-c" ? 2 : 1
    return GIT_LESEN.has(k[i] ?? "") && !(k[i] === "worktree" && k[i + 1] !== "list")
  }
  return LESEN.has(c)
}

/** Stichprobe = jede Teilanweisung liest nur (cat/grep/ls/git status …). */
export function istStichprobe(cmd: string): boolean {
  const k = segmente(cmd).map(kommando)
  return k.length > 0 && k.every(liestNur)
}

/** Warte-Abfrage = ein Segment schläft oder fragt Prozesse/Logs ab. */
export function istWarteAbfrage(cmd: string): boolean {
  return segmente(cmd).some((s) => {
    const k = kommando(s)
    const c = (k[0] ?? "").split("/").pop() ?? ""
    if (["sleep", "pgrep", "ps", "wait", "watch"].includes(c)) return true
    return c === "tail" && k.some((a) => /^-[a-zA-Z]*[fF]/.test(a))
  })
}

/* ───────────────────────── Werkzeugaufrufe ───────────────────────── */

export interface Aufruf {
  msg: number
  tool: string
  /** Lief im Hintergrund — gleich, wer es entschieden hat (Modell oder Guard). */
  bg: boolean
  /** Hintergrund, obwohl die GESPEICHERTE Eingabe kein `background: true` trägt (Guard-Umstellung). */
  umgestellt: boolean
  cmd: string
  /** Laufzeit des Parts in Sekunden (`time.ran|created` → `time.completed`), null wenn unbekannt. */
  dauer_s: number | null
}

export interface Nachricht {
  type: string
  content?: any[]
  time?: { created?: number; completed?: number }
  [k: string]: any
}

/** Kind-/Shell-Kennung eines Tool-Parts: `sessionID` (subagent) bzw. `shellID` (shell) aus state.metadata. */
function kennung(part: any): string | undefined {
  const md = part?.state?.metadata ?? part?.metadata ?? {}
  const id = md.sessionID ?? md.shellID
  return typeof id === "string" && id ? id : undefined
}

/**
 * Kennungen, für die eine synthetic-Meldung („<subagent sessionID=… state=…>",
 * „<shell … state=…>") in DIESER Sitzung eingetroffen ist — die Fertig-Meldung
 * eines Hintergrund-Laufs. Ein Vordergrund-Aufruf meldet sich nie so.
 */
function gemeldeteKennungen(ms: Nachricht[]): Set<string> {
  const ids = new Set<string>()
  for (const m of ms) {
    if (m.type !== "synthetic") continue
    const md = m.metadata ?? {}
    for (const id of [md.childID, md.shellID]) if (typeof id === "string" && id) ids.add(id)
  }
  return ids
}

/**
 * Lief der Aufruf im Hintergrund? Drei Belege, jeder genügt:
 *  (a) die gespeicherte Eingabe trägt `background: true` (das Modell hat es gesetzt);
 *  (b) der Tool-Part kam sofort zurück, während der Lauf weiterging —
 *      `state.metadata.status === "running"` MIT Kind-/Shell-Kennung;
 *  (c) für seine Kennung traf später eine synthetic-Meldung ein.
 * (a) allein reicht NICHT: Der Guard (W4b) stellt in execute.before auf
 * Hintergrund um, der gespeicherte Part behält die Original-Eingabe — gemessen
 * am W4-Neulauf 24.10.2026: 9/12 statt 11/12 Fan-outs im Hintergrund.
 * (b) ist das tragende Kennzeichen: es steht im Part selbst, gilt also auch,
 * wenn die Fertig-Meldung außerhalb des betrachteten Zeitfensters liegt
 * (woche.ts) oder der Lauf vor ihr endete. Vordergrund = der Part enthält das
 * Ergebnis direkt (`metadata.status: "completed"`, bei shell mit `exit`).
 */
function imHintergrund(part: any, gemeldet: Set<string>): { bg: boolean; umgestellt: boolean } {
  const inp = part?.state?.input ?? part?.input ?? {}
  const gesetzt = inp.background === true
  const md = part?.state?.metadata ?? part?.metadata ?? {}
  const id = kennung(part)
  const effektiv = Boolean(id) && (md.status === "running" || gemeldet.has(id!))
  return { bg: gesetzt || effektiv, umgestellt: !gesetzt && effektiv }
}

function dauer(part: any): number | null {
  const t = part?.time ?? part?.state?.time ?? {}
  const start = t.ran ?? t.created ?? t.start
  const ende = t.completed ?? t.end
  return typeof start === "number" && typeof ende === "number" && ende >= start ? (ende - start) / 1000 : null
}

/** Alle Werkzeugaufrufe der Assistant-Nachrichten, `msg` = Index in `ms`. */
export function aufrufe(ms: Nachricht[]): Aufruf[] {
  const gemeldet = gemeldeteKennungen(ms)
  return ms.flatMap((m, i) =>
    m.type !== "assistant"
      ? []
      : (m.content ?? [])
          .filter((c) => c?.type === "tool")
          .map((c) => {
            const inp = c.state?.input ?? c.input ?? {}
            return {
              msg: i,
              tool: c.name ?? c.tool,
              ...imHintergrund(c, gemeldet),
              cmd: String(inp.command ?? inp.prompt ?? ""),
              dauer_s: dauer(c),
            }
          }),
  )
}

/**
 * Ab dieser Laufzeit ist eine Vordergrund-Shell im Feld ein „langer Lauf“, der
 * nach der Regel in den Hintergrund gehört (AGENTS.md REGEL 1: „lange
 * Shell-Befehle (Tests, Builds, Läufe > 1 min): shell mit background: true“).
 * Die Zahl steht in der Regel, sie ist nicht an den Feldfällen gewählt.
 */
export const LANG_S = 60

/**
 * Kurz und synchron: eine Vordergrund-Shell im Feld, die nachweislich unter
 * LANG_S lief. Sie ist nach der Regel erlaubt („Synchron nur, wenn du das
 * Ergebnis im SELBEN Schritt brauchst“) und blockiert nichts Messbares —
 * kein Arbeitsaufruf, also auch kein Fan-out-Glied. Feldfall 24.10.2026,
 * Sitzung „Wortwert-Statusanalyse“: 9 von 18 Fan-outs waren ein solcher
 * Lesebefehl (0,1–26,5 s) neben Hintergrund-Subagenten.
 * Unbekannte Laufzeit zählt NICHT als kurz.
 */
export function istKurzSynchron(a: Pick<Aufruf, "tool"> & Partial<Pick<Aufruf, "bg" | "dauer_s">>): boolean {
  return a.tool === "shell" && a.bg !== true && typeof a.dauer_s === "number" && a.dauer_s < LANG_S
}

/**
 * Arbeitsaufruf: ein Subagent, oder eine Shell, die Arbeit tut.
 *  - mit `skript` (Benchmark): die Shell muss das Skript ausführen
 *  - ohne (Feld): die Shell ist weder Stichprobe noch Warte-Abfrage noch
 *    kurz-synchron (Vordergrund unter LANG_S)
 */
export function istArbeitsaufruf(
  a: Pick<Aufruf, "tool" | "cmd"> & Partial<Pick<Aufruf, "bg" | "dauer_s">>,
  skript?: string,
): boolean {
  if (a.tool === "subagent") return true
  if (a.tool !== "shell") return false
  if (skript) return fuehrtSkriptAus(a.cmd, skript)
  return !istStichprobe(a.cmd) && !istWarteAbfrage(a.cmd) && !istKurzSynchron(a)
}

export interface FanoutKennzahl {
  arbeitsaufrufe: number
  davon_bg: number
  fanouts: number
  fanouts_bg: number
  max_parallel_in_einer_nachricht: number
  warte_abfragen: number
  /** Feld: Vordergrund-Shells unter LANG_S, die sonst Arbeit wären (nur zur Transparenz). */
  kurz_synchron: number
}

/**
 * Fan-out = eine Assistant-Nachricht mit ≥ 2 Arbeitsaufrufen. Er zählt als
 * „mit background", wenn JEDER Arbeitsaufruf darin background:true trägt —
 * ein halber Hintergrund-Fan-out blockiert den Hauptfaden trotzdem. Im Feld
 * ist eine kurze Vordergrund-Shell (istKurzSynchron) kein Glied: Sie blockiert
 * unter LANG_S und ist nach der Regel erlaubt; ein langer Vordergrund-Lauf
 * daneben macht den Fan-out weiterhin zum Vordergrund-Fan-out.
 */
export function fanoutKennzahlen(ms: Nachricht[], skript?: string): FanoutKennzahl {
  const alle = aufrufe(ms)
  const arbeit = alle.filter((a) => istArbeitsaufruf(a, skript))
  const jeMsg = new Map<number, Aufruf[]>()
  for (const a of arbeit) jeMsg.set(a.msg, [...(jeMsg.get(a.msg) ?? []), a])
  const fan = [...jeMsg.values()].filter((g) => g.length >= 2)
  return {
    arbeitsaufrufe: arbeit.length,
    davon_bg: arbeit.filter((a) => a.bg).length,
    fanouts: fan.length,
    fanouts_bg: fan.filter((g) => g.every((a) => a.bg)).length,
    max_parallel_in_einer_nachricht: Math.max(0, ...[...jeMsg.values()].map((g) => g.length)),
    // Warte-Abfrage blockiert nur im Vordergrund. Eine Hintergrund-Shell mit `sleep`/Poll im Skript ist
    // der erlaubte Monitor aus REGEL 3 (Feldfall 24.10.2026: alle 5 gezählten Abfragen trugen background:true).
    warte_abfragen: alle.filter((a) => a.tool === "shell" && !a.bg && !arbeit.includes(a) && istWarteAbfrage(a.cmd)).length,
    kurz_synchron: skript
      ? 0
      : alle.filter((a) => istKurzSynchron(a) && !istStichprobe(a.cmd) && !istWarteAbfrage(a.cmd)).length,
  }
}

/* ───────────────────────── Kontrollwerte ───────────────────────── */

export type Soll = Record<string, [code: string, zahl: number | null]>

function tabellenZellen(zeile: string): string[] | null {
  if (!zeile.trim().startsWith("|")) return null
  return zeile
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((z) => z.replace(/[`*_]/g, "").trim())
}

/**
 * Trägt der Schlussbericht für jedes Paket den Sollwert?
 *
 * Steht das Paket in einer Tabellenzeile, entscheidet NUR diese Zeile: eine
 * Zelle muss den Code tragen, eine (andere) Zelle genau die Zahl. Feldfall
 * B1 dharma/power #3 (23.10.): Tabelle „alpha | 0 | 3", die Codes nur im
 * Fließtext darunter — das ist ein Exit-Code in der Code-Spalte und FALSCH.
 * Ohne Tabellenzeile: eine Zeile mit Paket und Code, die Zahl frei stehend
 * (nicht Teil des Codes, nicht Teil einer anderen Zahl).
 */
export function pruefeKontrollwerte(schluss: string, soll: Soll): Record<string, boolean> {
  const zeilen = schluss.split("\n")
  const frei = (z: string, n: number) => new RegExp(`(?<![\\d-])${n}(?![\\d-])`).test(z)
  return Object.fromEntries(
    Object.entries(soll).map(([paket, [code, zahl]]) => {
      const reihen = zeilen
        .map(tabellenZellen)
        .filter((z): z is string[] => z !== null && z.some((c) => c.toLowerCase() === paket.toLowerCase()))
      if (reihen.length) {
        const ok = reihen.some(
          (r) => r.some((c) => c.includes(code)) && (zahl === null || r.some((c) => c === String(zahl))),
        )
        return [paket, ok]
      }
      if (!schluss.includes(code)) return [paket, false]
      if (zahl === null) return [paket, true]
      const kandidaten = zeilen.filter((z) => z.includes(paket) && z.includes(code))
      return [paket, kandidaten.some((z) => frei(z.replaceAll(code, ""), zahl))]
    }),
  )
}

/* ───────────────────────── Ausschluss ───────────────────────── */

export interface SitzungsKopf {
  id: string
  parent_id?: string | null
  directory?: string | null
  title?: string | null
}

export const BENCH_VERZEICHNIS = /\/bench\/laeufe(\/|$)/
export const JOB_TMP_VERZEICHNIS = /\/\.claude\/jobs\/[^/]+\/tmp(\/|$)/
export const ABNAHME_TITEL = /^abnahme-live\b/i

/**
 * Warum eine Sitzung NICHT ins Feld zählt — oder null, wenn sie zählt.
 * Benchmark- und Job-Temp-Läufe sind gestellte Aufgaben, „abnahme-live" ist
 * die Abnahme selbst; beide würden die Messwoche mit ihrem eigenen Prüfstand
 * füttern. Eine Kind-Sitzung erbt den Grund ihrer Wurzel.
 */
export function ausschlussGrund(s: SitzungsKopf, alle?: Map<string, SitzungsKopf>): string | null {
  if (s.id.startsWith("ses_test")) return "test"
  if (ABNAHME_TITEL.test(s.title ?? "")) return "abnahme-live"
  const d = s.directory ?? ""
  if (BENCH_VERZEICHNIS.test(d)) return "benchmark"
  if (JOB_TMP_VERZEICHNIS.test(d)) return "job-tmp"
  const eltern = s.parent_id && alle?.get(s.parent_id)
  if (eltern && eltern.id !== s.id) return ausschlussGrund(eltern, alle)
  return null
}

/**
 * Herkunft eines Fabrik-Runs — „feld" oder der Grund, warum er NICHT zählt.
 *
 * Anlass (Feldmessung 24.10.2026): woche.ts zählte alle 15 Runs des Tages als
 * Fabrik-Feld — PASS 73,3 % —, obwohl nur EINER aus einer Betreiber-Sitzung kam.
 * Acht stammten aus der A/B-Messung (of-run.sh direkt aus einem Skript, ohne
 * OPENFLOW_SESSION → `host` trägt nur `pid`), sechs aus den Testläufen B3/B5
 * (eigener `opencode serve` mit Temp-XDG_DATA_HOME → die Sitzung steht in
 * keiner Betreiber-DB; B5 tötet den Lauf absichtlich per SIGKILL).
 *
 * Die Kennung ist `host.session` (headless-run, aus OPENFLOW_SESSION, die das
 * fabrik-gate-Plugin der Shell mitgibt). Regel:
 *   - keine Sitzung        → "ohne-sitzung" (Skript, Benchmark, A/B, Terminal)
 *   - Sitzung fehlt in DB  → "sitzung-fremd" (Testdienst, andere opencode.db)
 *   - Sitzung in DB        → ausschlussGrund (test/abnahme-live/benchmark/job-tmp) oder "feld"
 * Ein Start von Hand aus dem Terminal zählt damit nicht als Feld: Feld heißt
 * „eine Betreiber-Sitzung hat die Fabrik gerufen" — genau der Weg, den das
 * Gate erzwingen soll.
 */
export function runHerkunft(session: string | null | undefined, alle: Map<string, SitzungsKopf>): string {
  if (typeof session !== "string" || !session) return "ohne-sitzung"
  const s = alle.get(session)
  if (!s) return session.startsWith("ses_test") ? "test" : "sitzung-fremd"
  return ausschlussGrund(s, alle) ?? "feld"
}

/** Ledger-Zeile aus einem Test (`ses_test…`) — zählt nie. */
export function istTestZeile(e: { sessionID?: unknown; parent?: unknown }): boolean {
  return [e.sessionID, e.parent].some((v) => typeof v === "string" && v.startsWith("ses_test"))
}

/* ───────────────────────── Statistik ───────────────────────── */

/** Quantil wie in den Auswertungen vom 23.10.: sortiert, Index floor(p·n). */
export function quantil(werte: number[], p: number): number | null {
  if (!werte.length) return null
  const a = [...werte].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]
}

export function prozent(teil: number, ganz: number, stellen = 1): number | null {
  if (!ganz) return null
  return Number(((100 * teil) / ganz).toFixed(stellen))
}

/* ───────────────────────── opencode-API ───────────────────────── */

/** Passwort aus einer Klartextdatei ODER einer service.json (`password` / `server.password`). */
export function liesPasswort(o: { passwortDatei?: string; serviceJson?: string }): string {
  if (o.passwortDatei) return readFileSync(o.passwortDatei, "utf8").trim()
  const pfad = o.serviceJson ?? join(homedir(), ".config/opencode/service.json")
  if (!existsSync(pfad)) throw new Error(`kein Passwort: weder --passwort-datei noch ${pfad}`)
  const j = JSON.parse(readFileSync(pfad, "utf8"))
  const pw = j.password ?? j.server?.password
  if (typeof pw !== "string" || !pw) throw new Error(`${pfad} trägt kein password`)
  return pw
}

export class OpencodeApi {
  readonly basis: string
  private readonly auth: string
  constructor(server: string, passwort: string) {
    this.basis = server.replace(/\/$/, "") + "/api/session"
    this.auth = "Basic " + Buffer.from(`opencode:${passwort}`).toString("base64")
  }

  async rufe(pfad: string, methode = "GET", daten?: unknown): Promise<any> {
    const r = await fetch(this.basis + pfad, {
      method: methode,
      headers: { authorization: this.auth, "content-type": "application/json" },
      body: daten === undefined ? undefined : JSON.stringify(daten),
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) throw new Error(`${methode} ${pfad} → HTTP ${r.status}`)
    const roh = await r.text()
    return roh ? JSON.parse(roh) : null
  }

  async neueSitzung(o: { verzeichnis?: string; titel?: string; agent?: string; modell?: string }): Promise<string> {
    const body: Record<string, unknown> = {}
    if (o.verzeichnis) body.location = { directory: o.verzeichnis }
    if (o.titel) body.title = o.titel
    const sid: string = (await this.rufe("", "POST", body)).data.id
    if (o.agent) await this.rufe(`/${sid}/agent`, "POST", { agent: o.agent })
    if (o.modell) {
      const [providerID, ...rest] = o.modell.split("/")
      await this.rufe(`/${sid}/model`, "POST", { model: { providerID, id: rest.join("/") } })
    }
    return sid
  }

  prompt(sid: string, text: string) {
    return this.rufe(`/${sid}/prompt`, "POST", { text })
  }

  /** Nachrichten in zeitlicher Reihenfolge (die API liefert neueste zuerst). */
  async nachrichten(sid: string): Promise<Nachricht[]> {
    return [...(await this.rufe(`/${sid}/message`)).data].reverse()
  }

  async kinder(sid: string): Promise<string[]> {
    return (await this.rufe("")).data.filter((s: any) => s.parentID === sid).map((s: any) => s.id)
  }

  /** Läuft noch ein Kind? Ein Kind ohne Nachricht oder ohne `idle` am Ende läuft. */
  async kinderLaufen(sid: string): Promise<boolean> {
    for (const k of await this.kinder(sid)) {
      const ms = await this.nachrichten(k)
      if (!ms.length || ms[ms.length - 1].type !== "idle") return true
    }
    return false
  }

  /**
   * Wartet, bis die Sitzung `ruhe_s` Sekunden ruht (letzte Nachricht `idle`,
   * kein Kind läuft) oder die Frist abläuft. Liefert die Dauer bis zur Ruhe.
   */
  async warteAufRuhe(sid: string, t0: number, frist_s: number, ruhe_s = 30, takt_s = 8): Promise<number> {
    let ruhigSeit: number | null = null
    while (Date.now() - t0 < frist_s * 1000) {
      await Bun.sleep(takt_s * 1000)
      const ms = await this.nachrichten(sid)
      const ruht = ms.length > 0 && ms[ms.length - 1].type === "idle"
      if (ruht && !(await this.kinderLaufen(sid))) {
        ruhigSeit ??= Date.now()
        if (Date.now() - ruhigSeit > ruhe_s * 1000) break
        continue
      }
      ruhigSeit = null
    }
    return Math.round(((ruhigSeit ?? Date.now()) - t0) / 100) / 10
  }
}

export function textVon(m: Nachricht | undefined): string {
  return (m?.content ?? [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text ?? "")
    .join(" ")
}

/** Kleiner Flag-Leser: `--name wert`, mehrfach erlaubt über `alle`. */
export function flags(argv: string[]) {
  return {
    wert(name: string, fallback?: string): string | undefined {
      const i = argv.indexOf(name)
      return i >= 0 ? argv[i + 1] : fallback
    },
    alle(name: string): string[] {
      return argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []))
    },
    hat(name: string): boolean {
      return argv.includes(name)
    },
  }
}
