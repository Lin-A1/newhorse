import { describe, expect, it } from "bun:test"
import { Container, SeamError, createSeam, defineService } from "./seam"

describe("seam container", () => {
  it("registers a provider and reads it back", () => {
    const c = new Container()
    const logger = createSeam<{ log: (m: string) => void }>("logger")
    const disposer = c.register(logger.definition, { log: (m) => m })
    expect(c.get(logger.definition).log).toBeTypeOf("function")
    disposer()
  })

  it("disposer un-registers and re-registration is allowed", () => {
    const c = new Container()
    const s = createSeam<number>("count")
    const d1 = c.register(s.definition, 1)
    expect(c.get(s.definition)).toBe(1)
    d1()
    // after dispose, re-register succeeds
    const d2 = c.register(s.definition, 2)
    expect(c.get(s.definition)).toBe(2)
    d2()
  })

  it("throws on duplicate registration", () => {
    const c = new Container()
    const s = createSeam<number>("n")
    c.register(s.definition, 1)
    expect(() => c.register(s.definition, 2)).toThrow(SeamError)
  })

  it("throws when reading an unregistered service", () => {
    const c = new Container()
    const s = createSeam<number>("missing")
    expect(() => c.get(s.definition)).toThrow(SeamError)
  })

  it("consumer inject resolves declared deps", () => {
    const c = new Container()
    const a = createSeam<{ x: number }>("a")
    const b = createSeam<{ x: number }>("b")
    const { definition: aDef } = a
    const { definition: bDef } = b
    const consumer = a.consumer({ a: aDef, b: bDef })
    c.register(aDef, { x: 1 })
    c.register(bDef, { x: 2 })
    const deps = consumer.inject(c)
    expect(deps.a.x).toBe(1)
    expect(deps.b.x).toBe(2)
  })

  it("same displayName yields an interoperable service id across call sites", () => {
    // Simulates a provider and a consumer in different packages: both call
    // defineService("logger") and must agree on the same registry key.
    const c = new Container()
    const provider = defineService<{ log: (m: string) => void }>("logger")
    const consumer = defineService<{ log: (m: string) => void }>("logger")
    c.register(provider, { log: (m) => m })
    expect(c.get(consumer).log).toBeTypeOf("function")
  })

  it("distinguishes a registered undefined value from an absent service", () => {
    const c = new Container()
    const s = defineService<void>("void-svc")
    c.register(s, undefined)
    expect(c.has(s)).toBe(true)
    expect(c.get(s)).toBeUndefined()
  })

  it("dispose tears down cleanup in reverse registration order", () => {
    const c = new Container()
    const order: number[] = []
    const s1 = defineService<void>("parent")
    const s2 = defineService<void>("child")
    c.register(s1, undefined, () => order.push(1))
    c.register(s2, undefined, () => order.push(2))
    c.dispose()
    expect(order).toEqual([2, 1])
    expect(() => c.get(s1)).toThrow(SeamError)
    expect(() => c.get(s2)).toThrow(SeamError)
  })

  it("a child scope inherits the parent's providers for lookup", () => {
    const parent = new Container()
    const llm = createSeam<string>("llm")
    parent.register(llm.definition, "shared")
    const child = parent.scope()
    // child sees the parent-registered service
    expect(child.get(llm.definition)).toBe("shared")
    expect(child.has(llm.definition)).toBe(true)
  })

  it("a child can shadow a parent registration without affecting the parent", () => {
    const parent = new Container()
    const model = createSeam<string>("model")
    parent.register(model.definition, "expensive")
    const child = parent.scope()
    child.register(model.definition, "cheap")

    expect(child.get(model.definition)).toBe("cheap")
    expect(parent.get(model.definition)).toBe("expensive")
  })

  it("disposing a child tears down only its own registrations, leaving the parent intact", () => {
    const parent = new Container()
    const s = createSeam<string>("s")
    parent.register(s.definition, "parent-val")

    const child = parent.scope()
    child.register(s.definition, "child-val")
    child.dispose()

    // child's own registration is gone; lookup now falls back to the parent
    expect(child.get(s.definition)).toBe("parent-val")
    expect(parent.get(s.definition)).toBe("parent-val")
  })

  it("nested scopes resolve up the chain and dispose leaf-first", () => {
    const root = new Container()
    const tool = createSeam<string>("tool")
    root.register(tool.definition, "root-tool")

    const location = root.scope()
    const node = location.scope()
    // no override -> resolves to root value
    expect(node.get(tool.definition)).toBe("root-tool")

    // a node-level override shadows all ancestors inside the node
    const order: string[] = []
    const meta = createSeam<string>("meta")
    const disposeNode = node.register(meta.definition, "node-meta", () => order.push("node"))
    const disposeLoc = location.register(meta.definition, "loc-meta", () => order.push("loc"))
    expect(node.get(meta.definition)).toBe("node-meta")

    // disconnecting the leaf only unregisters the node's own entry
    disposeNode()
    expect(node.get(meta.definition)).toBe("loc-meta")
    disposeLoc()
    expect(() => node.get(meta.definition)).toThrow()
    expect(order).toEqual(["node", "loc"])
  })
})
