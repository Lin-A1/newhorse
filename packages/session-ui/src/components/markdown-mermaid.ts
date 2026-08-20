import type { MermaidConfig } from "mermaid"

export type MermaidRenderResult = { svg: string }

type ThemeVariables = Record<string, string | Record<string, string>>

// Ultimate fallbacks used when the v2 design tokens cannot be resolved (SSR,
// tests, or a page that never loaded the v2 theme). Values mirror the v2
// palette so diagrams stay close to the app even without tokens.
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

  // Flowchart / class nodes resolve through mainBkg + nodeBorder (defaults are
  // the generic mermaid lavender/purple, so pin them to the accent palette).
  mainBkg: "#ecf1fe",
  nodeBorder: "#3b5cf6",
  textColor: "#161616",
  titleColor: "#161616",
  border1: "#3b5cf6",
  border2: "#dbdbdb",

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

  stateBkg: "#ecf1fe",
  stateBorder: "#3b5cf6",
  stateLabelColor: "#161616",
  labelBackgroundColor: "#ffffff",
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

  mainBkg: "#1b2852",
  nodeBorder: "#7698fd",
  textColor: "#fafafa",
  titleColor: "#fafafa",
  border1: "#7698fd",
  border2: "#5c5c5c",

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

  stateBkg: "#1b2852",
  stateBorder: "#7698fd",
  stateLabelColor: "#fafafa",
  labelBackgroundColor: "#161616",
}

// Data-series fills (pie slices, timeline rows, xychart plots) are emitted as
// inline SVG attribute values, so they must be literal hex — CSS variables do
// not resolve inside SVG presentation attributes.
const lightPalette = [
  "#3b5cf6",
  "#7152f4",
  "#49c970",
  "#e7af36",
  "#ff8648",
  "#f1484f",
  "#f64aab",
  "#00abcf",
  "#2c47c8",
  "#623be2",
  "#198b43",
  "#cb9f34",
]
const darkPalette = [
  "#7698fd",
  "#8271f8",
  "#6bd586",
  "#f6c251",
  "#ffa478",
  "#f17471",
  "#f26cb2",
  "#00c5df",
  "#a2bcff",
  "#9e99f7",
  "#b8e9c1",
  "#f3da9b",
]

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

function pick(names: string[], fallback: string): string {
  for (const name of names) {
    const value = rawVar(name)
    if (!value) continue
    const resolved = resolveVar(value)
    if (!resolved) continue
    return toHex(resolved, fallback)
  }
  return fallback
}

function seriesPalette(keys: string[], colors: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key, index) => [key, colors[index % colors.length]!]))
}

