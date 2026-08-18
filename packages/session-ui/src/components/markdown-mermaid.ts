import type { MermaidConfig } from "mermaid"

export type MermaidRenderResult = { svg: string }

type ThemeVariables = Record<string, string>

const lightTheme: ThemeVariables = {
  primaryColor: "#ecf1fe",
  primaryTextColor: "#161616",
  primaryBorderColor: "#3b5cf6",
  lineColor: "#3b5cf6",
  secondaryColor: "#f2f2f2",
  tertiaryColor: "#fafafa",
  clusterBkg: "#fafafa",
  clusterBorder: "#dbdbdb",
  edgeLabelBackground: "#ffffff",
  nodeTextColor: "#161616",
  background: "#ffffff",

  actorBkg: "#f2f2f2",
  actorBorder: "#3b5cf6",
  actorTextColor: "#161616",
  signalColor: "#5c5c5c",
  signalTextColor: "#161616",
  labelBoxBkgColor: "#ffffff",
  labelBoxBorderColor: "#3b5cf6",
  labelTextColor: "#161616",
  noteBkgColor: "#fefaec",
  noteBorderColor: "#e7af36",
  noteTextColor: "#161616",
  activationBkgColor: "#d7e2fc",
  sequenceNumberColor: "#ffffff",
  sectionBkgColor: "#d7e2fc",
  altSectionBkgColor: "#fafafa",
  taskBorderColor: "#3b5cf6",
  taskBkgColor: "#ecf1fe",
  taskTextLightColor: "#161616",
  taskTextColor: "#161616",
  taskTextDarkColor: "#161616",
}

const darkTheme: ThemeVariables = {
  primaryColor: "#1b2852",
  primaryTextColor: "#fafafa",
  primaryBorderColor: "#7698fd",
  lineColor: "#7698fd",
  secondaryColor: "#2e2e2e",
  tertiaryColor: "#242424",
  clusterBkg: "#242424",
  clusterBorder: "#5c5c5c",
  edgeLabelBackground: "#161616",
  nodeTextColor: "#fafafa",
  background: "#161616",

  actorBkg: "#242424",
  actorBorder: "#7698fd",
  actorTextColor: "#fafafa",
  signalColor: "#aeaeae",
  signalTextColor: "#fafafa",
  labelBoxBkgColor: "#161616",
  labelBoxBorderColor: "#7698fd",
  labelTextColor: "#fafafa",
  noteBkgColor: "#4b4025",
  noteBorderColor: "#e7af36",
  noteTextColor: "#fafafa",
  activationBkgColor: "#1b2852",
  sequenceNumberColor: "#161616",
  sectionBkgColor: "#1b2852",
  altSectionBkgColor: "#242424",
  taskBorderColor: "#7698fd",
  taskBkgColor: "#1b2852",
  taskTextLightColor: "#fafafa",
  taskTextColor: "#fafafa",
  taskTextDarkColor: "#fafafa",
}

export type ThemeProbe = {
  computedColorScheme(): string
  attribute(name: string): string | undefined
  resolveVar(name: string): string | undefined
  prefersDark(): boolean
}

// The app applies themes through `data-theme` plus a computed `color-scheme`
// (inline style or CSS media query); `data-color-scheme` is only set on some
// paths. Compute the effective dark mode from the strongest available signal.
export function resolveDarkMode(probe: ThemeProbe): boolean {
  const computed = probe.computedColorScheme().toLowerCase()
  if (computed === "light" || computed === "dark") return computed === "dark"

  const scheme = probe.attribute("color-scheme")
  if (scheme === "light" || scheme === "dark") return scheme === "dark"

  // The active theme's background is the most direct color signal the theme
  // loader produces (it follows `data-theme` and the resolved v2 tokens).
  const background = probe.resolveVar("--v2-background-bg-base")
  const luminance = background ? colorLuminance(background) : undefined
  if (luminance !== undefined) return luminance < 0.4

  return probe.prefersDark()
}

function isDark(): boolean {
  if (typeof document === "undefined") return false
  return resolveDarkMode({
    computedColorScheme: () => getComputedStyle(document.documentElement).colorScheme,
    attribute: (name) => document.documentElement.getAttribute(`data-${name}`) ?? undefined,
    resolveVar: (name) => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      if (!value) return undefined
      return resolveVar(value)
    },
    prefersDark: () => typeof window === "object" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  })
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

