import { nodeModel } from "./default-model"
import { role } from "./roles"
import { emptyPipeline, type FlowNode, type Pipeline } from "./types"

/**
 * A ready-made pipeline a first-timer can drop onto the canvas and run with no
 * wiring. Every template is built from the built-in roles, so its colours and
 * prompts read exactly as a hand-built graph would.
 */
export type Template = { id: string; name: string; description: string; build(): Pipeline }

/** One node's role, with an optional prompt override for the `custom` role. */
type Step = { role: string; prompt?: string }

/**
 * Builds a left-to-right chain: one node per step, each wired to the next.
 * Node ids follow the `n<time><counter>` scheme `state.addNode` uses, unique
 * within the pipeline; the default model preference is applied exactly as a
 * freshly dropped node gets it (F3), so a template is runnable on drop.
 */
function chain(name: string, steps: Step[]): Pipeline {
  const pipeline = emptyPipeline(name)
  const stamp = Date.now().toString(36)
  const nodes: FlowNode[] = steps.map((step, index) => {
    const preset = role(step.role)
    const agent = { ...(preset?.agent ?? { prompt: "" }), tools: { ...(preset?.agent.tools ?? {}) } }
    if (step.prompt) agent.prompt = step.prompt
    agent.model = nodeModel(preset?.agent.model)
    return {
      id: `n${stamp}${index.toString(36)}`,
      role: preset?.label ?? step.role,
      agent,
      position: { x: 40 + index * 300, y: 80 },
    }
  })
  pipeline.nodes = nodes
  pipeline.edges = nodes.slice(1).map((node, index) => ({
    id: `e${stamp}${index}`,
    source: nodes[index].id,
    target: node.id,
  }))
  return pipeline
}

/**
 * A swarm laid out as a row of peers with the synthesizer under them.
 *
 * No edges: in swarm mode the mesh is the node list, so wiring one here would
 * only produce the `ignored-edges` warning on the first run. Every peer gets the
 * same default model, because what a template cannot know is which models the
 * user has keyed — swapping one card to a different provider is the first thing
 * a swarm is actually for.
 */
function swarm(name: string, steps: Step[], rounds: number): Pipeline {
  const pipeline = emptyPipeline(name)
  const stamp = Date.now().toString(36)
  const card = (step: Step, index: number, position: { x: number; y: number }): FlowNode => {
    const preset = role(step.role)
    const agent = { ...(preset?.agent ?? { prompt: "" }), tools: { ...(preset?.agent.tools ?? {}) } }
    if (step.prompt) agent.prompt = step.prompt
    agent.model = nodeModel(preset?.agent.model)
    return { id: `n${stamp}${index.toString(36)}`, role: preset?.label ?? step.role, agent, position }
  }
  const agents = steps.map((step, index) => card(step, index, { x: 40 + index * 300, y: 60 }))
  pipeline.nodes = [
    ...agents,
    card({ role: "synthesizer" }, steps.length, { x: 40 + Math.max(0, steps.length - 1) * 150, y: 300 }),
  ]
  pipeline.mode = "swarm"
  pipeline.rounds = rounds
  return pipeline
}

/**
 * An orchestrator with a row of subagents wired under it.
 *
 * One level deep on purpose: a template's job is to be runnable on drop, and a
 * second level multiplies the worst-case session count by however many cards
 * hang off it. Wiring a card under a subagent is the one edit that turns this
 * into the recursive shape.
 */
function orchestration(name: string, steps: Step[]): Pipeline {
  const pipeline = emptyPipeline(name)
  const stamp = Date.now().toString(36)
  const card = (step: Step, index: number, position: { x: number; y: number }): FlowNode => {
    const preset = role(step.role)
    const agent = { ...(preset?.agent ?? { prompt: "" }), tools: { ...(preset?.agent.tools ?? {}) } }
    if (step.prompt) agent.prompt = step.prompt
    agent.model = nodeModel(preset?.agent.model)
    return { id: `n${stamp}${index.toString(36)}`, role: preset?.label ?? step.role, agent, position }
  }
  const boss = card({ role: "orchestrator" }, 0, { x: 40 + Math.max(0, steps.length - 1) * 150, y: 60 })
  const crew = steps.map((step, index) => card(step, index + 1, { x: 40 + index * 300, y: 300 }))
  pipeline.nodes = [boss, ...crew]
  pipeline.edges = crew.map((node, index) => ({ id: `e${stamp}${index}`, source: boss.id, target: node.id }))
  pipeline.mode = "orchestration"
  return pipeline
}

