/**
 * Tests für of-erreichbar.ts — ein Engine-/vite-Neustart ist ein Warten, kein FAIL.
 * Fehlertexte wörtlich aus der FAIL-Serie 28.10.2026 (Runs …inj1m1, …8fjolp).
 */
import { afterAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { hostNeustart, hostProbe, infraAusfall, infraFortsetzen, istVerbindungsfehler, warteAufEngine, type EngineZustand } from "./of-erreichbar"

const PROXY_502 =
  "cannot reach opencode serve at http://127.0.0.1:4096 — start it with `bun openflow.ts` from the repo root (HTTP 502 Bad Gateway)"
const BUN_REFUSED = "Unable to connect. Is the computer able to access the url?"

describe("istVerbindungsfehler", () => {
  it("erkennt die Texte der FAIL-Serie und die üblichen Verbindungsfehler", () => {
    for (const t of [PROXY_502, BUN_REFUSED, "TypeError: fetch failed", "connect ECONNREFUSED 127.0.0.1:5174", "socket hang up", "read ECONNRESET"]) {
      expect(istVerbindungsfehler(t)).toBe(true)
    }
    expect(istVerbindungsfehler(new TypeError(BUN_REFUSED))).toBe(true)
  })

  it("Modell-, Provider- und Kartenfehler sind keine Verbindungsfehler", () => {
    for (const t of [
      'unknown model "dharma/x"',
      "Provider returned 502 Bad Gateway",
      "rate limited (429)",
      'the server does not know an agent named "a" — it reads its config once at boot',
      "Tool execution interrupted",
      undefined,
      null,
      "",
    ]) {
      expect(istVerbindungsfehler(t)).toBe(false)
    }
  })
})

describe("infraAusfall / infraFortsetzen", () => {
  const lauf = (status: string, fehler: Array<string | undefined>) => ({
    status,
    nodes: fehler.map((error, i) => ({ id: `n${i}`, status: error === undefined ? "done" : "error", error })),
  })

  it("Run …inj1m1: Karten mit 502 und Unable to connect → Infrastruktur-Ausfall", () => {
    expect(infraAusfall(lauf("error", [PROXY_502, BUN_REFUSED, PROXY_502, undefined]))).toBe(true)
  })

  it("ein einziger Verbindungsfehler neben einem Modellfehler reicht (die Fortsetzung trifft alle Fehlerkarten)", () => {
    expect(infraAusfall(lauf("error", ["rate limited", BUN_REFUSED]))).toBe(true)
  })

  it("nur echte Fehler, ein `stopped` oder `done` → kein Infrastruktur-Ausfall", () => {
    expect(infraAusfall(lauf("error", ["rate limited", "Tool execution interrupted"]))).toBe(false)
    expect(infraAusfall(lauf("stopped", [BUN_REFUSED]))).toBe(false)
    expect(infraAusfall(lauf("done", []))).toBe(false)
    expect(infraAusfall(undefined)).toBe(false)
  })

  it("das Kontingent begrenzt die Fortsetzungen", () => {
    const l = lauf("error", [PROXY_502])
    expect(infraFortsetzen(l, 1)).toBe(true)
    expect(infraFortsetzen(l, 0)).toBe(false)
  })
})

/** Simulierte Uhr: schlafen rückt die Zeit vor, ohne zu warten. */
function uhr() {
  let t = 0
  return { jetzt: () => t, schlafen: async (ms: number) => void (t += ms), pausen: [] as number[] }
}

describe("warteAufEngine", () => {
  it("Engine sofort da → ok ohne Warten", async () => {
    const u = uhr()
    const w = await warteAufEngine({ pruefe: async () => ({ erreichbar: true, host: true }), jetzt: u.jetzt, schlafen: u.schlafen })
    expect(w).toEqual({ ok: true, gewartetMs: 0, proben: 1, neustart: false })
  })

  it("Szenario 28.10.: Engine 83 s weg, kommt von selbst wieder → ok, kein Neustart, Backoff 1/2/4/8/15 s", async () => {
    const u = uhr()
    const pausen: number[] = []
    const w = await warteAufEngine({
      pruefe: async () => ({ erreichbar: u.jetzt() >= 83_000, host: true, managed: true }),
      neustart: async () => {
        throw new Error("darf nicht aufgerufen werden")
      },
      jetzt: u.jetzt,
      schlafen: async (ms) => {
        pausen.push(ms)
        await u.schlafen(ms)
      },
    })
    expect(w.ok).toBe(true)
    expect(w.neustart).toBe(false)
    expect(w.gewartetMs).toBeGreaterThanOrEqual(83_000)
    expect(pausen.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000])
  })

  it("Host da, verwaltete Engine bleibt weg → genau ein Neustart nach der Schonfrist, danach ok", async () => {
    const u = uhr()
    let neugestartetUm: number | undefined
    const neustarts: number[] = []
    const w = await warteAufEngine({
      pruefe: async () => ({ erreichbar: neugestartetUm !== undefined && u.jetzt() >= neugestartetUm + 20_000, host: true, managed: true }),
      neustart: async () => {
        neustarts.push(u.jetzt())
        neugestartetUm = u.jetzt()
      },
      neustartNachMs: 120_000,
      jetzt: u.jetzt,
      schlafen: u.schlafen,
    })
    expect(w.ok).toBe(true)
    expect(w.neustart).toBe(true)
    expect(neustarts.length).toBe(1)
    expect(neustarts[0]).toBeGreaterThanOrEqual(120_000)
  })

  it("Host weg oder Engine nicht verwaltet → kein Neustart", async () => {
    for (const z of [{ host: false }, { host: true, managed: false }]) {
      const u = uhr()
      let neustarts = 0
      const w = await warteAufEngine({
        pruefe: async (): Promise<EngineZustand> => ({ erreichbar: false, ...z }),
        neustart: async () => void neustarts++,
        budgetMs: 200_000,
        jetzt: u.jetzt,
        schlafen: u.schlafen,
      })
      expect(w.ok).toBe(false)
      expect(neustarts).toBe(0)
    }
  })

  it("das Budget hält: nach 5 min aufgeben, nie darüber", async () => {
    const u = uhr()
    const w = await warteAufEngine({ pruefe: async () => ({ erreichbar: false, host: false }), jetzt: u.jetzt, schlafen: u.schlafen })
    expect(w.ok).toBe(false)
    expect(w.gewartetMs).toBeLessThanOrEqual(300_000)
    expect(w.gewartetMs).toBeGreaterThan(280_000)
  })

  it("eine werfende Probe zählt als nicht erreichbar", async () => {
    const u = uhr()
    let n = 0
    const w = await warteAufEngine({
      pruefe: async () => {
        if (++n < 3) throw new Error(BUN_REFUSED)
        return { erreichbar: true, host: true }
      },
      jetzt: u.jetzt,
      schlafen: u.schlafen,
    })
    expect(w.ok).toBe(true)
    expect(w.proben).toBe(3)
  })
})

