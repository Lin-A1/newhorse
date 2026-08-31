import { useState } from "react"
import { api } from "../api"
import { EmotionBall } from "./EmotionBall"
import { ModelPill } from "./Session"
import { IconSend } from "./icons"
import { useStore } from "../store"

const SUGGESTIONS = ["读取当前仓库结构并总结", "帮我写一个周报草稿", "检查最近改动的代码质量", "给这个项目写一份 README"]

/** Home hero: ball + composer + suggestions + recent sessions. */
export function Home({ onCreated }: { onCreated: (id: string) => void }) {
  const { sessions, setRunning, showToast } = useStore()
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const recent = sessions.slice(0, 4)

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setRunning(true)
    try {
      const created = await api.createSession()
      onCreated(created.sessionId)
      // Fire the first prompt in the new session; the session view renders the stream.
      void api
        .prompt(created.sessionId, body, () => {})
        .catch(() => {})
        .finally(() => {
          setRunning(false)
          window.dispatchEvent(new CustomEvent("nh-session-updated", { detail: created.sessionId }))
        })
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
      setRunning(false)
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-12">
        <div className="fade flex w-full flex-col items-center gap-5 text-center">
          <EmotionBall mood="idle" size={112} />
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-slate-100">有什么可以帮你？</h1>
            <p className="mt-1 text-[13px] text-slate-500">把任务交给管家，它会自己读文件、跑工具、记重点</p>
          </div>
          <div className="panel-strong flex w-full items-end gap-2 p-2 !rounded-[22px] transition-colors focus-within:border-accent/50">
            <textarea
              className="max-h-44 min-h-[46px] w-full flex-1 resize-none bg-transparent px-3.5 pt-2 pb-1 text-sm outline-none placeholder:text-slate-600"
              rows={2}
              placeholder="描述一个任务…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <div className="flex items-center gap-2 pb-1 pr-1">
              <ModelPill compact />
              <button className="btn-primary h-8 w-8 !rounded-xl !p-0" disabled={busy || !text.trim()} onClick={send} aria-label="发送">
                <IconSend size={14} />
              </button>
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((sg) => (
              <button key={sg} className="pill transition-colors hover:border-white/[0.16] hover:!text-slate-200" onClick={() => setText(sg)}>
                {sg}
              </button>
            ))}
          </div>
        </div>

        {recent.length > 0 && (
          <div className="fade mt-14 w-full">
            <div className="mb-3 px-1 text-[11px] uppercase tracking-wider text-slate-600">最近会话</div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {recent.map((s) => (
                <button
                  key={s.sessionId}
                  className="panel group p-3.5 text-left transition-all hover:border-white/[0.14] hover:bg-white/[0.05]"
                  onClick={() => onCreated(s.sessionId)}
                >
                  <div className="truncate text-[13px] text-slate-200 group-hover:text-white">{s.title || s.sessionId.slice(0, 8)}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-600">
                    <span className={`inline-block h-1 w-1 rounded-full ${s.status === "active" ? "bg-emerald-400" : "bg-slate-600"}`} />
                    {s.updatedAt > 1000 ? new Date(s.updatedAt).toLocaleString() : "—"}
                    {s.model ? <span className="text-slate-700">·</span> : null}
                    {s.model && <span className="truncate">{s.model}</span>}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
