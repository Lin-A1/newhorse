import { describe, expect, test } from "bun:test"
import type { EventScheduledEventDue } from "@newhorse/sdk/v2"
import { base64Encode } from "@newhorse/core/util/encode"
import { reminderDeliveryKey, reminderNotification } from "./notification"

const event = (sessionID?: string): EventScheduledEventDue => ({
  id: "evt_reminder",
  type: "scheduled-event.due",
  properties: {
    id: "sch_reminder",
    profileID: "assistant",
    ...(sessionID ? { sessionID } : {}),
    eventType: "reminder",
    title: "Drink water",
    body: "Take a water break",
    scheduleAt: 123,
    occurrenceAt: 123,
    deliveryKey: "sch_reminder:123",
    attemptCount: 1,
  },
})

describe("reminder notifications", () => {
  test("builds a session notification and deep link", () => {
    const result = reminderNotification("/workspace", event("ses_test"), 456)

    expect(result.notification).toEqual({
      directory: "/workspace",
      session: "ses_test",
      time: 456,
      viewed: false,
      type: "reminder",
      title: "Drink water",
      body: "Take a water break",
      metadata: {
        id: "sch_reminder",
        eventType: "reminder",
        deliveryKey: "sch_reminder:123",
        occurrenceAt: 123,
      },
    })
    expect(result.href).toBe(`/${base64Encode("/workspace")}/session/ses_test`)
  })

  test("links workspace reminders without a session to the project", () => {
    expect(reminderNotification("/workspace", event()).href).toBe(`/${base64Encode("/workspace")}`)
  })

  test("recovers the stable delivery identity from persisted notification metadata", () => {
    const { notification } = reminderNotification("/workspace", event())
    expect(reminderDeliveryKey(notification)).toBe("sch_reminder:123")
    expect(reminderDeliveryKey({ ...notification, metadata: undefined })).toBeUndefined()
  })
})
