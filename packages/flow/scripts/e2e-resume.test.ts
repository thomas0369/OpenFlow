/**
 * T-12 (B8, 28.10.2026) — Kill/Resume und Auto-Retry end-to-end, auf einem
 * isolierten Stack (scripts/testing/stack.sh: Engine :4197, Canvas :5274,
 * eigene XDG-Verzeichnisse). Nur mit OPENFLOW_E2E=1 — der Stack braucht ~30 s
 * zum Hochfahren und belegt zwei Ports.
 *
 * Kein echtes Modell: der Provider `fake` ist ein OpenAI-kompatibler Server in
 * diesem Test (Bun.serve). Er antwortet „OK", kann eine Antwort verzögern (der
 * Lauf ist dann lange genug `running`, um ihn per SIGTERM abzubrechen) und
 * kann die nächste Anfrage mit 400 ablehnen (ein Karten-`error` im ersten
 * Versuch, den der Auto-Retry heilt). Kostet nichts, ist deterministisch.
 *
 * Hazard „test runs write real files" (FLOW.md): die globale Test-Config
 * verbietet edit/bash/webfetch, die Karten schalten write/edit/bash ab.
 * Isolation: Ledger, Runs, Checkpoints, Log-Dir, Projekt liegen im Temp-Dir;
 * am Ende wird geprüft, dass das echte Ledger und flow-lab/.openflow/runs
 * keinen Eintrag dieses Tests tragen.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const E2E = !!process.env.OPENFLOW_E2E
const STACK = join(import.meta.dir, "testing", "stack.sh")
const ORIGIN = `http://localhost:${process.env.OPENFLOW_E2E_CANVAS_PORT ?? "5274"}`
const ECHTES_LEDGER = join(homedir(), ".openflow/gate-ledger.jsonl")
const ECHTE_RUNS = join(homedir(), "workspace/flow-lab/.openflow/runs")
const PIPELINE = "e2e-mini"

const R = E2E ? mkdtempSync(join(tmpdir(), "of-e2e-")) : ""
const fake = { verzoegerungMs: 0, ablehnen: 0, anfragen: 0 }
let server: ReturnType<typeof Bun.serve> | undefined
const vorher = { ledger: 0, runs: [] as string[] }

const zeilen = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [])
const runsListe = () => (existsSync(ECHTE_RUNS) ? readdirSync(ECHTE_RUNS) : [])

function env(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    OPENFLOW_ORIGIN: ORIGIN,
    OPENFLOW_PROJECT: join(R, "proj"),
    OPENFLOW_FABRIK_PROJEKT: join(R, "proj"),
    OPENFLOW_RUNS_DIR: join(R, "proj/.openflow/runs"),
    OPENFLOW_CHECKPOINT_DIR: join(R, "ck"),
    OPENFLOW_LEDGER: join(R, "ledger.jsonl"),
    OPENFLOW_LOG_DIR: join(R, "logs"),
    OPENFLOW_OPENCODE_SERVICE: join(R, "kein-dienst.json"),
    OPENFLOW_SESSION: "",
    OPENFLOW_AUFRUF_ID: "",
    OPENFLOW_ENGINE: "",
    BUN: process.execPath,
    ...extra,
  }
}

function sse(text: string) {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
    `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "ok", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
  return chunk({ role: "assistant", content: text }, null) + chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) + "data: [DONE]\n\n"
}

beforeAll(async () => {
  if (!E2E) return
  vorher.ledger = zeilen(ECHTES_LEDGER).length
  vorher.runs = runsListe()
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      fake.anfragen++
      if (fake.ablehnen > 0) {
        fake.ablehnen--
        return Response.json({ error: { message: "e2e: abgelehnt (gewollt)", type: "invalid_request_error" } }, { status: 400 })
      }
      if (fake.verzoegerungMs > 0) await Bun.sleep(fake.verzoegerungMs)
      const body = (await req.json().catch(() => ({}))) as { stream?: boolean }
      if (body.stream === false) return Response.json({ id: "fake", object: "chat.completion", created: 0, model: "ok", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
      return new Response(sse("OK"), { headers: { "content-type": "text/event-stream" } })
    },
  })
  mkdirSync(join(R, "xdg-config/opencode"), { recursive: true })
  for (const d of ["ck", "logs", "proj/.openflow/pipelines", "proj/.openflow/runs"]) mkdirSync(join(R, d), { recursive: true })
  writeFileSync(
    join(R, "xdg-config/opencode/opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "fake/ok",
      small_model: "fake/ok",
      permission: { edit: "deny", bash: "deny", webfetch: "deny" },
      provider: {
        fake: { npm: "@ai-sdk/openai-compatible", name: "fake", options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "e2e" }, models: { ok: { name: "ok" } } },
      },
    }),
  )
  writeFileSync(join(R, "proj/opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
  const tools = { write: false, edit: false, bash: false }
  writeFileSync(
    join(R, `proj/.openflow/pipelines/${PIPELINE}.json`),
    JSON.stringify({
      id: PIPELINE,
      name: PIPELINE,
      nodes: [
        { id: "a", role: "custom", agent: { model: "fake/ok", prompt: "Antworte nur mit OK.", tools }, position: { x: 0, y: 0 } },
        { id: "b", role: "custom", agent: { model: "fake/ok", prompt: "Antworte nur mit OK.", tools }, position: { x: 0, y: 200 } },
      ],
      edges: [{ id: "e1", source: "a", target: "b" }],
    }),
  )
  const p = await lauf(["bash", STACK, "start", R], { ...process.env, BUN: process.execPath })
  if (p.code !== 0) throw new Error(`stack.sh start: exit ${p.code}\n${p.err}\n${p.out}`)
  // Gemessen: /api/agent antwortet, bevor die Engine die Config-Provider im
  // Katalog hat — ein Lauf in diesem Fenster endet „unknown model fake/ok".
  for (let i = 0; i < 120; i++) {
    const modelle = await fetch(`${ORIGIN}/api/model`).then((r) => r.text()).catch(() => "")
    if (modelle.includes('"providerID":"fake"')) return
    await Bun.sleep(500)
  }
  throw new Error("Engine kennt fake/ok nach 60 s nicht")
}, 240_000)

// Immer asynchron: der Fake-Provider läuft in DIESEM Prozess — ein spawnSync
// blockiert seine Ereignisschleife, und die Karte wartet auf eine Antwort,
// die nie kommt (gemessen: Versuch 2 hing bis zum Test-Timeout).
async function lauf(cmd: string[], e: Record<string, string | undefined>) {
  const p = Bun.spawn(cmd, { env: e, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out, err }
}

afterAll(() => {
  if (!E2E) return
  Bun.spawnSync(["bash", STACK, "stop", R])
  server?.stop(true)
  if (!process.env.OPENFLOW_E2E_KEEP) rmSync(R, { recursive: true, force: true })
})

describe.skipIf(!E2E)("T-12 E2E auf isoliertem Stack", () => {
  test("(a) Lauf starten, SIGTERM, --resume <checkpoint> → done", async () => {
    fake.verzoegerungMs = 15_000
    const erster = Bun.spawn([process.execPath, join(import.meta.dir, "headless-run.ts"), PIPELINE, "Sag OK"], {
      env: env({ OPENFLOW_AUTO_RETRY: "0" }),
      stdout: "ignore",
      stderr: "ignore",
    })
    // Warten, bis der Lauf einen Checkpoint mit einer laufenden Karte hat.
    const ck = await (async () => {
      for (let i = 0; i < 120; i++) {
        const f = readdirSync(join(R, "ck")).find((n) => n.endsWith(".json"))
        if (f && /"status": "running"/.test(readFileSync(join(R, "ck", f), "utf8"))) return join(R, "ck", f)
        await Bun.sleep(500)
      }
      throw new Error("kein running-Checkpoint nach 60 s")
    })()
    erster.kill("SIGTERM")
    expect(await erster.exited).toBe(143)
    const gestoppt = JSON.parse(readFileSync(ck, "utf8"))
    expect(gestoppt.status).toBe("stopped")
    expect(gestoppt.stoppedBySignal?.signal).toBe("SIGTERM")

    fake.verzoegerungMs = 0
    const resume = await lauf(["bash", join(import.meta.dir, "of-run.sh"), "--resume", ck], env())
    const out = resume.out
    expect(resume.code, out + resume.err).toBe(0)
    expect(out).toMatch(/^PID=\d+$/m)
    expect(out).toMatch(/verdict: PASS /)
    const cpNeu = out.match(/^checkpoint: (.+)$/m)?.[1]
    expect(cpNeu).toBeDefined()
    const neu = JSON.parse(readFileSync(cpNeu!, "utf8"))
    expect(neu.status).toBe("done")
    expect(neu.resumeOf ?? neu.origin).toBeDefined()
  }, 240_000)

  test("(b) erzwungener error im ersten Versuch → Auto-Retry → PASS_RETRIED", async () => {
    fake.verzoegerungMs = 0
    fake.ablehnen = 1
    const r = await lauf(["bash", join(import.meta.dir, "of-run.sh"), "--wait", PIPELINE, "Sag OK"], env({ OPENFLOW_AUTO_RETRY: "1" }))
    const out = r.out
    const log = out.match(/^LOG=(.+)$/m)?.[1]
    const logText = log && existsSync(log) ? readFileSync(log, "utf8") : ""
    expect(r.code, out + logText.slice(-3000)).toBe(0)
    expect(fake.ablehnen).toBe(0)
    expect(out).toContain("verdict: PASS_RETRIED")
    expect(logText).toMatch(/: error \(Versuch 1\/2\)/)
    expect(logText).toMatch(/: done \(Versuch 2\/2\)/)
  }, 240_000)

  test("Isolation: echtes Ledger und flow-lab-Runs tragen nichts von diesem Test", () => {
    const neu = zeilen(ECHTES_LEDGER).slice(vorher.ledger)
    // Live-Sitzungen schreiben parallel ins echte Ledger — gezählt wird, was
    // von HIER stammt (Pipeline-Name oder Temp-Pfad), und das muss null sein.
    expect(neu.filter((z) => z.includes(PIPELINE) || z.includes(R))).toEqual([])
    const eigene = readdirSync(join(R, "proj/.openflow/runs")).filter((f) => !f.startsWith("."))
    expect(eigene.length).toBeGreaterThan(0)
    expect(runsListe().filter((f) => eigene.includes(f))).toEqual([])
    expect(runsListe().filter((f) => !vorher.runs.includes(f) && readFileSync(join(ECHTE_RUNS, f), "utf8").includes(PIPELINE))).toEqual([])
    // Die Läufe dieses Tests landeten im Temp-Ledger.
    expect(zeilen(join(R, "ledger.jsonl")).some((z) => z.includes('"fabrik_ende"'))).toBe(true)
  })
})
