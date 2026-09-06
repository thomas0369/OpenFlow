import { describe, expect, test } from "bun:test"
import { boardAbsorb, boardSection, taskLines } from "./board"

const RETURN = `Hier meine Rückmeldung:

[T2] status: running · owner: coder · ziel: pad-nutzung prüfen

Details folgen im nächsten Turn.`

describe("taskLines", () => {
  test("extracts only [Tn] lines", () => {
    expect(taskLines(RETURN)).toEqual(["[T2] status: running · owner: coder · ziel: pad-nutzung prüfen"])
  })

  test("no task lines yields empty", () => {
    expect(taskLines("alles done, keine Marks")).toEqual([])
  })
})

describe("boardAbsorb", () => {
  test("new lines append", () => {
    const board = boardAbsorb([], "[T1] status: pending")
    expect(board).toEqual(["[T1] status: pending"])
  })

  test("a later line for the same task replaces the earlier one", () => {
    let board = boardAbsorb([], "[T1] status: pending")
    board = boardAbsorb(board, "[T1] status: done · beleg: tools.ts:12")
    expect(board).toEqual(["[T1] status: done · beleg: tools.ts:12"])
  })

  test("sorts numerically, not lexically", () => {
    let board = boardAbsorb([], "[T10] status: pending")
    board = boardAbsorb(board, "[T2] status: pending")
    board = boardAbsorb(board, "[T1] status: pending")
    expect(board.map((l) => l.match(/\[T\d+\]/)![0])).toEqual(["[T1]", "[T2]", "[T10]"])
  })

  test("different tasks coexist", () => {
    let board = boardAbsorb([], "[T1] status: done")
    board = boardAbsorb(board, RETURN)
    expect(board).toHaveLength(2)
  })
})

describe("boardSection", () => {
  test("empty board renders nothing", () => {
    expect(boardSection([])).toBeUndefined()
  })

  test("renders header and lines", () => {
    const section = boardSection(["[T1] status: done"])
    expect(section).toContain("Team-Board")
    expect(section).toContain("[T1] status: done")
  })
})
