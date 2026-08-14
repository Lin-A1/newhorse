// Close/minimize behavior in tray-resident background mode.
//
// When a window closes:
//   - if the app is really quitting or no tray exists → the window closes normally
//   - otherwise the configured close action applies:
//       "quit" → quit the app
//       "tray" → hide the window to the system tray
//       "ask"  → show a dialog asking, with an option to remember the choice
//
// Minimize always minimizes to the taskbar (normal behavior) — only closing a
// window ever parks it in the tray.
export type CloseAction = "quit" | "tray" | "ask"

export type TrayResidentWindow = {
  hide(): void
  on(event: "close", handler: (event: { preventDefault(): void }) => void): void
}

export type CloseActionDeps = {
  isQuitting: () => boolean
  isTrayEnabled: () => boolean
  getCloseAction: () => CloseAction
  /** Shows the close-action dialog and returns the chosen action. Persisting
   * the "always do this" choice is the caller's responsibility. */
  askCloseAction: () => Promise<CloseAction>
  /** Actually quits the app (e.g. app.quit()). */
  quit: () => void
}

export function wireTrayResidentClose(win: TrayResidentWindow, deps: CloseActionDeps) {
  win.on("close", (event) => {
    if (deps.isQuitting() || !deps.isTrayEnabled()) return
    const action = deps.getCloseAction()
    if (action === "quit") return
    event.preventDefault()
    if (action === "ask") {
      void deps.askCloseAction().then((chosen) => {
        if (chosen === "quit") deps.quit()
        else win.hide()
      })
      return
    }
    win.hide()
  })
}