describe("hostProbe / hostNeustart gegen einen echten HTTP-Server", () => {
  let zustand: { status: number; body: unknown } = { status: 200, body: { running: true, managed: true } }
  let health = true
  let neustarts = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const pfad = new URL(req.url).pathname
      if (pfad === "/flow/api/server") return Response.json(zustand.body, { status: zustand.status })
      if (pfad === "/api/health") return new Response("", { status: health ? 200 : 502 })
      if (pfad === "/flow/api/server/restart" && req.method === "POST") {
        neustarts++
        return Response.json({ running: true })
      }
      return new Response("", { status: 404 })
    },
  })
  afterAll(() => server.stop(true))
  const origin = `http://127.0.0.1:${server.port}`

  it("Engine läuft / steht laut Host", async () => {
    zustand = { status: 200, body: { running: true, managed: true } }
    expect(await hostProbe(origin)()).toEqual({ erreichbar: true, host: true, managed: true })
    zustand = { status: 200, body: { running: false, managed: true } }
    expect(await hostProbe(origin)()).toEqual({ erreichbar: false, host: true, managed: true })
  })

  it("Host trackt die Engine nicht (501) → /api/health entscheidet", async () => {
    zustand = { status: 501, body: { error: "this host does not track `opencode serve`" } }
    health = true
    expect(await hostProbe(origin)()).toEqual({ erreichbar: true, host: true })
    health = false
    expect(await hostProbe(origin)()).toEqual({ erreichbar: false, host: true })
  })

  it("niemand lauscht → host false (Unable to connect)", async () => {
    const tot = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") })
    const port = tot.port
    tot.stop(true)
    expect(await hostProbe(`http://127.0.0.1:${port}`, fetch, 1_000)()).toEqual({ erreichbar: false, host: false })
  })

  it("Neustart geht über POST /flow/api/server/restart", async () => {
    await hostNeustart(origin)()
    expect(neustarts).toBe(1)
  })
})

describe("headless-run nutzt of-erreichbar", () => {
  it("wartet vor dem Start und setzt nach einem Infrastruktur-Ausfall fort, ohne Versuch zu verbrauchen", async () => {
    const s = await Bun.file(join(import.meta.dir, "headless-run.ts")).text()
    // Warten vor dem ersten Store-Zugriff
    expect(s.indexOf("await aufEngineWarten()")).toBeLessThan(s.indexOf('flow<{ project?: string }>("context")'))
    // Fortsetzung vor der regulären Abbruchregel, Versuchszähler zurückgedreht
    const fort = s.indexOf("if (infraFortsetzen(log, infraRest))")
    expect(fort).toBeGreaterThan(0)
    expect(fort).toBeLessThan(s.indexOf("if (!nochmalVersuchen(log.status, attempt, attemptsMax)) break"))
    expect(s.slice(fort, s.indexOf("if (!nochmalVersuchen(log.status, attempt, attemptsMax)) break"))).toContain("attempt--")
  })
})
