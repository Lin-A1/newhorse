import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@newhorse/core/v1/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@newhorse/core/provider"
import { ModelV2 } from "@newhorse/core/model"

const sessionID = SessionID.make("session")
const providerID = ProviderV2.ID.make("test")

function userInfo(id: string): SessionV1.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelV2.ID.make("test") },
    tools: {},
    mode: "",
  } as unknown as SessionV1.User
}

function assistantInfo(id: string, parentID: string): SessionV1.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: "test",
    providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as SessionV1.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

function text(msg: SessionV1.User | SessionV1.Assistant, text: string): SessionV1.WithParts {
  return {
    info: msg,
    parts: [
      {
        ...basePart(msg.id, "p1"),
        type: "text",
        text,
      },
    ] as SessionV1.Part[],
  }
}

function ids(msgs: SessionV1.WithParts[]) {
  return msgs.map((m) => String(m.info.id))
}

describe("session.message-v2.filterCompacted", () => {
  // stream() returns newest-first, so build the sequence newest -> oldest.
  function realisticSequence() {
    const head1 = text(userInfo("msg_head1"), "head prompt 1")
    const head2 = text(assistantInfo("msg_head2", "msg_head1"), "head reply 1")
    const head3 = text(userInfo("msg_head3"), "head prompt 2")
    const head4 = text(assistantInfo("msg_head4", "msg_head3"), "head reply 2")

    const tail1 = text(userInfo("msg_tail1"), "recent prompt 1")
    const tail2 = text(assistantInfo("msg_tail2", "msg_tail1"), "recent reply 1")

    const compactionUser: SessionV1.WithParts = {
      info: userInfo("msg_compact"),
      parts: [
        {
          ...basePart("msg_compact", "p1"),
          type: "compaction",
          auto: true,
          tail_start_id: MessageID.make("msg_tail1"),
          compactedCount: 2,
          compactedTokens: 1000,
        },
      ] as SessionV1.Part[],
    }

    const summaryAssistant: SessionV1.WithParts = {
      info: {
        ...assistantInfo("msg_summary", "msg_compact"),
        summary: true,
        finish: "stop",
      } as SessionV1.Assistant,
      parts: [
        {
          ...basePart("msg_summary", "p1"),
          type: "text",
          text: "Summary of the compacted head.",
        },
      ] as SessionV1.Part[],
    }

    const newUser = text(userInfo("msg_new"), "follow-up prompt")
    const newAssistant = text(assistantInfo("msg_new2", "msg_new"), "follow-up reply")

    // stream() orders newest first; chronological order is the mirror.
    return {
      newestFirst: [newAssistant, newUser, summaryAssistant, compactionUser, tail2, tail1, head4, head3, head2, head1],
    }
  }

  test("excludes compacted head turns, keeps compaction-user, summary and tail", () => {
    const { newestFirst } = realisticSequence()
    const filtered = MessageV2.filterCompacted(newestFirst)
    const result = ids(filtered)

    expect(result).not.toContain("msg_head1")
    expect(result).not.toContain("msg_head2")
    expect(result).not.toContain("msg_head3")
    expect(result).not.toContain("msg_head4")
    expect(result).toContain("msg_compact")
    expect(result).toContain("msg_summary")
    expect(result).toContain("msg_tail1")
    expect(result).toContain("msg_tail2")
    expect(result).toContain("msg_new")
    expect(result).toContain("msg_new2")
  })

  test("output order is [compaction-user, summary, tail..., continue...]", () => {
    const { newestFirst } = realisticSequence()
    const filtered = MessageV2.filterCompacted(newestFirst)
    const result = ids(filtered)

    expect(String(result[0])).toBe("msg_compact")
    expect(String(result[1])).toBe("msg_summary")
    expect(result.slice(2)).toEqual(["msg_tail1", "msg_tail2", "msg_new", "msg_new2"])
  })

  test("handles a compaction with no retained tail", () => {
    const head1 = text(userInfo("msg_head1"), "head prompt 1")
    const head2 = text(assistantInfo("msg_head2", "msg_head1"), "head reply 1")

    const compactionUser: SessionV1.WithParts = {
      info: userInfo("msg_compact"),
      parts: [
        {
          ...basePart("msg_compact", "p1"),
          type: "compaction",
          auto: true,
          compactedCount: 1,
          compactedTokens: 500,
        },
      ] as SessionV1.Part[],
    }

    const summaryAssistant: SessionV1.WithParts = {
      info: {
        ...assistantInfo("msg_summary", "msg_compact"),
        summary: true,
        finish: "stop",
      } as SessionV1.Assistant,
      parts: [],
    }

    const newUser = text(userInfo("msg_new"), "follow-up prompt")

    const filtered = MessageV2.filterCompacted([newUser, summaryAssistant, compactionUser, head2, head1])
    const result = ids(filtered)

    expect(result).not.toContain("msg_head1")
    expect(result).not.toContain("msg_head2")
    expect(result).toEqual(["msg_compact", "msg_summary", "msg_new"])
  })

  test("no compaction leaves the message list untouched", () => {
    const msgs = [text(assistantInfo("msg_a2", "msg_a1"), "reply"), text(userInfo("msg_a1"), "hello")]
    const filtered = MessageV2.filterCompacted(msgs)
    expect(ids(filtered)).toEqual(["msg_a1", "msg_a2"])
  })
})
