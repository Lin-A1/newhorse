import { describe, expect, test } from "bun:test"
import type { EventScheduledEventDue } from "@newhorse/sdk/v2/client"
import { createDeliveryDeduper, reminderToast } from "../../../src/ui/toast"

const event: EventScheduledEventDue = {
  id: "evt_reminder",
  type: "scheduled-event.due",
  properties: {
    id: "sch_reminder",
    workspaceID: "wrk_one",
    profileID: "assistant",
    eventType: "reminder",
    title: "Stand up",
    body: "Take a short movement break",
    scheduleAt: 123,
    occurrenceAt: 123,
    deliveryKey: "sch_reminder:123",
    attemptCount: 1,
  },
}

describe("reminder toast", () => {
  test("renders due reminders for the current workspace", () => {
    expect(reminderToast(event, "wrk_one", "wrk_one")).toEqual({
      title: "Stand up",
      message: "Take a short movement break",
      variant: "info",
      duration: 8000,
    })
  })

  test("ignores reminders routed to another workspace", () => {
    expect(reminderToast(event, "wrk_two", "wrk_one")).toBeUndefined()
  })

  test("deduplicates delivery keys with bounded FIFO retention", () => {
    const changes: string[][] = []
    const accept = createDeliveryDeduper({ limit: 2, initial: ["persisted"], onChange: (keys) => changes.push(keys) })
    expect(accept("persisted")).toBe(false)
    expect(accept("one")).toBe(true)
    expect(accept("one")).toBe(false)
    expect(accept("two")).toBe(true)
    expect(accept("three")).toBe(true)
    expect(accept("one")).toBe(true)
    expect(changes.at(-1)).toEqual(["three", "one"])
  })
})