/**
 * A refine canvas on drop: a cheap briefing card turns the run's task into a
 * contract — measured evidence, named skills, fenced paths, checkable
 * criteria — and hands the whole thing to the boss as one dispatch. The
 * pattern is the one a good orchestrator prompt is written by: whoever starts
 * the run says two sentences; the contract is somebody's actual job.
 *
 * The briefing card is an orchestrator because only orchestrators dispatch,
 * and it is the root because the boss must not see the raw task — only the
 * refined one. Cheap model on it, strong model on the boss: refinement is
 * reading and writing, not building.
 */
const BRIEFER_PROMPT =
  "You are the briefing card. Your one dispatch is the run's contract, and it is all you do.\n" +
  "Before you write it: quote the run task in one line. Measure what your cards would otherwise " +
  "spend their first turn measuring — read, grep, bash — and put each finding in `evidence` as " +
  "file:line or a number. Name the skill folders in `skills` if any apply. Fence every path no " +
  "card may touch in `avoid`. Write `plan.verify`: the criteria, one per line, that the boss, its " +
  "critics and every return are held to.\n" +
  "Then dispatch exactly once, to the boss card, with the contract as its task. Do not do the " +
  "work and do not answer the run — the boss and its cards do that."

function dirigent(name: string, steps: Step[]): Pipeline {
  const pipeline = emptyPipeline(name)
  const stamp = Date.now().toString(36)
  const card = (step: Step, index: number, position: { x: number; y: number }): FlowNode => {
    const preset = role(step.role)
    const agent = { ...(preset?.agent ?? { prompt: "" }), tools: { ...(preset?.agent.tools ?? {}) } }
    if (step.prompt) agent.prompt = step.prompt
    agent.model = nodeModel(preset?.agent.model)
    return { id: `n${stamp}${index.toString(36)}`, role: preset?.label ?? step.role, agent, position }
  }
  const breifer = card({ role: "orchestrator", prompt: BRIEFER_PROMPT }, 0, {
    x: 40 + steps.length * 150,
    y: 60,
  })
  const boss = card({ role: "orchestrator" }, steps.length + 1, { x: 40 + steps.length * 150, y: 300 })
  const crew = steps.map((step, index) => card(step, index + 1, { x: 40 + index * 300, y: 540 }))
  pipeline.nodes = [breifer, boss, ...crew]
  pipeline.edges = [
    { id: `e${stamp}b`, source: breifer.id, target: boss.id },
    ...crew.map((node, index) => ({ id: `e${stamp}${index}`, source: boss.id, target: node.id })),
  ]
  pipeline.mode = "orchestration"
  pipeline.refine = true
  return pipeline
}

const WRITER_PROMPT =
  "You are the writer. Using the plan above, draft a clear, well-structured document in prose. " +
  "Follow the plan's outline, fill in each section, and do not write code."

export const TEMPLATES: Template[] = [
  {
    id: "solo-coder",
    name: "solo coder",
    description: "Make one change to your project.",
    build: () => chain("solo coder", [{ role: "coder" }]),
  },
  {
    id: "plan-and-code",
    name: "plan and code",
    description: "Plan first, then implement.",
    build: () => chain("plan and code", [{ role: "planner" }, { role: "coder" }]),
  },
  {
    id: "plan-code-review",
    name: "plan, code, review",
    description: "The full loop.",
    build: () => chain("plan, code, review", [{ role: "planner" }, { role: "coder" }, { role: "reviewer" }]),
  },
  {
    id: "research-write",
    name: "research and write",
    description: "Draft a document.",
    build: () => chain("research and write", [{ role: "planner" }, { role: "custom", prompt: WRITER_PROMPT }]),
  },
  {
    id: "swarm-debate",
    name: "swarm debate",
    description: "Three views argue, one decides.",
    build: () => swarm("swarm debate", [{ role: "planner" }, { role: "architect" }, { role: "reviewer" }], 3),
  },
  {
    id: "orchestrated-build",
    name: "orchestrated build",
    description: "One boss, three specialists.",
    build: () =>
      orchestration("orchestrated build", [{ role: "architect" }, { role: "coder" }, { role: "reviewer" }]),
  },
  {
    id: "dirigent-build",
    name: "dirigent build",
    description: "A briefing card writes the contract, a boss runs it.",
    build: () => dirigent("dirigent build", [{ role: "architect" }, { role: "coder" }, { role: "reviewer" }]),
  },
]
