import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../api"
import { useStore } from "../store"
import { IconCheck, IconChevron } from "./icons"

/**
 * ccswitch-style switcher pill: one popover, two levels. Top = provider
 * presets (click = switch the whole preset: protocol/baseUrl/key/model/
 * budgets atomically); bottom = the models of the ACTIVE provider. The
 * popover is portal'd to <body> with fixed coordinates so the composer's
 * overflow-hidden can never clip it. On failure: real reason + settings
 * shortcut, and the last fetched list is kept so a stale failure never
 * blanks it.
 */
export function ModelPill({ compact }: { compact?: boolean }) {
  const { settings, reloadSettings, showToast } = useStore()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [err, setErr] = useState("")
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const model = settings?.model ?? "…"
  const profiles = settings?.providers ?? []
  const activeId = settings?.activeProviderId
  const rootRef = useRef<HTMLDivElement>(null)

  const loadModels = (): void => {
    setLoading(true)
    setErr("")
    void api
      .models()
      .then((r2) => {
        setModels(r2.models)
        if (r2.models.length === 0) setErr("供应商没有返回模型列表")
      })
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e)
        setErr(raw.slice(0, 140).replace(/\s+/g, " ").replace(/\{.*$/s, "").trim() || "拉取失败")
      })
      .finally(() => setLoading(false))
  }

  const toggle = (e: React.MouseEvent): void => {
    if (!open) {
      const r = e.currentTarget.getBoundingClientRect()
      setAnchor({ top: r.top, right: window.innerWidth - r.right })
      loadModels()
    }
    setOpen(!open)
  }

  // Esc closes the popover (and the session's interrupt handler skips it
  // because of the data-nh-popover marker)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("mousedown", onDocClick)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("mousedown", onDocClick)
    }
  }, [open])

  const pickModel = async (m: string): Promise<void> => {
    setOpen(false)
    if (m === model) return
    setBusy(true)
    await api.putSettings({ model: m }).catch(() => showToast("模型切换失败"))
    await reloadSettings()
    setBusy(false)
    showToast(`模型已切换为 ${m}`)
  }

  /** Switch the WHOLE preset (ccswitch semantics) and re-pull its models. */
  const pickProvider = async (id: string): Promise<void> => {
    if (id === activeId) return
    setBusy(true)
    try {
      await api.putSettings({ activeProviderId: id })
      await reloadSettings()
      showToast("供应商已切换（新会话生效）")
      loadModels()
    } catch {
      showToast("切换失败")
    } finally {
      setBusy(false)
    }
  }

  const showError = !loading && err && models.length === 0
  return (
    <div className="relative" ref={rootRef}>
      <button
        className={`pill hover:border-linestrong hover:!text-fg ${busy || loading ? "opacity-60" : ""}`}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full bg-faint ${busy ? "pulse-dot" : ""}`} />
        {compact ? model.split("/").pop() : model}
        {!compact && <IconChevron size={11} className={`opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>
      {open && anchor &&
        createPortal(
          <div
            className="fade pop-surface fixed z-50 mb-2 max-h-[70vh] w-72 overflow-y-auto rounded-xl border border-linestrong py-1.5 shadow-modal"
            style={{ top: anchor.top - 8, right: anchor.right, transform: "translateY(-100%)" }}
            role="listbox"
            data-nh-popover
          >
            <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">模型 · 新会话生效</div>
            {loading && <div className="px-3 py-2 text-xs text-faint">拉取模型列表…</div>}
            {showError && (
              <div className="px-3 py-2">
                <div className="text-xs leading-relaxed text-bad">{err}</div>
                <button
                  className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px] text-dim transition-colors hover:border-linestrong hover:text-fg"
                  onClick={() => {
                    setOpen(false)
                    window.dispatchEvent(new CustomEvent("nh-open-settings"))
                  }}
                >
                  去设置填写 Key / 调整 Base URL
                  <IconChevron size={11} className="ml-auto rotate-90" />
                </button>
              </div>
            )}
            {models.map((m) => (
              <button key={m} role="option" aria-selected={m === model} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface2 ${m === model ? "text-accent" : "text-dim"}`} onClick={() => void pickModel(m)}>
                {m === model ? <IconCheck size={12} className="shrink-0" /> : <span className="inline-block w-[12px] shrink-0" />}
                <span className="truncate">{m}</span>
              </button>
            ))}

            {profiles.length > 0 && (
              <>
                <div className="mt-1.5 border-t border-line px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">供应商档案 · 一键整组切换</div>
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    role="option"
                    aria-selected={p.id === activeId}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface2 ${p.id === activeId ? "text-accent" : "text-dim"}`}
                    title={`${p.kind} · ${p.baseUrl}${p.model ? ` · ${p.model}` : ""}`}
                    onClick={() => void pickProvider(p.id)}
                  >
                    {p.id === activeId ? <IconCheck size={12} className="shrink-0" /> : <span className="inline-block w-[12px] shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {!p.hasApiKey && <span className="shrink-0 rounded border border-warn/30 bg-warn/10 px-1 text-[9.5px] text-warn">无 Key</span>}
                    <span className="shrink-0 rounded border border-line bg-surface px-1 text-[9.5px] text-faint">{p.kind === "anthropic" ? "anthropic" : p.kind.startsWith("openai-responses") ? "responses" : "openai"}</span>
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}
