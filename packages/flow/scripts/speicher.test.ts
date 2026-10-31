/**
 * Tests für of-speicher.ts — der letzte Run-Log-PUT geht vor dem Exit nicht verloren
 * (R3, B3-Neulauf 24.10.2026: Run …wpfg9a PASS, Store `running`, als Zombie abgeräumt).
 */
import { afterAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { speicherKette } from "./of-speicher"

const SPEICHER = join(import.meta.dir, "of-speicher.ts")
let angekommen = 0
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    await req.text()
    angekommen++
    await Bun.sleep(30)
    return new Response("{}")
  },
})
afterAll(() => server.stop(true))
const url = `http://127.0.0.1:${server.port}/flow/api/runs/x`

describe("speicherKette", () => {
  it("hält die Aufrufreihenfolge, auch wenn der frühere PUT langsamer ist", async () => {
    const reihenfolge: string[] = []
    const k = speicherKette(async (b: any) => {
      await Bun.sleep(b.status === "running" ? 40 : 1)
      reihenfolge.push(b.status)
    })
    void k.schreibe({ status: "running" })
    void k.schreibe({ status: "done" })
    expect(await k.leeren(2_000)).toBe(true)
    expect(reihenfolge).toEqual(["running", "done"])
  })

  it("ein Fehler bricht die Kette nicht ab und wirft nicht", async () => {
    const fehler: unknown[] = []
    const gesehen: number[] = []
    const k = speicherKette(async (b: any) => {
      if (b.n === 1) throw new Error("503")
      gesehen.push(b.n)
    }, (e) => fehler.push(e))
    void k.schreibe({ n: 1 })
    void k.schreibe({ n: 2 })
    expect(await k.leeren(1_000)).toBe(true)
    expect(gesehen).toEqual([2])
    expect(fehler.length).toBe(1)
  })

  it("leeren hält die Frist auch bei einem hängenden PUT", async () => {
    const k = speicherKette(() => new Promise(() => undefined))
    void k.schreibe({})
    const t0 = Date.now()
    expect(await k.leeren(50)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  // Gegenprobe gegen das alte Muster aus headless-run.ts (`void flow(PUT)`; process.exit):
  // in einem echten Kindprozess, gegen einen echten HTTP-Server.
  it("Gegenprobe: void-PUT + exit verliert den Schreibvorgang, Kette + leeren nicht", async () => {
    const alt = `void fetch(${JSON.stringify(url)}, { method: "PUT", body: "{}" }).catch(() => {}); process.exit(0)`
    const neu =
      `import { speicherKette } from ${JSON.stringify(SPEICHER)};` +
      `const k = speicherKette(async (b) => { await fetch(${JSON.stringify(url)}, { method: "PUT", body: JSON.stringify(b) }) });` +
      `void k.schreibe({ id: "r" }); await k.leeren(5000); process.exit(0)`
    const zaehle = async (code: string) => {
      let n = 0
      for (let i = 0; i < 3; i++) {
        const vor = angekommen
        const p = Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" })
        await p.exited
        await Bun.sleep(80)
        if (angekommen > vor) n++
      }
      return n
    }
    expect(await zaehle(alt)).toBe(0)
    expect(await zaehle(neu)).toBe(3)
  })
})

describe("headless-run.ts nutzt die Kette", () => {
  it("kein `void flow(` PUT mehr, leeren vor dem Exit", async () => {
    const s = await Bun.file(join(import.meta.dir, "headless-run.ts")).text()
    expect(s.match(/void flow\(`runs\//g) ?? []).toEqual([])
    const exit = s.lastIndexOf('process.exit(log.status === "done" ? 0 : 1)')
    expect(exit).toBeGreaterThan(0)
    expect(s.slice(0, exit).lastIndexOf("speicher.leeren(")).toBeGreaterThan(s.slice(0, exit).lastIndexOf("abschliessen("))
  })
})

describe("speicherKette mit Wiederholung (Host im Neustart, 28.10.2026)", () => {
  const verbindung = () => new TypeError("Unable to connect. Is the computer able to access the url?")
  const w = { istVoruebergehend: (e: unknown) => String(e).includes("Unable to connect"), budgetMs: 5_000, schlafen: () => Bun.sleep(1) }

  it("wiederholt einen Verbindungsfehler, bis der Host wieder antwortet", async () => {
    let versuche = 0
    const fehler: unknown[] = []
    const k = speicherKette(async () => {
      if (++versuche < 4) throw verbindung()
    }, (e) => fehler.push(e), w)
    void k.schreibe({ status: "done" })
    expect(await k.leeren(2_000)).toBe(true)
    expect(versuche).toBe(4)
    expect(fehler).toEqual([])
  })

  it("ein überholter Stand wird nicht weiter wiederholt — der neuere übernimmt", async () => {
    const angekommen: string[] = []
    let hostDa = false
    const k = speicherKette(async (b: any) => {
      if (!hostDa) throw verbindung()
      angekommen.push(b.status)
    }, () => undefined, { ...w, schlafen: () => Bun.sleep(5) })
    void k.schreibe({ status: "running" })
    void k.schreibe({ status: "done" })
    await Bun.sleep(20)
    hostDa = true
    expect(await k.leeren(2_000)).toBe(true)
    expect(angekommen).toEqual(["done"])
  })

  it("ein echter Fehler (kein Verbindungsfehler) wird nicht wiederholt", async () => {
    let versuche = 0
    const fehler: unknown[] = []
    const k = speicherKette(async () => {
      versuche++
      throw new Error("flow store runs/x -> 500")
    }, (e) => fehler.push(e), w)
    void k.schreibe({})
    expect(await k.leeren(1_000)).toBe(true)
    expect(versuche).toBe(1)
    expect(fehler.length).toBe(1)
  })

  it("das Budget begrenzt die Wiederholung, dann meldet die Kette den Fehler", async () => {
    let versuche = 0
    const fehler: unknown[] = []
    const k = speicherKette(async () => {
      versuche++
      throw verbindung()
    }, (e) => fehler.push(e), { ...w, budgetMs: 0 })
    void k.schreibe({})
    expect(await k.leeren(1_000)).toBe(true)
    expect(versuche).toBe(1)
    expect(fehler.length).toBe(1)
  })

  it("headless-run wiederholt Store-PUTs bei Verbindungsfehlern und leert mit Frist über dem Budget", async () => {
    const s = await Bun.file(join(import.meta.dir, "headless-run.ts")).text()
    expect(s).toContain("{ istVoruebergehend: istVerbindungsfehler, budgetMs: 120_000 }")
    expect(s).toContain("speicher.leeren(130_000)")
  })
})
