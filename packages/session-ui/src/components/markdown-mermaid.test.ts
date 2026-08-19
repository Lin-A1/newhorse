import { describe, expect, test } from "bun:test"
import {
  isMermaidRenderFresh,
  MERMAID_MAX_RETRIES,
  resolveDarkMode,
  themeFlipDetected,
  type ThemeProbe,
} from "./markdown-mermaid"

function probe(overrides: Partial<ThemeProbe> = {}): ThemeProbe {
  return {
    computedColorScheme: () => "normal",
    attribute: () => undefined,
    resolveVar: () => undefined,
    prefersDark: () => false,
    ...overrides,
  }
}

describe("resolveDarkMode", () => {
  test("uses the computed color-scheme first", () => {
    expect(resolveDarkMode(probe({ computedColorScheme: () => "dark" }))).toBe(true)
    expect(resolveDarkMode(probe({ computedColorScheme: () => "light" }))).toBe(false)
  })

  test("falls back to the color-scheme attribute", () => {
    const attribute = (name: string) => (name === "color-scheme" ? "dark" : undefined)
    expect(resolveDarkMode(probe({ attribute }))).toBe(true)
    const light = (name: string) => (name === "color-scheme" ? "light" : undefined)
    expect(resolveDarkMode(probe({ attribute: light }))).toBe(false)
  })

  test("infers dark from the resolved app background luminance", () => {
    const background = (value: string | undefined) => ({
      resolveVar: (name: string) => (name === "--v2-background-bg-base" ? value : undefined),
    })
    expect(resolveDarkMode(probe(background("#161616ff")))).toBe(true)
    expect(resolveDarkMode(probe(background("#242424")))).toBe(true)
    expect(resolveDarkMode(probe(background("#fafafaff")))).toBe(false)
    expect(resolveDarkMode(probe(background("#ffffff")))).toBe(false)
    expect(resolveDarkMode(probe(background("rgb(8, 8, 8)")))).toBe(true)
    expect(resolveDarkMode(probe(background("rgb(250, 250, 250)")))).toBe(false)
  })

  test("falls back to prefers-color-scheme", () => {
    expect(resolveDarkMode(probe({ prefersDark: () => true }))).toBe(true)
    expect(resolveDarkMode(probe({ prefersDark: () => false }))).toBe(false)
  })
})

describe("themeFlipDetected", () => {
  test("does not fire for the initial state probe", () => {
    expect(themeFlipDetected(undefined, true)).toBe(false)
    expect(themeFlipDetected(undefined, false)).toBe(false)
  })

  test("does not fire when dark/light did not change", () => {
    expect(themeFlipDetected(true, true)).toBe(false)
    expect(themeFlipDetected(false, false)).toBe(false)
  })

  test("fires only on an actual dark/light flip", () => {
    expect(themeFlipDetected(false, true)).toBe(true)
    expect(themeFlipDetected(true, false)).toBe(true)
  })
})

describe("isMermaidRenderFresh", () => {
  const block = { raw: "graph LR\n  A --> B" }

  test("rejects a missing or different-raw cache entry", () => {
    expect(isMermaidRenderFresh(undefined, block, 0)).toBe(false)
    expect(isMermaidRenderFresh({ raw: "graph LR\n  A --> C" }, block, 0)).toBe(false)
  })

  test("rejects a cache entry from a previous theme epoch", () => {
    const cached = { raw: block.raw, themeVersion: 0, mermaid: { svg: "<svg/>" }, retries: 0 }
    expect(isMermaidRenderFresh(cached, block, 1)).toBe(false)
  })

  test("accepts a rendered diagram at the current epoch", () => {
    const cached = { raw: block.raw, themeVersion: 2, mermaid: { svg: "<svg/>" }, retries: 0 }
    expect(isMermaidRenderFresh(cached, block, 2)).toBe(true)
  })

  test("does not accept a failed render until the retry budget is exhausted", () => {
    const error = { raw: block.raw, themeVersion: 1, mermaidError: "render failed", retries: 1 }
    expect(isMermaidRenderFresh(error, block, 1)).toBe(false)
    expect(isMermaidRenderFresh({ ...error, retries: MERMAID_MAX_RETRIES }, block, 1)).toBe(true)
    expect(isMermaidRenderFresh({ ...error, retries: MERMAID_MAX_RETRIES + 1 }, block, 1)).toBe(true)
  })
})
