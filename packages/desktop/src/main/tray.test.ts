import { beforeEach, describe, expect, test } from "bun:test"
import type { TrayDeps, TrayLike } from "./tray"
import { createTray } from "./tray"
import type { TrayResidentWindow } from "./tray-policy"
import { wireTrayResidentClose, type CloseAction, type CloseActionDeps } from "./tray-policy"

// Fake electron pieces. tray.ts injects all electron/window dependencies, so
// tests drive the real module with these fakes and never load the electron
// package (which is only the binary path outside an Electron process).
class FakeTray implements TrayLike {
  static instances: FakeTray[] = []
  tooltip: string | undefined
  contextMenu: unknown
  private handlers = new Map<string, (...args: unknown[]) => unknown>()

  constructor(readonly icon: string) {
    FakeTray.instances.push(this)
  }

  setToolTip(value: string) {
    this.tooltip = value
  }

  setContextMenu(menu: unknown) {
    this.contextMenu = menu
  }

  on(event: "click", handler: () => void) {
    this.handlers.set(event, handler)
  }

  emit(event: "click", ...args: unknown[]) {
    this.handlers.get(event)?.(...args)
  }
}

const fakeMenu = {
  buildFromTemplate: (template: unknown[]) => ({ template }),
}

let showMainWindowCalls = 0
let toggleMainWindowCalls = 0
let quitCalls = 0
let freshIndex = 0

function makeDeps(): TrayDeps {
  return {
    Tray: FakeTray,
    Menu: fakeMenu,
    app: { quit: () => void quitCalls++ },
    iconPath: () => "C:/icons/icon.ico",
    showMainWindow: () => void showMainWindowCalls++,
    toggleMainWindow: () => void toggleMainWindowCalls++,
  }
}

beforeEach(() => {
  showMainWindowCalls = 0
  toggleMainWindowCalls = 0
  quitCalls = 0
})

// Each test gets a fresh module instance (via a cache-busting query) so the
// module-level `tray` singleton from the previous test does not leak.
async function freshTrayModule() {
  return await import(`./tray.ts?fresh=${++freshIndex}`)
}

function lastTray() {
  return FakeTray.instances.at(-1)!
}

function menuTemplate(tray: FakeTray) {
  return (tray.contextMenu as { template: { label?: string; type?: string; click?: () => void }[] }).template
}

describe("createTray", () => {
  test("creates a tray with the app icon, tooltip, and a show/hide + quit menu", async () => {
    const mod = await freshTrayModule()
    mod.createTray(makeDeps())
    const created = lastTray()

    const template = menuTemplate(created)
    expect(created.icon).toBe("C:/icons/icon.ico")
    expect(created.tooltip).toBe("newhorse")
    expect(template).toHaveLength(3)
    expect(template[0]).toMatchObject({ label: "Show/Hide Window" })
    expect(template[1]).toMatchObject({ type: "separator" })
    expect(template[2]).toMatchObject({ label: "Quit newhorse" })
  })

  test("left click on the tray shows the main window", async () => {
    const mod = await freshTrayModule()
    mod.createTray(makeDeps())
    const tray = lastTray()

    tray.emit("click")

    expect(showMainWindowCalls).toBe(1)
  })

  test("the Show/Hide Window menu item toggles the window", async () => {
    const mod = await freshTrayModule()
    mod.createTray(makeDeps())
    const template = menuTemplate(lastTray())

    template.find((item) => item.label === "Show/Hide Window")!.click!()

    expect(toggleMainWindowCalls).toBe(1)
  })

  test("the Quit menu item quits the app", async () => {
    const mod = await freshTrayModule()
    mod.createTray(makeDeps())
    const template = menuTemplate(lastTray())

    template.find((item) => item.label === "Quit newhorse")!.click!()

    expect(quitCalls).toBe(1)
  })

  test("returns the existing tray instead of creating a second one", async () => {
    const mod = await freshTrayModule()
    const before = FakeTray.instances.length

    const first = mod.createTray(makeDeps())
    const second = mod.createTray(makeDeps())

    expect(second).toBe(first)
    expect(FakeTray.instances).toHaveLength(before + 1)
  })
})

