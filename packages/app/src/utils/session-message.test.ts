import { describe, expect, test } from "bun:test"
import type { Message } from "@newhorse/sdk/v2/client"
import { compareMessages, messageKey } from "./session-message"

const message = (id: string, created: number) => ({ id, time: { created } }) as Pick<Message, "id" | "time">

describe("session-message", () => {
  test("messageKey orders by creation time first, then ID", () => {
    expect(messageKey(message("msg_z", 100))).toBe("100msg_z")
    expect(messageKey(message("msg_a", 200))).toBe("200msg_a")
  })

  test("compareMessages sorts by creation time", () => {
    const older = message("msg_z", 100)
    const newer = message("msg_a", 200)
    expect(compareMessages(older, newer)).toBeLessThan(0)
    expect(compareMessages(newer, older)).toBeGreaterThan(0)
    expect(compareMessages(older, older)).toBe(0)
  })

  test("IDs break equal-time ties deterministically", () => {
    const lower = message("msg_a", 100)
    const higher = message("msg_z", 100)
    expect(compareMessages(lower, higher)).toBeLessThan(0)
    expect(compareMessages(higher, lower)).toBeGreaterThan(0)
  })
})
