/**
 * The Run button, without the canvas.
 *
 * The engine runs in the page: `start` in src/server/engine.ts is plain
 * TypeScript, but its `api` dependency (src/server/client.ts) resolves the
 * engine through `window.location.origin` — the vite dev server, whose proxy
 * carries the engine password so the browser never needs it. A headless caller
 * gets the same service by faking `window` to the canvas origin and importing
 * the same modules, so run orchestration, prompts, permissions and usage all
 * come from the tested engine path rather than a reimplementation.
 *
 * Usage:
 *   bun packages/flow/scripts/headless-run.ts <pipeline-name> [task words...]
 *
 * What it does, in the canvas's own order:
 *   1. loads the pipeline from the flow store (GET /flow/api/pipelines/:name)
 *   2. merges the per-node agent defs (POST .../agents?merge=1), the same
 *      write the canvas does before every run
 *   3. connects the engine client through the dev-server proxy
 *   4. starts the run with permissions on "auto"; arriving questions are
 *      rejected so each card continues on its own assumption instead of
 *      stalling an unattended run
 *   5. checkpoints the run log to the flow store (PUT /flow/api/runs/:id), so
 *      the run shows up in the canvas's Runs menu like any other
 *
 * Exit code 0 only when the run log ends "done". Node outputs print to stdout,
 * everything else goes to stderr.
 */

;(globalThis as unknown as { window: unknown }).window = {
  location: { origin: process.env.OPENFLOW_ORIGIN ?? "http://127.0.0.1:5174" },
}

import { start } from "../src/server/engine"
import * as api from "../src/server/client"
import { agentBlock } from "../src/server/store"
import { isPipeline } from "../src/graph/pipeline-io"

const origin = process.env.OPENFLOW_ORIGIN ?? "http://127.0.0.1:5174"

// `connect()` fetches relative paths ("/flow/api/context") - legal in a page,
// invalid in bun. Rewrite relative URLs to the canvas origin before they leave.
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" && input.startsWith("/")) input = origin + input
  return realFetch(input, init)
}) as typeof fetch

// bun exits on an unhandled rejection by default; a run that dies mid-run
// loses its log with it. The engine callbacks already catch their own errors,
// so anything reaching here is a wiring bug - report it and keep the run.
process.on("unhandledRejection", (reason) => console.error(`[unhandledRejection] ${String(reason)}`))
process.on("uncaughtException", (error) => console.error(`[uncaughtException] ${error.stack ?? error}`))
// `--resume <checkpoint-path|run-id>` continues an interrupted run: finished
// cards keep their output (no session, no cost), the rest are prompted in the
// sessions they already hold - the same contract the canvas's resume uses.
const argv = process.argv.slice(2)
const resumeIdx = argv.indexOf("--resume")
const resumeRef = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined
const rest = resumeIdx >= 0 ? [...argv.slice(0, resumeIdx), ...argv.slice(resumeIdx + 2)] : argv
let name = rest[0]
let input = rest.slice(1).join(" ")
const resumeOutputs: Record<string, string> = {}
const resumeSessions: Record<string, string> = {}
if (resumeRef !== undefined) {
  const path = resumeRef.startsWith("/") ? resumeRef : `/tmp/openflow-checkpoint-${resumeRef}.json`
  const log = JSON.parse(await Bun.file(path).text())
  name = log.pipeline
  if (!input) input = log.input ?? ""
  for (const node of log.nodes ?? []) {
    if (node.status === "done" && typeof node.output === "string") resumeOutputs[node.id] = node.output
    else if (node.sessionID) resumeSessions[node.id] = node.sessionID
  }
  console.error(
    `resuming ${log.id} - ${Object.keys(resumeOutputs).length} card(s) kept, ${Object.keys(resumeSessions).length} continued in session`,
  )
}
if (!name) {
  console.error("usage: bun packages/flow/scripts/headless-run.ts [--resume <checkpoint|run-id>] <pipeline-name> [task words...]")
  process.exit(2)
}

async function flow<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${origin}/flow/api/${path}`, init)
  if (!response.ok) throw new Error(`flow store ${path} -> ${response.status} ${await response.text().catch(() => "")}`)
  return (await response.json()) as T
}

const pipeline = await flow<unknown>(`pipelines/${encodeURIComponent(name)}`)
if (!isPipeline(pipeline)) throw new Error(`"${name}" did not load as a pipeline`)

const servers = await flow<Array<{ name: string }>>("mcp")
const names = servers.map((entry) => entry.name)
const merged = await flow(`pipelines/${encodeURIComponent(name)}/agents?merge=1`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(agentBlock(pipeline, names)),
})
console.error(`agents merged (${names.length} mcp server(s) known)`)

await api.connect()

const run = start(pipeline, input, {
  resume: resumeOutputs,
  sessions: resumeSessions,
  onNode: (id, patch) => {
    if (patch.status) console.error(`[${id}] ${patch.status}`)
  },
  onRun: (log) => {
    void Bun.write(`/tmp/openflow-checkpoint-${log.id}.json`, JSON.stringify(log, null, 2)).catch(() => undefined)
    void flow(`runs/${encodeURIComponent(log.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(log),
    }).catch((error) => console.error(`run log save failed: ${String(error)}`))
  },
  onNotice: (kind, text) => console.error(`[${kind}] ${text}`),
  onQuestion: () => Promise.resolve(undefined),
  onEngineStale: () => console.error("engine config is stale — restart opencode serve"),
})

const log = await run.done
console.error(`checkpoint: /tmp/openflow-checkpoint-${log.id}.json`)
for (const node of log.nodes) {
  console.error(`[${node.id}] ${node.status}`)
  if (node.output !== undefined) console.log(`=== ${node.id} ===\n${node.output}`)
}
console.error(`run ${log.id}: ${log.status}`)
process.exit(log.status === "done" ? 0 : 1)
