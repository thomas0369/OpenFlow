/**
 * of-erreichbar — Infrastruktur-Ausfälle (Engine/Proxy weg) von echten
 * Lauf-Fehlern trennen und auf die Rückkehr der Engine warten.
 *
 * Anlass (FAIL-Serie 28.10.2026, 19:23–19:52 UTC): Ein `git pull` in den
 * Launcher-Checkout (19:30:39 UTC, Commit 2677db987 ändert lib/store.ts) ließ
 * vite neu starten; mit FLOW_MANAGE_SERVER=1 ging die Engine mit. Jede Karte
 * des laufenden Runs …inj1m1 endete mit `cannot reach opencode serve … (HTTP
 * 502 Bad Gateway)` bzw. `Unable to connect`. Der Auto-Retry startete 3 s
 * später (…8fjolp, 19:30:42) — die Engine war erst um 19:32:02 wieder da
 * (auto-resume.log: `pid=31391 setup instanz=3fevsr`), also scheiterte auch
 * Versuch 2 sofort: FAIL, obwohl die Sessions auf der Platte überlebt hatten
 * (der Resume 19:35:08 lief durch).
 *
 * Regel: Endet ein Versuch mit `error` und trägt mindestens eine Karte einen
 * Verbindungsfehler, wartet headless-run mit Backoff (Gesamtbudget, Vorgabe
 * 5 min), bis die Engine wieder antwortet, und setzt die betroffenen Karten
 * fort — ohne einen der regulären Versuche zu verbrauchen. Antwortet der Host
 * (vite), meldet aber eine stehende, von ihm verwaltete Engine, wird sie nach
 * einer Schonfrist über die vorhandene Neustart-Route
 * (`POST /flow/api/server/restart`, lib/opencode-process.ts) gestartet. Die
 * Schonfrist lässt vite seinen eigenen Neustart zu Ende bringen (gemessen
 * 28.10.: 83 s vom Pull bis zur neuen Engine).
 */

/**
 * Texte, die einen nicht erreichbaren Server meinen — nicht einen Fehler des
 * Modells oder der Karte. Absichtlich ohne nackte „502"/„Bad Gateway": die
 * kommen auch von LLM-Providern und sind dort kein Engine-Ausfall.
 */
const VERBINDUNG =
  /unable to connect|econnrefused|econnreset|fetch failed|cannot reach opencode serve|socket hang up|connection refused|the socket connection was closed unexpectedly|connectionrefused/i

export function istVerbindungsfehler(fehler: unknown): boolean {
  if (fehler === undefined || fehler === null) return false
  const text = fehler instanceof Error ? `${fehler.name}: ${fehler.message} ${String((fehler as { code?: unknown }).code ?? "")}` : String(fehler)
  return VERBINDUNG.test(text)
}

/** Ein `error`-Lauf, an dem mindestens eine Karte mit einem Verbindungsfehler scheiterte. */
export function infraAusfall(log: any): boolean {
  if (log?.status !== "error") return false
  const karten = Array.isArray(log?.nodes) ? log.nodes : []
  return karten.some((k: any) => k?.status === "error" && istVerbindungsfehler(k?.error))
}

/**
 * Wartet headless-run nach diesem Versuch auf die Engine und setzt fort, statt
 * zu scheitern? Nur nach `error` (B4: `stopped` hat jemand gewollt), nur bei
 * einem Verbindungsfehler, nur solange das eigene Kontingent reicht — eine
 * Fortsetzung verbraucht keinen regulären Versuch (nochmalVersuchen).
 */
export function infraFortsetzen(log: any, infraRest: number): boolean {
  return infraRest > 0 && infraAusfall(log)
}

export type EngineZustand = {
  /** Der Lauf kann starten: Host antwortet und die Engine dahinter auch. */
  erreichbar: boolean
  /** Der Canvas-Host (vite/server.ts) antwortet überhaupt. */
  host: boolean
  /** Der Host hat die Engine gestartet und kann sie neu starten. */
  managed?: boolean
}

export type WarteErgebnis = { ok: boolean; gewartetMs: number; proben: number; neustart: boolean }

export const ENGINE_WARTEN_MS = 300_000
export const NEUSTART_NACH_MS = 120_000
const PAUSE_START_MS = 1_000
const PAUSE_MAX_MS = 15_000

