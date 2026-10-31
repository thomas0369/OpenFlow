/**
 * Defekt 4 (Woche 16.–23.10.2026): 12 Timeouts (`llm_fehler: "timeout"`) bei
 * 88 LLM-Urteilen = 13,6 %. Gemessen aus dem Ledger:
 *   - erfolgreiche Urteile: 76, p50 2387 ms, p90 3371 ms, Maximum 4489 ms —
 *     KEIN Erfolg über 6000 ms; die Timeouts enden bei 6003–6013 ms.
 *     Eine längere Frist hätte also nichts gerettet: die Anfrage hängt.
 *   - die Timeouts liegen vereinzelt (9 von 12 ohne Nachbar-Timeout), meist
 *     nach einer Pause ≥ 10 min — ein zweiter, unabhängiger Versuch trifft
 *     dann mit hoher Wahrscheinlichkeit einen antwortenden Weg.
 *
 * Budget (VOR dem Bau festgelegt):
 *   Gesamtfrist bleibt 6000 ms (Plugin wartet 6500 ms). Ist nach
 *   LLM_HEDGE_MS = 3000 ms keine Antwort da, startet EIN paralleler zweiter
 *   Versuch; das erste gültige Urteil gewinnt. Zielwerte, aus den 88 Messungen
 *   unter Unabhängigkeit gerechnet (Test „Budget-Rechnung"):
 *     Timeout-Anteil ≤ 5 %    (Modell 4,5 %; Basis 13,6 %)
 *     Zusatzaufrufe   ≤ 35 %   (Modell 33 % der LLM-Urteile)
 *     Wartezeit Hook  ≤ 6,0 s  (vorher bis ~9 s: Plugin-Retry nach Timeout)
 *   Hedge bei 2500 ms brächte 2,9 % für 53 % Zusatzaufrufe, bei 3500 ms 7,3 %
 *   — 3000 ms ist der Punkt, an dem beide Ziele halten.
 * Rückfall: kein Urteil → deterministisches Verdikt (Wortregel-Grauzone,
 * injizieren:false) mit `rueckfall: "deterministisch"` und Grund im Ledger.
 *
 * NACHMESSUNG 31.10.2026 (Ledger 24.–31.10., 60 LLM-Urteile mit Hedge):
 * Timeouts 8/60 = 13,3 % — der Hedge hat nichts gesenkt. 18 Urteile brauchten
 * den Hedge, 8 davon liefen trotzdem in die Frist (44 %, nicht die ~14 % der
 * Unabhängigkeitsannahme oben). 16 der 18 kamen nach ≥ 10 min LLM-Pause.
 * Ursache (dharma-Quelltext + Live-Messung): `fast` ist eine Kandidatenkette,
 * dharma wartet je Kandidat bis 8000 ms (PROXY_TIMEOUT_BY_TIER.fast) — länger
 * als die Gate-Frist; der identische Hedge-Body landet auf demselben hängenden
 * Kandidaten. Live, 97 Grauzonenfälle: `fast` p50 10 127 ms (89× erst nach dem
 * 8-s-Warten auf yolo beantwortet), explizit qwen3.8-27b p50 1476 ms, Maximum
 * 2625 ms. Neu: erster Versuch explizit LLM_MODELL, Hedge nach 2500 ms über
 * LLM_HEDGE_MODELL (`fast`) — zwei verschiedene Wege. Rechnung unten
 * („Nachmessung"), Ziel unverändert ≤ 5 % Timeouts.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { entscheide, LLM_HEDGE_MODELL, LLM_HEDGE_MS, LLM_MODELL, LLM_TIMEOUT_MS, urteileMitLlmDetail } from "./of-gate"

const TMP = mkdtempSync(join(tmpdir(), "gate-llm-budget-"))
const KEY = join(TMP, "dharma.key")
writeFileSync(KEY, "k\n")
const GRAU = "Bau eine Testsuite für befehl.ts und eine zweite für rm-gefahr.ts, unabhängig voneinander."

const antwort = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } })
/** fetch, das je Aufruf ein Verhalten nimmt: "haengt" bis Abbruch, sonst [ms, Inhalt]. */
function skript(verhalten: ("haengt" | [number, string])[]) {
  let n = 0
  const f = ((_url: any, init: any) => {
    const v = verhalten[n++] ?? "haengt"
    return new Promise<Response>((resolve, reject) => {
      const abbruch = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
      if (init?.signal?.aborted) return abbruch()
      init?.signal?.addEventListener("abort", abbruch)
      if (v !== "haengt") setTimeout(() => resolve(antwort(v[1])), v[0])
    })
  }) as unknown as typeof fetch
  return { f, aufrufe: () => n }
}

