import { describe, expect, test } from "bun:test"
import { relevantRecall, significantRecallTerms } from "../../src/session/prompt"

// Live regression fixture: the exact block that was injected into a work
// session as "relevant memories". Only the first two entries are actually
// about the memory-injection fix the query was discussing; the last three
// merely share the "newhorse project" topic and must be filtered out.
const INJECTED_BLOCK = [
  "In the newhorse memory-injection fix, the assistant implemented a significance-keyword (显著性词项) threshold in the FTS memory recall path so that only memories sharing substantive terms with the current query are considered, filtering out project-level generic-word matches, and was running verification.",
  "In the newhorse project, the assistant found the root cause of the memory-injection issue: work sessions used a recency fallback that treated trailing user messages as context, causing irrelevant memories to be injected; the fix removes the recency fallback for work sessions, and the assistant is updating tests that depend on the old behavior and adding regression tests.",
  "In the newhorse project, task-list items should be cleared once their execution is complete.",
  "In the newhorse project, the user wants the full context and system-prompt assembly path audited because conversations frequently contain strange text that may indicate context contamination.",
  "In the newhorse project, the user wants browser `auth_token` persistence investigated and fixed so browser sessions retain authentication.",
]

describe("recall relevance gate", () => {
  test("only injects memories sharing a significant term with the query", () => {
    // A query about the memory-injection fix (recency fallback, FTS recall).
    const query =
      "In the newhorse memory-injection fix, the assistant implemented a significance-keyword threshold in the FTS memory recall path so only memories sharing substantive terms with the current query are considered."
    const terms = significantRecallTerms(query)
    expect(terms.length).toBeGreaterThan(0)
    expect(terms).toContain("memory")
    expect(terms).toContain("memory-injection")
    expect(terms).toContain("threshold")

    const relevant = INJECTED_BLOCK.filter((content) => relevantRecall(content, terms))
    // Entries 0 and 1 genuinely mention the injection fix; 2–4 are unrelated
    // project-level memories and must not leak into the prompt.
    expect(relevant).toContain(INJECTED_BLOCK[0])
    expect(relevant).toContain(INJECTED_BLOCK[1])
    expect(relevant).not.toContain(INJECTED_BLOCK[2])
    expect(relevant).not.toContain(INJECTED_BLOCK[3])
    expect(relevant).not.toContain(INJECTED_BLOCK[4])
  })

  test("the live injected block reduces to only the genuinely related entries", () => {
    // The exact 5-memory block that was injected into this session's prompt.
    // Only entries 0 and 1 are about the memory-injection fix being discussed.
    const query =
      "the assistant implemented a significance-keyword threshold in the FTS memory recall path filtering out project-level generic-word matches and was running verification"
    const terms = significantRecallTerms(query)
    const relevant = INJECTED_BLOCK.filter((content) => relevantRecall(content, terms))
    expect(relevant).toEqual([INJECTED_BLOCK[0], INJECTED_BLOCK[1]])
  })

  test("a generic greeting query yields no significant terms", () => {
    const terms = significantRecallTerms("hello")
    expect(terms).toEqual([])
  })

  test("stopwords and short fragments do not count as significant terms", () => {
    const terms = significantRecallTerms("the project user work fix test newhorse session sessions issue")
    expect(terms).toEqual([])
  })

  test("CJK queries produce 3..6 char windows", () => {
    const terms = significantRecallTerms("记忆注入修复")
    expect(terms).toContain("记忆注")
    expect(terms).toContain("记忆注入")
    expect(terms).toContain("注入修复")
  })
})
