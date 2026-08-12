// Lightweight, dependency-free entity extraction for memory content.
//
// Ported conceptually from mem0's entity extraction heuristics
// (mem0/utils/entity_extraction.py, Apache-2.0) — same *idea* (proper nouns,
// quoted phrases, technical identifiers, compound-noun topics), but re-implemented
// in TypeScript with regex/word-form heuristics only. No NLP model, no spaCy:
// the v1 memory system must not pull a model dependency for search ranking.
//
// Entities are stored per memory row (memory_entity) and used as a ranking
// boost: memories whose stored entities match query entities rank above raw
// keyword matches. Precision over recall — the primary ranking signal is still
// FTS5/BM25; entities only break ties.

export type MemoryEntityType = "PROPER" | "QUOTED" | "IDENTIFIER" | "TOPIC"

export interface MemoryEntityCandidate {
  text: string
  type: MemoryEntityType
  normalized: string
}

/** Collapse whitespace and lowercase — the key used for exact entity matching. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

// Common capitalized words that are not entities (sentence starters, function
// words, pronouns, days/months). Mirrors mem0's _GENERIC_SINGLE_ENTITY_TERMS +
// sentence-start heuristic without a tokenizer.
const GENERIC_CAPITALIZED = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "how",
  "why",
  "and",
  "but",
  "or",
  "nor",
  "for",
  "with",
  "without",
  "from",
  "into",
  "onto",
  "upon",
  "through",
  "across",
  "within",
  "between",
  "before",
  "after",
  "while",
  "since",
  "until",
  "during",
  "because",
  "although",
  "though",
  "if",
  "unless",
  "then",
  "than",
  "so",
  "such",
  "as",
  "at",
  "by",
  "in",
  "of",
  "on",
  "to",
  "up",
  "down",
  "off",
  "out",
  "over",
  "under",
  "again",
  "further",
  "once",
  "here",
  "there",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "user",
  "users",
  "assistant",
  "companion",
  "agent",
  "memory",
  "memories",
  "message",
  "session",
  "system",
  "please",
  "thanks",
  "thank",
  "you",
  "your",
  "yours",
  "i",
  "we",
  "our",
  "us",
  "they",
  "their",
  "them",
  "he",
  "she",
  "it",
  "its",
  "his",
  "her",
  "him",
  "me",
  "my",
  "mine",
  "yes",
  "no",
  "not",
  "never",
  "always",
  "just",
  "really",
  "actually",
  "maybe",
  "perhaps",
  "probably",
  "today",
  "tomorrow",
  "yesterday",
  "now",
  "then",
  "next",
  "last",
  "first",
  "second",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "spring",
  "summer",
  "autumn",
  "winter",
  "prefers",
  "likes",
  "loves",
  "enjoys",
  "uses",
  "wants",
  "needs",
  "works",
  "plans",
  "writes",
  "builds",
  "learns",
  "reads",
  "plays",
  "thinks",
  "feels",
  "tries",
  "gets",
  "makes",
  "takes",
  "prefer",
  "like",
  "love",
  "enjoy",
  "use",
  "want",
  "need",
  "work",
  "plan",
  "write",
  "build",
  "learn",
  "read",
  "play",
  "think",
  "feel",
  "try",
  "get",
  "make",
  "take",
])

// Common verbs that should never anchor a topic phrase ("prefers dark mode",
// "uses GitHub").
const TOPIC_VERBS = new Set([
  "prefer",
  "prefers",
  "preferred",
  "like",
  "likes",
  "liked",
  "love",
  "loves",
  "loved",
  "enjoy",
  "enjoys",
  "enjoyed",
  "use",
  "uses",
  "used",
  "using",
  "want",
  "wants",
  "wanted",
  "need",
  "needs",
  "needed",
  "have",
  "has",
  "had",
  "get",
  "gets",
  "got",
  "make",
  "makes",
  "made",
  "work",
  "works",
  "worked",
  "working",
  "plan",
  "plans",
  "planned",
  "go",
  "goes",
  "going",
  "went",
  "come",
  "comes",
  "coming",
  "take",
  "takes",
  "took",
  "talk",
  "talks",
  "talking",
  "feel",
  "feels",
  "think",
  "thinks",
  "say",
  "says",
  "said",
  "write",
  "writes",
  "wrote",
  "build",
  "builds",
  "built",
  "learn",
  "learns",
  "learned",
  "try",
  "tries",
  "tried",
  "play",
  "plays",
  "played",
  "read",
  "reads",
  "call",
  "calls",
  "called",
  "run",
  "runs",
  "running",
  "develop",
  "develops",
  "developed",
  "create",
  "creates",
  "created",
  "set",
  "sets",
  "put",
  "puts",
  "prefer",
])

// Words too generic to anchor a compound-noun topic phrase.
const GENERIC_TOPIC_WORDS = new Set([
  "thing",
  "things",
  "stuff",
  "way",
  "ways",
  "time",
  "times",
  "experience",
  "situation",
  "case",
  "fact",
  "matter",
  "issue",
  "idea",
  "thought",
  "feeling",
  "place",
  "area",
  "part",
  "kind",
  "type",
  "sort",
  "lot",
  "bit",
  "day",
  "year",
  "week",
  "month",
  "moment",
  "instance",
  "example",
  "technique",
  "method",
  "approach",
  "process",
  "step",
  "tool",
  "result",
  "outcome",
  "goal",
  "task",
  "item",
  "topic",
  "work",
  "works",
  "job",
  "info",
  "information",
  "details",
  "data",
  "content",
  "material",
  "activities",
  "activity",
  "effort",
  "efforts",
  "option",
  "options",
  "choice",
  "choices",
  "results",
  "output",
  "product",
  "products",
])

// Function words that never join a topic phrase.
const FUNCTION_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "so",
  "for",
  "with",
  "without",
  "from",
  "into",
  "onto",
  "through",
  "across",
  "within",
  "between",
  "before",
  "after",
  "while",
  "since",
  "until",
  "during",
  "because",
  "although",
  "though",
  "unless",
  "at",
  "by",
  "in",
  "of",
  "on",
  "to",
  "up",
  "down",
  "off",
  "out",
  "over",
  "under",
  "again",
  "once",
  "here",
  "there",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "can",
  "may",
  "might",
  "must",
  "shall",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "not",
  "no",
  "yes",
  "also",
  "too",
  "very",
  "much",
  "many",
  "about",
  "around",
  "like",
  "just",
  "really",
  "now",
])

const MAX_ENTITIES = 12
const MAX_TOPICS = 4

function cleanTerm(raw: string): string | undefined {
  let cleaned = raw.trim().replace(/^[^\p{L}\p{N}_#@/\\]+/u, "").replace(/[^\p{L}\p{N}_)\]]+$/u, "")
  if (cleaned.length < 2 || cleaned.length > 80) return undefined
  return cleaned
}

export function extractEntities(text: string): MemoryEntityCandidate[] {
  const seen = new Map<string, MemoryEntityCandidate>()
  const topics: MemoryEntityCandidate[] = []

  const add = (type: MemoryEntityType, raw: string): boolean => {
    const cleaned = cleanTerm(raw)
    if (!cleaned) return false
    const normalized = normalize(cleaned)
    if (seen.has(normalized) || (type === "TOPIC" && topics.some((topic) => topic.normalized === normalized))) {
      return false
    }
    if (seen.size + topics.length >= MAX_ENTITIES) return false
    const candidate: MemoryEntityCandidate = { text: cleaned, type, normalized }
    if (type === "TOPIC") topics.push(candidate)
    else seen.set(normalized, candidate)
    return true
  }

  // --- IDENTIFIER: dotted paths/namespaces, /-separated paths, camelCase,
  // snake_case. Each requires a structural hint (dot, slash, underscore, or
  // internal capital) so ordinary prose never matches.
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g)) {
    add("IDENTIFIER", m[0])
  }
  for (const m of text.matchAll(/\b(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+\b/g)) {
    // /-separated path, e.g. packages/core/src/memory/index.ts
    if (m[0].includes("//")) continue
    add("IDENTIFIER", m[0])
  }
  for (const m of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*_(?:[A-Za-z0-9]+_)*[A-Za-z0-9]+\b/g)) {
    if (m[0].length >= 3) add("IDENTIFIER", m[0])
  }
  for (const m of text.matchAll(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9_]*\b/g)) {
    if (m[0].length >= 4) add("IDENTIFIER", m[0])
  }

  // --- QUOTED: text in single/double/CJK quotes (titles, exact terms).
  for (const m of text.matchAll(/["“]([^"”]{2,80})["”]/g)) add("QUOTED", m[1])
  for (const m of text.matchAll(/['‘]([^'’]{2,80})['’]/g)) add("QUOTED", m[1])

  // --- PROPER:
  //  1. camelCase capitalized tokens are strong brand/product names (GitHub,
  //     PostgreSQL, TypeScript, OpenAI) — no sentence-start ambiguity.
  for (const m of text.matchAll(/\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/g)) {
    if (GENERIC_CAPITALIZED.has(m[0].toLowerCase())) continue
    add("PROPER", m[0])
  }
  //  2. Multi-word capitalized spans (person/place/brand names). Requires two
  //     or more capitalized tokens in a row; drop whole span if it is all
  //     generic (e.g. "The Quick").
  for (const m of text.matchAll(/\b(?:[A-Z][A-Za-z0-9]+\s+){1,3}[A-Z][A-Za-z0-9]+\b/g)) {
    const words = m[0].split(/\s+/)
    if (words.some((w) => GENERIC_CAPITALIZED.has(w.toLowerCase()))) continue
    add("PROPER", m[0])
  }
  //  3. Single capitalized words that are not sentence-openers, not generic,
  //     and not the tail of a longer captured proper noun (drop "Actions"
  //     when "GitHub Actions" is already captured).
  for (const m of text.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    if (GENERIC_CAPITALIZED.has(m[0].toLowerCase())) continue
    const prev = text[m.index! - 1] ?? ""
    if (prev === "" || /[.!?，。！？；\n]/.test(prev)) continue
    const normalized = normalize(m[0])
    const redundant = [...seen.values()].some(
      (c) => c.type === "PROPER" && c.normalized.length > normalized.length && c.normalized.endsWith(` ${normalized}`),
    )
    if (redundant) continue
    add("PROPER", m[0])
  }

  // --- TOPIC: compound-noun phrases. Slide a 2-3 word window over lowercase
  // words and keep windows free of function words, generic heads, verbs, and
  // words already captured as entities (e.g. "dark mode", "hiking trip",
  // "coffee preferences").
  const seenWords = new Set(
    [...seen.values()].flatMap((c) => c.normalized.split(/\s+/)),
  )
  const words = text.toLowerCase().match(/[a-z]{3,}/g) ?? []
  for (let index = 0; index < words.length && topics.length < MAX_TOPICS; index++) {
    for (let length = 2; length <= 3 && index + length <= words.length; length++) {
      const phrase = words.slice(index, index + length).join(" ")
      if (
        phrase
          .split(/\s+/)
          .some(
            (w) =>
              FUNCTION_WORDS.has(w) ||
              GENERIC_TOPIC_WORDS.has(w) ||
              TOPIC_VERBS.has(w) ||
              seenWords.has(w),
          )
      ) {
        continue
      }
      if (seen.size + topics.length >= MAX_ENTITIES) break
      if (topics.length < MAX_TOPICS) add("TOPIC", phrase)
    }
  }

  return [...seen.values(), ...topics]
}