// 76 erfolgreiche Urteile (ms) und 12 Timeouts, ~/.openflow/gate-ledger.jsonl 16.–23.10.2026
const ERFOLG_MS = [2711, 1692, 1820, 3078, 2089, 1831, 2897, 2237, 2086, 2740, 2074, 4371, 2251, 1468, 2726, 1660, 3675, 1964, 1890, 1727, 1981, 1930, 1847, 2635, 2118, 1764, 1925, 2387, 2911, 2801, 2248, 2166, 2231, 2023, 2684, 1802, 2229, 3293, 3083, 2595, 3813, 2524, 2346, 2522, 2852, 2728, 3269, 3772, 3281, 3371, 3735, 3121, 3597, 2471, 2730, 3212, 2807, 2735, 3136, 3233, 2163, 2506, 2309, 2222, 2135, 1877, 1955, 2218, 1908, 2162, 2088, 4489, 2479, 2770, 2173, 2084]
const TIMEOUTS = 12

describe("Budget-Rechnung (vorher festgelegte Zielwerte)", () => {
  const p = TIMEOUTS / (TIMEOUTS + ERFOLG_MS.length)
  test("Basis: Timeout-Anteil 13,6 %", () => expect(+(p * 100).toFixed(1)).toBe(13.6))
  test("Annahme von damals: 3000 ms Hedge auf denselben Weg, erfolgreiche Urteile alle < 4500 ms", () => {
    expect(Math.max(...ERFOLG_MS)).toBeLessThan(4500)
  })
  test("Frist 6000 ms (Plugin wartet 6500 ms) — unverändert", () => {
    expect(LLM_TIMEOUT_MS).toBe(6000)
  })
})

// Nachmessung 31.10.2026 — Ledger 24.–31.10. und Live-Probe (siehe Kopf).
const FELD_HEDGE = { urteile: 60, timeouts: 8, hedges: 18 }
// qwen3.8-27b explizit, 96 Korpus-Grauzonenfälle, 31.10.2026 (ms, sortiert)
const QWEN_MS = [1193, 1254, 1255, 1278, 1296, 1318, 1327, 1357, 1357, 1372, 1376, 1377, 1379, 1382, 1385, 1386, 1393, 1395, 1396, 1408, 1415, 1427, 1427, 1429, 1429, 1431, 1433, 1439, 1440, 1441, 1441, 1442, 1442, 1442, 1444, 1448, 1452, 1455, 1461, 1461, 1462, 1463, 1469, 1471, 1471, 1472, 1473, 1473, 1476, 1481, 1490, 1490, 1492, 1498, 1504, 1508, 1515, 1546, 1548, 1554, 1580, 1583, 1590, 1592, 1599, 1615, 1634, 1637, 1643, 1670, 1678, 1694, 1727, 1729, 1729, 1747, 1747, 1748, 1749, 1757, 1793, 1816, 1840, 1854, 1884, 1891, 1924, 1925, 1942, 2037, 2085, 2087, 2113, 2194, 2290, 2625]

describe("Nachmessung 31.10.2026: zwei Wege statt zweimal derselbe", () => {
  test("Feld: der Hedge auf dieselbe Stufe senkte nichts (13,3 % ≈ Basis 13,6 %), 44 % der Hedges scheiterten", () => {
    expect(+((FELD_HEDGE.timeouts / FELD_HEDGE.urteile) * 100).toFixed(1)).toBe(13.3)
    expect(FELD_HEDGE.timeouts / FELD_HEDGE.hedges).toBeGreaterThan(0.4)
  })
  test("erster Versuch explizit, Hedge über die Router-Stufe, Hedge nach 2500 ms", () => {
    expect(LLM_MODELL).toBe("qwen3.8-27b")
    expect(LLM_HEDGE_MODELL).toBe("fast")
    expect(LLM_MODELL).not.toBe(LLM_HEDGE_MODELL)
    expect(LLM_HEDGE_MS).toBe(2500)
  })
  test("Rechnung: Timeout-Anteil ≤ 5 % selbst wenn der Hedge-Weg IMMER scheitert", () => {
    // Pessimistisch: `fast` antwortet nie in der Restzeit. Dann bleibt nur der
    // erste Versuch: 0 von 96 über der Frist; obere 95-%-Schranke (Dreierregel) 3/96.
    const ueberFrist = QWEN_MS.filter((x) => x > LLM_TIMEOUT_MS).length
    expect(ueberFrist).toBe(0)
    expect(3 / QWEN_MS.length).toBeLessThanOrEqual(0.05)
    // Zusatzaufrufe: Anteil erster Versuche über dem Hedge-Zeitpunkt.
    expect(QWEN_MS.filter((x) => x > LLM_HEDGE_MS).length / QWEN_MS.length).toBeLessThanOrEqual(0.05)
  })
})