function buildThemeVariables(): ThemeVariables {
  const dark = isDark()
  const base = dark ? darkTheme : lightTheme
  const accent = dark ? "--v2-blue-500" : "--v2-blue-600"
  const accentSoft = dark ? "--v2-blue-1000" : "--v2-blue-100"
  const accentSoftDeep = dark ? "--v2-blue-1200" : "--v2-blue-200"
  const palette = dark ? darkPalette : lightPalette
  return {
    ...base,
    primaryColor: pick([accentSoft], base.primaryColor as string),
    primaryTextColor: pick(["--v2-text-text-base"], base.primaryTextColor as string),
    primaryBorderColor: pick([accent], base.primaryBorderColor as string),
    lineColor: pick([accent], base.lineColor as string),
    secondaryColor: pick(["--v2-background-bg-layer-02"], base.secondaryColor as string),
    tertiaryColor: pick(["--v2-background-bg-layer-01"], base.tertiaryColor as string),
    clusterBkg: pick(["--v2-background-bg-layer-01"], base.clusterBkg as string),
    clusterBorder: pick([dark ? "--v2-grey-600" : "--v2-grey-400"], base.clusterBorder as string),
    edgeLabelBackground: pick(["--v2-background-bg-base"], base.edgeLabelBackground as string),
    nodeTextColor: pick(["--v2-text-text-base"], base.nodeTextColor as string),
    background: pick(["--v2-background-bg-base"], base.background as string),

    mainBkg: pick([accentSoft], base.mainBkg as string),
    nodeBorder: pick([accent], base.nodeBorder as string),
    textColor: pick(["--v2-text-text-base"], base.textColor as string),
    titleColor: pick(["--v2-text-text-base"], base.titleColor as string),
    border1: pick([accent], base.border1 as string),
    border2: pick([dark ? "--v2-grey-600" : "--v2-grey-400"], base.border2 as string),

    actorBkg: pick(["--v2-background-bg-layer-02"], base.actorBkg as string),
    actorBorder: pick([accent], base.actorBorder as string),
    actorTextColor: pick(["--v2-text-text-base"], base.actorTextColor as string),
    signalColor: pick(["--v2-text-text-muted"], base.signalColor as string),
    signalTextColor: pick(["--v2-text-text-base"], base.signalTextColor as string),
    labelBoxBkgColor: pick(["--v2-background-bg-base"], base.labelBoxBkgColor as string),
    labelBoxBorderColor: pick([accent], base.labelBoxBorderColor as string),
    labelTextColor: pick(["--v2-text-text-base"], base.labelTextColor as string),
    noteBkgColor: pick([dark ? "--v2-yellow-1200" : "--v2-yellow-100"], base.noteBkgColor as string),
    noteBorderColor: pick([dark ? "--v2-yellow-700" : "--v2-yellow-800"], base.noteBorderColor as string),
    noteTextColor: pick(["--v2-text-text-base"], base.noteTextColor as string),
    activationBkgColor: pick([accentSoft], base.activationBkgColor as string),
    sequenceNumberColor: pick(["--v2-background-bg-base"], base.sequenceNumberColor as string),
    sectionBkgColor: pick([accentSoftDeep], base.sectionBkgColor as string),
    altSectionBkgColor: pick(["--v2-background-bg-layer-01"], base.altSectionBkgColor as string),
    taskBorderColor: pick([accent], base.taskBorderColor as string),
    taskBkgColor: pick([accentSoft], base.taskBkgColor as string),
    taskTextLightColor: pick(["--v2-text-text-base"], base.taskTextLightColor as string),
    taskTextColor: pick(["--v2-text-text-base"], base.taskTextColor as string),
    taskTextDarkColor: pick(["--v2-text-text-base"], base.taskTextDarkColor as string),

    stateBkg: pick([accentSoft], base.stateBkg as string),
    stateBorder: pick([accent], base.stateBorder as string),
    stateLabelColor: pick(["--v2-text-text-base"], base.stateLabelColor as string),
    labelBackgroundColor: pick(["--v2-background-bg-base"], base.labelBackgroundColor as string),

    ...seriesPalette(
      [
        "pie1",
        "pie2",
        "pie3",
        "pie4",
        "pie5",
        "pie6",
        "pie7",
        "pie8",
        "pie9",
        "pie10",
        "pie11",
        "pie12",
      ],
      palette,
    ),
    ...seriesPalette(
      [
        "cScale0",
        "cScale1",
        "cScale2",
        "cScale3",
        "cScale4",
        "cScale5",
        "cScale6",
        "cScale7",
        "cScale8",
        "cScale9",
        "cScale10",
        "cScale11",
      ],
      palette,
    ),
    xyChart: {
      backgroundColor: pick(["--v2-background-bg-base"], base.background as string),
      titleColor: pick(["--v2-text-text-base"], base.primaryTextColor as string),
      xAxisLabelColor: pick(["--v2-text-text-muted"], base.signalColor as string),
      xAxisTitleColor: pick(["--v2-text-text-base"], base.primaryTextColor as string),
      xAxisTickColor: pick(["--v2-text-text-muted"], base.signalColor as string),
      xAxisLineColor: pick([accent], base.lineColor as string),
      yAxisLabelColor: pick(["--v2-text-text-muted"], base.signalColor as string),
      yAxisTitleColor: pick(["--v2-text-text-base"], base.primaryTextColor as string),
      yAxisTickColor: pick(["--v2-text-text-muted"], base.signalColor as string),
      yAxisLineColor: pick([accent], base.lineColor as string),
      plotColorPalette: palette.join(", "),
    },
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
    fontSize: 14,
    flowchart: {
      curve: "basis",
      htmlLabels: true,
      nodeSpacing: 60,
      rankSpacing: 60,
      padding: 12,
    },
    themeVariables,
  }
}

