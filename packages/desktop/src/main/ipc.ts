import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { stat, writeFile } from "node:fs/promises"
import { basename } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, powerMonitor, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@newhorse/app/desktop-menu"

import type { FatalRendererError, LanConfigInput, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getLanConfig, getNetworkIPs, saveLanConfig } from "./lan"
import { saveTextFile } from "./save-text-file"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { getPinchZoomEnabled, getWindowID, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

// Real foreground-window sensing (HANDOFF: no resident daemon). One persistent
// PowerShell process compiles the P/Invoke type once at startup and answers
// each probe over stdin/stdout — a few ms after the first — so the renderer's
// polling never pays a per-call Add-Type compile or shell spawn, and no
// per-probe timeout can silently fail the reading. The result is memoized for
// FOREGROUND_PROBE_TTL_MS so concurrent callers coalesce on one probe.
const FOREGROUND_PROBE_TTL_MS = 2_000

const FOREGROUND_PROBE_SCRIPT = `
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Foreground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr hp, uint flags, StringBuilder name, ref uint size);
}
'@
Add-Type -TypeDefinition $sig
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $hwnd = [Win32Foreground]::GetForegroundWindow()
  $pidValue = 0
  [Win32Foreground]::GetWindowThreadProcessId($hwnd, [ref]$pidValue) | Out-Null
  $locked = ($hwnd -eq [IntPtr]::Zero)
  $appName = ""
  if (-not $locked) {
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($proc) { $appName = $proc.ProcessName } else { $appName = "unknown" }
    if ($appName -eq "LockApp" -or $appName -eq "lockapp") { $locked = $true; $appName = "" }
  }
  $meeting = @("ms-teams", "Teams", "Zoom", "webex", "腾讯会议", "wemeetapp", "Slack", "discord", "LINE") | Where-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
  $meetingName = if ($meeting) { [string]$meeting } else { "" }
  Write-Output ("{0}|{1}|{2}" -f $appName, $locked, $meetingName)
}
`

type ForegroundProbe = { focusApp: string; locked: boolean; inMeeting: boolean; observedAt: number }

let foregroundProbe: ForegroundProbe | undefined
let probeProcess: ChildProcess | undefined
let probeProcessStarting: Promise<void> | undefined
let probeBuffer = ""
let probeWaiters: Array<{ timer: NodeJS.Timeout; resolve: (line: string) => void }> = []
// Consecutive empty/timeout probes since the last successful reading. A wedged
// persistent PowerShell process stays alive but stops answering; counting
// failures lets us kill and respawn it instead of silently freezing the Gantt
// on the last known open segment.
let probeFailures = 0
const PROBE_MAX_FAILURES = 3

function drainProbeWaiters() {
  const stale = probeWaiters.splice(0)
  for (const waiter of stale) {
    clearTimeout(waiter.timer)
    waiter.resolve("")
  }
}

function resetProbeProcess() {
  probeProcess?.kill()
  probeProcess = undefined
  probeBuffer = ""
  drainProbeWaiters()
}

function startProbeProcess(): Promise<void> {
  if (probeProcess) return Promise.resolve()
  if (probeProcessStarting) return probeProcessStarting
  probeProcessStarting = new Promise<void>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", FOREGROUND_PROBE_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    probeProcess = child
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      probeBuffer += chunk
      let index = probeBuffer.indexOf("\n")
      while (index !== -1) {
        const line = probeBuffer.slice(0, index).trim()
        probeBuffer = probeBuffer.slice(index + 1)
        const waiter = probeWaiters.shift()
        if (waiter) {
          clearTimeout(waiter.timer)
          waiter.resolve(line)
        }
        index = probeBuffer.indexOf("\n")
      }
    })
    child.stderr.on("data", () => {})
    child.stdin.on("error", () => {
      // Broken stdin (e.g. after sleep/resume) means the persistent process can
      // no longer be probed; force a clean respawn on the next request.
      resetProbeProcess()
    })
    child.on("error", () => {
      resetProbeProcess()
    })
    child.on("exit", () => {
      resetProbeProcess()
    })
    resolve()
  }).finally(() => {
    probeProcessStarting = undefined
  })
  return probeProcessStarting
}

// One request/response round-trip with the persistent probe. Each write to
// stdin triggers one probe; the matching stdout line resolves the waiter. A
// timeout (5s) guards against a wedged process and resolves with an empty line.
function probeOnce(): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = probeWaiters.findIndex((waiter) => waiter.timer === timer)
      if (index !== -1) probeWaiters.splice(index, 1)
      resolve("")
    }, 5_000)
    probeWaiters.push({ timer, resolve })
    void startProbeProcess()
      .then(() => probeProcess?.stdin?.write("\n"))
      .catch(() => {
        clearTimeout(timer)
        resolve("")
      })
  })
}

