/**
 * Team-Board — the shared task list an orchestrator's children report into.
 *
 * Modeled on Claude Code's agent-team task list (a shared, visible source of
 * truth with per-task status and dependencies), but built with what OpenFlow
 * already has: cards answer in a `[T1] status: …` line format, the scheduler
 * collects those lines from every child return, and injects the merged board
 * into every later dispatch and into the orchestrator's next result turn.
 * Cards never need write access to share state — the server is the writer,
 * the cards are readers, which keeps read-only roles (explorer, critic)
 * first-class team members.
 *
 * Pure functions on string arrays: no engine state, trivially testable.
 */

/** A board is the set of newest task lines, keyed by task id. */
export type Board = readonly string[]

const TASK_LINE = /^\s*\[(T\d+)\]/

/** Extract a card's task lines from its return text, newest information last. */
export function taskLines(answer: string): string[] {
  return answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => TASK_LINE.test(line))
}

/**
 * Merge child task lines into the board. A later line for the same task id
 * replaces the earlier one — a card reporting `blocked` after `running`
 * overwrites it, exactly like a TaskUpdate.
 */
export function boardAbsorb(board: Board, answer: string): string[] {
  const merged = new Map<string, string>()
  const put = (line: string) => {
    const id = line.match(TASK_LINE)![1]
    merged.set(id, line)
  }
  for (const line of board) put(line)
  for (const line of taskLines(answer)) put(line)
  return [...merged.entries()].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1))).map(([, line]) => line)
}

/**
 * Render the board as a prompt section, or undefined while it is empty.
 * Worded so both roles can use it unchanged: the orchestrator reads the
 * validated stand, the worker reads what the rest of the team reported.
 */
export function boardSection(board: Board): string | undefined {
  if (board.length === 0) return undefined
  return [
    "## Team-Board (vom Scheduler aus den Karten-Rückmeldungen geführt)",
    "",
    ...board,
    "",
    "Das ist der gemeinsame Stand. Als Orchestrator: vergib oder aktualisiere Aufgaben in deinen Dispatches mit demselben [Tn]-Zeilenformat. Als Karte: melde deine Aufgabe mit einer [Tn]-Zeile zurück (status: done | blocked | needs-input).",
  ].join("\n")
}
