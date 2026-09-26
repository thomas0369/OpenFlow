import { describe, expect, test } from "bun:test"
import { orchestrationShape } from "./orchestration"
import { swarmShape } from "./swarm"
import { TEMPLATES } from "./templates"
import { modeOf } from "./types"
import { layer, preflight } from "./validate"

describe("templates", () => {
  for (const template of TEMPLATES) {
    describe(template.id, () => {
      test("builds a structurally valid graph", () => {
        const result = layer(template.build())
        if (!result.ok) throw new Error(`expected a valid graph, got: ${result.error}`)
      })

      test("every edge references nodes that exist", () => {
        const pipeline = template.build()
        const ids = new Set(pipeline.nodes.map((node) => node.id))
        for (const edge of pipeline.edges) {
          expect(ids.has(edge.source)).toBe(true)
          expect(ids.has(edge.target)).toBe(true)
        }
      })

      test("node ids are unique", () => {
        const ids = template.build().nodes.map((node) => node.id)
        expect(new Set(ids).size).toBe(ids.length)
      })

      test("has at least one node", () => {
        expect(template.build().nodes.length).toBeGreaterThan(0)
      })
    })
  }

  test("ids are unique across the catalog", () => {
    const ids = TEMPLATES.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("the swarm template", () => {
  const built = () => TEMPLATES.find((template) => template.id === "swarm-debate")!.build()

  test("is a swarm with exactly one synthesizer and peers to debate", () => {
    const graph = built()
    expect(modeOf(graph)).toBe("swarm")
    const shape = swarmShape(graph)
    expect(shape.agents).toHaveLength(3)
    expect(shape.synthesizers).toHaveLength(1)
  })

  test("draws no edges — wiring one would only earn the ignored-edges warning", () => {
    expect(built().edges).toEqual([])
  })

  test("passes its own mode's shape rules on drop", () => {
    const graph = built()
    for (const node of graph.nodes) node.agent.model = "opencode/x"
    expect(preflight(graph, { unlockedModels: new Set(["opencode/x"]) }).blocking).toEqual([])
  })
})

describe("the orchestration template", () => {
  const built = () => TEMPLATES.find((template) => template.id === "orchestrated-build")!.build()

  test("is a tree with one card at the top and the rest wired under it", () => {
    const graph = built()
    expect(modeOf(graph)).toBe("orchestration")
    const shape = orchestrationShape(graph)
    expect(shape.roots).toHaveLength(1)
    expect(shape.root.role).toBe("orchestrator")
    expect(shape.children(shape.root.id)).toHaveLength(3)
  })

  test("is one level deep, so dropping it cannot start a run nobody sized", () => {
    expect(orchestrationShape(built()).depth).toBe(1)
  })

  test("passes its own mode's shape rules on drop", () => {
    const graph = built()
    for (const node of graph.nodes) node.agent.model = "opencode/x"
    expect(preflight(graph, { unlockedModels: new Set(["opencode/x"]) }).blocking).toEqual([])
  })
})

describe("the dirigent template", () => {
  const built = () => TEMPLATES.find((template) => template.id === "dirigent-build")!.build()

  test("is a refine canvas whose root is the briefing card", () => {
    const graph = built()
    expect(graph.refine).toBe(true)
    expect(modeOf(graph)).toBe("orchestration")
    const shape = orchestrationShape(graph)
    expect(shape.roots).toHaveLength(1)
    expect(shape.root.role).toBe("orchestrator")
    expect(shape.root.agent.prompt).toContain("You are the briefing card")
  })

  test("hands the contract to one boss, who owns the crew", () => {
    const graph = built()
    const shape = orchestrationShape(graph)
    expect(shape.children(shape.root.id)).toHaveLength(1)
    const boss = graph.nodes.find((node) => node.id === shape.children(shape.root.id)[0])!
    expect(boss.role).toBe("orchestrator")
    expect(boss.agent.prompt).not.toContain("briefing card")
    expect(shape.children(boss.id)).toHaveLength(3)
  })

  test("passes its own mode's shape rules on drop", () => {
    const graph = built()
    for (const node of graph.nodes) node.agent.model = "opencode/x"
    expect(preflight(graph, { unlockedModels: new Set(["opencode/x"]) }).blocking).toEqual([])
  })
})
