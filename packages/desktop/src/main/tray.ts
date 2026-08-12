import type { MenuItemConstructorOptions } from "electron"

// Creates the system tray (kept alive for the lifetime of the app). When the
// window is closed/minimized the app keeps running in the tray with the server
// sidecar alive, so Companion can keep working in the background.
//
// The electron pieces are injected (index.ts wires the real Tray/Menu/app and
// the window helpers) so this module stays pure and unit-testable in a plain
// Node process.
//
// The icon reuses the app logo (`icon.ico` on Windows, `icon.png` elsewhere) —
// there is no dedicated tray glyph yet. On macOS the full-color logo is not a
// template image, so it will not auto-adapt to the menu bar appearance.
export interface TrayLike {
  setToolTip(value: string): void
  setContextMenu(menu: unknown): void
  on(event: "click", handler: () => void): void
}

export interface TrayDeps {
  Tray: new (icon: string) => TrayLike
  Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): unknown }
  app: { quit: () => void }
  iconPath: () => string
  showMainWindow: () => void
  toggleMainWindow: () => void
}

let tray: TrayLike | null = null

export function createTray(deps: TrayDeps): TrayLike {
  if (tray) return tray
  tray = new deps.Tray(deps.iconPath())
  tray.setToolTip("newhorse")
  tray.setContextMenu(buildContextMenu(deps))
  // Left click (Windows/Linux) shows and focuses the window. On macOS a click
  // opens the context menu instead, where "Show/Hide Window" does the same.
  tray.on("click", () => deps.showMainWindow())
  return tray
}

function buildContextMenu(deps: TrayDeps) {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Show/Hide Window",
      click: () => deps.toggleMainWindow(),
    },
    { type: "separator" },
    {
      label: "Quit newhorse",
      click: () => deps.app.quit(),
    },
  ]
  return deps.Menu.buildFromTemplate(template)
}
