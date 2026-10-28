import { describe, expect, test } from "bun:test"
import { editMembers } from "./jsonc-edit"

// The reader opencode itself would use, minus jsonc-parser: drop comments and
// trailing commas, then JSON.parse. Enough to check what an edit produced.
function parse(text: string) {
  return JSON.parse(
    text
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? "")
      .replace(/,(\s*[}\]])/g, "$1"),
  )
}

const source = `{
  // global notes the user wrote
  "model": "dharma/balanced",
  "agent": {
    "build": {
      // dharma/power statt fast (18.10.2026)
      "model": "dharma/power"
    },
    "old-generated": { "description": "OpenFlow node a of pipeline p" },
    "mine": { "model": "x" }
  },
  /* trailing block */
  "provider": {}
}
`

describe("editMembers", () => {
  test("adds, replaces and removes members of one object and keeps every comment", () => {
    const edited = editMembers(source, ["agent"], {
      "old-generated": undefined,
      mine: { model: "y" },
      "p-boss": { mode: "primary", model: "dharma/power" },
    })!
    expect(edited).toContain("// global notes the user wrote")
    expect(edited).toContain("// dharma/power statt fast (18.10.2026)")
    expect(edited).toContain("/* trailing block */")
    expect(parse(edited)).toEqual({
      model: "dharma/balanced",
      agent: {
        "p-boss": { mode: "primary", model: "dharma/power" },
        build: { model: "dharma/power" },
        mine: { model: "y" },
      },
      provider: {},
    })
  })

  test("removing the last member takes the previous comma with it", () => {
    const edited = editMembers(source, ["agent"], { mine: undefined })!
    expect(Object.keys(parse(edited).agent)).toEqual(["build", "old-generated"])
    expect(edited).toContain('"old-generated": { "description": "OpenFlow node a of pipeline p" }\n  }')
  })

  test("a missing object on the path is created, comments untouched", () => {
    const raw = `{\n  // only a note\n  "model": "m"\n}\n`
    const edited = editMembers(raw, ["agent"], { a: { mode: "primary" } })!
    expect(edited).toContain("// only a note")
    expect(parse(edited)).toEqual({ agent: { a: { mode: "primary" } }, model: "m" })
  })

  test("an empty object gets members without a dangling comma", () => {
    const edited = editMembers(`{\n  "agent": {}\n}\n`, ["agent"], { a: 1, b: 2 })!
    expect(parse(edited)).toEqual({ agent: { a: 1, b: 2 } })
    expect(edited).not.toMatch(/,\s*}/)
  })

  test("comment markers and braces inside strings are not structure", () => {
    const raw = `{ "agent": { "x": { "prompt": "a // b /* c */ } {" } }, "k": "v" }`
    const edited = editMembers(raw, ["agent"], { x: undefined, y: true })!
    expect(parse(edited)).toEqual({ agent: { y: true }, k: "v" })
  })

  test("answers undefined rather than guessing at something it cannot follow", () => {
    expect(editMembers("[]", ["agent"], { a: 1 })).toBeUndefined()
    expect(editMembers(`{ "agent": [] }`, ["agent"], { a: 1 })).toBeUndefined()
    expect(editMembers(`{ "agent": { "a": 1 "b": 2 } }`, ["agent"], { c: 3 })).toBeUndefined()
  })
})
