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

  test("applies opt-in gating to tool load and MCP connect, not just extensions", () => {
    expect(TrustPolicy.decideContentFlow({ action: "tool.load", source: "personal", destination: "personal" })).toEqual({
      decision: "deny",
      reason: "extension_personal_opt_in_required",
    })
    expect(
      TrustPolicy.decideContentFlow({ action: "mcp.connect", source: "project", destination: "personal", personalOptIn: true }),
    ).toEqual({ decision: "allow", reason: "same_scope" })
    expect(
      TrustPolicy.decideContentFlow({ action: "mcp.connect", source: "project", destination: "project", personalOptIn: true }),
    ).toEqual({ decision: "allow", reason: "same_scope" })
  })

  test("applies opt-in gating to skill loading in personal scope", () => {
    expect(TrustPolicy.decideContentFlow({ action: "skill.load", source: "personal", destination: "personal" })).toEqual({
      decision: "deny",
      reason: "extension_personal_opt_in_required",
    })
    expect(
      TrustPolicy.decideContentFlow({ action: "skill.load", source: "personal", destination: "personal", personalOptIn: true }),
    ).toEqual({ decision: "allow", reason: "same_scope" })
    expect(
      TrustPolicy.decideContentFlow({ action: "skill.load", source: "project", destination: "project" }),
    ).toEqual({ decision: "allow", reason: "same_scope" })
  })

  test("denies reminder and skill flows that cross into relationship scope", () => {
    expect(
      TrustPolicy.decideContentFlow({ action: "reminder.deliver", source: "personal", destination: "relationship" }),
    ).toEqual({ decision: "allow", reason: "relationship_personal_only" })
    expect(
      TrustPolicy.decideContentFlow({ action: "skill.load", source: "project", destination: "relationship" }),
    ).toEqual({ decision: "deny", reason: "relationship_personal_only" })
  })

  test("user configuration can only tighten, never relax, a platform decision", () => {
    expect(TrustPolicy.applyUserPolicy("allow", undefined)).toBe("allow")
    expect(TrustPolicy.applyUserPolicy("allow", "ask")).toBe("ask")
    expect(TrustPolicy.applyUserPolicy("allow", "deny")).toBe("deny")
    expect(TrustPolicy.applyUserPolicy("ask", "deny")).toBe("deny")
    expect(TrustPolicy.applyUserPolicy("deny", "allow")).toBe("deny")
    expect(TrustPolicy.applyUserPolicy("deny", "ask")).toBe("deny")
    expect(TrustPolicy.applyUserPolicy("deny", undefined)).toBe("deny")
  })

  test("audit records are content-free and carry minimal opaque identifiers", () => {
    const event = TrustPolicy.auditDecision({
      id: "pol_audit_1",
      time: 1000,
      action: "memory.save",
      source: "project",
      destination: "user_global",
      decision: "deny",
      reason: "user_global_preference_only",
      actor: "ses_opaque",
    })
    expect(event).toEqual({
      id: "pol_audit_1",
      time: 1000,
      action: "memory.save",
      source: "project",
      destination: "user_global",
      decision: "deny",
      reason: "user_global_preference_only",
      actor: "ses_opaque",
    })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain("content")
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("summary")
    expect(serialized).not.toContain("purpose")
    expect(serialized).not.toContain("token")
  })
})
