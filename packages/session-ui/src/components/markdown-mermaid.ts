import type { MermaidConfig } from "mermaid"

export type MermaidRenderResult = { svg: string }

type ThemeVariables = Record<string, string>

const lightPurple: ThemeVariables = {
  primaryColor: "#eef2ff",
  primaryTextColor: "#312e81",
  primaryBorderColor: "#6366f1",
  lineColor: "#818cf8",
  secondaryColor: "#f5f3ff",
  tertiaryColor: "#fafaff",
  clusterBkg: "#f5f3ff",
  clusterBorder: "#c7d2fe",
  edgeLabelBackground: "#ffffff",
  nodeTextColor: "#1e1b4b",
  background: "#ffffff",
}

const darkPurple: ThemeVariables = {
  primaryColor: "#312e81",
  primaryTextColor: "#e0e7ff",
  primaryBorderColor: "#818cf8",
  lineColor: "#818cf8",
  secondaryColor: "#1e1b4b",
  tertiaryColor: "#1e293b",
  clusterBkg: "#171a2e",
  clusterBorder: "#3730a3",
  edgeLabelBackground: "#111827",
  nodeTextColor: "#c7d2fe",
  background: "#0b0b16",
}

function isDark(): boolean {
  if (typeof document === "undefined") return false
  const scheme = document.documentElement.dataset.colorScheme
  if (scheme === "light" || scheme === "dark") return scheme === "dark"
  if (typeof window === "object") return window.matchMedia("(prefers-color-scheme: dark)").matches
  return false
}

function rawVar(name: string): string | undefined {
  if (typeof document === "undefined") return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || undefined
}

function resolveVar(value: string): string | undefined {
  let current = value
  for (let depth = 0; depth < 6; depth++) {
    const match = current.match(/^var\((--[\w-]+)\)$/)
    if (!match) return current
    const next = rawVar(match[1]!)
    if (!next) return undefined
    current = next
  }
  return current
}

function toHex(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  const hex = resolveVar(value)
  if (!hex) return fallback
  const six = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex)
  if (six) return `#${six[1]!.toLowerCase()}`
  return hex
}

function pick(light: string[], dark: string[], fallback: string): string {
  const names = isDark() ? dark : light
  for (const name of names) {
    const value = rawVar(name)
    if (!value) continue
    const resolved = resolveVar(value)
    if (!resolved) continue
    return toHex(resolved, fallback)
  }
  return fallback
}

function buildThemeVariables(): ThemeVariables {
  const base = isDark() ? darkPurple : lightPurple
  return {
    ...base,
    primaryColor: pick(["--v2-blue-100", "--v2-blue-700"], ["--v2-blue-900", "--v2-blue-400"], base.primaryColor),
    primaryTextColor: pick(
      ["--v2-blue-900", "--v2-grey-1000"],
      ["--v2-blue-300", "--v2-grey-100"],
      base.primaryTextColor,
    ),
    primaryBorderColor: pick(["--v2-blue-600", "--v2-blue-700"], ["--v2-blue-500", "--v2-blue-300"], base.primaryBorderColor),
    lineColor: pick(["--v2-blue-600", "--v2-blue-500"], ["--v2-blue-500", "--v2-blue-300"], base.lineColor),
    secondaryColor: pick(["--v2-blue-50", "--v2-grey-100"], ["--v2-blue-900", "--v2-grey-800"], base.secondaryColor),
    tertiaryColor: pick(["--v2-grey-100", "--v2-grey-200"], ["--v2-grey-900", "--v2-grey-700"], base.tertiaryColor),
    clusterBkg: pick(["--v2-blue-50", "--v2-grey-100"], ["--v2-blue-1000", "--v2-grey-800"], base.clusterBkg),
    clusterBorder: pick(["--v2-blue-300", "--v2-blue-400"], ["--v2-blue-800", "--v2-grey-500"], base.clusterBorder),
    edgeLabelBackground: pick(
      ["--v2-grey-50", "--v2-background-bg-base"],
      ["--v2-grey-1000", "--v2-background-bg-base"],
      base.edgeLabelBackground,
    ),
    nodeTextColor: pick(
      ["--v2-grey-1000", "--v2-text-text-contrast"],
      ["--v2-grey-100", "--v2-text-text-contrast"],
      base.nodeTextColor,
    ),
    background: pick(
      ["--v2-background-bg-base", "--v2-grey-50"],
      ["--v2-background-bg-base", "--v2-grey-1100"],
      base.background,
    ),
  }
}

function config(themeVariables: ThemeVariables): MermaidConfig {
  return {
    startOnLoad: false,
    theme: "base",
    securityLevel: "strict",
    fontFamily: "'Segoe UI','Microsoft YaHei',sans-serif",
    fontSize: 13,
    flowchart: {
      curve: "basis",
      htmlLabels: true,
      nodeSpacing: 60,
      rankSpacing: 60,
      padding: 10,
    },
    themeVariables,
  }
}

let mermaidPromise: Promise<Module> | undefined
type Module = typeof import("mermaid")

function loadMermaid(): Promise<Module> {
  mermaidPromise ??= import("mermaid").then((mod) => {
    mod.default.initialize(config(buildThemeVariables()))
    return mod
  })
  return mermaidPromise
}

let sequence = 0

export async function renderMermaid(source: string): Promise<MermaidRenderResult> {
  const { default: mermaid } = await loadMermaid()
  mermaid.initialize(config(buildThemeVariables()))
  const id = `newhorse-mermaid-${Date.now()}-${++sequence}`
  const result = await mermaid.render(id.trim(), source)
  return { svg: result.svg }
}
