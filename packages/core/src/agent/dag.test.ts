import { describe, expect, it } from "bun:test"
import { validate, foldDAG, cascadeTerminal, readyNodes, DAGError, type DAGSpec } from "./dag"
import type { StoredEvent } from "@newhorse/schema"

const diamond: DAGSpec = {
  nodes: {
    A: { id: "A", agent: { name: "a" }, produces: "A" },
    B: { id: "B", agent: { name: "b" }, dependsOn: ["A"], consumes: ["A"] },
    C: { id: "C", agent: { name: "c" }, dependsOn: ["A"], consumes: ["A"] },
    D: { id: "D", agent: { name: "d" }, dependsOn: ["B", "C"], consumes: ["B", "C"] },
  },
}

function ev(type: string, data: Record<string, unknown>, seq: number): StoredEvent {
  return { aggregate: "dag", aggregate_id: "g1", seq, type, data }
}

describe("dag topology", () => {
  it("dedupes edges so a repeated dep does not double the in-degree", () => {
    const spec: DAGSpec = { nodes: { X: { id: "X", agent: { name: "x" } }, Y: { id: "Y", agent: { name: "y" }, dependsOn: ["X", "X"] } } }
    const topo = validate(spec)
    expect(topo.inDegree["Y"]).toBe(1)
    expect(topo.deps["Y"]).toEqual(["X"])
  })

  it("rejects a cycle", () => {
    const spec: DAGSpec = { nodes: { A: { id: "A", agent: { name: "a" }, dependsOn: ["B"] }, B: { id: "B", agent: { name: "b" }, dependsOn: ["A"] } } }
    expect(() => validate(spec)).toThrow(DAGError)
  })

  it("rejects unknown and self dependencies", () => {
    expect(() => validate({ nodes: { A: { id: "A", agent: { name: "a" }, dependsOn: ["ghost"] } } })).toThrow(DAGError)
    expect(() => validate({ nodes: { A: { id: "A", agent: { name: "a" }, dependsOn: ["A"] } } })).toThrow(DAGError)
  })

  it("rejects duplicate produces slot ids (no silent last-writer-wins)", () => {
    const spec: DAGSpec = {
      nodes: {
        A: { id: "A", agent: { name: "a" }, produces: "shared" },
        B: { id: "B", agent: { name: "b" }, produces: "shared" },
      },
    }
    expect(() => validate(spec)).toThrow(DAGError)
    // Two nodes may NOT declare the same slot, but a node may default its slot
    // to its own id (produces undefined) — that is always unique.
    const ok: DAGSpec = { nodes: { A: { id: "A", agent: { name: "a" } }, B: { id: "B", agent: { name: "b" }, dependsOn: ["A"] } } }
    expect(validate(ok)).toBeDefined()
  })

  it("rejects an entry id that does not exist", () => {
    expect(() => validate({ nodes: { A: { id: "A", agent: { name: "a" } } }, entry: ["ghost"] })).toThrow(DAGError)
  })

  it("rejects an entry that has dependencies (it would never be dispatched)", () => {
    const spec: DAGSpec = { nodes: { A: { id: "A", agent: { name: "a" } }, B: { id: "B", agent: { name: "b" }, dependsOn: ["A"] } }, entry: ["B"] }
    expect(() => validate(spec)).toThrow(DAGError)
  })

  it("with no entry, every in-degree-0 root and its dependents are active", () => {
    const topo = validate(diamond)
    expect([...topo.active].sort()).toEqual(["A", "B", "C", "D"])
  })

  it("honors entry: only the entry root and its transitive dependents are active", () => {
    const spec: DAGSpec = {
      nodes: {
        A: { id: "A", agent: { name: "a" } },
        B: { id: "B", agent: { name: "b" }, dependsOn: ["A"] },
        C: { id: "C", agent: { name: "c" } },
      },
      entry: ["A"],
    }
    const topo = validate(spec)
    // C is an in-degree-0 root but sits on no path from A, so it is inert.
    expect([...topo.active].sort()).toEqual(["A", "B"])
  })
})

describe("foldDAG", () => {
  it("reconstructs status + results from events", () => {
    const events = [
      ev("DAG.Declared", { spec: diamond }, 0),
      ev("DAG.NodeStarted", { nodeId: "A", sessionId: "sA" }, 1),
      ev("DAG.NodeResolved", { nodeId: "A", slotId: "A", sessionId: "sA", outputRef: "refA" }, 2),
      ev("DAG.NodeFailed", { nodeId: "B", reason: "boom" }, 3),
    ]
    const d = foldDAG(events)
    expect(d.status["A"]).toBe("succeeded")
    expect(d.status["B"]).toBe("failed")
    expect(d.results["A"]?.outputRef).toBe("refA")
    expect(d.aborted).toBe(false)
  })

  it("handles retry as failed -> pending", () => {
    const d = foldDAG([
      ev("DAG.NodeFailed", { nodeId: "B", reason: "boom" }, 1),
      ev("DAG.NodeRetried", { nodeId: "B", attempt: 1 }, 2),
    ])
    expect(d.status["B"]).toBe("pending")
    expect(d.attempts["B"]).toBe(1)
  })
})

describe("cascadeTerminal", () => {
  it("a node whose dep is non-succeeded is cascade terminal (not dispatched)", () => {
    const topo = validate(diamond)
    const status: Record<string, ReturnType<typeof foldDAG>["status"][string]> = { A: "pending", B: "pending", C: "pending", D: "pending" }
    status["A"] = "failed"
    const next = cascadeTerminal(topo, status as never)
    // B/C depend on A (failed) -> cascade skipped; D depends on B/C (both skipped) -> cascade skipped.
    expect(next["B"]).toBe("skipped")
    expect(next["C"]).toBe("skipped")
    expect(next["D"]).toBe("skipped")
    // A itself stays failed (its own terminal state, not cascade-produced).
    expect(next["A"]).toBe("failed")
  })

  it("leaves nodes ready when all deps are settled successfully", () => {
    const topo = validate(diamond)
    const status = { A: "succeeded", B: "pending", C: "pending", D: "pending" }
    const ready = readyNodes(topo, status as never, (id) => status[id as keyof typeof status] === "succeeded")
    expect(ready).toEqual(["B", "C"])
  })
})
