import { describe, expect, test } from "bun:test"
import { VERDICT_FENCE, largestGap, parseVerdict, scoreOf, signatureOf } from "./verdict"

const block = (body: string) => "```" + VERDICT_FENCE + "\n" + body + "\n```"
const criterion = (id: string, erfuellt: boolean, beleg = "wc -l x → 3") => ({ id, text: `Kriterium ${id}`, erfuellt, beleg })

describe("parseVerdict", () => {
  test("reads criteria and blockers and derives a 10 only when everything is proven", () => {
    const result = parseVerdict(
      "Geprüft.\n\n" + block(JSON.stringify({ kriterien: [criterion("K1", true), criterion("K2", true)], blocker: [] })),
    )
    expect(result.kind).toBe("verdict")
    if (result.kind !== "verdict") return
    expect(result.verdict.score).toBe(10)
    expect(result.verdict.passed).toBe(true)
    expect(result.verdict.criteria.map((entry) => entry.id)).toEqual(["K1", "K2"])
  })

  test("a criterion marked met without evidence counts as unmet", () => {
    const result = parseVerdict(block(JSON.stringify({ kriterien: [criterion("K1", true), criterion("K2", true, " ")] })))
    if (result.kind !== "verdict") throw new Error(result.reason)
    expect(result.verdict.score).toBe(4)
    expect(result.verdict.passed).toBe(false)
  })

  test("an open blocker keeps the score below 10 even with every criterion proven", () => {
    const result = parseVerdict(
      block(
        JSON.stringify({ kriterien: [criterion("K1", true)], blocker: [{ id: "B1", befund: "Test rot", beleg: "bun test → 1 fail" }] }),
      ),
    )
    if (result.kind !== "verdict") throw new Error(result.reason)
    expect(result.verdict.score).toBe(9)
    expect(result.verdict.passed).toBe(false)
  })

  test("the last block wins, so a critic that revises itself means its final word", () => {
    const first = block(JSON.stringify({ kriterien: [criterion("K1", false)] }))
    const second = block(JSON.stringify({ kriterien: [criterion("K1", true)] }))
    const result = parseVerdict(`${first}\n\nNach erneutem Lauf:\n${second}`)
    if (result.kind !== "verdict") throw new Error(result.reason)
    expect(result.verdict.passed).toBe(true)
  })

  test("tolerates a stray character after the object, like the dispatch block", () => {
    const result = parseVerdict(block(JSON.stringify({ kriterien: [criterion("K1", true)] }) + '"'))
    expect(result.kind).toBe("verdict")
  })

  test("refuses with a reason the engine can hand back", () => {
    expect(parseVerdict("alles gut, 10/10")).toMatchObject({ kind: "error" })
    expect(parseVerdict(block("{ nicht json"))).toMatchObject({ kind: "error" })
    expect(parseVerdict(block("[1,2]"))).toMatchObject({ kind: "error" })
    expect(parseVerdict(block(JSON.stringify({ kriterien: [] })))).toMatchObject({ kind: "error" })
    expect(parseVerdict(block(JSON.stringify({ kriterien: [{ id: "K1", erfuellt: "ja" }] })))).toMatchObject({
      kind: "error",
    })
    expect(parseVerdict(block(JSON.stringify({ kriterien: [criterion("K1", true)], blocker: "keine" })))).toMatchObject({
      kind: "error",
    })
  })

  test("a critic's own score is ignored — only evidence raises it", () => {
    const result = parseVerdict(block(JSON.stringify({ note: 10, kriterien: [criterion("K1", false)] })))
    if (result.kind !== "verdict") throw new Error(result.reason)
    expect(result.verdict.score).toBe(0)
  })
})

describe("scoreOf", () => {
  test("floors 9 × proven share and never reaches 10 short of everything", () => {
    const proven = { id: "K", text: "", met: true, evidence: "x" }
    const open = { id: "K", text: "", met: false, evidence: "" }
    expect(scoreOf([proven, proven, proven, open], [])).toBe(6)
    expect(scoreOf([proven], [])).toBe(10)
    expect(scoreOf([], [])).toBe(0)
  })
})

describe("signatureOf and largestGap", () => {
  test("the same open findings give the same signature whatever their order or spacing", () => {
    const one = parseVerdict(
      block(
        JSON.stringify({
          kriterien: [criterion("K1", false), criterion("K2", true)],
          blocker: [
            { id: "B1", befund: "Test  rot" },
            { id: "B2", befund: "Link tot" },
          ],
        }),
      ),
    )
    const two = parseVerdict(
      block(
        JSON.stringify({
          kriterien: [criterion("K2", true), criterion("K1", false)],
          blocker: [
            { id: "B2", befund: "link tot" },
            { id: "B1", befund: "test rot" },
          ],
        }),
      ),
    )
    if (one.kind !== "verdict" || two.kind !== "verdict") throw new Error("parse")
    expect(signatureOf(one.verdict)).toBe(signatureOf(two.verdict))
  })

  test("names the first blocker, else the first unproven criterion", () => {
    const blocked = parseVerdict(
      block(JSON.stringify({ kriterien: [criterion("K1", false)], blocker: [{ id: "B1", befund: "rot", beleg: "bun test" }] })),
    )
    const unproven = parseVerdict(block(JSON.stringify({ kriterien: [criterion("K1", true, "")] })))
    if (blocked.kind !== "verdict" || unproven.kind !== "verdict") throw new Error("parse")
    expect(largestGap(blocked.verdict)).toBe("B1: rot (Beleg: bun test)")
    expect(largestGap(unproven.verdict)).toContain("ohne Beleg")
  })
})

describe("refuted premises", () => {
  test("a refuted original criterion with evidence is recorded and does not lower the score", () => {
    const result = parseVerdict(
      block(
        JSON.stringify({
          kriterien: [criterion("K1", true)],
          praemisse_widerlegt: [{ id: "P1", befund: "91 ist nicht prim", beleg: "all(91%k …) → False" }],
        }),
      ),
    )
    if (result.kind !== "verdict") throw new Error(result.reason)
    expect(result.verdict.score).toBe(10)
    expect(result.verdict.premises).toEqual([{ id: "P1", finding: "91 ist nicht prim", evidence: "all(91%k …) → False" }])
  })

  test("a refutation without evidence blocks — it would be a way to drop a criterion", () => {
    const result = parseVerdict(
      block(JSON.stringify({ kriterien: [criterion("K1", true)], praemisse_widerlegt: [{ id: "P1", befund: "geht nicht" }] })),
    )
    if (result.kind !== "verdict") throw new Error(result.reason)
    expect(result.verdict.passed).toBe(false)
    expect(result.verdict.blockers[0].finding).toContain("ohne Beleg")
  })
})
