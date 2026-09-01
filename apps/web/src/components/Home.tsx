import { useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowUp, Paperclip, X } from "lucide-react"
import { api, prettyTitle, relativeTime } from "../api"
import { useApp, wsName } from "./App"
import { EmotionBall, HeroParticles, type BallMood } from "./EmotionBall"

/**
 * Cover: the resident newhorse session front and center. The expressive ball
 * (vendored emotion-ball engine) reacts to pointer and boot state; the
 * composer sends straight into the workspace's persistent session, so the
 * cover is never a dead end — one keystroke lands in an ongoing conversation.
 */

const SUGGESTIONS = ["读取当前仓库结构并总结", "检查最近变动的代码质量", "给这个项目写一份 README", "帮我写一个周报草稿"]

export function Home(): React.ReactElement {
  const navigate = useNavigate()
  const { workspace, sessions, resident } = useApp()
  const [text, setText] = useState("")
  const [images, setImages] = useState<Array<{ mime: string; data: string; url: string }>>([])
  const [sending, setSending] = useState(false)
  const [booted, setBooted] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // boot: health round-trip gates the ball's wake animation
  useMemo(() => {
    api.health().then(() => setBooted(true)).catch(() => setBooted(true))
  }, [])

  const mood: BallMood = !booted ? "boot" : sending ? "thinking" : resident && resident.status === "active" ? "working" : "listening"

  const recent = useMemo(
    () =>
      sessions
        .filter((s) => !s.archived && !s.parentId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4),
    [sessions],
  )

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue
      const buf = await f.arrayBuffer()
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      setImages((v) => [...v, { mime: f.type, data: b64, url: `data:${f.type};base64,${b64}` }])
    }
  }

  const send = (raw?: string): void => {
    const t = (raw ?? text).trim()
    if ((!t && !images.length) || sending) return
    setSending(true)
    api
      .createSession(undefined, workspace || undefined)
      .then((r) => {
        navigate(`/s/${r.sessionId}`, { state: { prompt: t, images: images.map(({ mime, data }) => ({ mime, data })) } })
      })
      .catch(() => setSending(false))
  }

  return (
    <div className="relative flex h-full flex-col overflow-y-auto">
      <HeroParticles className="pointer-events-none absolute inset-0 h-full w-full opacity-70" />
      <div className="relative z-10 mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center px-6 pb-10 pt-[9vh]">
        <EmotionBall mood={mood} size={176} interactive className="drop-shadow-[0_18px_50px_rgba(0,0,0,0.45)]" />

        <h1 className="mt-6 text-[22px] font-semibold tracking-tight">有什么可以帮你?</h1>
        <p className="mt-1.5 text-sm text-faint">
          把任务交给 <span className="font-medium text-dim">newhorse</span>
          {workspace ? (
            <>
              ,它会在这个工作区里读文件、跑工具、记重点
            </>
          ) : (
            ",它会自己读文件、跑工具、记重点"
          )}
        </p>

        <div className="composer mt-7 w-full">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3">
              {images.map((img, i) => (
                <div key={i} className="group relative h-14 w-14 overflow-hidden rounded-md border border-line">
                  <img src={img.url} className="h-full w-full object-cover" alt="" />
                  <button
                    className="absolute inset-y-0 right-0 hidden items-center justify-center bg-black/55 text-white group-hover:flex"
                    onClick={() => setImages((v) => v.filter((_, j) => j !== i))}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={text}
            rows={2}
            placeholder={workspace ? `描述一个任务,直接发给 ${wsName(workspace)} 的常驻会话…` : "描述一个任务…"}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items].filter((it) => it.kind === "file").map((it) => it.getAsFile() as File)
              if (files.length) void addFiles(files)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="flex items-center gap-2 px-3 pb-2.5">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files)
                e.target.value = ""
              }}
            />
            <button className="icon-btn !h-7 !w-7" title="附加图片" onClick={() => fileRef.current?.click()}>
              <Paperclip size={14} />
            </button>
            <div className="ml-auto flex items-center gap-2">
              {workspace && <span className="chip !py-0.5">{wsName(workspace)}</span>}
              <button className="send-btn" disabled={(!text.trim() && !images.length) || sending} onClick={() => send()}>
                <ArrowUp size={15} />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggest" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <div className="mt-12 w-full">
            <div className="mb-3 flex items-center gap-3">
              <span className="label">最近会话</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {recent.map((s) => (
                <button
                  key={s.sessionId}
                  className="card group px-4 py-3.5 text-left transition-colors hover:border-linestrong"
                  onClick={() => navigate(`/s/${s.sessionId}`)}
                >
                  <div className="truncate text-[13px] font-medium leading-snug">{prettyTitle(s.title, "未命名会话", 30)}</div>
                  <div className="mt-2 flex items-center gap-2 font-mono text-2xs text-ghost">
                    <span>{relativeTime(s.updatedAt)}</span>
                    {s.model && <span className="chip !py-0 !text-2xs">{s.model}</span>}
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
