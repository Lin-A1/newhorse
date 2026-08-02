import { describe, expect, test } from "bun:test"
import { TrustPolicy } from "@/trust-policy"

describe("TrustPolicy", () => {
  test("allows same-scope content flow and capability explanations", () => {
    expect(TrustPolicy.decideContentFlow({ action: "memory.retrieve", source: "project", destination: "project" })).toEqual({
      decision: "allow",
      reason: "same_scope",
    })
    expect(TrustPolicy.decideContentFlow({ action: "capability.explain", source: "personal", destination: "project" })).toEqual({
      decision: "allow",
      reason: "workspace_policy",
    })
  })

  test("restricts user-global memory to preferences", () => {
    expect(
      TrustPolicy.decideContentFlow({
        action: "memory.save",
        source: "project",
        destination: "user_global",
        kind: "preference",
      }),
    ).toEqual({ decision: "allow", reason: "user_global_preference_only" })
    expect(
      TrustPolicy.decideContentFlow({
        action: "memory.save",
        source: "project",
        destination: "user_global",
        kind: "fact",
      }),
    ).toEqual({ decision: "deny", reason: "user_global_preference_only" })
  })

  test("requires grants for project and personal crossing", () => {
    expect(
      TrustPolicy.decideContentFlow({ action: "continuity.propose", source: "project", destination: "personal" }),
    ).toEqual({ decision: "ask", reason: "project_to_personal_requires_grant" })
    expect(
      TrustPolicy.decideContentFlow({ action: "continuity.propose", source: "personal", destination: "project" }),
    ).toEqual({ decision: "ask", reason: "personal_to_project_requires_grant" })
  })

  test("keeps relationship memory in personal scope", () => {
    expect(
      TrustPolicy.decideContentFlow({ action: "memory.retrieve", source: "relationship", destination: "personal" }),
    ).toEqual({ decision: "allow", reason: "relationship_personal_only" })
    expect(
      TrustPolicy.decideContentFlow({ action: "memory.retrieve", source: "relationship", destination: "project" }),
    ).toEqual({ decision: "deny", reason: "relationship_personal_only" })
  })

  test("requires personal opt-in before extension loading in personal scope", () => {
    expect(
      TrustPolicy.decideContentFlow({ action: "extension.load", source: "project", destination: "personal" }),
    ).toEqual({ decision: "deny", reason: "extension_personal_opt_in_required" })
    expect(
      TrustPolicy.decideContentFlow({
        action: "extension.load",
        source: "project",
        destination: "personal",
        personalOptIn: true,
      }),
    ).toEqual({ decision: "allow", reason: "same_scope" })
  })
})
