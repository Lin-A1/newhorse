// Close/minimize behavior in tray-resident background mode. A window hides to
// the tray (instead of closing/quit) only when the app is not quitting for
// real AND a system tray actually exists; otherwise the window keeps its
// original close/minimize behavior (all windows closing outside a quit does
// not exit the app — the sidecar keeps running — but closing a window really
// destroys it, so the registry keeps its id for restore).
export type TrayResidentWindow = {
  hide(): void
  on(event: "close", handler: (event: { preventDefault(): void }) => void): void
  on(event: "minimize", handler: () => void): void
}

export function wireTrayResidentClose(
  win: TrayResidentWindow,
  shouldHide: { isQuitting: () => boolean; isTrayEnabled: () => boolean },
) {
  win.on("close", (event) => {
    if (shouldHide.isQuitting() || !shouldHide.isTrayEnabled()) return
    event.preventDefault()
    win.hide()
  })
  win.on("minimize", () => {
    if (shouldHide.isQuitting() || !shouldHide.isTrayEnabled()) return
    win.hide()
  })
}
