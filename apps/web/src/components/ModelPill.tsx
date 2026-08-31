import { useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import { IconCheck, IconChevron } from "./icons"

/** Inline model switcher pill: shows the effective model, pulls the
 *  provider's list, writes the new model on pick (new sessions pick it up). */
export function ModelPill({ compact }: { compact?: boolean }) {
  const { settings, reloadSettings, showToast } = useStore()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const model = settings?.model ?? "…"
  const pick = async (m: string): Promise<void> => {
    setOpen(false)
    if (m === model) return
    setBusy(true)
    await api.putSettings({ model: m }).catch(() => showToast("模型切换失败"))
    await reloadSettings()
    setBusy(false)
    showToast(`模型已切换为 ${m}（新会话生效）`)
  }
  return (
    <div className="relative">
      <button
        className={`pill transition-colors hover:border-white/[0.16] hover:!text-slate-200 ${busy ? "opacity-60" : ""}`}
        onClick={() => {
          if (!open) void api.models().then((r) => setModels(r.models)).catch(() => setModels([]))
          setOpen(!open)
        }}
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full bg-accent ${busy ? "pulse-dot" : ""}`} />
        {compact ? model.split("/").pop() : model}
        {!compact && <IconChevron size={11} className="opacity-60" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="rise absolute bottom-full z-30 mb-2 w-64 rounded-xl border border-white/[0.09] bg-[#12151f] py-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-slate-600">模型（新会话生效）</div>
            {models.length === 0 && <div className="px-3 py-2 text-xs text-slate-500">拉取失败或无列表</div>}
            {models.map((m) => (
              <button key={m} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-white/[0.05] ${m === model ? "text-accent" : "text-slate-300"}`} onClick={() => pick(m)}>
                {m === model ? <IconCheck size={12} /> : <span className="inline-block w-[12px]" />}
                <span className="truncate">{m}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