function luminanceRgb(r: number, g: number, b: number): number {
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function colorLuminance(value: string): number | undefined {
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim())
  if (hex) {
    const digits = hex[1]!.toLowerCase()
    return luminanceRgb(
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    )
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value.trim())
  if (rgb) return luminanceRgb(Number(rgb[1]!), Number(rgb[2]!), Number(rgb[3]!))
  return undefined
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
  const text = ["--v2-text-text-base", isDark() ? "--v2-grey-100" : "--v2-grey-1100"]
  const bgBase = ["--v2-background-bg-base", isDark() ? "--v2-grey-1100" : "--v2-grey-50"]
  const bgLayer = ["--v2-background-bg-layer-01", isDark() ? "--v2-grey-1000" : "--v2-grey-100"]
  const accent = isDark() ? "--v2-blue-500" : "--v2-blue-600"
  return {
    ...base,
    primaryColor: pick(["--v2-blue-100"], ["--v2-blue-1000"], base.primaryColor),
    primaryTextColor: pick(text, text, base.primaryTextColor),
    primaryBorderColor: pick([accent], [accent], base.primaryBorderColor),
    lineColor: pick([accent], [accent], base.lineColor),
    secondaryColor: pick(bgLayer, bgLayer, base.secondaryColor),
    tertiaryColor: pick(bgLayer, bgLayer, base.tertiaryColor),
    clusterBkg: pick(bgLayer, bgLayer, base.clusterBkg),
    clusterBorder: pick(["--v2-border-border-strong", "--v2-grey-400"], ["--v2-border-border-strong", "--v2-grey-600"], base.clusterBorder),
    edgeLabelBackground: pick(bgBase, bgBase, base.edgeLabelBackground),
    nodeTextColor: pick(text, text, base.nodeTextColor),
    background: pick(bgBase, bgBase, base.background),

    actorBkg: pick(bgLayer, bgLayer, base.actorBkg),
    actorBorder: pick([accent], [accent], base.actorBorder),
    actorTextColor: pick(text, text, base.actorTextColor),
    signalColor: pick(["--v2-text-text-muted", "--v2-grey-700"], ["--v2-text-text-muted", "--v2-grey-500"], base.signalColor),
    signalTextColor: pick(text, text, base.signalTextColor),
    labelBoxBkgColor: pick(bgBase, bgBase, base.labelBoxBkgColor),
    labelBoxBorderColor: pick([accent], [accent], base.labelBoxBorderColor),
    labelTextColor: pick(text, text, base.labelTextColor),
    noteBkgColor: pick(["--v2-yellow-100"], ["--v2-yellow-1200"], base.noteBkgColor),
    noteBorderColor: pick(["--v2-yellow-700"], ["--v2-yellow-700"], base.noteBorderColor),
    noteTextColor: pick(text, text, base.noteTextColor),
    activationBkgColor: pick(["--v2-blue-200"], ["--v2-blue-1000"], base.activationBkgColor),
    sequenceNumberColor: pick(bgBase, bgBase, base.sequenceNumberColor),
    sectionBkgColor: pick(["--v2-blue-200"], ["--v2-blue-1000"], base.sectionBkgColor),
    altSectionBkgColor: pick(bgLayer, bgLayer, base.altSectionBkgColor),
    taskBorderColor: pick([accent], [accent], base.taskBorderColor),
    taskBkgColor: pick(["--v2-blue-100"], ["--v2-blue-1000"], base.taskBkgColor),
    taskTextLightColor: pick(text, text, base.taskTextLightColor),
    taskTextColor: pick(text, text, base.taskTextColor),
    taskTextDarkColor: pick(text, text, base.taskTextDarkColor),
  }
}

function appFontFamily(): string {
  if (typeof document === "undefined") return "'Inter','Segoe UI','Microsoft YaHei',sans-serif"
  const v2Font = rawVar("--v2-font-family-sans")
  if (v2Font) return v2Font
  const baseFont = rawVar("--font-family-sans")
  if (baseFont) return baseFont
  return "'Inter','Segoe UI','Microsoft YaHei',sans-serif"
}

function config(themeVariables: ThemeVariables): MermaidConfig {
  return {
    startOnLoad: false,
    theme: "base",
    securityLevel: "strict",
    fontFamily: appFontFamily(),
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

export type ThemeChangeListener = () => void

const themeChangeListeners = new Set<ThemeChangeListener>()
let lastDarkState: boolean | undefined
let themeObserver: MutationObserver | undefined
let systemDarkQuery: MediaQueryList | undefined
let systemDarkListener: (() => void) | undefined

function emitThemeChanges(): void {
  const dark = isDark()
  if (dark === lastDarkState) return
  lastDarkState = dark
  for (const listener of themeChangeListeners) listener()
}

function ensureThemeChangeObserver(): void {
  if (themeObserver) return
  if (typeof document === "undefined" || typeof MutationObserver === "undefined" || typeof window === "undefined") return
  lastDarkState = isDark()
  themeObserver = new MutationObserver(emitThemeChanges)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color-scheme", "style"],
  })
  systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)")
  systemDarkListener = () => emitThemeChanges()
  systemDarkQuery.addEventListener("change", systemDarkListener)
}

// Register a callback fired whenever the effective dark/light mode changes,
// including attribute changes on <html> and OS-level prefers-color-scheme
// shifts. Returns an unsubscribe function.
export function subscribeThemeChange(listener: ThemeChangeListener): () => void {
  themeChangeListeners.add(listener)
  ensureThemeChangeObserver()
  return () => {
    themeChangeListeners.delete(listener)
    if (themeChangeListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = undefined
      const listener = systemDarkListener
      if (listener) systemDarkQuery?.removeEventListener("change", listener)
      systemDarkQuery = undefined
      systemDarkListener = undefined
      lastDarkState = undefined
    }
  }
}
