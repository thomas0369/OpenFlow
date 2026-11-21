import { describe as suite, expect, test } from "bun:test"
import { describe, normalizeEvent, parseModel, formatModel, turnText } from "./client"

suite("describe", () => {
  test("prefers a message field over the raw body", () => {
    expect(describe({ message: "Model glm-4.7-free is not supported" })).toBe(
      "Model glm-4.7-free is not supported",
    )
  })

  test("reads the nested message the opencode server nests under data", () => {
    expect(describe({ data: { message: "no such agent" } })).toBe("no such agent")
  })

  test("reads an error field, which is the key the flow store answers with", () => {
    expect(describe({ error: "pipeline not found" })).toBe("pipeline not found")
  })

  test("prefers message over error when a body carries both", () => {
    expect(describe({ message: "engine is down", error: "engine is down" })).toBe("engine is down")
  })

  test("ignores a non-string error field rather than printing [object Object]", () => {
    expect(describe({ error: { code: 500 } })).toBe('{"error":{"code":500}}')
  })

  // Both hosts proxy `/api` to `opencode serve`, and both must render an
  // unreachable engine as a sentence. These are the literal bodies they emit;
  // a brace in the output means describe() fell through to JSON.stringify.
  test("renders both hosts' proxy failures as prose, never as JSON", () => {
    const bodies = [
      // server.ts, 502
      { message: "cannot reach opencode serve at http://127.0.0.1:4096: fetch failed" },
      // server.ts, 504
      {
        message:
          "opencode serve at http://127.0.0.1:4096 did not answer within 30s — it may have been restarted; retry",
      },
      // vite.config.ts, 502
      {
        message:
          "cannot reach opencode serve at http://127.0.0.1:4096 — start it with `bun openflow.ts` from the repo root",
      },
      // the shape server.ts used to emit, in case a host ever drifts back
      { error: "cannot reach opencode serve at http://127.0.0.1:4096: fetch failed" },
    ]
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
    for (const body of bodies) {
      const rendered = describe(body, response)
      expect(rendered).not.toContain("{")
      expect(rendered).not.toContain("}")
      expect(rendered).toContain("opencode serve")
      expect(rendered).toEndWith("(HTTP 502 Bad Gateway)")
    }
  })

  test("falls back to the status when the body is empty", () => {
    const response = new Response(null, { status: 502, statusText: "Bad Gateway" })
    expect(describe({}, response)).toBe("HTTP 502 Bad Gateway")
  })

  test("names the effect failure tag when that is all the body carries", () => {
    expect(describe({ _tag: "ProviderAuthError" })).toBe("ProviderAuthError")
  })

  test("serializes a shape it does not recognise rather than losing it", () => {
    expect(describe({ reason: "nope", attempts: 2 })).toBe('{"reason":"nope","attempts":2}')
  })

  test("never renders an empty body as the string {}", () => {
    expect(describe({})).toBe("unknown error")
    expect(describe(undefined)).toBe("unknown error")
  })

  test("keeps both the reason and the status when both are known", () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" })
    expect(describe({ message: "bad key" }, response)).toBe("bad key (HTTP 401 Unauthorized)")
  })

  test("a 2xx response contributes no status noise", () => {
    const response = new Response(null, { status: 200 })
    expect(describe("boom", response)).toBe("boom")
  })

  test("unwraps an Error's message", () => {
    expect(describe(new Error("network error"))).toBe("network error")
  })
})

suite("model refs", () => {
  test("splits on the first slash only", () => {
    expect(parseModel("opencode/glm-5.2")).toEqual({ providerID: "opencode", id: "glm-5.2" })
    expect(parseModel("openrouter/z-ai/glm-4.6")).toEqual({ providerID: "openrouter", id: "z-ai/glm-4.6" })
  })

  test("rejects values with no provider", () => {
    expect(parseModel("/glm-5.2")).toBeUndefined()
    expect(parseModel("glm-5.2")).toBeUndefined()
    expect(parseModel("")).toBeUndefined()
  })

  test("round-trips", () => {
    expect(formatModel(parseModel("opencode/glm-5.2"))).toBe("opencode/glm-5.2")
    expect(formatModel(undefined)).toBe("")
  })
})

suite("turnText", () => {
  const assistant = (...parts: string[]) => ({
    type: "assistant",
    content: parts.map((part) => (part === "tool" ? { type: "tool" } : { type: "text", text: part })),
  })
  const prompt = (text: string) => ({ type: "user", text, content: [] })

  test("reads the newest assistant message that actually said something", () => {
    // Measured shape: a card that ends its turn on tool calls leaves the newest
    // messages textless, and the block it wrote sits two messages back.
    const page = [assistant("tool"), assistant("tool"), assistant("the block", "tool"), prompt("go")]
    expect(turnText(page)?.text).toBe("the block")
  })

  test("stops at the prompt, so a previous turn's block is never re-read", () => {
    // Reading past the prompt would dispatch the same work a second time.
    const page = [assistant("tool"), prompt("go again"), assistant("last turn's block")]
    expect(turnText(page)?.text).toBe("")
  })

  test("tool output does not end the scan", () => {
    const page = [assistant("tool"), { type: "user", content: [{ type: "tool_result" }] }, assistant("said it")]
    expect(turnText(page)?.text).toBe("said it")
  })

  test("joins every text part of the message it settles on", () => {
    expect(turnText([assistant("one", "two")])?.text).toBe("one\ntwo")
  })

  test("an error on the newest message survives a textless turn", () => {
    const page = [{ type: "assistant", content: [{ type: "tool" }], error: { message: "boom" } }]
    expect(turnText(page)).toEqual({ text: "", error: { message: "boom" } })
  })

  test("nothing to read at all", () => {
    expect(turnText([prompt("go")])).toBeUndefined()
    expect(turnText([])).toBeUndefined()
  })
})

