import { useState } from "react"
import { Sparkles as IconSparkle, ChevronRight as IconChevronRight } from "lucide-react"
import { api, prettyTitle, relativeTime } from "../api"
import { EmotionBall } from "./EmotionBall"
import { ModelPill } from "./ModelPill"
import { IconSend, IconArrowUpRight, IconButler } from "./icons"
import { pendingPrompts, useStore } from "../store"

const SUGGESTIONS = ["读取当前仓库结构并总结", "帮我写一个周报草稿", "检查最近改动的代码质量", "给这个项目写一份 README"]

/** Home hero: ball + composer + suggestions + recent sessions. The composer
 *  has a 管家 toggle — on = the session is created as the fixed BUTLER role
 *  (coordinator toolset: spawn_agent / wait / interrupt, audited). */
export function Home({ onCreated }: { onCreated: (id: string) => void }) {
  const { sessions, mood, showToast, settings } = useStore()
  const noKey = !!settings && !settings.provider.hasApiKey && !(settings.providers ?? []).some((p) => p.hasApiKey)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [butler, setButler] = useState(false)
  const recent = sessions.slice(0, 4)

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      const ws = localStorage.getItem("NEWHORSE_WORKSPACE") || settings?.workspace || undefined
      const created = await api.createSession(undefined, ws, butler)
      // Hand the first prompt to the session view so it drives the live stream.
      pendingPrompts.set(created.sessionId, body)
      onCreated(created.sessionId)
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center px-4 py-12">
        <div className="fade flex w-full flex-col items-center gap-5 text-center">
          <div className="rise relative flex items-center justify-center" style={{ width: 150, height: 150 }}>
            <div className="hero-float">
              <EmotionBall mood={mood} size={104} interactive />
            </div>
          </div>
          <div className="rise" style={{ ["--d" as string]: "60ms" }}>
            <h1 className="text-[24px] font-semibold tracking-tight text-fg">有什么可以帮你？</h1>
            <p className="mt-1.5 text-[13px] text-faint">{butler ? "管家模式：把任务拆给子代理并行干，结果汇总给你" : "把任务交给管家，它会自己读文件、跑工具、记重点"}</p>
          </div>
          <div className="panel-strong composer-solid rise w-full overflow-hidden !rounded-[18px] transition-shadow" style={{ ["--d" as string]: "120ms" }}>
            <textarea
              className="max-h-44 min-h-[52px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3.5 text-[14px] outline-none placeholder:text-faint"
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
            <div className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
              <ModelPill compact />
              <button
                className={`pill transition-colors ${butler ? "!border-accent/40 !bg-accent/10 !text-accent" : "hover:border-linestrong hover:!text-fg"}`}
                title="管家模式：创建的会话是固定「管家」角色，可派出/等待/中断子代理"
                onClick={() => setButler((v) => !v)}
                aria-pressed={butler}
              >
                <IconButler size={11} />
                管家
              </button>
              <span className="flex-1" />
              <button className="btn-primary h-8 w-8 shrink-0 !rounded-full !p-0" disabled={busy || !text.trim()} onClick={() => void send()} aria-label="发送">
                <IconSend size={15} />
              </button>
            </div>
          </div>
          {noKey && (
            <div className="rise flex w-full items-center gap-2.5 rounded-xl border border-warn/25 bg-warn/[0.07] px-4 py-3 text-left" style={{ ["--d" as string]: "150ms" }}>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-warn/15 text-[11px] font-bold text-warn">1</span>
              <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-dim">
                还没有配置模型供应商——配置 Key 后才能开始对话。
              </span>
              <button className="btn-primary shrink-0 !px-3 !py-1.5 !text-[11.5px]" onClick={() => window.dispatchEvent(new CustomEvent("nh-open-settings"))}>
                去配置
              </button>
            </div>
          )}
          <div className="rise flex flex-wrap justify-center gap-2" style={{ ["--d" as string]: "180ms" }}>
            {SUGGESTIONS.map((sg) => (
              <button
                key={sg}
                className="group flex items-center gap-1.5 rounded-full border border-linestrong bg-surface2 px-3.5 py-2 text-[12.5px] text-dim shadow-[inset_0_1px_0_rgba(127,127,127,0.07)] transition-all duration-150 hover:-translate-y-0.5 hover:border-linestrong hover:bg-surface hover:text-fg"
                onClick={() => setText(sg)}
              >
                <IconSparkle size={13} className="text-faint" />
                {sg}
                <IconArrowUpRight size={12} className="opacity-0 transition-opacity group-hover:opacity-70" />
              </button>
            ))}
          </div>
        </div>

        {recent.length > 0 && (
          <div className="rise mt-14 w-full" style={{ ["--d" as string]: "240ms" }}>
            <div className="mb-3 flex items-center gap-2 px-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">最近会话</span>
              <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {recent.map((s, i) => (
                <button
                  key={s.sessionId}
                  className="panel rise group relative overflow-hidden p-3.5 text-left hover:-translate-y-0.5 hover:!border-linestrong hover:!bg-surface hover:shadow-raise"
                  style={{ ["--d" as string]: `${280 + i * 60}ms` }}
                  onClick={() => onCreated(s.sessionId)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug text-fg">{prettyTitle(s.title, s.sessionId.slice(0, 8), 40)}</div>
                    <IconChevronRight size={14} className="mt-0.5 shrink-0 text-faint opacity-0 transition-all duration-150 group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${s.status === "active" ? "bg-ok" : "bg-faint"}`} />
                    <span className="tnum">{relativeTime(s.updatedAt)}</span>
                    {s.model && (
                      <span className="pill !px-2 !py-0 !text-[10px]">{s.model.split("/").pop()}</span>
                    )}
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
