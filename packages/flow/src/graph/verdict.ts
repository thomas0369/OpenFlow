/**
 * A critic's verdict, read back as data.
 *
 * Until now a critic's answer was prose, and the engine only asked whether one
 * had arrived (`judged.add` on any text). Measured over 430 runs: at least 23
 * were delivered as PASS while the last critic still listed BLOCKERs. So a
 * gauntlet that opts into `verdict: "structured"` makes the critic end with a
 * fenced block the engine can read:
 *
 *   ```urteil
 *   {"kriterien":[{"id":"K1","text":"…","erfuellt":true,"beleg":"command + output"}],
 *    "blocker":[{"id":"B1","befund":"…","beleg":"…"}]}
 *   ```
 *
 * The keys are German because the critic prompts and the user's rules are.
 *
 * The score is DERIVED, never taken from the critic: 10 only when every
 * criterion is met AND carries evidence AND no blocker is open. A criterion
 * marked met without evidence counts as unmet — an unchecked claim is worth
 * nothing, which is the user's rule ("ungeprüft zählt 0"). A critic that hands
 * out a 10 out of politeness therefore cannot raise the score; only evidence
 * can.
 */

import { parseJson } from "./dispatch"

export const VERDICT_FENCE = "urteil"

export type Criterion = { id: string; text: string; met: boolean; evidence: string }
export type Blocker = { id: string; finding: string; evidence: string }

export type Verdict = {
  criteria: Criterion[]
  blockers: Blocker[]
  /**
   * Criteria of the original task the critic holds to be refuted rather than
   * unmet — the task asked for something false. Measured 2026-11-22: asked to
   * prove 91 prime, the boss wrote the honest opposite and its own Definition of
   * Done to match, the critic judged that DoD, and the run read as a plain 10.
   * Correcting a premise is right; doing it silently is not. Each entry needs
   * evidence — a refutation without one is a blocker.
   */
  premises: Blocker[]
  /** 0–10, derived by `scoreOf`. */
  score: number
  /** `score === 10`. */
  passed: boolean
}

export type VerdictRead = { kind: "verdict"; verdict: Verdict } | { kind: "error"; reason: string }

/**
 * Reads the LAST ```urteil block of a critic's answer. The last one wins
 * because a critic that revises itself mid-answer means its final word.
 */
export function parseVerdict(text: string): VerdictRead {
  const blocks = [...text.matchAll(new RegExp("```" + VERDICT_FENCE + "\\s*\\n([\\s\\S]*?)```", "g"))]
  const body = blocks.at(-1)?.[1]
  if (body === undefined)
    return { kind: "error", reason: `Your answer carried no \`\`\`${VERDICT_FENCE} block, so the verdict cannot be read.` }
  const value = parseJson(body)
  if (value === undefined) return { kind: "error", reason: `The \`\`\`${VERDICT_FENCE} block is not valid JSON.` }
  if (!isObject(value)) return { kind: "error", reason: `The \`\`\`${VERDICT_FENCE} block must hold a JSON object.` }

  const rawCriteria = value.kriterien
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0)
    return {
      kind: "error",
      reason: `"kriterien" must be a non-empty list — without criteria there is nothing a 10 could stand for.`,
    }
  const criteria: Criterion[] = []
  for (const [index, entry] of rawCriteria.entries()) {
    if (!isObject(entry) || typeof entry.erfuellt !== "boolean")
      return { kind: "error", reason: `kriterien[${index}] needs a boolean "erfuellt".` }
    criteria.push({
      id: text_(entry.id) || `K${index + 1}`,
      text: text_(entry.text),
      met: entry.erfuellt,
      evidence: text_(entry.beleg),
    })
  }

  const rawBlockers = value.blocker ?? []
  if (!Array.isArray(rawBlockers)) return { kind: "error", reason: `"blocker" must be a list.` }
  const blockers: Blocker[] = rawBlockers.map((entry, index) => ({
    id: isObject(entry) ? text_(entry.id) || `B${index + 1}` : `B${index + 1}`,
    finding: isObject(entry) ? text_(entry.befund) : text_(entry),
    evidence: isObject(entry) ? text_(entry.beleg) : "",
  }))

  const rawPremises = value.praemisse_widerlegt ?? []
  if (!Array.isArray(rawPremises)) return { kind: "error", reason: `"praemisse_widerlegt" must be a list.` }
  const premises: Blocker[] = rawPremises.map((entry, index) => ({
    id: isObject(entry) ? text_(entry.id) || `P${index + 1}` : `P${index + 1}`,
    finding: isObject(entry) ? text_(entry.befund) : text_(entry),
    evidence: isObject(entry) ? text_(entry.beleg) : "",
  }))
  // An unproven refutation is a way to drop a criterion, so it blocks like one.
  const unproven = premises
    .filter((entry) => !entry.evidence)
    .map((entry) => ({ id: entry.id, finding: `Prämisse als widerlegt gemeldet, aber ohne Beleg: ${entry.finding}`, evidence: "" }))

  const score = scoreOf(criteria, [...blockers, ...unproven])
  return { kind: "verdict", verdict: { criteria, blockers: [...blockers, ...unproven], premises, score, passed: score === 10 } }
}

/** 10 when every criterion is met with evidence and no blocker is open, else floor(9 · proven / total). */
export function scoreOf(criteria: Criterion[], blockers: Blocker[]) {
  if (criteria.length === 0) return 0
  const proven = criteria.filter(provenMet).length
  if (proven === criteria.length && blockers.length === 0) return 10
  return Math.floor((9 * proven) / criteria.length)
}

export function provenMet(criterion: Criterion) {
  return criterion.met && criterion.evidence.trim().length > 0
}

/**
 * What is still wrong, as one comparable string: open blockers and unproven
 * criteria, ids and findings normalised. Two rounds with the same signature
 * made no progress — the loop stops instead of burning a third.
 */
export function signatureOf(verdict: Verdict) {
  const open = [
    ...verdict.blockers.map((entry) => `B:${entry.id}:${normalise(entry.finding)}`),
    ...verdict.criteria.filter((entry) => !provenMet(entry)).map((entry) => `K:${entry.id}`),
  ]
  return open.sort().join("|")
}

/** The single most important thing to fix: the first blocker, else the first unproven criterion. */
export function largestGap(verdict: Verdict) {
  const blocker = verdict.blockers[0]
  if (blocker) return `${blocker.id}: ${blocker.finding}${blocker.evidence ? ` (Beleg: ${blocker.evidence})` : ""}`
  const criterion = verdict.criteria.find((entry) => !provenMet(entry))
  if (!criterion) return undefined
  return criterion.met
    ? `${criterion.id}: ${criterion.text} — als erfüllt gemeldet, aber ohne Beleg`
    : `${criterion.id}: ${criterion.text} — nicht erfüllt${criterion.evidence ? ` (Beleg: ${criterion.evidence})` : ""}`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text_(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalise(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim()
}

/** Open blockers and unproven criteria, as `id: finding` lines for the run log. */
export function openOf(verdict: Verdict) {
  return [
    ...verdict.blockers.map((entry) => `${entry.id}: ${entry.finding}`),
    ...verdict.criteria
      .filter((entry) => !provenMet(entry))
      .map((entry) => `${entry.id}: ${entry.text}${entry.met ? " (ohne Beleg)" : ""}`),
  ]
}
