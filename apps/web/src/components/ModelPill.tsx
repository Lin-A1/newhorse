import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import { IconCheck, IconChevron } from "./icons"

/** Inline model switcher pill: shows the effective model, pulls the
 *  provider's list, writes the new model on pick (new sessions pick it up). */
export function ModelPill({ compact }: { compact?: boolean }) {
  const { settings, reloadSettings, showToast } = useStore()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const model = settings?.model ?? "…"
  const rootRef = useRef<HTMLDivElement>(null)

  const toggle = (): void => {
    if (!open) {
      setLoading(true)
      void api
        .models()
        .then((r) => setModels(r.models))
        .catch(() => setModels([]))
        .finally(() => setLoading(false))
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

  const pick = async (m: string): Promise<void> => {
    setOpen(false)
    if (m === model) return
    setBusy(true)
    await api.putSettings({ model: m }).catch(() => showToast("模型切换失败"))
    await reloadSettings()
    setBusy(false)
    showToast(`模型已切换为 ${m}`)
  }
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
      {open && (
        <div className="pop-in absolute bottom-full z-30 mb-2 w-64 overflow-hidden rounded-xl border border-linestrong bg-surface2 py-1.5 shadow-modal" role="listbox" data-nh-popover>
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">模型 · 新会话生效</div>
          {loading && <div className="px-3 py-2 text-xs text-faint">拉取模型列表…</div>}
          {!loading && models.length === 0 && <div className="px-3 py-2 text-xs text-faint">拉取失败或无列表（检查 BaseURL / Key）</div>}
          {models.map((m) => (
            <button key={m} role="option" aria-selected={m === model} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-surface2 ${m === model ? "text-accent" : "text-dim"}`} onClick={() => pick(m)}>
              {m === model ? <IconCheck size={12} className="shrink-0" /> : <span className="inline-block w-[12px] shrink-0" />}
              <span className="truncate">{m}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