describe("Hedge: zweiter Versuch nach LLM_HEDGE_MS, erstes Urteil gewinnt", () => {
  test("erster hängt, zweiter antwortet → Urteil statt Timeout, 2 Versuche", async () => {
    const s = skript(["haengt", [20, "JA"]])
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 600, hedgeMs: 100 })
    expect(d.urteil).toBe(true)
    expect(d.fehler).toBeNull()
    expect(d.versuche).toBe(2)
    expect(d.ms).toBeLessThan(400)
  })
  test("schnelle Antwort → KEIN zweiter Aufruf", async () => {
    const s = skript([[10, "NEIN"]])
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 600, hedgeMs: 100 })
    expect(d.urteil).toBe(false)
    expect(d.versuche).toBe(1)
    await Bun.sleep(150)
    expect(s.aufrufe()).toBe(1)
  })
  test("beide hängen → timeout innerhalb der Gesamtfrist", async () => {
    const s = skript(["haengt", "haengt"])
    const t0 = Date.now()
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 300, hedgeMs: 100 })
    expect(d.urteil).toBeNull()
    expect(d.fehler).toBe("timeout")
    expect(Date.now() - t0).toBeLessThan(450)
    expect(s.aufrufe()).toBe(2)
  })
  test("erster liefert Unklares, zweiter (gehedgt) JA → JA", async () => {
    const s = skript([[150, "vielleicht"], [10, "JA"]])
    const d = await urteileMitLlmDetail("x", { fetch: s.f, keyFile: KEY, timeoutMs: 600, hedgeMs: 100 })
    expect(d.urteil).toBe(true)
  })
})

describe("deterministischer Rückfall mit Grund", () => {
  test("Timeout → Wortregel-Verdikt, rueckfall + rueckfall_grund gesetzt, keine Injektion", async () => {
    const s = skript(["haengt", "haengt"])
    const v: any = await entscheide(GRAU, { fetch: s.f, keyFile: KEY, timeoutMs: 200, hedgeMs: 50 })
    expect(v.entscheidung).toBe("GRAUZONE")
    expect(v.injizieren).toBe(false)
    expect(v.llm_fehler).toBe("timeout")
    expect(v.rueckfall).toBe("deterministisch")
    expect(v.rueckfall_grund).toBe("llm_timeout")
    expect(v.llm_versuche).toBe(2)
  })
  test("fehlender Schlüssel → rueckfall_grund llm_schluessel_fehlt", async () => {
    const v: any = await entscheide(GRAU, { keyFile: join(TMP, "gibt-es-nicht") })
    expect(v.rueckfall).toBe("deterministisch")
    expect(v.rueckfall_grund).toBe("llm_schluessel_fehlt")
  })
  test("Kontrollwert: LLM-Urteil → kein rueckfall-Feld", async () => {
    const v: any = await entscheide(GRAU, { fetch: skript([[5, "NEIN"]]).f, keyFile: KEY, timeoutMs: 300, hedgeMs: 100 })
    expect(v.llm).toBe(false)
    expect(v.rueckfall).toBeUndefined()
  })
})

describe("Scorecard zeigt den Timeout-Anteil je Fenster", () => {
  test("2 Timeouts von 4 Urteilen → 50 %, Rückfälle und Zweitversuche gezählt", () => {
    const { mkdirSync } = require("node:fs")
    const jetzt = new Date().toISOString()
    const z = (x: Record<string, unknown>) => JSON.stringify({ ts: jetzt, event: "user_prompt", entscheidung: "GRAUZONE", ...x })
    const ledger = join(TMP, "l.jsonl")
    writeFileSync(ledger, [
      z({ llm: true, llm_ms: 2000 }),
      z({ llm: false, llm_ms: 3500, llm_versuche: 2 }),
      z({ llm: null, llm_fehler: "timeout", llm_versuche: 2, rueckfall: "deterministisch" }),
      z({ llm: null, llm_fehler: "timeout" }),
      z({ llm: null, llm_uebersprungen: "kurz" }),
    ].join("\n") + "\n")
    mkdirSync(join(TMP, "runs"), { recursive: true })
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "of-scorecard.ts"), "--runs-dir", join(TMP, "runs"), "--ledger", ledger, "--json"], { stdout: "pipe" })
    const g = JSON.parse(p.stdout.toString()).ledger.gateLlm.find((x: any) => x.name === "gesamt")
    expect(g).toMatchObject({ urteile: 4, timeouts: 2, timeoutQuote: 50, rueckfaelle: 1, zweitversuche: 2 })
  })
})