async function probeForeground(): Promise<ForegroundProbe> {
  const now = Date.now()
  if (foregroundProbe && now - foregroundProbe.observedAt < FOREGROUND_PROBE_TTL_MS) return foregroundProbe
  const line = await probeOnce()
  const [appName, lockedText, meetingName] = line.split("|")
  const probe: ForegroundProbe = {
    focusApp: appName || "",
    locked: lockedText === "True",
    inMeeting: meetingName.length > 0,
    observedAt: now,
  }
  // A valid reading resets the failure streak. Repeated failures mean the
  // persistent probe is wedged: respawn it so the next probe starts fresh
  // instead of the Gantt silently freezing on the last open segment.
  if (!appName) {
    probeFailures += 1
    if (probeFailures >= PROBE_MAX_FAILURES) {
      probeFailures = 0
      resetProbeProcess()
    }
  } else {
    probeFailures = 0
  }
  foregroundProbe = probe
  return probe
}

function stopProbeProcess() {
  probeProcess?.kill()
  probeProcess = undefined
  drainProbeWaiters()
}

// Push the latest foreground reading to the local sidecar. The server derives
// idle time itself; the host only reports lock/focus/meeting state.
async function pushPresence(deps: Deps, probe: ForegroundProbe) {
  const ready = await deps.awaitInitialization().catch(() => undefined)
  if (!ready) return
  const token = Buffer.from(`${ready.username ?? "opencode"}:${ready.password}`).toString("base64")
  void fetch(`${ready.url}/presence`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${token}`,
    },
    body: JSON.stringify({
      locked: probe.locked,
      focusApp: probe.focusApp || undefined,
      inMeeting: probe.inMeeting,
    }),
  }).catch(() => undefined)
}

// Presence collection runs from the main process on a timer so the Gantt gets
// granular app segments even when the renderer is backgrounded (window hidden
// to the tray, tab throttled, or the workbench page not open). The renderer's
// get-presence calls still probe on demand for immediate display.
const PRESENCE_PUSH_INTERVAL_MS = 15_000

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
}

export function registerIpcHandlers(deps: Deps) {
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  // Best-effort presence collection on a timer (main process, not renderer) so
  // the workbench Gantt records real foreground-app segments regardless of
  // which page is open or whether the window is hidden to the tray.
  const presenceTimer = setInterval(() => {
    void probeForeground().then((probe) => void pushPresence(deps, probe))
  }, PRESENCE_PUSH_INTERVAL_MS)
  presenceTimer.unref?.()
  app.once("will-quit", () => {
    clearInterval(presenceTimer)
    stopProbeProcess()
  })

  ipcMain.handle("kill-sidecar", () => deps.killSidecar())
  ipcMain.handle("await-initialization", () => deps.awaitInitialization())
  ipcMain.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  ipcMain.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  ipcMain.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  ipcMain.handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  ipcMain.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend())
  ipcMain.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  ipcMain.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  ipcMain.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  ipcMain.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  ipcMain.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  ipcMain.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  ipcMain.handle("updater-check", () => deps.updater.check())
  ipcMain.handle("updater-install", () => deps.updater.install())
  ipcMain.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  ipcMain.handle("export-debug-logs", () => deps.exportDebugLogs())
  ipcMain.handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) =>
    setForceFocus(event.sender, enabled),
  )
  ipcMain.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  ipcMain.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  ipcMain.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  ipcMain.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  ipcMain.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  ipcMain.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  ipcMain.handle("get-lan-config", () => getLanConfig())
  ipcMain.handle("set-lan-config", (_event: IpcMainInvokeEvent, partial: LanConfigInput) => {
    saveLanConfig(partial)
  })
  ipcMain.handle("get-network-ips", () => getNetworkIPs())

  ipcMain.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  ipcMain.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  ipcMain.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  ipcMain.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  ipcMain.handle("save-text-file", (_event: IpcMainInvokeEvent, input: unknown) =>
    saveTextFile(input, {
      choose: (options) => dialog.showSaveDialog(options),
      write: (path, contents) => writeFile(path, contents, "utf8"),
    }),
  )

  ipcMain.on("open-link", (_event: IpcMainEvent, url: string) => {
    void shell.openExternal(url)
  })

  ipcMain.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  ipcMain.handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })

  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  ipcMain.handle("write-clipboard-text", (_event: IpcMainInvokeEvent, value: unknown) => {
    if (typeof value !== "string") return false
    clipboard.writeText(value)
    return true
  })

  ipcMain.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  ipcMain.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  ipcMain.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  ipcMain.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  ipcMain.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  ipcMain.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  ipcMain.handle("get-presence", async (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const probe = await probeForeground()
    // Display preference: the OS foreground window, or the "newhorse is
    // focused" proxy when the probe came back empty. This is only for the
    // renderer snapshot; the server push carries the raw probe value so an
    // empty/unknown reading never turns into a fake "newhorse" segment.
    const focusedApp = probe.focusApp || (win?.isFocused() ? "newhorse" : undefined)
    // Push every desktop probe to the local server, even when LAN mode is off.
    // The sidecar always has credentials (random loopback password when LAN is
    // disabled); limiting this to durable LAN credentials left the Gantt empty
    // for normal desktop-only users.
    void pushPresence(deps, probe)
    return {
      idleSeconds: powerMonitor.getSystemIdleTime(),
      locked: probe.locked,
      focusedApp,
      inMeeting: probe.inMeeting,
    }
  })

  ipcMain.on("relaunch", () => {
    deps.relaunch()
  })

  ipcMain.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  ipcMain.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  ipcMain.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  ipcMain.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  ipcMain.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  ipcMain.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
