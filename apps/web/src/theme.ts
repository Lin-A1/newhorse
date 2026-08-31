/**
 * Theme: follows the OS light/dark preference by default, with a manual
 * override persisted to localStorage. The choice is applied as
 * `data-theme="light|dark"` on <html>; an inline bootstrap in index.html
 * sets the same attribute before React mounts (no flash).
 */
export type ThemePref = "system" | "light" | "dark"

const KEY = "NEWHORSE_THEME"
const ORDER: ThemePref[] = ["system", "light", "dark"]
const mq = window.matchMedia("(prefers-color-scheme: light)")

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return mq.matches ? "light" : "dark"
  return pref
}

function apply(pref: ThemePref): void {
  const theme = resolve(pref)
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f5f6f8" : "#0d0e11")
}

export function initTheme(): void {
  apply(getThemePref())
  mq.addEventListener("change", () => {
    if (getThemePref() === "system") apply("system")
  })
}

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === "light" || v === "dark" || v === "system" ? v : "system"
}

/** system → light → dark → system */
export function cycleTheme(): ThemePref {
  const next = ORDER[(ORDER.indexOf(getThemePref()) + 1) % ORDER.length]!
  localStorage.setItem(KEY, next)
  apply(next)
  return next
}
