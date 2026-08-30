import { useEffect, useState } from "react"
import { api, type MemoryRecord } from "../api"

/** Memory browser (记忆): search + delete over the shared memory store. */
export function MemoryPage() {
  const [rows, setRows] = useState<MemoryRecord[]>([])
  const [q, setQ] = useState("")
  const [err, setErr] = useState("")

  const refresh = (query = ""): Promise<void> =>
    api
      .memory(query)
      .then((r) => setRows(r.memories))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))

  useEffect(() => {
    void refresh()
  }, [])

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold">记忆库</h1>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded-lg bg-ink-800 border border-ink-600 px-3 py-2 text-sm"
          placeholder="搜索记忆（关键词或语义）…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && refresh(q)}
        />
        <button className="rounded-lg bg-accent px-4 text-sm font-medium text-ink-950" onClick={() => refresh(q)}>
          搜索
        </button>
      </div>
      {err && <div className="text-xs text-red-300">{err}</div>}
      <div className="space-y-2">
        {rows.length === 0 && <div className="text-sm text-slate-600">没有记忆{q ? "命中" : "（会话中模型会自动沉淀）"}</div>}
        {rows.map((m) => (
          <div key={m.id} className="rounded-2xl bg-ink-800 border border-ink-600 shadow-card p-4 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-slate-200">{m.content}</div>
              <div className="text-[11px] text-slate-500 mt-1">
                {m.type} · 优先级 {m.priority} · {new Date(m.createdAt).toLocaleString()}
              </div>
            </div>
            <button
              className="text-xs rounded-lg border border-red-500/40 text-red-300 px-2 py-1 hover:bg-red-500/10"
              onClick={() =>
                api
                  .deleteMemory(m.id)
                  .then(() => refresh(q))
                  .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
              }
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