/**
 * Wartet mit exponentiellem Backoff (1 s, 2 s, 4 s … höchstens 15 s), bis
 * `pruefe` eine erreichbare Engine meldet, längstens `budgetMs`. Höchstens ein
 * Neustart, und nur wenn der Host antwortet, die Engine verwaltet und sie seit
 * `neustartNachMs` steht.
 */
export async function warteAufEngine(o: {
  pruefe: () => Promise<EngineZustand>
  neustart?: () => Promise<unknown>
  budgetMs?: number
  neustartNachMs?: number
  schlafen?: (ms: number) => Promise<unknown>
  jetzt?: () => number
  log?: (zeile: string) => void
}): Promise<WarteErgebnis> {
  const jetzt = o.jetzt ?? Date.now
  const schlafen = o.schlafen ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const budget = o.budgetMs ?? ENGINE_WARTEN_MS
  const neustartNach = o.neustartNachMs ?? NEUSTART_NACH_MS
  const t0 = jetzt()
  let pause = PAUSE_START_MS
  let proben = 0
  let neustart = false
  let gemeldet = false
  for (;;) {
    proben++
    const z = await o.pruefe().catch((): EngineZustand => ({ erreichbar: false, host: false }))
    const gewartet = jetzt() - t0
    if (z.erreichbar) {
      if (proben > 1) o.log?.(`engine wieder erreichbar nach ${Math.round(gewartet / 1000)} s (${proben} Proben${neustart ? ", nach Neustart" : ""})`)
      return { ok: true, gewartetMs: gewartet, proben, neustart }
    }
    if (!gemeldet) {
      gemeldet = true
      o.log?.(`engine nicht erreichbar (${z.host ? "Host antwortet, Engine steht" : "Host antwortet nicht"}) — warte bis ${Math.round(budget / 1000)} s`)
    }
    if (!neustart && o.neustart && z.host && z.managed && gewartet >= neustartNach) {
      neustart = true
      o.log?.(`engine steht seit ${Math.round(gewartet / 1000)} s — Neustart über den Host`)
      await o.neustart().catch((e) => o.log?.(`engine-Neustart gescheitert: ${String(e)}`))
      continue
    }
    if (gewartet + pause > budget) {
      o.log?.(`engine nach ${Math.round(gewartet / 1000)} s nicht erreichbar — gebe auf`)
      return { ok: false, gewartetMs: gewartet, proben, neustart }
    }
    await schlafen(pause)
    pause = Math.min(pause * 2, PAUSE_MAX_MS)
  }
}

/**
 * Die Probe gegen einen Canvas-Host: `GET /flow/api/server` (Engine-Zustand,
 * lib/store.ts); trackt der Host die Engine nicht (501), entscheidet
 * `/api/health` durch den Proxy. Keine Antwort = Host weg. Jede andere Antwort
 * des Hosts sagt nichts über die Engine — dann entscheidet der Lauf selbst,
 * statt auf ein Signal zu warten, das nie kommt.
 */
export function hostProbe(origin: string, f: typeof fetch = fetch, timeoutMs = 5_000): () => Promise<EngineZustand> {
  return async () => {
    const r = await f(`${origin}/flow/api/server`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined)
    if (!r) return { erreichbar: false, host: false }
    if (r.status === 501) {
      // 502/503/504 sind die Antworten des Proxys bei stehender Engine (vite.config.ts).
      const h = await f(`${origin}/api/health`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined)
      return { erreichbar: !!h && ![502, 503, 504].includes(h.status), host: true }
    }
    if (!r.ok) return { erreichbar: true, host: true }
    const s = (await r.json().catch(() => ({}))) as { running?: unknown; managed?: unknown }
    return { erreichbar: s.running !== false, host: true, managed: s.managed === true }
  }
}

/** Neustart über die vorhandene Host-Route (nur loopback, nur bei verwalteter Engine). */
export function hostNeustart(origin: string, f: typeof fetch = fetch): () => Promise<unknown> {
  return async () => {
    const r = await f(`${origin}/flow/api/server/restart`, { method: "POST", signal: AbortSignal.timeout(120_000) })
    if (!r.ok) throw new Error(`restart -> ${r.status} ${await r.text().catch(() => "")}`)
    return r.json().catch(() => undefined)
  }
}