suite("waitUntilIdle", () => {
  test("gives up at its deadline even while the server still lists the session as running", async () => {
    // Measured 12.10.2026: a session stuck in a `read` tool stayed `running`
    // for over an hour; the deadline sat behind the "still active" branch and
    // was never reached.
    const { waitUntilIdle } = await import("./client")
    const probes = { active: async () => new Set(["s1"]), last: async () => undefined }
    const began = Date.now()
    await expect(waitUntilIdle("s1", probes, { interval: 5, timeout: 50 })).rejects.toThrow("timed out")
    expect(Date.now() - began).toBeLessThan(1_000)
  }, 2_000)

  test("returns once the session is idle with a finished turn", async () => {
    const { waitUntilIdle } = await import("./client")
    const probes = { active: async () => new Set<string>(), last: async () => ({ finish: "stop" }) }
    await waitUntilIdle("s1", probes, { interval: 5, timeout: 1_000 })
  })
})

suite("normalizeEvent — opencode 2.x bus events in the vendored shape", () => {
  // Payloads as captured from opencode 2.3.2's /api/event on 2026-11-21.
  const S = "ses_e011d9146ffeynEyOjOC18CweZ"
  const M = "msg_1fee38f060018qoUX23CwYqgMi"
  const C = "call_c49904580e0f4269b15b42d4"

  test("tool events: next. prefix, callID from id, name carried from input.started to called, shell is bash", () => {
    const names = new Map<string, string>()
    const started = normalizeEvent({ type: "session.tool.input.started", data: { sessionID: S, assistantMessageID: M, id: C, name: "shell" } }, names)
    expect(started.type).toBe("session.next.tool.input.started")
    expect(started.data).toMatchObject({ callID: C, name: "bash" })
    const called = normalizeEvent({ type: "session.tool.called", data: { sessionID: S, assistantMessageID: M, id: C, input: { command: "echo hi" }, executed: false } }, names)
    expect(called.type).toBe("session.next.tool.called")
    expect(called.data).toMatchObject({ callID: C, tool: "bash", input: { command: "echo hi" } })
    const success = normalizeEvent({ type: "session.tool.success", data: { sessionID: S, id: C, content: [{ type: "text", text: "hi\n" }] } }, names)
    expect(success.type).toBe("session.next.tool.success")
    expect(success.data?.callID).toBe(C)
    expect(names.size).toBe(0)
  })

  test("2.x subagent tool reads as the vendored task tool", () => {
    const e = normalizeEvent({ type: "session.tool.input.started", data: { sessionID: S, id: "call_x", name: "subagent" } }, new Map())
    expect(e.data?.name).toBe("task")
  })

  test("step.ended keeps its tokens under the vendored name — live spend depends on it", () => {
    const tokens = { input: 1200, output: 80, reasoning: 0, cache: { read: 0, write: 0 } }
    const e = normalizeEvent({ type: "session.step.ended", data: { sessionID: S, assistantMessageID: M, finish: "stop", tokens, cost: 0 } }, new Map())
    expect(e.type).toBe("session.next.step.ended")
    expect(e.data?.tokens).toEqual(tokens)
  })

  test("text and reasoning parts get an id from message + ordinal", () => {
    const t = normalizeEvent({ type: "session.text.delta", data: { sessionID: S, assistantMessageID: M, ordinal: 2, delta: "x" } }, new Map())
    expect(t.type).toBe("session.next.text.delta")
    expect(t.data?.textID).toBe(`${M}:2`)
    const r = normalizeEvent({ type: "session.reasoning.ended", data: { sessionID: S, assistantMessageID: M, ordinal: 0, text: "t" } }, new Map())
    expect(r.data?.reasoningID).toBe(`${M}:0`)
  })

  test("permission.asked becomes permission.v2.asked with the fields answer() reads", () => {
    const e = normalizeEvent({ type: "permission.asked", data: { id: "per_1feefd5780010bj8JnpyU0d3H7", sessionID: S, action: "edit", resources: ["a.txt"] } }, new Map())
    expect(e.type).toBe("permission.v2.asked")
    expect(e.data).toMatchObject({ id: "per_1feefd5780010bj8JnpyU0d3H7", action: "edit", resources: ["a.txt"] })
  })

  test("session.created stays session.created; a child carries its parent like the vendored info", () => {
    expect(normalizeEvent({ type: "session.created", data: { sessionID: S } }, new Map()).type).toBe("session.created")
    const child = normalizeEvent({ type: "session.created", data: { sessionID: "ses_child", parentID: S } }, new Map())
    expect(child.data?.info).toEqual({ parentID: S })
  })

  test("Kontrollwert: vendored events pass through untouched", () => {
    const vendored = [
      { type: "session.next.tool.called", data: { sessionID: S, callID: C, tool: "bash", input: {} } },
      { type: "permission.v2.asked", data: { id: "p1", sessionID: S, action: "edit" } },
      { type: "server.connected", data: {} },
    ]
    for (const e of vendored) expect(normalizeEvent(e, new Map())).toBe(e)
  })
})
