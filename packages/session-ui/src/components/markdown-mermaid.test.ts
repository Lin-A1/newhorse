import { describe, expect, test } from "bun:test"
import { resolveDarkMode, type ThemeProbe } from "./markdown-mermaid"

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
