import type { MermaidConfig } from "mermaid"

export type MermaidRenderResult = { svg: string }

type ThemeVariables = Record<string, string>

const lightTheme: ThemeVariables = {
  primaryColor: "#e8eefc",
  primaryTextColor: "#15213d",
  primaryBorderColor: "#5578d8",
  lineColor: "#5578d8",
  secondaryColor: "#f4f7fb",
  tertiaryColor: "#eef2f7",
  clusterBkg: "#f4f7fb",
  clusterBorder: "#b7c5e2",
  edgeLabelBackground: "#ffffff",
  nodeTextColor: "#15213d",
  background: "#ffffff",
}

const darkTheme: ThemeVariables = {
  primaryColor: "#223357",
  primaryTextColor: "#eef4ff",
  primaryBorderColor: "#89a9ff",
  lineColor: "#89a9ff",
  secondaryColor: "#18233b",
  tertiaryColor: "#101827",
  clusterBkg: "#16233b",
  clusterBorder: "#48638f",
  edgeLabelBackground: "#101827",
  nodeTextColor: "#eef4ff",
  background: "#0f141d",
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
  const base = isDark() ? darkTheme : lightTheme
  return {
    ...base,
    primaryColor: pick(["--v2-accent-accent", "--v2-blue-100"], ["--v2-accent-accent", "--v2-blue-900"], base.primaryColor),
    primaryTextColor: pick(
      ["--v2-text-text-base", "--v2-grey-1000"],
      ["--v2-text-text-base", "--v2-grey-100"],
      base.primaryTextColor,
    ),
    primaryBorderColor: pick(["--v2-accent-accent", "--v2-blue-600"], ["--v2-accent-accent", "--v2-blue-400"], base.primaryBorderColor),
    lineColor: pick(["--v2-accent-accent", "--v2-blue-600"], ["--v2-accent-accent", "--v2-blue-400"], base.lineColor),
    secondaryColor: pick(["--v2-background-bg-layer-02", "--v2-grey-100"], ["--v2-background-bg-layer-02", "--v2-grey-800"], base.secondaryColor),
    tertiaryColor: pick(["--v2-background-bg-layer-01", "--v2-grey-100"], ["--v2-background-bg-layer-01", "--v2-grey-700"], base.tertiaryColor),
    clusterBkg: pick(["--v2-background-bg-layer-01", "--v2-grey-100"], ["--v2-background-bg-layer-01", "--v2-grey-800"], base.clusterBkg),
    clusterBorder: pick(["--v2-border-border-muted", "--v2-blue-300"], ["--v2-border-border-muted", "--v2-grey-500"], base.clusterBorder),
    edgeLabelBackground: pick(
      ["--v2-background-bg-base", "--v2-grey-50"],
      ["--v2-background-bg-base", "--v2-grey-1000"],
      base.edgeLabelBackground,
    ),
    nodeTextColor: pick(
      ["--v2-text-text-base", "--v2-grey-1000"],
      ["--v2-text-text-base", "--v2-grey-100"],
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
let renderQueue: Promise<void> = Promise.resolve()

export async function renderMermaid(source: string): Promise<MermaidRenderResult> {
  let result: MermaidRenderResult | undefined
  let failure: unknown
  const task = renderQueue.then(async () => {
    try {
      const { default: mermaid } = await loadMermaid()
      // Mermaid has global renderer state; serialize initialize/render pairs so
      // streaming markdown updates cannot race each other.
      mermaid.initialize(config(buildThemeVariables()))
      const id = `newhorse-mermaid-${Date.now()}-${++sequence}`
      const rendered = await mermaid.render(id, source)
      result = { svg: rendered.svg }
    } catch (error) {
      failure = error
    }
  })
  renderQueue = task.then(() => undefined, () => undefined)
  await task
  if (failure) throw failure
  if (!result) throw new Error("Mermaid produced no SVG")
  return result
}