describe("close-to-tray policy", () => {
  type WindowLike = TrayResidentWindow & {
    hidden: number
    prevented: boolean
    emitClose(): void
    emitMinimize(): void
  }

  function fakeWindow(): WindowLike {
    const win = {
      hidden: 0,
      prevented: false,
      closeHandler: null as null | ((event: { preventDefault(): void }) => void),
      minimizeHandler: null as null | (() => void),
      hide() {
        this.hidden++
      },
      on(
        event: "close" | "minimize",
        handler: ((event: { preventDefault(): void }) => void) | (() => void),
      ) {
        if (event === "close") this.closeHandler = handler as (event: { preventDefault(): void }) => void
        else this.minimizeHandler = handler as () => void
      },
      emitClose() {
        this.prevented = false
        this.closeHandler?.({ preventDefault: () => void (this.prevented = true) })
      },
      emitMinimize() {
        this.minimizeHandler?.()
      },
    }
    return win
  }

  test("close hides to the tray when not quitting and a tray exists", () => {
    const win = fakeWindow()
    wireTrayResidentClose(win, { isQuitting: () => false, isTrayEnabled: () => true, getCloseAction: () => "tray" as CloseAction, askCloseAction: async () => "tray" as CloseAction, quit: () => {} })

    win.emitClose()

    expect(win.prevented).toBe(true)
    expect(win.hidden).toBe(1)
  })

  test("close is allowed through during a real quit", () => {
    const win = fakeWindow()
    wireTrayResidentClose(win, { isQuitting: () => true, isTrayEnabled: () => true, getCloseAction: () => "tray" as CloseAction, askCloseAction: async () => "tray" as CloseAction, quit: () => {} })

    win.emitClose()

    expect(win.prevented).toBe(false)
    expect(win.hidden).toBe(0)
  })

  test("close is allowed through when no tray was created", () => {
    const win = fakeWindow()
    wireTrayResidentClose(win, { isQuitting: () => false, isTrayEnabled: () => false, getCloseAction: () => "tray" as CloseAction, askCloseAction: async () => "tray" as CloseAction, quit: () => {} })

    win.emitClose()

    expect(win.prevented).toBe(false)
    expect(win.hidden).toBe(0)
  })

  test("minimize hides to the tray only when not quitting and a tray exists", () => {
    const hide = fakeWindow()
    wireTrayResidentClose(hide, { isQuitting: () => false, isTrayEnabled: () => true, getCloseAction: () => "tray" as CloseAction, askCloseAction: async () => "tray" as CloseAction, quit: () => {} })
    hide.emitMinimize()
    expect(hide.hidden).toBe(1)

    const quitting = fakeWindow()
    wireTrayResidentClose(quitting, { isQuitting: () => true, isTrayEnabled: () => true, getCloseAction: () => "tray" as CloseAction, askCloseAction: async () => "tray" as CloseAction, quit: () => {} })
    quitting.emitMinimize()
    expect(quitting.hidden).toBe(0)

    const noTray = fakeWindow()
    wireTrayResidentClose(noTray, { isQuitting: () => false, isTrayEnabled: () => false, getCloseAction: () => "tray" as CloseAction, askCloseAction: async () => "tray" as CloseAction, quit: () => {} })
    noTray.emitMinimize()
    expect(noTray.hidden).toBe(0)
  })

  test("re-reads the live quitting and tray flags on every event", () => {
    const win = fakeWindow()
    let quitting = false
    let trayEnabled = true
    wireTrayResidentClose(win, {
      isQuitting: () => quitting,
      isTrayEnabled: () => trayEnabled,
      getCloseAction: () => "tray" as CloseAction,
      askCloseAction: async () => "tray" as CloseAction,
      quit: () => {},
    })

    win.emitClose()
    expect(win.prevented).toBe(true)

    quitting = true
    win.emitClose()
    expect(win.prevented).toBe(false)
    expect(win.hidden).toBe(1)

    trayEnabled = false
    quitting = false
    win.emitClose()
    expect(win.prevented).toBe(false)
    expect(win.hidden).toBe(1)
  })

  test("close with a quit close action lets the window close", () => {
    const win = fakeWindow()
    wireTrayResidentClose(win, {
      isQuitting: () => false,
      isTrayEnabled: () => true,
      getCloseAction: () => "quit",
      askCloseAction: async () => "tray",
      quit: () => {},
    })
    win.emitClose()
    expect(win.prevented).toBe(false)
    expect(win.hidden).toBe(0)
  })

  test("close with an ask action shows the dialog and honors the chosen action", async () => {
    const win = fakeWindow()
    let asked = 0
    const askCloseAction = async () => {
      asked += 1
      return "tray"
    }
    wireTrayResidentClose(win, {
      isQuitting: () => false,
      isTrayEnabled: () => true,
      getCloseAction: () => "ask",
      askCloseAction,
      quit: () => {},
    })
    win.emitClose()
    expect(win.prevented).toBe(true)
    expect(asked).toBe(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(win.hidden).toBe(1)
  })

  test("close with an ask action can quit the app", async () => {
    const win = fakeWindow()
    let quit = 0
    wireTrayResidentClose(win, {
      isQuitting: () => false,
      isTrayEnabled: () => true,
      getCloseAction: () => "ask",
      askCloseAction: async () => "quit",
      quit: () => {
        quit += 1
      },
    })
    win.emitClose()
    await Promise.resolve()
    await Promise.resolve()
    expect(quit).toBe(1)
    expect(win.hidden).toBe(0)
  })
})
