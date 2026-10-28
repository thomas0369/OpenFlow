/**
 * Comment-preserving edits to opencode's config dialect (JSONC).
 *
 * The store re-serialises a parsed config, which drops every comment, so it
 * refused any write to a commented config. That made Run unusable for anyone
 * whose global `opencode.jsonc` carries notes: the agent merge before every
 * run was refused with "existing opencode.json has comments" (measured
 * 2026-10-28). `jsonc-parser` is not reachable from this package (`bun.lock`
 * gains only the workspace entry), so this edits the text directly: members of
 * ONE object are replaced, added or removed, and every other byte — comments,
 * order, formatting — is left exactly as it was.
 *
 * It answers `undefined` for anything it cannot place with certainty, and the
 * caller re-parses the result and compares it with the value it meant to
 * write. Either way a doubtful edit becomes the old refusal, never damage.
 */

type Member = { key: string; start: number; valueStart: number; valueEnd: number; comma?: number }
type Obj = { open: number; close: number; members: Member[] }
type Edit = { start: number; end: number; text: string }

/**
 * Sets (`value`) or removes (`undefined`) members of the object at `at` (a key
 * path from the root). A missing object on the path is created.
 */
export function editMembers(raw: string, at: string[], changes: Record<string, unknown>) {
  const root = skip(raw, 0)
  if (raw[root] !== "{") return undefined
  const walked = walk(raw, objectAt(raw, root), at)
  if (!walked) return undefined
  if (walked.missing.length) {
    const created = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined))
    const nested = walked.missing.slice(1).reduceRight<unknown>((inner, key) => ({ [key]: inner }), created)
    return apply(raw, addTo(raw, walked.obj, { [walked.missing[0]!]: nested }))
  }
  const obj = walked.obj
  const edits = Object.entries(changes).flatMap(([key, value]) => {
    const member = obj.members.find((entry) => entry.key === key)
    if (!member) return []
    if (value === undefined) return [removal(raw, obj, member)]
    return [{ start: member.valueStart, end: member.valueEnd, text: serialize(value, indentOf(raw, member.start)) }]
  })
  const added = Object.fromEntries(
    Object.entries(changes).filter(([key, value]) => value !== undefined && !obj.members.some((entry) => entry.key === key)),
  )
  return apply(raw, [...edits, ...addTo(raw, obj, added)])
}

function walk(raw: string, obj: Obj | undefined, at: string[]): { obj: Obj; missing: string[] } | undefined {
  if (!obj) return undefined
  if (!at.length) return { obj, missing: [] }
  const member = obj.members.find((entry) => entry.key === at[0])
  if (!member) return { obj, missing: at }
  if (raw[member.valueStart] !== "{") return undefined
  return walk(raw, objectAt(raw, member.valueStart), at.slice(1))
}

/** New members go right after the opening brace, so no existing member's comma changes. */
function addTo(raw: string, obj: Obj, added: Record<string, unknown>): Edit[] {
  const entries = Object.entries(added)
  if (!entries.length) return []
  const indent = obj.members.length ? indentOf(raw, obj.members[0]!.start) : indentOf(raw, obj.open) + "  "
  const lines = entries.map(([key, value]) => `\n${indent}${JSON.stringify(key)}: ${serialize(value, indent)}`)
  if (obj.members.length) return [{ start: obj.open + 1, end: obj.open + 1, text: lines.map((line) => `${line},`).join("") }]
  return [{ start: obj.open + 1, end: obj.open + 1, text: lines.join(",") + "\n" + indentOf(raw, obj.open) }]
}

function removal(raw: string, obj: Obj, member: Member): Edit {
  if (member.comma !== undefined) {
    const lineStart = raw.lastIndexOf("\n", member.start - 1) + 1
    const start = raw.slice(lineStart, member.start).trim() ? member.start : lineStart
    const rest = raw.slice(member.comma + 1).match(/^[ \t]*\n/)
    return { start, end: member.comma + 1 + (rest ? rest[0].length : 0), text: "" }
  }
  // the last member: take the previous member's comma with it
  const previous = obj.members[obj.members.indexOf(member) - 1]
  if (previous?.comma !== undefined) return { start: previous.comma, end: member.valueEnd, text: "" }
  return { start: member.start, end: member.valueEnd, text: "" }
}

function apply(raw: string, edits: Edit[]) {
  return edits
    .toSorted((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), raw)
}

function serialize(value: unknown, indent: string) {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`)
}

function indentOf(raw: string, at: number) {
  const lead = raw.slice(raw.lastIndexOf("\n", at - 1) + 1, at)
  return /^[ \t]*$/.test(lead) ? lead : "  "
}

/** The object whose `{` sits at `open`; undefined when it is not one this reader can follow. */
function objectAt(raw: string, open: number): Obj | undefined {
  const members: Member[] = []
  let index = skip(raw, open + 1)
  while (raw[index] !== "}") {
    if (raw[index] !== '"') return undefined
    const keyEnd = stringEnd(raw, index)
    const key = JSON.parse(raw.slice(index, keyEnd)) as string
    const colon = skip(raw, keyEnd)
    if (raw[colon] !== ":") return undefined
    const valueStart = skip(raw, colon + 1)
    const valueEnd = valueEndAt(raw, valueStart)
    if (valueEnd === undefined) return undefined
    const after = skip(raw, valueEnd)
    const comma = raw[after] === "," ? after : undefined
    members.push({ key, start: index, valueStart, valueEnd, comma })
    index = comma === undefined ? after : skip(raw, after + 1)
    if (comma === undefined && raw[index] !== "}") return undefined
  }
  return { open, close: index, members }
}

function valueEndAt(raw: string, start: number): number | undefined {
  const char = raw[start]
  if (char === '"') return stringEnd(raw, start)
  if (char !== "{" && char !== "[") {
    let end = start
    while (end < raw.length && !/[,}\]\s/]/.test(raw[end]!)) end++
    return end > start ? end : undefined
  }
  let depth = 0
  let index = start
  while (index < raw.length) {
    const next = raw[index]
    if (next === '"') {
      index = stringEnd(raw, index)
      continue
    }
    if (next === "/" && (raw[index + 1] === "/" || raw[index + 1] === "*")) {
      index = skip(raw, index)
      continue
    }
    if (next === "{" || next === "[") depth++
    if (next === "}" || next === "]") depth--
    index++
    if (depth === 0) return index
  }
  return undefined
}

function stringEnd(raw: string, start: number) {
  let index = start + 1
  while (index < raw.length && raw[index] !== '"') index += raw[index] === "\\" ? 2 : 1
  return index + 1
}

/** Past whitespace and comments. */
function skip(raw: string, start: number): number {
  let index = start
  while (index < raw.length && /\s/.test(raw[index]!)) index++
  if (raw.startsWith("//", index)) {
    const end = raw.indexOf("\n", index)
    return end === -1 ? raw.length : skip(raw, end)
  }
  if (raw.startsWith("/*", index)) {
    const end = raw.indexOf("*/", index + 2)
    return end === -1 ? raw.length : skip(raw, end + 2)
  }
  return index
}