let mermaidPromise: Promise<Module> | undefined
type Module = typeof import("mermaid")

function loadMermaid(): Promise<Module> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(
      (mod) => {
        mod.default.initialize(config(buildThemeVariables()))
        return mod
      },
      (error) => {
        // Do not cache a failed import; a transient bundle failure should not
        // permanently disable diagrams for the rest of the page lifetime.
        mermaidPromise = undefined
        throw error
      },
    )
  }
  return mermaidPromise
}

let sequence = 0
let renderQueue: Promise<void> = Promise.resolve()

// A hung mermaid render must not wedge the queue forever: every later diagram
// (including re-renders triggered by theme flips and session switches) would
// otherwise stay pending and the block would degrade to plain text.
const RENDER_TIMEOUT_MS = 20_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mermaid render timed out")), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

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
      const rendered = await withTimeout(mermaid.render(id, source), RENDER_TIMEOUT_MS)
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

export type MermaidCacheEntry = {
  raw: string
  themeVersion?: number
  mermaid?: { svg: string }
  mermaidError?: string
  retries?: number
}

export const MERMAID_MAX_RETRIES = 3
const MERMAID_CACHE_LIMIT = 500
const completedMermaid = new Map<string, MermaidCacheEntry>()

export function getCachedMermaid(key: string) {
  const cached = completedMermaid.get(key)
  if (!cached) return
  completedMermaid.delete(key)
  completedMermaid.set(key, cached)
  return cached
}

export function cacheMermaid(key: string, entry: MermaidCacheEntry) {
  completedMermaid.delete(key)
  completedMermaid.set(key, entry)
  if (completedMermaid.size <= MERMAID_CACHE_LIMIT) return
  const oldest = completedMermaid.keys().next().value
  if (oldest !== undefined) completedMermaid.delete(oldest)
}

// A cached diagram can be reused only while the raw source and the theme epoch
// match. Failed renders are retried until the retry budget is exhausted so a
// transient failure (e.g. while the render queue is busy during a session
// switch) recovers instead of permanently degrading to a code block.
export function isMermaidRenderFresh(
  cached: MermaidCacheEntry | undefined,
  block: { raw: string },
  themeVersion: number,
): boolean {
  if (!cached || cached.raw !== block.raw || cached.themeVersion !== themeVersion) return false
  if (cached.mermaid) return true
  return !!cached.mermaidError && (cached.retries ?? 0) >= MERMAID_MAX_RETRIES
}

export type ThemeChangeListener = () => void

// Listeners fire only when the effective dark/light state actually flips; the
// initial probe (no previous state) and same-state mutations are no-ops.
export function themeFlipDetected(previous: boolean | undefined, current: boolean): boolean {
  return previous !== undefined && previous !== current
}

const themeChangeListeners = new Set<ThemeChangeListener>()
let lastDarkState: boolean | undefined
let themeObserver: MutationObserver | undefined
let systemDarkQuery: MediaQueryList | undefined
let systemDarkListener: (() => void) | undefined
let themeEvaluationQueued = false

// Applying a theme touches several attributes in one synchronous batch, so
// evaluate once per microtask instead of once per mutation. Listeners fire
// only when the effective dark/light state actually flips.
function scheduleThemeEvaluation(): void {
  if (themeEvaluationQueued) return
  themeEvaluationQueued = true
  queueMicrotask(() => {
    themeEvaluationQueued = false
    const dark = isDark()
    if (!themeFlipDetected(lastDarkState, dark)) return
    lastDarkState = dark
    for (const listener of themeChangeListeners) listener()
  })
}

function ensureThemeChangeObserver(): void {
  if (themeObserver) return
  if (typeof document === "undefined" || typeof MutationObserver === "undefined" || typeof window === "undefined") return
  lastDarkState = isDark()
  themeObserver = new MutationObserver(scheduleThemeEvaluation)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color-scheme", "style"],
  })
  systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)")
  systemDarkListener = () => scheduleThemeEvaluation()
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
