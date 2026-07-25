export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@newhorse/schema/event"
import { EventManifest } from "@newhorse/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
