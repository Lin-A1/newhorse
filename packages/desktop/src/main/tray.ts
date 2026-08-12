import { Menu, Tray, app } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { iconPath, showMainWindow, toggleMainWindow } from "./windows"

let tray: Tray | null = null

// Creates the system tray (kept alive for the lifetime of the app). When the
// window is closed/minimized the app keeps running in the tray with the server
// sidecar alive, so Companion can keep working in the background.
//
// The icon reuses the app logo (`icon.ico` on Windows, `icon.png` elsewhere) —
// there is no dedicated tray glyph yet. On macOS the full-color logo is not a
// template image, so it will not auto-adapt to the menu bar appearance.
export function createTray() {
  if (tray) return tray
  tray = new Tray(iconPath())
  tray.setToolTip("newhorse")
  tray.setContextMenu(buildContextMenu())
  // Left click (Windows/Linux) shows and focuses the window. On macOS a click
  // opens the context menu instead, where "Show/Hide Window" does the same.
  tray.on("click", () => showMainWindow())
  return tray
}

function buildContextMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Show/Hide Window",
      click: () => toggleMainWindow(),
    },
    { type: "separator" },
    {
      label: "Quit newhorse",
      click: () => app.quit(),
    },
  ]
  return Menu.buildFromTemplate(template)
}
