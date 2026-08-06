type Translate = (key: string, params?: Record<string, string | number | boolean>) => string

// Maps the canonical English menu labels from `desktop-menu.ts` to i18n keys.
// Unknown labels fall back to the raw English string so a label never renders
// as a bare key. The native macOS menus are built from `desktop-menu.ts`
// outside the Solid render tree and stay English; this only localizes the
// in-app Windows menu at render time.
export const desktopMenuLabelKeys: Record<string, string> = {
  newhorse: "desktopMenu.menu.app",
  File: "desktopMenu.menu.file",
  Edit: "desktopMenu.menu.edit",
  View: "desktopMenu.menu.view",
  Go: "desktopMenu.menu.go",
  Window: "desktopMenu.menu.window",
  Help: "desktopMenu.menu.help",
  "Check for Updates...": "desktopMenu.item.checkForUpdates",
  Settings: "desktopMenu.item.settings",
  "Reload Webview": "desktopMenu.item.reloadWebview",
  Restart: "desktopMenu.item.restart",
  "Export Logs...": "desktopMenu.item.exportLogs",
  "New Session": "desktopMenu.item.newSession",
  "Open Project...": "desktopMenu.item.openProject",
  "New Window": "desktopMenu.item.newWindow",
  "Close Window": "desktopMenu.item.closeWindow",
  Undo: "desktopMenu.item.undo",
  Redo: "desktopMenu.item.redo",
  Cut: "desktopMenu.item.cut",
  Copy: "desktopMenu.item.copy",
  Paste: "desktopMenu.item.paste",
  Delete: "desktopMenu.item.delete",
  "Select All": "desktopMenu.item.selectAll",
  "Toggle Sidebar": "desktopMenu.item.toggleSidebar",
  "Toggle Terminal": "desktopMenu.item.toggleTerminal",
  "Toggle File Tree": "desktopMenu.item.toggleFileTree",
  Reload: "desktopMenu.item.reload",
  "Toggle Developer Tools": "desktopMenu.item.toggleDevTools",
  "Actual Size": "desktopMenu.item.actualSize",
  "Zoom In": "desktopMenu.item.zoomIn",
  "Zoom Out": "desktopMenu.item.zoomOut",
  "Toggle Full Screen": "desktopMenu.item.toggleFullScreen",
  Back: "desktopMenu.item.back",
  Forward: "desktopMenu.item.forward",
  "Previous Session": "desktopMenu.item.previousSession",
  "Next Session": "desktopMenu.item.nextSession",
  "Previous Project": "desktopMenu.item.previousProject",
  "Next Project": "desktopMenu.item.nextProject",
  Minimize: "desktopMenu.item.minimize",
  Maximize: "desktopMenu.item.maximize",
  "newhorse Documentation": "desktopMenu.item.documentation",
  "Share Feedback": "desktopMenu.item.shareFeedback",
  "Report a Bug": "desktopMenu.item.reportBug",
}

export function desktopMenuLabel(t: Translate, label: string): string {
  const key = desktopMenuLabelKeys[label]
  return key ? t(key) : label
}
