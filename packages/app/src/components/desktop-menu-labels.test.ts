import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "../desktop-menu"
import { dict as en } from "../i18n/en"
import { desktopMenuLabel, desktopMenuLabelKeys } from "./desktop-menu-labels"

const t = (key: string) => key

function allLabels(): string[] {
  return DESKTOP_MENU.flatMap((menu) => [
    menu.label,
    ...(menu.items ?? []).map((item) => (item.type === "item" ? item.label : undefined)),
  ]).filter((label): label is string => !!label)
}

describe("desktop menu labels", () => {
  test("every label in DESKTOP_MENU maps to an i18n key", () => {
    for (const label of allLabels()) {
      expect(desktopMenuLabel(t, label), `label has no mapping: "${label}"`).not.toBe(label)
    }
  })

  test("every mapped key exists in the en dictionary", () => {
    const dict = en as Record<string, string | undefined>
    for (const key of Object.values(desktopMenuLabelKeys)) {
      expect(dict[key], `missing en key: "${key}"`).toBeDefined()
    }
  })

  test("unknown labels fall back to the raw label", () => {
    expect(desktopMenuLabel(t, "Something New")).toBe("Something New")
  })
})
